/* =====================================================================
   Confidence Coach — frontend app logic
   Talks to the FastAPI backend at the same origin under /api/*
   ===================================================================== */

const API = ""; // same-origin; set to "http://localhost:8000" if serving frontend separately

const state = {
  sessionId: null,
  webcamStream: null,
  webcamRecorder: null,
  webcamChunks: [],
  webcamBlob: null,
  webcamTimerHandle: null,
  webcamStartedAt: 0,

  audioStream: null,
  audioRecorder: null,
  audioChunks: [],
  audioBlob: null,
  audioCtx: null,
  analyser: null,
  rafHandle: null,

  videoFile: null,
  audioFile: null,

  staged: { webcam: false, video: false, audio: false },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", async () => {
  await checkHealth();
  await startSession();
  wireTabs();
  wireWebcam();
  wireVideoUpload();
  wireAudio();
  wireAnalyze();
});

async function checkHealth() {
  const chip = $("#apiStatus");
  const text = $("#apiStatusText");
  try {
    const res = await fetch(`${API}/api/health`);
    if (!res.ok) throw new Error();
    chip.classList.add("is-online");
    text.textContent = "model ready";
  } catch {
    chip.classList.add("is-offline");
    text.textContent = "backend offline";
  }
}

async function startSession() {
  try {
    const res = await fetch(`${API}/api/session/start`, { method: "POST" });
    const data = await res.json();
    state.sessionId = data.session_id;
  } catch (err) {
    console.error("Could not start session", err);
  }
}

/* ---------------------------------------------------------------------
   Tabs
   --------------------------------------------------------------------- */
function wireTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("is-active"));
      $$(".tab-panel").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      $(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
    });
  });
}

/* ---------------------------------------------------------------------
   Webcam capture
   --------------------------------------------------------------------- */
function wireWebcam() {
  const enableBtn = $("#enableCamBtn");
  const startBtn = $("#startRecBtn");
  const stopBtn = $("#stopRecBtn");
  const retakeBtn = $("#retakeBtn");
  const uploadBtn = $("#uploadWebcamBtn");

  enableBtn.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      state.webcamStream = stream;
      const videoEl = $("#webcamPreview");
      videoEl.srcObject = stream;
      $("#webcamOverlay").hidden = true;
      startBtn.disabled = false;
    } catch (err) {
      alert("Camera/microphone access was denied or unavailable: " + err.message);
    }
  });

  startBtn.addEventListener("click", () => {
    if (!state.webcamStream) return;
    state.webcamChunks = [];
    const recorder = new MediaRecorder(state.webcamStream, { mimeType: pickMime(["video/webm;codecs=vp9,opus", "video/webm"]) });
    recorder.ondataavailable = (e) => e.data.size && state.webcamChunks.push(e.data);
    recorder.onstop = () => {
      state.webcamBlob = new Blob(state.webcamChunks, { type: "video/webm" });
      const url = URL.createObjectURL(state.webcamBlob);
      const videoEl = $("#webcamPreview");
      videoEl.srcObject = null;
      videoEl.src = url;
      videoEl.muted = false;
      videoEl.controls = true;
      $("#webcamFileSize").textContent = formatBytes(state.webcamBlob.size);
      $("#webcamUploadRow").hidden = false;
    };
    recorder.start();
    state.webcamRecorder = recorder;
    state.webcamStartedAt = Date.now();
    $("#recBadge").hidden = false;
    startBtn.hidden = true;
    stopBtn.hidden = false;
    state.webcamTimerHandle = setInterval(updateWebcamTimer, 1000);
  });

  stopBtn.addEventListener("click", () => {
    if (state.webcamRecorder && state.webcamRecorder.state !== "inactive") {
      state.webcamRecorder.stop();
    }
    clearInterval(state.webcamTimerHandle);
    $("#recBadge").hidden = true;
    stopBtn.hidden = true;
    retakeBtn.hidden = false;
  });

  retakeBtn.addEventListener("click", () => {
    const videoEl = $("#webcamPreview");
    videoEl.src = "";
    videoEl.controls = false;
    videoEl.muted = true;
    videoEl.srcObject = state.webcamStream;
    state.webcamBlob = null;
    $("#webcamUploadRow").hidden = true;
    retakeBtn.hidden = true;
    startBtn.hidden = false;
    $("#recTimer").textContent = "00:00";
    setStaged("webcam", false);
  });

  uploadBtn.addEventListener("click", async () => {
    if (!state.webcamBlob) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading…";
    try {
      await uploadFile("/api/upload/webcam", state.webcamBlob, "webcam-session.webm");
      setStaged("webcam", true);
      uploadBtn.textContent = "Uploaded ✓";
    } catch (err) {
      uploadBtn.textContent = "Use this take";
      alert("Upload failed: " + err.message);
    } finally {
      uploadBtn.disabled = false;
    }
  });
}

