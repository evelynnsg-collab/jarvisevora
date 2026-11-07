// Evora Web — interface de voz no navegador.
// Reconhecimento de fala e voz usam as APIs nativas do navegador (melhor no Chrome e no Edge).
// As respostas vêm de /api/chat, que fala com o Gemini no servidor.

const $ = (id) => document.getElementById(id);
const els = {
  body: document.body,
  statusText: $("statusText"),
  log: $("log"),
  form: $("form"),
  input: $("input"),
  mic: $("micBtn"),
  settingsBtn: $("settingsBtn"),
  settings: $("settings"),
  voiceSelect: $("voiceSelect"),
  styleSelect: $("styleSelect"),
  fxToggle: $("fxToggle"),
  rate: $("rate"),
  rateOut: $("rateOut"),
  speakToggle: $("speakToggle"),
  convoToggle: $("convoToggle"),
  testVoice: $("testVoice"),
  clearBtn: $("clearBtn"),
  hint: $("supportHint"),
  canvas: $("holo"),
};

// ── Armazenamento local (pode falhar em modo privado) ─────────────────────
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignora */ }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignora */ } },
};

const prefs = Object.assign(
  { voice: "", rate: 1, speak: true, convo: false, style: "jarvis", fx: true },
  store.get("evora.prefs", {})
);
let history = store.get("evora.history", []);
let accessCode = store.get("evora.code", "");

// ── Estado ────────────────────────────────────────────────────────────────
const STATUS = {
  idle: "Online",
  listening: "Ouvindo…",
  thinking: "Pensando…",
  speaking: "Falando…",
  error: "Erro",
  offline: "Sem chave",
};
let state = "idle";
const CMD = {
  idle: "EVORA PRONTA",
  listening: "OUVINDO…",
  thinking: "PROCESSANDO…",
  speaking: "FALANDO…",
  error: "VERIFICAR",
  offline: "SEM CHAVE",
};
function setState(s, label) {
  state = s;
  els.body.dataset.state = s === "offline" ? "error" : s;
  els.statusText.textContent = label || STATUS[s] || s;
  const cmd = $("cmdState");
  if (cmd) cmd.textContent = label && s !== "idle" ? label.toUpperCase() : CMD[s] || s.toUpperCase();
}

// ── Conversa na tela ──────────────────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function renderText(text) {
  // Blocos de código ``` viram <pre>; o resto é texto simples.
  const parts = text.split(/```[a-zA-Z0-9_-]*\n?/);
  return parts
    .map((p, i) => (i % 2 ? `<pre><code>${escapeHtml(p.replace(/\n$/, ""))}</code></pre>` : escapeHtml(p.replace(/\*\*(.+?)\*\*/g, "$1"))))
    .join("");
}
function addMessage(role, text, extraClass = "") {
  const div = document.createElement("div");
  div.className = `msg ${role} ${extraClass}`.trim();
  div.innerHTML = renderText(text);
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
  return div;
}
function renderHistory() {
  els.log.innerHTML = "";
  for (const m of history) addMessage(m.role, m.text);
}

// ── Voz (síntese) ─────────────────────────────────────────────────────────
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
let voices = [];
const FEMALE_HINTS = /francisca|thalita|luciana|maria|vit[oó]ria|raquel|helo[ií]sa|camila|fernanda|leticia|google portugu[eê]s do brasil/i;

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^pt/i.test(v.lang));
  voices.sort((a, b) => {
    const score = (v) => (/pt[-_]BR/i.test(v.lang) ? 4 : 0) + (FEMALE_HINTS.test(v.name) ? 2 : 0) + (/natural|online|neural/i.test(v.name) ? 1 : 0);
    return score(b) - score(a);
  });
  els.voiceSelect.innerHTML = "";
  if (!voices.length) {
    const o = document.createElement("option");
    o.textContent = "Voz padrão do navegador";
    o.value = "";
    els.voiceSelect.appendChild(o);
    return;
  }
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    els.voiceSelect.appendChild(o);
  }
  if (prefs.voice && voices.some((v) => v.name === prefs.voice)) els.voiceSelect.value = prefs.voice;
  else els.voiceSelect.value = voices[0].name;
}

function speechText(text) {
  return text
    .replace(/```[\s\S]*?```/g, " (o código está na tela) ")
    .replace(/https?:\/\/\S+/g, " link na tela ")
    .replace(/[*_#>`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function chunk(text) {
  // O Chrome corta falas longas; dividimos em frases de até ~200 caracteres.
  const sentences = text.match(/[^.!?;:]+[.!?;:]*\s*/g) || [text];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > 200 && cur) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Voz do navegador (feminina por padrão; masculina quando é o fallback do Jarvis).
const MALE_HINTS = /ant[oô]nio|daniel|ricardo|thiago|fabio|f[aá]bio|donato|julio|j[uú]lio|humberto|valerio|male/i;
function browserSpeak(text, { male = false } = {}) {
  return new Promise((resolve) => {
    if (!synth) return resolve();
    synth.cancel();
    const pieces = chunk(speechText(text));
    if (!pieces.length) return resolve();
    let voice = voices.find((v) => v.name === els.voiceSelect.value) || voices[0];
    if (male) voice = voices.find((v) => MALE_HINTS.test(v.name)) || voice;
    setState("speaking");
    let i = 0;
    const next = () => {
      if (i >= pieces.length || speakToken.cancelled) { holo.level = 0; return resolve(); }
      const u = new SpeechSynthesisUtterance(pieces[i++]);
      u.lang = voice?.lang || "pt-BR";
      if (voice) u.voice = voice;
      u.rate = prefs.rate;
      u.pitch = male ? 0.8 : 1.05;
      u.onboundary = () => { holo.kick(); };
      u.onend = next;
      u.onerror = () => resolve();
      synth.speak(u);
    };
    next();
  });
}

// ── Voz "Jarvis": áudio do Gemini TTS + efeito de IA no Web Audio ────────────
let audioCtx = null;
let analyser = null;
let currentSource = null;
let speakToken = { cancelled: false };

function ensureAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { audioCtx = null; }
  return audioCtx;
}

