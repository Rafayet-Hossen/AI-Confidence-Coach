# Confidence Coach — AI Session Analyzer

A full-stack scaffold for your ML course project: a FastAPI backend that
accepts **webcam recordings, uploaded video files, and audio clips**, plus a
modern dark "control-room" frontend to capture them and display results.

```
confidence-coach/
├── backend/
│   ├── main.py            # FastAPI app: sessions, uploads, /api/analyze
│   ├── ml_model.py         # <-- plug your trained model in here
│   ├── requirements.txt
│   └── uploads/            # recordings land here, per session_id
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── README.md
```

## 1. Run it

```bash
cd confidence-coach/backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Open **http://localhost:8000** — the backend serves the frontend directly, so
there's nothing else to run. (Browsers only allow camera/mic access over
`localhost` or HTTPS, which `localhost:8000` satisfies.)

## 2. How the pieces fit together

1. On page load, the frontend calls `POST /api/session/start` and gets a
   `session_id` that tags every upload.
2. You record a **webcam session** (video+audio together), upload a **video
   file**, and/or record or upload an **audio** clip — any combination.
   Each is sent to its own endpoint:
   - `POST /api/upload/webcam`
   - `POST /api/upload/video`
   - `POST /api/upload/audio`
3. Clicking **"Run confidence analysis"** calls
   `POST /api/analyze/{session_id}`, which hands the saved file paths to
   `ConfidenceModel.analyze()` in `ml_model.py` and returns a JSON result.
4. The frontend renders that JSON as the arc gauge, metric bars, and
   coaching notes on the right.

## 3. Plug in your trained model

Everything routes through **one file**: `backend/ml_model.py`.

```python
class ConfidenceModel:
    def __init__(self):
        # load your weights once, at startup
        self.model = ...

    def analyze(self, video_path=None, audio_path=None, webcam_path=None):
        # run your real preprocessing + inference here
        return {
            "overall_score": 82.4,
            "metrics": {
                "eye_contact": 78.0,
                "voice_clarity": 85.0,
                "speaking_pace": 80.0,
                "posture": 75.0,
                "filler_words": 88.0,
                "facial_expression": 90.0,
            },
            "feedback": ["...", "..."],
            "inputs_used": {"video": True, "audio": False, "webcam": True},
        }
```

Right now it returns randomized demo numbers so you can build/demo the full
pipeline before your model is ready. Swap in real inference and everything
downstream (API + UI) keeps working unchanged. If you add new fields to the
result dict, extend `renderResults()` in `frontend/app.js` to display them.

## 4. Notes for your writeup / defense

- **Sessions** are stored in-memory (`sessions` dict in `main.py`) for
  simplicity — swap in SQLite/Postgres if you need persistence across
  restarts.
- **File limits**: 500MB per upload, enforced server-side in `main.py`
  (`MAX_FILE_SIZE_MB`).
- **CORS** is wide open (`allow_origins=["*"]`) for local development —
  restrict it before deploying anywhere public.
- Recordings are written to `backend/uploads/<session_id>/`, one file per
  input type (`webcam.webm`, `video.mp4`, `audio.webm`, etc.).
- The frontend uses only vanilla HTML/CSS/JS (no build step) so it's easy to
  read and modify directly, and uses the browser's native `MediaRecorder`
  and `getUserMedia` APIs for capture — no external libraries required.
