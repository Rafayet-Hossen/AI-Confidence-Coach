"""
AI Confidence Coach — FastAPI backend

Handles:
  - session creation
  - uploading recorded/streamed webcam video, plain video files, and audio files
  - running the ML model on whatever inputs are available for a session
  - serving the frontend

Run with:
    uvicorn main:app --reload --port 8000
"""

import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from ml_model import ConfidenceModel

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="AI Confidence Coach API",
    description="Backend that collects audio/video/webcam recordings and runs them through a confidence-scoring ML model.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # tighten this to your frontend origin in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

FRONTEND_DIR = BASE_DIR.parent / "frontend"

# Load the model once at startup. See ml_model.py to wire in your real model.
model = ConfidenceModel()

# In-memory session store. Swap for a database (SQLite/Postgres) if you need
# persistence across restarts or multiple workers.
sessions: dict[str, dict] = {}

MAX_FILE_SIZE_MB = 500
ALLOWED_VIDEO_EXT = {".webm", ".mp4", ".mov", ".mkv"}
ALLOWED_AUDIO_EXT = {".webm", ".wav", ".mp3", ".m4a", ".ogg"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_session_or_404(session_id: str) -> dict:
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found. Start a new session first.")
    return session


def _validate_extension(filename: str, allowed: set[str]) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(allowed))}",
        )
    return ext


async def _save_upload(session_id: str, kind: str, file: UploadFile, allowed_ext: set[str]) -> Path:
    session = _get_session_or_404(session_id)
    ext = _validate_extension(file.filename, allowed_ext)

    session_dir = UPLOAD_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    dest = session_dir / f"{kind}{ext}"

    size = 0
    with dest.open("wb") as out_file:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_FILE_SIZE_MB * 1024 * 1024:
                out_file.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"File exceeds {MAX_FILE_SIZE_MB}MB limit.")
            out_file.write(chunk)

    session["files"][kind] = str(dest)
    session["status"] = "captured"
    return dest


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------

@app.post("/api/session/start")
def start_session():
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "id": session_id,
        "created_at": time.time(),
        "status": "created",
        "files": {},
        "result": None,
    }
    return {"session_id": session_id}


@app.get("/api/session/{session_id}")
def get_session(session_id: str):
    session = _get_session_or_404(session_id)
    return {
        "id": session["id"],
        "status": session["status"],
        "files": {k: Path(v).name for k, v in session["files"].items()},
        "result": session["result"],
    }


@app.delete("/api/session/{session_id}")
def delete_session(session_id: str):
    _get_session_or_404(session_id)
    session_dir = UPLOAD_DIR / session_id
    if session_dir.exists():
        shutil.rmtree(session_dir)
    del sessions[session_id]
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Uploads — one endpoint per input type your model accepts
# ---------------------------------------------------------------------------

@app.post("/api/upload/webcam")
async def upload_webcam(session_id: str = Form(...), file: UploadFile = File(...)):
    """Live webcam session recording (video + mic captured together)."""
    dest = await _save_upload(session_id, "webcam", file, ALLOWED_VIDEO_EXT)
    return {"status": "ok", "kind": "webcam", "filename": dest.name}


@app.post("/api/upload/video")
async def upload_video(session_id: str = Form(...), file: UploadFile = File(...)):
    """Pre-recorded video file uploaded from disk."""
    dest = await _save_upload(session_id, "video", file, ALLOWED_VIDEO_EXT)
    return {"status": "ok", "kind": "video", "filename": dest.name}


@app.post("/api/upload/audio")
async def upload_audio(session_id: str = Form(...), file: UploadFile = File(...)):
    """Audio-only recording or upload."""
    dest = await _save_upload(session_id, "audio", file, ALLOWED_AUDIO_EXT)
    return {"status": "ok", "kind": "audio", "filename": dest.name}


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

@app.post("/api/analyze/{session_id}")
async def analyze(session_id: str):
    session = _get_session_or_404(session_id)
    files = session["files"]
    if not files:
        raise HTTPException(status_code=400, detail="No recordings uploaded for this session yet.")

    session["status"] = "analyzing"
    try:
        result = model.analyze(
            video_path=files.get("video"),
            audio_path=files.get("audio"),
            webcam_path=files.get("webcam"),
        )
    except Exception as exc:  # surface model errors instead of a bare 500
        session["status"] = "error"
        raise HTTPException(status_code=500, detail=f"Model inference failed: {exc}") from exc

    session["status"] = "analyzed"
    session["result"] = result
    return result


@app.get("/api/health")
def health():
    return {"status": "ok", "model_loaded": model.is_loaded()}


# ---------------------------------------------------------------------------
# Serve the frontend last, so /api/* routes above take precedence
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