// Cadeia de efeito: tira o grave embolado, realça a presença e soma um eco
// curtíssimo (12 ms) que dá o timbre "metálico" de voz sintetizada.
function buildChain(ctx, input) {
  if (!prefs.fx) { input.connect(analyser); return; }
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 110;
  const presence = ctx.createBiquadFilter(); presence.type = "peaking"; presence.frequency.value = 3200; presence.Q.value = 0.9; presence.gain.value = 4;
  const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 220; low.gain.value = 2;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -22; comp.ratio.value = 4;
  const dry = ctx.createGain(); dry.gain.value = 0.85;
  const delay = ctx.createDelay(0.1); delay.delayTime.value = 0.012;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  const wet = ctx.createGain(); wet.gain.value = 0.3;
  const out = ctx.createGain(); out.gain.value = 1.05;
  input.connect(hp); hp.connect(low); low.connect(presence); presence.connect(comp);
  comp.connect(dry); dry.connect(out);
  comp.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(out);
  out.connect(analyser);
}

async function fetchTts(text) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(accessCode ? { "x-evora-code": accessCode } : {}) },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  const buf = await res.arrayBuffer();
  return audioCtx.decodeAudioData(buf);
}

function ttsChunks(text) {
  // Pedaços de até ~450 caracteres: o primeiro chega rápido e o resto é buscado enquanto ele toca.
  const out = [];
  let cur = "";
  for (const s of chunk(text)) {
    if ((cur + " " + s).length > 450 && cur) { out.push(cur.trim()); cur = ""; }
    cur += " " + s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function playBuffer(buffer, token) {
  return new Promise((resolve) => {
    if (token.cancelled) return resolve();
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = prefs.rate;
    buildChain(audioCtx, src);
    currentSource = src;
    src.onended = () => { if (currentSource === src) currentSource = null; resolve(); };
    src.start();
  });
}

let ttsWarned = false;
async function jarvisSpeak(text, token) {
  const clean = speechText(text);
  if (!clean || !ensureAudio()) return browserSpeak(text, { male: true });
  const parts = ttsChunks(clean);
  setState("thinking", "Preparando a voz…");
  let pending = fetchTts(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    let buffer;
    try {
      buffer = await pending;
    } catch {
      if (token.cancelled) return;
      if (!ttsWarned) {
        ttsWarned = true;
        addMessage("system", "A voz do Gemini não respondeu agora (provavelmente cota). Usando a voz do navegador por enquanto.");
      }
      return browserSpeak(parts.slice(i).join(" "), { male: true });
    }
    if (token.cancelled) return;
    if (i + 1 < parts.length) pending = fetchTts(parts[i + 1]);
    setState("speaking");
    await playBuffer(buffer, token);
    if (token.cancelled) return;
  }
}

async function speak(text) {
  if (!prefs.speak) return;
  stopSpeaking();
  const token = (speakToken = { cancelled: false });
  if (prefs.style === "jarvis") await jarvisSpeak(text, token);
  else await browserSpeak(text);
  holo.level = 0;
}
function stopSpeaking() {
  speakToken.cancelled = true;
  if (currentSource) { try { currentSource.stop(); } catch { /* já parou */ } currentSource = null; }
  if (synth) synth.cancel();
}

// ── Reconhecimento de fala ────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let interimEl = null;

function startListening() {
  if (!SR) {
    addMessage("system", "Este navegador não reconhece fala. Use o Chrome ou o Edge, ou digite sua mensagem.");
    return;
  }
  stopSpeaking();
  if (recog) { recog.abort(); recog = null; }
  recog = new SR();
  recog.lang = "pt-BR";
  recog.interimResults = true;
  recog.continuous = false;
  recog.maxAlternatives = 1;
  let finalText = "";

  recog.onstart = () => setState("listening");
  recog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    holo.kick(0.5);
    const shown = (finalText + interim).trim();
    if (shown) {
      if (!interimEl) interimEl = addMessage("user", shown, "interim");
      else interimEl.textContent = shown;
      els.log.scrollTop = els.log.scrollHeight;
    }
  };
  recog.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      addMessage("system error", "O microfone foi bloqueado. Libere o acesso no cadeado da barra de endereço.");
      sys.mic = false; refreshSystem();
    } else if (e.error === "no-speech") {
      // silêncio: só volta ao normal
    } else if (e.error !== "aborted") {
      addMessage("system error", `Não consegui ouvir (${e.error}).`);
    }
  };
  recog.onend = () => {
    recog = null;
    if (interimEl) { interimEl.remove(); interimEl = null; }
    const text = finalText.trim();
    if (text) send(text);
    else if (state === "listening") setState("idle");
  };
  try { recog.start(); } catch { setState("idle"); }
}
function stopListening() {
  if (recog) recog.stop();
}