function updateWebcamTimer() {
  const elapsed = Math.floor((Date.now() - state.webcamStartedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  $("#recTimer").textContent = `${mm}:${ss}`;
}

/* ---------------------------------------------------------------------
   Video file upload
   --------------------------------------------------------------------- */
function wireVideoUpload() {
  const dropzone = $("#videoDropzone");
  const input = $("#videoFileInput");
  const uploadBtn = $("#uploadVideoBtn");

  ["dragover", "dragenter"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragover"); })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleVideoFile(file);
  });
  input.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleVideoFile(file);
  });

  function handleVideoFile(file) {
    state.videoFile = file;
    $("#videoFileName").textContent = file.name;
    $("#videoFileSize").textContent = formatBytes(file.size);
    $("#videoUploadRow").hidden = false;
  }

  uploadBtn.addEventListener("click", async () => {
    if (!state.videoFile) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading…";
    try {
      await uploadFile("/api/upload/video", state.videoFile, state.videoFile.name);
      setStaged("video", true);
      uploadBtn.textContent = "Uploaded ✓";
    } catch (err) {
      uploadBtn.textContent = "Use this file";
      alert("Upload failed: " + err.message);
    } finally {
      uploadBtn.disabled = false;
    }
  });
}

/* ---------------------------------------------------------------------
   Audio capture + upload
   --------------------------------------------------------------------- */
function wireAudio() {
  const startBtn = $("#startAudioBtn");
  const stopBtn = $("#stopAudioBtn");
  const dropzone = $("#audioDropzone");
  const input = $("#audioFileInput");
  const uploadBtn = $("#uploadAudioBtn");

  startBtn.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.audioStream = stream;
      setupWaveform(stream);

      state.audioChunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: pickMime(["audio/webm;codecs=opus", "audio/webm"]) });
      recorder.ondataavailable = (e) => e.data.size && state.audioChunks.push(e.data);
      recorder.onstop = () => {
        state.audioBlob = new Blob(state.audioChunks, { type: "audio/webm" });
        $("#audioFileName").textContent = "audio-recording.webm";
        $("#audioFileSize").textContent = formatBytes(state.audioBlob.size);
        $("#audioUploadRow").hidden = false;
        stream.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(state.rafHandle);
      };
      recorder.start();
      state.audioRecorder = recorder;
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (err) {
      alert("Microphone access was denied or unavailable: " + err.message);
    }
  });

  stopBtn.addEventListener("click", () => {
    if (state.audioRecorder && state.audioRecorder.state !== "inactive") {
      state.audioRecorder.stop();
    }
    stopBtn.hidden = true;
    startBtn.hidden = false;
  });

  ["dragover", "dragenter"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragover"); })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleAudioFile(file);
  });
  input.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleAudioFile(file);
  });

  function handleAudioFile(file) {
    state.audioFile = file;
    state.audioBlob = null;
    $("#audioFileName").textContent = file.name;
    $("#audioFileSize").textContent = formatBytes(file.size);
    $("#audioUploadRow").hidden = false;
  }

  uploadBtn.addEventListener("click", async () => {
    const fileToSend = state.audioBlob || state.audioFile;
    if (!fileToSend) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading…";
    try {
      const name = state.audioFile ? state.audioFile.name : "audio-recording.webm";
      await uploadFile("/api/upload/audio", fileToSend, name);
      setStaged("audio", true);
      uploadBtn.textContent = "Uploaded ✓";
    } catch (err) {
      uploadBtn.textContent = "Use this clip";
      alert("Upload failed: " + err.message);
    } finally {
      uploadBtn.disabled = false;
    }
  });
}

function setupWaveform(stream) {
  const canvas = $("#waveCanvas");
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;

  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioCtx.createMediaStreamSource(stream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 256;
  source.connect(state.analyser);

  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    state.rafHandle = requestAnimationFrame(draw);
    state.analyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barWidth = (canvas.width / bufferLength) * 1.6;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height * 0.9;
      const hue = 158; // teal
      ctx.fillStyle = `hsla(${hue}, 75%, 55%, ${0.35 + (dataArray[i] / 255) * 0.6})`;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
      x += barWidth + 2;
    }
  }
  draw();
}

