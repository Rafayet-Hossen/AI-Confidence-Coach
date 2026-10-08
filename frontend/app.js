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
   Session History (localStorage)
   Newest session is the top entry; click an entry for its full page.
   --------------------------------------------------------------------- */
const HISTORY_KEY = "confidence_coach_history";

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveToHistory(result) {
  const history = loadHistory();
  history.push({
    id             : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date           : new Date().toLocaleString(),
    ts             : Date.now(),
    overall_score  : result.overall_score,
    level          : result.level,
    mode           : result.mode,
    metrics        : result.metrics,
    strengths      : result.explanation?.strengths  || [],
    weaknesses     : result.explanation?.weaknesses || [],
    tip            : result.coaching?.tip      || "",
    exercise       : result.coaching?.exercise || "",
    transcript     : result.transcript || "",
    dominant_emotion: result.dominant_emotion || null,
    inputs_used    : result.inputs_used || {},
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  console.log("[History] Saved session #" + history.length, history[history.length-1]);
}

/* Metric display config, shared by the stack rows and the detail page */
const METRIC_LABELS = {
  speaking_pace    : "Speaking Pace",
  filler_words     : "Filler Cleanliness",
  voice_steadiness : "Voice Steadiness",
  pause_pattern    : "Pause Pattern",
  audio_score      : "Audio Score",
  face_score       : "Face Score",
  facial_expression: "Facial Expression",
};

function scoreBand(score) {
  return score >= 75 ? "high" : score >= 55 ? "mid" : "low";
}

function metricDisplay(key, val) {
  if (key === "speaking_pace") return `${val} WPM`;
  return `${val}%`;
}

/* Delta of a session against the one before it (null when there is none) */
function sessionDelta(history, idx) {
  if (idx <= 0) return null;
  const prev = history[idx - 1].overall_score;
  const cur  = history[idx].overall_score;
  if (typeof prev !== "number" || typeof cur !== "number") return null;
  return Math.round((cur - prev) * 10) / 10;
}

function deltaMarkup(delta) {
  if (delta === null) {
    return `<span class="stack-row__delta stack-row__delta--first">baseline</span>`;
  }
  if (Math.abs(delta) < 0.05) {
    return `<span class="stack-row__delta stack-row__delta--flat">no change</span>`;
  }
  const up   = delta > 0;
  const sign = up ? "+" : "−";
  return `<span class="stack-row__delta stack-row__delta--${up ? "up" : "down"}">${up ? "▲" : "▼"} ${sign}${Math.abs(delta)}</span>`;
}

function renderHistory() {
  const history = loadHistory();
  const container = $("#sessionHistory");
  if (!container) return;

  container.innerHTML = "";

  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "No previous sessions yet. Complete an analysis to start tracking your progress.";
    container.appendChild(empty);
    return;
  }

  // ── Progress bar chart ──
  const scores = history.map(h => h.overall_score);
  const labels = history.map((h, i) => `S${i + 1}`);

  const chart = document.createElement("div");
  chart.className = "history-chart";
  chart.innerHTML = `
    <div class="history-chart__label">📈 Progress over ${history.length} session(s)</div>
    <div class="history-chart__bars">
      ${scores.map((s, i) => `
        <div
          class="history-chart__bar"
          title="${labels[i]}: ${s}/100"
          style="
            height:${Math.max(8, (s / 100) * 70)}px;
            background:${s >= 75 ? 'var(--confidence)' : s >= 55 ? 'var(--amber)' : 'var(--live)'};
          "
        >
          <span class="history-chart__bar-val">${s}</span>
        </div>
      `).join("")}
    </div>
    <div class="history-chart__xlabels">
      ${labels.map(l => `<div class="history-chart__xlabel">${l}</div>`).join("")}
    </div>
  `;
  container.appendChild(chart);

  // ── Session stack: newest session is the top entry ──
  const stack = document.createElement("div");
  stack.className = "history-stack";

  for (let i = history.length - 1; i >= 0; i--) {
    const h          = history[i];
    const sessionNum = i + 1;
    const band       = scoreBand(h.overall_score);
    const delta      = sessionDelta(history, i);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "stack-row";
    row.setAttribute("aria-label", `Open full details for session ${sessionNum}`);
    row.innerHTML = `
      <span class="stack-row__rank">${sessionNum}</span>
      <span class="stack-row__main">
        <span class="stack-row__date">${h.date || "Unknown date"}</span>
        <span class="stack-row__meta">${h.level || "—"} · ${h.mode || "—"}</span>
      </span>
      <span class="stack-row__trend">${deltaMarkup(delta)}</span>
      <span class="stack-row__score stack-row__score--${band}">${h.overall_score}</span>
      <span class="stack-row__chevron" aria-hidden="true">›</span>
    `;
    row.addEventListener("click", () => openSessionDetail(i));

    stack.appendChild(row);
  }

  container.appendChild(stack);

  // ── Clear button ──
  const clearBtn = document.createElement("button");
  clearBtn.className = "history-clear-btn";
  clearBtn.textContent = "Clear All History";
  clearBtn.addEventListener("click", () => {
    if (confirm("Clear all session history?")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
  });
  container.appendChild(clearBtn);
}

/* ---------------------------------------------------------------------
   Full-page session detail
   --------------------------------------------------------------------- */
function openSessionDetail(index) {
  const history = loadHistory();
  const h = history[index];
  const page = $("#sessionDetail");
  if (!h || !page) return;

  const sessionNum = index + 1;
  const band       = scoreBand(h.overall_score);
  const delta      = sessionDelta(history, index);
  const isLatest   = index === history.length - 1;

  $("#detailTitle").textContent = `Session ${sessionNum}`;
  $("#detailSubtitle").textContent = h.date || "Unknown date";

  // ── Hero: score + level + mode + trend vs previous ──
  $("#detailScore").textContent = h.overall_score;
  $("#detailScore").className = `detail-hero__score detail-hero__score--${band}`;
  $("#detailLevel").textContent  = h.level || "—";
  $("#detailMode").textContent   = h.mode  || "—";
  $("#detailDelta").innerHTML    = isLatest
    ? `<span class="stack-row__delta stack-row__delta--first">latest session</span>`
    : deltaMarkup(delta);

  // ── Metrics ──
  const metricsBox = $("#detailMetrics");
  metricsBox.innerHTML = "";
  Object.keys(METRIC_LABELS).forEach((key) => {
    const val = h.metrics?.[key];
    if (val === null || val === undefined) return;
    const isPace = key === "speaking_pace";
    const barPct = isPace ? Math.min(val, 100) : Math.min(Math.max(val, 0), 100);
    const row = document.createElement("div");
    row.className = "metric-row";
    row.innerHTML = `
      <span class="metric-row__label">${METRIC_LABELS[key]}</span>
      <span class="metric-row__track">
        <span class="metric-row__fill" style="width:${barPct}%"></span>
      </span>
      <span class="metric-row__value">${metricDisplay(key, val)}</span>
    `;
    metricsBox.appendChild(row);
  });
  if (!metricsBox.children.length) {
    metricsBox.innerHTML = `<p class="muted">No metrics recorded for this session.</p>`;
  }

  // ── Narrative sections ──
  const notes = $("#detailNotes");
  notes.innerHTML = "";

  const section = (icon, title, items, color, cls) => {
    if (!items?.length) return;
    const sec = document.createElement("div");
    sec.className = "history-card__section";
    sec.innerHTML = `<div class="history-card__sec-title history-card__sec-title--${color}">${icon} ${title}</div>`;
    items.forEach((text) => {
      const p = document.createElement("div");
      p.className = `history-card__sec-item history-card__sec-item--${cls}`;
      p.textContent = text;
      sec.appendChild(p);
    });
    notes.appendChild(sec);
  };

  section("✅", "Strengths",  h.strengths,  "green",  "green");
  section("❌", "Areas to Improve", h.weaknesses, "red", "red");

  if (h.tip || h.exercise) {
    const sec = document.createElement("div");
    sec.className = "history-card__section";
    sec.innerHTML = `<div class="history-card__sec-title history-card__sec-title--amber">💡 Coaching</div>`;
    if (h.tip) {
      const p = document.createElement("div");
      p.className = "history-card__sec-item history-card__sec-item--amber";
      p.textContent = `Tip: ${h.tip}`;
      sec.appendChild(p);
    }
    if (h.exercise) {
      const p = document.createElement("div");
      p.className = "history-card__sec-item history-card__sec-item--blue";
      p.textContent = `Exercise: ${h.exercise}`;
      sec.appendChild(p);
    }
    notes.appendChild(sec);
  }

  section("📝", "Transcript", h.transcript ? [h.transcript] : [], "muted", "muted");

  // ── Signals used ──
  const sources = $("#detailSources");
  sources.innerHTML = "";
  const used = Object.entries(h.inputs_used || {});
  if (used.length) {
    used.forEach(([key, on]) => {
      const pill = document.createElement("span");
      pill.className = "source-pill" + (on ? " is-active" : "");
      pill.textContent = key;
      sources.appendChild(pill);
    });
  }
  $("#detailSourcesBlock").hidden = used.length === 0;

  if (h.dominant_emotion) {
    $("#detailEmotion").textContent = h.dominant_emotion;
    $("#detailEmotionBlock").hidden = false;
  } else {
    $("#detailEmotionBlock").hidden = true;
  }

  // ── Prev / next navigation ──
  $("#detailPrev").disabled = index <= 0;
  $("#detailNext").disabled = index >= history.length - 1;
  page.dataset.index = String(index);

  page.hidden = false;
  document.body.classList.add("detail-open");
  window.scrollTo({ top: 0, behavior: "auto" });
  $("#detailBack").focus();
}

function closeSessionDetail() {
  const page = $("#sessionDetail");
  if (!page || page.hidden) return;
  page.hidden = true;
  document.body.classList.remove("detail-open");
}

function stepSessionDetail(delta) {
  const page = $("#sessionDetail");
  if (!page || page.hidden) return;
  const next = Number(page.dataset.index) + delta;
  const history = loadHistory();
  if (next < 0 || next >= history.length) return;
  openSessionDetail(next);
}

function wireSessionDetail() {
  const back = $("#detailBack");
  if (back) back.addEventListener("click", closeSessionDetail);
  const prev = $("#detailPrev");
  if (prev) prev.addEventListener("click", () => stepSessionDetail(-1));
  const next = $("#detailNext");
  if (next) next.addEventListener("click", () => stepSessionDetail(1));

  document.addEventListener("keydown", (e) => {
    const page = $("#sessionDetail");
    if (!page || page.hidden) return;
    if (e.key === "Escape")     closeSessionDetail();
    if (e.key === "ArrowLeft")  stepSessionDetail(-1);
    if (e.key === "ArrowRight") stepSessionDetail(1);
  });
}

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
  wireSessionDetail();
  renderHistory();
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
      const hue = 158;
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

    // Persist this session so the history stack stays up to date
    saveToHistory(result);

    renderResults(result);
    renderHistory();
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

  // ── Score + arc gauge ──
  const score = result.overall_score ?? 0;
  $("#overallScore").textContent = score;

  const path = $("#arcFill");
  const length = path.getTotalLength();
  path.style.strokeDasharray = `${length}`;
  path.style.strokeDashoffset = `${length}`;
  path.style.stroke = scoreColor(score);
  requestAnimationFrame(() => {
    const offset = length - (length * Math.min(score, 100)) / 100;
    path.style.strokeDashoffset = `${offset}`;
  });

  // ── Metrics ──
  const grid = $("#metricsGrid");
  grid.innerHTML = "";

  const metricLabels = {
    speaking_pace    : "Speaking Pace",
    filler_words     : "Filler Cleanliness",
    voice_steadiness : "Voice Steadiness",
    pause_pattern    : "Pause Pattern",
    facial_expression: "Facial Expression",
  };

  // Only show these keys, skip nulls and raw scores
  const showKeys = ['speaking_pace', 'filler_words', 'voice_steadiness', 'pause_pattern', 'facial_expression'];

  showKeys.forEach((key) => {
    const value = result.metrics?.[key];
    if (value === null || value === undefined) return;

    const label      = metricLabels[key] || key;
    const barValue   = Math.min(Math.max(value, 0), 100);
    const displayVal = key === 'speaking_pace' ? `${value} WPM` : `${value}%`;

    const row = document.createElement("div");
    row.className = "metric-row";
    row.innerHTML = `
      <span class="metric-row__label">${label}</span>
      <span class="metric-row__track">
        <span class="metric-row__fill" style="width:${barValue}%"></span>
      </span>
      <span class="metric-row__value">${displayVal}</span>
    `;
    grid.appendChild(row);
  });

  // ── Feedback: XAI + Coaching ──
  // Use a div container instead of ul/li to avoid CSS conflicts
  const feedbackContainer = $("#feedbackList");
  feedbackContainer.innerHTML = "";

  function addSection(icon, title, color, items, isText) {
    const section = document.createElement("div");
    section.style.cssText = `margin-bottom:12px;`;

    const header = document.createElement("div");
    header.style.cssText = `
      font-size:0.78rem;font-weight:600;color:${color};
      letter-spacing:0.03em;margin-bottom:6px;
      font-family:var(--font-mono);text-transform:uppercase;
    `;
    header.textContent = `${icon} ${title}`;
    section.appendChild(header);

    items.forEach(text => {
      const item = document.createElement("div");
      item.style.cssText = `
        font-size:0.86rem;
        color:var(--text-dim);
        background:var(--surface-2);
        border:1px solid var(--border);
        border-radius:var(--radius-sm);
        padding:10px 12px;
        margin-bottom:6px;
        line-height:1.5;
        ${isText ? 'color:var(--muted);font-size:0.82rem;' : ''}
      `;
      item.textContent = text;
      section.appendChild(item);
    });

    feedbackContainer.appendChild(section);
  }

  // Strengths
  const strengths = result.explanation?.strengths || [];
  if (strengths.length > 0) {
    addSection("✅", "Strengths", "var(--confidence)", strengths, false);
  }

  // Weaknesses
  const weaknesses = result.explanation?.weaknesses || [];
  if (weaknesses.length > 0) {
    addSection("❌", "Areas to Improve", "var(--live)", weaknesses, false);
  }

  // RL Coaching
  const tip      = result.coaching?.tip;
  const exercise = result.coaching?.exercise;

  if (tip || exercise) {
    const coachSection = document.createElement("div");
    coachSection.style.marginBottom = "12px";

    const coachHeader = document.createElement("div");
    coachHeader.style.cssText = `
      font-size:0.78rem;font-weight:600;color:var(--amber);
      letter-spacing:0.03em;margin-bottom:6px;
      font-family:var(--font-mono);text-transform:uppercase;
    `;
    coachHeader.textContent = "💡 Coaching (RL Agent)";
    coachSection.appendChild(coachHeader);

    if (tip) {
      const tipDiv = document.createElement("div");
      tipDiv.style.cssText = `
        font-size:0.86rem;color:var(--amber);
        background:var(--amber-soft);
        border:1px solid var(--amber);
        border-radius:var(--radius-sm);
        padding:10px 12px;margin-bottom:6px;line-height:1.5;
      `;
      tipDiv.textContent = `Tip: ${tip}`;
      coachSection.appendChild(tipDiv);
    }

    if (exercise) {
      const exDiv = document.createElement("div");
      exDiv.style.cssText = `
        font-size:0.86rem;color:#a0c4ff;
        background:rgba(160,196,255,0.08);
        border:1px solid rgba(160,196,255,0.2);
        border-radius:var(--radius-sm);
        padding:10px 12px;margin-bottom:6px;line-height:1.5;
      `;
      exDiv.textContent = `Exercise: ${exercise}`;
      coachSection.appendChild(exDiv);
    }

    feedbackContainer.appendChild(coachSection);
  }

  // Transcript
  if (result.transcript) {
    addSection("📝", "Transcript", "var(--muted)", [result.transcript], true);
  }

  // Mode badge
  const modeBadge = document.createElement("div");
  modeBadge.style.cssText = "font-size:0.72rem;color:var(--muted);margin-top:4px;font-family:var(--font-mono);";
  modeBadge.textContent = `Mode: ${result.mode}`;
  feedbackContainer.appendChild(modeBadge);

  // ── Sources ──
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