// ── Conversa com o servidor ───────────────────────────────────────────────
let busy = false;

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  stopSpeaking();
  history.push({ role: "user", text });
  store.set("evora.history", history);
  addMessage("user", text);
  setState("thinking");
  const t0 = performance.now();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessCode ? { "x-evora-code": accessCode } : {}) },
      body: JSON.stringify({ messages: history.slice(-30), voiceStyle: prefs.style }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && data.code === "LOCKED") {
      history.pop();
      store.set("evora.history", history);
      els.log.lastElementChild?.remove();
      const code = window.prompt("Esta Evora é protegida. Digite o código de acesso:");
      busy = false;
      if (code) { accessCode = code.trim(); store.set("evora.code", accessCode); return send(text); }
      setState("idle");
      return;
    }
    if (!res.ok) {
      history.pop();
      store.set("evora.history", history);
      addMessage("system error", (data.error || `Erro ${res.status}.`) + (data.detail ? `\nDetalhe do Google: ${data.detail}` : ""));
      setState(data.code === "NO_KEY" ? "offline" : "error");
      busy = false;
      return;
    }

    recordPerf(performance.now() - t0);
    history.push({ role: "model", text: data.text });
    if (history.length > 60) history = history.slice(-60);
    store.set("evora.history", history);
    addMessage("model", data.text);
    busy = false;
    await speak(data.text);
    setState("idle");
    if (prefs.convo && SR && state === "idle") startListening();
  } catch {
    history.pop();
    store.set("evora.history", history);
    addMessage("system error", "Sem conexão com o servidor. Verifique a internet e tente de novo.");
    setState("error");
    busy = false;
  }
}

