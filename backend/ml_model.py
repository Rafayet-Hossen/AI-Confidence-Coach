import os
import pickle
import json
import subprocess
import numpy as np
import librosa
import whisper
from deepface import DeepFace
from stable_baselines3 import PPO

# ── Load all models at startup ──────────────────────────

BASE_DIR = os.path.dirname(__file__)

# Random Forest confidence model
with open(os.path.join(BASE_DIR, "models/confidence_model_v3.pkl"), "rb") as f:
    rf_model = pickle.load(f)

# Feature columns
with open(os.path.join(BASE_DIR, "models/feature_cols_v3.json"), "r") as f:
    feature_cols = json.load(f)

# SHAP explainer
with open(os.path.join(BASE_DIR, "models/shap_explainer_v1_new.pkl"), "rb") as f:
    shap_explainer = pickle.load(f)

# RL agent
rl_agent = PPO.load(os.path.join(BASE_DIR, "models/rl_coach_v1"))

# RL env stats
with open(os.path.join(BASE_DIR, "models/rl_env_stats_v1.pkl"), "rb") as f:
    rl_stats = pickle.load(f)

# Whisper
whisper_model = whisper.load_model("base")

# ── Constants ───────────────────────────────────────────

WEAK_FEATURES = rl_stats['weak_features']
ACTIONS       = rl_stats['actions']
FEATURE_MIN   = rl_stats['feature_min']
FEATURE_MAX   = rl_stats['feature_max']

EMOTION_CONFIDENCE_MAP = {
    'happy'    : 1.0,
    'neutral'  : 0.8,
    'surprise' : 0.6,
    'angry'    : 0.4,
    'sad'      : 0.3,
    'fear'     : 0.2,
    'disgust'  : 0.2,
}

AUDIO_WEIGHT = 0.65
FACE_WEIGHT  = 0.35

HUMAN_READABLE = [
    'pitch_mean', 'pitch_std', 'energy_mean', 'energy_std',
    'pause_ratio', 'num_pauses', 'tempo',
    'filler_ratio', 'words_per_min'
]

# ── Conversion Helper ────────────────────────────────────

def convert_to_wav(input_path):
    """
    Convert any audio/video file (webm, mp4, mov etc.)
    to 16kHz mono wav using ffmpeg.
    Returns path to converted wav file.
    """
    output_path = os.path.splitext(input_path)[0] + '_converted.wav'
    try:
        subprocess.run([
            'ffmpeg', '-y',
            '-i', input_path,
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            output_path
        ], check=True, capture_output=True)
        return output_path
    except FileNotFoundError:
        raise RuntimeError(
            "ffmpeg not found. Install it with: winget install ffmpeg"
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"ffmpeg conversion failed: {e.stderr.decode()}"
        )

# ── Feature Extraction ───────────────────────────────────

def extract_audio_features(audio_path):
    # Convert webm/mp4/mov to wav if needed
    ext = os.path.splitext(audio_path)[1].lower()
    if ext not in ['.wav']:
        audio_path = convert_to_wav(audio_path)

    y, sr = librosa.load(audio_path, sr=16000, mono=True)
    dur   = librosa.get_duration(y=y, sr=sr)

    # Pitch
    f0, _, _    = librosa.pyin(y, fmin=50, fmax=3000)
    valid_f0    = f0[~np.isnan(f0)]
    pitch_mean  = float(np.mean(valid_f0)) if len(valid_f0) > 0 else 0.0
    pitch_std   = float(np.std(valid_f0))  if len(valid_f0) > 0 else 0.0

    # Energy
    rms         = librosa.feature.rms(y=y)[0]
    energy_mean = float(np.mean(rms))
    energy_std  = float(np.std(rms))

    # Pauses
    intervals   = librosa.effects.split(y, top_db=30)
    speech_dur  = sum([(e - s) / sr for s, e in intervals])
    pause_ratio = 1 - (speech_dur / dur) if dur > 0 else 0
    num_pauses  = max(0, len(intervals) - 1)

    # Tempo
    tempo, _    = librosa.beat.beat_track(y=y, sr=sr)
    tempo       = float(tempo)

    # MFCCs
    mfccs       = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    mfcc_means  = mfccs.mean(axis=1).tolist()

    # Whisper transcription (use converted wav path)
    result        = whisper_model.transcribe(audio_path)
    text          = result['text'].strip()
    words         = text.split()
    word_count    = len(words)
    words_per_min = (word_count / dur * 60) if dur > 0 else 0

    fillers       = ['um', 'uh', 'hmm', 'err', 'ah']
    filler_count  = sum(text.lower().count(f) for f in fillers)
    filler_ratio  = filler_count / word_count if word_count > 0 else 0

    row = {
        'pitch_mean'    : pitch_mean,
        'pitch_std'     : pitch_std,
        'energy_mean'   : energy_mean,
        'energy_std'    : energy_std,
        'pause_ratio'   : pause_ratio,
        'num_pauses'    : num_pauses,
        'tempo'         : tempo,
        'filler_ratio'  : filler_ratio,
        'words_per_min' : words_per_min,
        'transcript'    : text,
    }
    for i, v in enumerate(mfcc_means, 1):
        row[f'mfcc_mean_{i}'] = v

    return row