/* ---------------------------------------------------------------------
   Upload helper (progress-aware, via XHR)
   --------------------------------------------------------------------- */
function uploadFile(path, fileOrBlob, filename) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("session_id", state.sessionId);
    form.append("file", fileOrBlob, filename);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}${path}`);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        try {
          reject(new Error(JSON.parse(xhr.responseText).detail || xhr.statusText));
        } catch {
          reject(new Error(xhr.statusText));
        }
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(form);
  });
}

/* ---------------------------------------------------------------------
   Staged inputs / analyze
   --------------------------------------------------------------------- */
function setStaged(kind, ready) {
  state.staged[kind] = ready;
  const chip = $(`#chip-${kind}`);
  chip.classList.toggle("is-ready", ready);
  chip.querySelector(".collected__state").textContent = ready ? "ready" : "—";
  const anyReady = Object.values(state.staged).some(Boolean);
  $("#analyzeBtn").disabled = !anyReady;
}

function wireAnalyze() {
  $("#analyzeBtn").addEventListener("click", runAnalysis);
  $("#newSessionBtn").addEventListener("click", () => window.location.reload());
}

async function runAnalysis() {
  setStep(2);
  $("#emptyState").hidden = true;
  $("#resultsState").hidden = true;
  $("#analyzingState").hidden = false;

  try {
    const res = await fetch(`${API}/api/analyze/${state.sessionId}`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Analysis failed");
    }
    const result = await res.json();
    renderResults(result);
    setStep(3);
  } catch (err) {
    $("#analyzingState").hidden = true;
    $("#emptyState").hidden = false;
    alert("Analysis failed: " + err.message);
    setStep(1);
  }
}

function setStep(n) {
  $$(".stepper__item").forEach((el) => {
    el.classList.toggle("is-active", Number(el.dataset.step) === n);
  });
}

/* ---------------------------------------------------------------------
   Results rendering
   --------------------------------------------------------------------- */
function renderResults(result) {
  $("#analyzingState").hidden = true;
  $("#resultsState").hidden = false;

  // Score + arc gauge
  const score = result.overall_score ?? 0;
  $("#overallScore").textContent = score;

  const path = $("#arcFill");
  const length = path.getTotalLength();
  path.style.strokeDasharray = `${length}`;
  path.style.strokeDashoffset = `${length}`;
  path.style.stroke = scoreColor(score);
  // force reflow then animate
  requestAnimationFrame(() => {
    const offset = length - (length * Math.min(score, 100)) / 100;
    path.style.strokeDashoffset = `${offset}`;
  });

  // Metrics
  const grid = $("#metricsGrid");
  grid.innerHTML = "";
  const labels = {
    eye_contact: "Eye contact",
    voice_clarity: "Voice clarity",
    speaking_pace: "Speaking pace",
    posture: "Posture",
    filler_words: "Filler words",
    facial_expression: "Expression",
  };
  Object.entries(result.metrics || {}).forEach(([key, value]) => {
    const row = document.createElement("div");
    row.className = "metric-row";
    row.innerHTML = `
      <span class="metric-row__label">${labels[key] || key}</span>
      <span class="metric-row__track"><span class="metric-row__fill" style="width:${value}%"></span></span>
      <span class="metric-row__value">${value}</span>
    `;
    grid.appendChild(row);
  });

  // Feedback
  const list = $("#feedbackList");
  list.innerHTML = "";
  (result.feedback || []).forEach((tip) => {
    const li = document.createElement("li");
    li.textContent = tip;
    list.appendChild(li);
  });

  // Sources
  const row = $("#sourcesRow");
  row.innerHTML = "";
  Object.entries(result.inputs_used || {}).forEach(([key, used]) => {
    const pill = document.createElement("span");
    pill.className = "source-pill" + (used ? " is-active" : "");
    pill.textContent = key;
    row.appendChild(pill);
  });
}

function scoreColor(score) {
  if (score >= 75) return "#33E6B4";
  if (score >= 50) return "#FFB020";
  return "#FF4438";
}

/* ---------------------------------------------------------------------
   Utils
   --------------------------------------------------------------------- */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pickMime(candidates) {
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}