// ── Holograma ─────────────────────────────────────────────────────────────
const holo = (() => {
  const c = els.canvas;
  const ctx = c.getContext("2d");
  const BARS = 72;
  const bars = new Float32Array(BARS);
  let w = 0, h = 0, dpr = 1, t = 0;
  const api = {
    level: 0,
    kick(amount = 1) { api.level = Math.min(1, api.level + 0.55 * amount); },
  };
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    w = r.width; h = r.height;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function arc(r, start, len, width, alpha) {
    ctx.beginPath();
    ctx.arc(0, 0, r, start, start + len);
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(83,224,255,${alpha})`;
    ctx.stroke();
  }
  function frame() {
    t += reduce ? 0 : 1 / 60;
    const speaking = state === "speaking";
    const thinking = state === "thinking";
    const listening = state === "listening";
    // nível de "áudio": decai sozinho; enquanto fala, recebe ruído para parecer voz
    if (speaking && currentSource && analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let k = 2; k < 48; k++) sum += data[k];
      api.level = Math.max(api.level, Math.min(1, (sum / 46 / 255) * 1.8));
    } else if (speaking) api.level = Math.max(api.level, 0.25 + 0.35 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1)));
    api.level *= 0.94;

    ctx.clearRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.34;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.shadowColor = "#53e0ff";
    ctx.shadowBlur = 14;

    // núcleo
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.7);
    glow.addColorStop(0, `rgba(83,224,255,${0.18 + api.level * 0.25})`);
    glow.addColorStop(1, "rgba(83,224,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2); ctx.fill();

    // anéis giratórios
    const spin = thinking ? 2.4 : listening ? 1.2 : 0.5;
    ctx.save(); ctx.rotate(t * 0.6 * spin);
    arc(R * 0.62, 0, Math.PI * 1.3, 2, 0.75);
    arc(R * 0.62, Math.PI * 1.45, Math.PI * 0.4, 2, 0.35);
    ctx.restore();
    ctx.save(); ctx.rotate(-t * 0.35 * spin);
    for (let i = 0; i < 6; i++) arc(R * 0.78, (i * Math.PI) / 3, Math.PI / 5, 4, 0.55);
    ctx.restore();
    ctx.save(); ctx.rotate(t * 0.18 * spin);
    arc(R * 1.18, 0, Math.PI * 0.5, 1.5, 0.4);
    arc(R * 1.18, Math.PI, Math.PI * 0.7, 1.5, 0.25);
    ctx.restore();
    // arcos laranja externos, como no painel
    ctx.save(); ctx.rotate(-t * 0.12 * spin);
    ctx.shadowColor = "#ffa53a";
    for (const [a0, len] of [[0.15, 0.55], [Math.PI * 0.9, 0.35], [Math.PI * 1.45, 0.25]]) {
      ctx.beginPath(); ctx.arc(0, 0, R * 1.3, a0, a0 + len);
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,165,58,.7)"; ctx.stroke();
    }
    ctx.shadowColor = "#53e0ff";
    ctx.restore();
    // anel tracejado externo
    ctx.save(); ctx.rotate(t * 0.05);
    ctx.setLineDash([2, 9]); arc(R * 1.42, 0, Math.PI * 2, 2, 0.35); ctx.setLineDash([]);
    ctx.restore();

    // barras de áudio em volta
    for (let i = 0; i < BARS; i++) {
      const target = api.level * (0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + t * 9))) + (listening ? 0.08 : 0.02);
      bars[i] += (target - bars[i]) * 0.25;
      const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
      const r0 = R * 0.9;
      const r1 = r0 + 4 + bars[i] * R * 0.38;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = `rgba(83,224,255,${0.35 + bars[i] * 0.6})`;
      ctx.stroke();
    }

    // varredura enquanto pensa
    if (thinking) {
      ctx.rotate(t * 3);
      const g = ctx.createLinearGradient(0, 0, R * 1.05, 0);
      g.addColorStop(0, "rgba(255,181,71,0)");
      g.addColorStop(1, "rgba(255,181,71,.55)");
      ctx.strokeStyle = g; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R * 1.05, 0); ctx.stroke();
    }
    ctx.restore();
    requestAnimationFrame(frame);
  }
  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);
  return api;
})();

// ── Ligações da interface ─────────────────────────────────────────────────
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  ensureAudio();
  const text = els.input.value;
  els.input.value = "";
  send(text);
});

els.mic.addEventListener("click", () => {
  ensureAudio();
  if (state === "listening") stopListening();
  else if (state === "speaking") { stopSpeaking(); setState("idle"); startListening(); }
  else if (!busy) startListening();
});

// Atalho: segurar a barra de espaço fora do campo de texto também abre o microfone.
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== els.input && !e.repeat && state !== "listening") {
    e.preventDefault();
    els.mic.click();
  }
  if (e.key === "Escape") { stopSpeaking(); stopListening(); if (!busy) setState("idle"); }
});

els.settingsBtn.addEventListener("click", () => {
  const open = els.settings.hidden;
  els.settings.hidden = !open;
  els.settingsBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (!els.settings.hidden && !els.settings.contains(e.target) && !els.settingsBtn.contains(e.target)) {
    els.settings.hidden = true;
    els.settingsBtn.setAttribute("aria-expanded", "false");
  }
});

function savePrefs() { store.set("evora.prefs", prefs); }
els.voiceSelect.addEventListener("change", () => { prefs.voice = els.voiceSelect.value; savePrefs(); });
els.rate.value = prefs.rate;
els.rateOut.textContent = Number(prefs.rate).toFixed(2);
els.rate.addEventListener("input", () => {
  prefs.rate = Number(els.rate.value);
  els.rateOut.textContent = prefs.rate.toFixed(2);
  savePrefs();
});
els.styleSelect.value = prefs.style;
els.fxToggle.checked = prefs.fx;
function syncStyleUi() { $("voiceField").style.display = prefs.style === "browser" ? "" : "none"; }
syncStyleUi();
els.styleSelect.addEventListener("change", () => { prefs.style = els.styleSelect.value; ttsWarned = false; syncStyleUi(); savePrefs(); refreshSystem(); });
els.fxToggle.addEventListener("change", () => { prefs.fx = els.fxToggle.checked; savePrefs(); });
els.speakToggle.checked = prefs.speak;
els.speakToggle.addEventListener("change", () => { prefs.speak = els.speakToggle.checked; if (!prefs.speak) stopSpeaking(); savePrefs(); });
els.convoToggle.checked = prefs.convo;
els.convoToggle.addEventListener("change", () => { prefs.convo = els.convoToggle.checked; savePrefs(); refreshSystem(); });
els.testVoice.addEventListener("click", async () => {
  const was = prefs.speak; prefs.speak = true;
  ensureAudio();
  await speak(prefs.style === "jarvis" ? "Boa noite. Todos os sistemas estão operacionais. Estou pronto." : "Oi, eu sou a Evora. Estou pronta.");
  prefs.speak = was; setState("idle");
});
els.clearBtn.addEventListener("click", () => {
  history = [];
  store.del("evora.history");
  els.log.innerHTML = "";
  stopSpeaking();
  addMessage("system", "Conversa apagada.");
  setState("idle");
});

// ── Início ────────────────────────────────────────────────────────────────
if (synth) {
  loadVoices();
  synth.onvoiceschanged = loadVoices;
}
const missing = [];
if (!SR) missing.push("reconhecimento de fala");
if (!synth) missing.push("voz");
els.hint.textContent = missing.length
  ? `Este navegador não oferece ${missing.join(" nem ")}. Para usar por voz, abra no Chrome ou no Edge.`
  : "Dica: a barra de espaço abre o microfone; Esc interrompe a fala.";

renderHistory();
if (!history.length) addMessage("system", "Toque no microfone ou digite para falar com a Evora.");

fetch("/api/chat")
  .then((r) => r.json())
  .then((info) => {
    sys.gemini = Boolean(info.configured);
    refreshSystem();
    if (!info.configured) {
      setState("offline");
      addMessage("system error", "A Evora ainda não tem a chave do Gemini. Adicione GEMINI_API_KEY nas variáveis de ambiente do projeto no Vercel e faça um novo deploy.");
    } else {
      setState("idle");
    }
  })
  .catch(() => setState("idle"));


// ── Painel (relógio, menu, status, módulos, desempenho, onda) ──────────────
const clockEl = $("clock");
function tick() {
  clockEl.textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });
}
tick();
setInterval(tick, 1000);

document.querySelectorAll(".menu button[data-action]").forEach((btn) => {
  if (btn.id === "settingsBtn") return;
  btn.addEventListener("click", () => {
    document.querySelectorAll(".menu button").forEach((b) => b.classList.toggle("active", b === btn));
    const action = btn.dataset.action;
    if (action === "assistente") { ensureAudio(); els.mic.click(); return; }
    if (btn.dataset.prompt) {
      els.input.value = btn.dataset.prompt;
      els.input.focus();
      els.input.setSelectionRange(els.input.value.length, els.input.value.length);
      return;
    }
    els.log.scrollTop = els.log.scrollHeight;
    els.input.focus();
  });
});

const sys = { gemini: null, mic: Boolean(SR), rede: navigator.onLine };
let storageOk = true;
try { localStorage.setItem("evora.t", "1"); localStorage.removeItem("evora.t"); } catch { storageOk = false; }

function refreshSystem() {
  const voiceOk = prefs.style === "jarvis" ? sys.gemini !== false : Boolean(synth);
  const rows = {
    gemini: sys.gemini == null ? null : sys.gemini,
    voz: voiceOk,
    mic: sys.mic,
    rede: sys.rede,
  };
  let ok = 0, total = 0;
  document.querySelectorAll("#sysBars li").forEach((li) => {
    const v = rows[li.dataset.key];
    const known = v !== null;
    li.classList.toggle("off", known && !v);
    li.querySelector("b").style.width = !known ? "30%" : v ? "100%" : "12%";
    li.querySelector("em").textContent = !known ? "…" : v ? "OK" : "OFF";
    if (known) { total++; if (v) ok++; }
  });
  const pct = total ? Math.round((ok / total) * 100) : 0;
  $("gauge").style.setProperty("--p", pct);
  $("gaugeVal").textContent = `${pct}%`;
  const label = $("sysLabel");
  label.textContent = !total ? "Verificando" : pct === 100 ? "Operacional" : pct >= 50 ? "Parcial" : "Atenção";
  label.classList.toggle("warn", total > 0 && pct < 100);

  const mods = [
    ["IA conversacional", sys.gemini !== false],
    ["Pesquisa na web", sys.gemini !== false],
    [prefs.style === "jarvis" ? "Voz Jarvis" : "Voz do navegador", voiceOk],
    ["Fala pelo microfone", sys.mic],
    ["Modo conversa", prefs.convo],
    ["Memória da conversa", storageOk],
    ["Análise de dados", sys.gemini !== false],
  ];
  $("modules").innerHTML = mods
    .map(([name, on]) => `<li class="${on ? "" : "off"}">${escapeHtml(name)}</li>`)
    .join("");
}
window.addEventListener("online", () => { sys.rede = true; refreshSystem(); });
window.addEventListener("offline", () => { sys.rede = false; refreshSystem(); });
refreshSystem();

// Desempenho: tempo real das últimas respostas da IA.
const perfData = store.get("evora.perf", []);
function recordPerf(ms) {
  perfData.push(Math.round(ms));
  while (perfData.length > 16) perfData.shift();
  store.set("evora.perf", perfData);
  drawPerf();
}
function drawPerf() {
  const c = $("perf");
  if (!c || !c.offsetParent) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(83,224,255,.12)"; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (h * i) / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  const note = $("perfNote");
  if (!perfData.length) { note.textContent = "Aguardando a primeira resposta."; return; }
  const max = Math.max(...perfData, 2000);
  const n = 16, bw = w / n;
  perfData.forEach((v, i) => {
    const bh = Math.max(3, (v / max) * (h - 10));
    const x = (n - perfData.length + i) * bw;
    const g = ctx.createLinearGradient(0, h - bh, 0, h);
    g.addColorStop(0, "rgba(83,224,255,.9)"); g.addColorStop(1, "rgba(83,224,255,.15)");
    ctx.fillStyle = g;
    ctx.fillRect(x + 2, h - bh, bw - 4, bh);
  });
  ctx.beginPath();
  perfData.forEach((v, i) => {
    const x = (n - perfData.length + i) * bw + bw / 2;
    const y = h - Math.max(3, (v / max) * (h - 10));
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = "#ffa53a"; ctx.lineWidth = 1.6; ctx.stroke();
  const last = perfData[perfData.length - 1];
  const avg = perfData.reduce((a, b) => a + b, 0) / perfData.length;
  note.textContent = `Última: ${(last / 1000).toFixed(1)} s · média: ${(avg / 1000).toFixed(1)} s`;
}
window.addEventListener("resize", drawPerf);
drawPerf();

// Onda de áudio da barra de comando.
(() => {
  const c = $("wave");
  if (!c) return;
  const ctx = c.getContext("2d");
  let t = 0;
  function frame() {
    t += 1 / 60;
    if (c.offsetParent) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const N = 34, gap = w / N;
      const lvl = Math.max(holo.level, state === "listening" ? 0.25 : 0.06);
      for (let i = 0; i < N; i++) {
        const env = Math.sin((i / (N - 1)) * Math.PI);
        const amp = env * (0.15 + lvl * Math.abs(Math.sin(i * 1.9 + t * 8)) * 0.85);
        const bh = Math.max(2, amp * (h - 14));
        ctx.fillStyle = `rgba(83,224,255,${0.4 + amp * 0.6})`;
        ctx.fillRect(i * gap + gap * 0.3, (h - bh) / 2, gap * 0.4, bh);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
