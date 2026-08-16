"""
ConfidenceModel — the single place you plug your trained ML model into.

The rest of the app (FastAPI routes, frontend dashboard) is already wired to
call `ConfidenceModel().analyze(...)` and render whatever dict comes back, as
long as it roughly follows the shape documented below. You should only need
to edit this file to go from "demo with fake numbers" to "real model".

--------------------------------------------------------------------------
WHAT TO DO
--------------------------------------------------------------------------
1. In __init__: load your model weights / pipelines once (not per-request).
     e.g. self.video_model = torch.load("weights/video_model.pt")
          self.audio_model = joblib.load("weights/audio_model.pkl")

2. In analyze(): run your real preprocessing + inference using whichever of
   video_path / audio_path / webcam_path were provided, and return a dict
   shaped like RESULT_SCHEMA below.

3. If your model needs extracted frames or an audio track pulled out of the
   webcam video, do that here (e.g. with `ffmpeg-python` or `moviepy`) before
   calling your model.

--------------------------------------------------------------------------
RESULT_SCHEMA (what the frontend expects back)
--------------------------------------------------------------------------
{
    "overall_score": float,        # 0-100
    "metrics": {                   # each 0-100, shown as gauges/bars
        "eye_contact": float,
        "voice_clarity": float,
        "speaking_pace": float,
        "posture": float,
        "filler_words": float,
        "facial_expression": float,
    },
    "feedback": [str, ...],        # short natural-language coaching tips
    "inputs_used": {                # which inputs actually informed the score
        "video": bool,
        "audio": bool,
        "webcam": bool,
    },
}

Feel free to add extra keys (e.g. a per-second timeline) — the frontend will
ignore anything it doesn't know how to render, and you can extend
frontend/app.js to visualize new fields.
"""

import random
import time
from typing import Optional


class ConfidenceModel:
    def __init__(self):
        self._loaded = True
        # TODO: replace with real model loading, e.g.:
        #
        # import torch
        # self.device = "cuda" if torch.cuda.is_available() else "cpu"
        # self.video_model = torch.load("weights/video_confidence.pt", map_location=self.device)
        # self.video_model.eval()
        #
        # self.audio_model = load_your_audio_model("weights/audio_confidence.pt")

    def is_loaded(self) -> bool:
        return self._loaded

    def analyze(
        self,
        video_path: Optional[str] = None,
        audio_path: Optional[str] = None,
        webcam_path: Optional[str] = None,
    ) -> dict:
        """
        Run inference on whatever inputs are available and return a result
        dict matching RESULT_SCHEMA above.

        video_path / audio_path / webcam_path are absolute paths to files
        already saved on disk by the FastAPI upload endpoints, or None if
        that input type wasn't provided for this session.
        """

        # -----------------------------------------------------------------
        # DEMO IMPLEMENTATION — replace everything below this line.
        # -----------------------------------------------------------------
        time.sleep(1.2)  # simulate inference latency; remove once real

        def rand_score():
            return round(random.uniform(45, 96), 1)

        metrics = {
            "eye_contact": rand_score(),
            "voice_clarity": rand_score(),
            "speaking_pace": rand_score(),
            "posture": rand_score(),
            "filler_words": rand_score(),
            "facial_expression": rand_score(),
        }
        overall = round(sum(metrics.values()) / len(metrics), 1)

        feedback_pool = [
            "Hold eye contact with the camera for longer stretches instead of glancing away.",
            "Nice steady pace — you're avoiding rushed delivery.",
            "Try to cut down on filler words like 'um' and 'like'.",
            "Your posture is upright and confident throughout most of the clip.",
            "Vary your vocal tone a bit more to keep the energy up.",
            "Good use of pauses before key points.",
        ]
        feedback = random.sample(feedback_pool, k=3)

        return {
            "overall_score": overall,
            "metrics": metrics,
            "feedback": feedback,
            "inputs_used": {
                "video": bool(video_path),
                "audio": bool(audio_path),
                "webcam": bool(webcam_path),
            },
        }