def extract_face_score(video_path):
    """Extract face confidence score from webcam video."""
    import cv2
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None, None

    frame_scores      = []
    dominant_emotions = []
    frame_count       = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_count % 30 == 0:
            try:
                result   = DeepFace.analyze(
                    img_path          = frame,
                    actions           = ['emotion'],
                    enforce_detection = False,
                    silent            = True
                )
                emo_dict = result[0]['emotion']
                dominant = result[0]['dominant_emotion']

                score = sum(
                    (p / (sum(emo_dict.values()) + 1e-8)) *
                    EMOTION_CONFIDENCE_MAP.get(e, 0.5)
                    for e, p in emo_dict.items()
                ) * 100

                frame_scores.append(score)
                dominant_emotions.append(dominant)
            except Exception:
                pass
        frame_count += 1

    cap.release()

    if not frame_scores:
        return None, None

    from collections import Counter
    dominant = Counter(dominant_emotions).most_common(1)[0][0]
    return round(float(np.mean(frame_scores)), 2), dominant


# ── XAI Explanation ─────────────────────────────────────

def get_explanation(features):
    """Generate human readable SHAP explanation."""
    import pandas as pd
    X = pd.DataFrame(
        [[features.get(f, 0.0) for f in feature_cols]],
        columns=feature_cols
    )
    sv       = shap_explainer.shap_values(X)[0]
    shap_df  = (
        pd.DataFrame({'Feature': feature_cols, 'SHAP': sv})
        .query("Feature in @HUMAN_READABLE")
        .sort_values('SHAP', key=abs, ascending=False)
    )

    strengths  = []
    weaknesses = []

    labels = {
        'filler_ratio'  : ("Minimal filler words",    "Too many filler words"),
        'pause_ratio'   : ("Natural pause pattern",   "Unnatural pauses"),
        'words_per_min' : ("Good speaking pace",      "Speaking pace off"),
        'pitch_std'     : ("Steady voice",            "Shaky voice"),
        'pitch_mean'    : ("Appropriate pitch",       "Pitch too high/low"),
        'energy_mean'   : ("Strong voice energy",     "Weak voice energy"),
        'energy_std'    : ("Consistent voice",        "Inconsistent voice"),
        'num_pauses'    : ("Appropriate pause count", "Too many/few pauses"),
        'tempo'         : ("Natural rhythm",          "Irregular rhythm"),
    }

    for _, row in shap_df.iterrows():
        feat  = row['Feature']
        label = labels.get(feat, (feat, feat))
        if row['SHAP'] > 0:
            strengths.append(label[0])
        else:
            weaknesses.append(label[1])

    return strengths[:3], weaknesses[:3]


# ── RL Coaching ──────────────────────────────────────────

def get_coaching(features):
    """Get personalized coaching tip + exercise from RL agent."""
    state = []
    for feat in WEAK_FEATURES:
        val     = features.get(feat, 0.0)
        min_val = FEATURE_MIN[feat]
        max_val = FEATURE_MAX[feat]
        norm    = (val - min_val) / (max_val - min_val + 1e-8)
        state.append(float(np.clip(norm, 0.0, 1.0)))

    state      = np.array(state, dtype=np.float32)
    action, _  = rl_agent.predict(state, deterministic=True)
    info       = ACTIONS[int(action)]

    return info['tip'], info['exercise']


# ── Main Analyze Function ────────────────────────────────

class ConfidenceModel:
    def __init__(self):
        pass

    def is_loaded(self):
        return True

    def analyze(self, video_path=None, audio_path=None, webcam_path=None):
        import pandas as pd

        # ── Step 1: Audio features ──
        source_audio = audio_path or webcam_path or video_path
        if not source_audio:
            return {"error": "No audio or video file provided"}

        features   = extract_audio_features(source_audio)
        transcript = features.pop('transcript', '')

        # ── Step 2: Audio confidence score ──
        X = pd.DataFrame(
            [[features.get(f, 0.0) for f in feature_cols]],
            columns=feature_cols
        )
        audio_score = float(rf_model.predict(X)[0])

        # ── Step 3: Face score (if webcam or video available) ──
        face_score       = None
        dominant_emotion = None
        source_video     = webcam_path or video_path

        if source_video:
            face_score, dominant_emotion = extract_face_score(source_video)

        # ── Step 4: Fuse scores ──
        if face_score is not None:
            final_score = (audio_score * AUDIO_WEIGHT) + (face_score * FACE_WEIGHT)
            mode        = "audio + face"
        else:
            final_score = audio_score
            mode        = "audio only"

        final_score = round(final_score, 2)

        # ── Step 5: XAI explanation ──
        strengths, weaknesses = get_explanation(features)

        # ── Step 6: RL coaching ──
        tip, exercise = get_coaching(features)

        # ── Step 7: Confidence level label ──
        if final_score >= 75:
            level = "High Confidence"
        elif final_score >= 55:
            level = "Moderate Confidence"
        else:
            level = "Low Confidence"

        return {
            "overall_score"   : final_score,
            "level"           : level,
            "mode"            : mode,
            "metrics"         : {
                "audio_score"      : round(audio_score, 2),
                "face_score"       : face_score,
                "speaking_pace"    : round(features.get('words_per_min', 0), 1),
                "filler_words"     : round((1 - features.get('filler_ratio', 0)) * 100, 1),
                "voice_steadiness" : round((1 - min(features.get('pitch_std', 0) / 1000, 1)) * 100, 1),
                "pause_pattern"    : round((1 - features.get('pause_ratio', 0)) * 100, 1),
                "facial_expression": face_score,
            },
            "transcript"      : transcript,
            "dominant_emotion": dominant_emotion,
            "explanation"     : {
                "strengths"  : strengths,
                "weaknesses" : weaknesses,
            },
            "coaching"        : {
                "tip"      : tip,
                "exercise" : exercise,
            },
            "inputs_used"     : {
                "video"  : video_path  is not None,
                "audio"  : audio_path  is not None,
                "webcam" : webcam_path is not None,
            }
        }
