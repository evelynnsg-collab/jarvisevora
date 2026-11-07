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
  { voice: "", rate: 1, speak: true, handsFree: true, style: "jarvis", fx: true },
  store.get("evora.prefs", {})
);
let history = store.get("evora.history", []);
let accessCode = store.get("evora.code", "");

// ── Estado ────────────────────────────────────────────────────────────────
const STATUS = {
  idle: "ONLINE",
  listening: "OUVINDO",
  thinking: "PENSANDO",
  speaking: "FALANDO",
  error: "ERRO",
  offline: "SEM CHAVE",
};
let state = "idle";
const CMD = {
  idle: "EVORA PRONTA",
  listening: "OUVINDO…",
  thinking: "PENSANDO…",
  speaking: "FALANDO…",
  error: "VERIFICAR",
  offline: "SEM CHAVE",
};
function setState(s, label) {
  state = s;
  els.body.dataset.state = s === "offline" ? "error" : s;
  els.statusText.textContent = label || STATUS[s] || s;
  const cmd = $("cmdState");
  if (cmd) cmd.textContent = label ? label.toUpperCase() : CMD[s] || s.toUpperCase();
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
  const wrap = document.getElementById("logWrap");
  if (wrap && wrap.classList.contains("hidden") && role !== "user") {
    wrap.classList.remove("hidden");
    const t = document.getElementById("logToggle");
    if (t) t.textContent = "–";
  }
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
  // O primeiro pedaço é só a primeira frase (curta = a voz começa mais cedo);
  // os seguintes têm até ~400 caracteres e são gerados enquanto o anterior toca.
  const out = [];
  let cur = "";
  for (const s of chunk(text)) {
    const limit = out.length === 0 ? 140 : 400;
    if ((cur + " " + s).length > limit && cur) { out.push(cur.trim()); cur = ""; }
    cur += " " + s;
    if (out.length === 0 && /[.!?]\s*$/.test(cur) && cur.length > 25) { out.push(cur.trim()); cur = ""; }
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
  setState("thinking");
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
  let retryDelay = 250;
  recog.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      addMessage("system error", "O microfone foi bloqueado. Libere o acesso no cadeado da barra de endereço e recarregue a página.");
      micBlocked = true;
      sys.mic = false; refreshSystem();
    } else if (e.error === "no-speech" || e.error === "aborted") {
      // silêncio ou interrupção: o ciclo mãos-livres volta a ouvir
    } else {
      retryDelay = 2000; // rede/áudio: espera um pouco antes de tentar de novo
      if (e.error !== "network") addMessage("system error", `Não consegui ouvir (${e.error}).`);
    }
  };
  recog.onend = () => {
    recog = null;
    if (interimEl) { interimEl.remove(); interimEl = null; }
    const text = finalText.trim();
    if (text) send(text);
    else {
      // no mãos-livres o status continua "ouvindo" entre um reinício e outro
      if (state === "listening" && !loopActive()) setState("idle");
      keepListening(retryDelay);
    }
  };
  try { recog.start(); } catch { setState("idle"); }
}
function stopListening() {
  if (recog) recog.stop();
}

// ── Mãos-livres (AUTO-START) ───────────────────────────────────────────────
// Depois de ativada, a Evora fica num ciclo: ouve → pensa → fala → volta a ouvir.
// O microfone fica fechado enquanto ela fala, para não ouvir a própria voz.
let armed = false;      // o navegador exige um toque antes de liberar áudio e microfone
let paused = false;     // microfone pausado pelo usuário
let micBlocked = false;
let loopTimer = null;
function loopActive() {
  return armed && prefs.handsFree && !paused && !micBlocked && Boolean(SR);
}
function keepListening(delay = 250) {
  clearTimeout(loopTimer);
  if (!loopActive()) return;
  loopTimer = setTimeout(() => {
    if (loopActive() && !recog && !busy && state !== "speaking" && state !== "thinking") startListening();
  }, delay);
}
function arm() {
  if (armed) return;
  armed = true;
  ensureAudio();
  document.getElementById("activate")?.remove();
}

// ── Conversa com o servidor ───────────────────────────────────────────────
let busy = false;

async function postChat() {
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(accessCode ? { "x-evora-code": accessCode } : {}) },
    body: JSON.stringify({ messages: history.slice(-30), voiceStyle: prefs.style }),
  });
}

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
    let res = await postChat();
    // 504 = o Vercel cortou por tempo, 502/503 = falha momentânea: tenta mais uma vez sozinha
    if ([502, 503, 504].includes(res.status)) {
      setState("thinking", "TENTANDO DE NOVO…");
      await new Promise((r) => setTimeout(r, 1200));
      res = await postChat();
    }
    const data = await res.json().catch(() => ({}));
    if (!data.error && !res.ok) {
      data.error = res.status === 504
        ? "O Gemini demorou demais para responder. Tente falar de novo."
        : `Erro ${res.status} no servidor.`;
    }

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
      const detail = data.detail && res.status !== 429 ? `\nDetalhe: ${String(data.detail).slice(0, 180)}` : "";
      addMessage("system error", (data.error || `Erro ${res.status}.`) + detail);
      setState(data.code === "NO_KEY" ? "offline" : "error");
      busy = false;
      if (data.code !== "NO_KEY") keepListening(3000);
      return;
    }

    recordPerf(performance.now() - t0);
    history.push({ role: "model", text: data.text });
    if (history.length > 60) history = history.slice(-60);
    store.set("evora.history", history);
    addMessage("model", data.text);
    busy = false;
    showSources(data);
    await speak(data.text);
    if (state === "speaking" || state === "thinking") setState("idle");
    keepListening(150);
  } catch {
    history.pop();
    store.set("evora.history", history);
    addMessage("system error", "Sem conexão com o servidor. Verifique a internet e tente de novo.");
    setState("error");
    busy = false;
    keepListening(3000);
  }
}

function showSources(data) {
  if (!data || (!data.queries?.length && !data.sources?.length)) return;
  window.__evoraSearchHit?.();
  const div = document.createElement("div");
  div.className = "msg search";
  const q = (data.queries || []).join(" · ");
  const links = (data.sources || [])
    .map((s) => `<a href="${escapeHtml(s.uri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || "fonte")}</a>`)
    .join("");
  div.innerHTML = `<b>PESQUISA${q ? " — " + escapeHtml(q.toUpperCase()) : ""}</b>${links ? `<span class="links">${links}</span>` : ""}`;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
}

// ── Holograma ─────────────────────────────────────────────────────────────
const holo = (() => {
  // Núcleo holográfico: luz aditiva, anéis finos, espectro real da voz e partículas.
  const c = els.canvas;
  const ctx = c.getContext("2d");
  let w = 0, h = 0, dpr = 1, t = 0, last = performance.now();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BINS = 96;
  const spec = new Float32Array(BINS);
  const api = {
    level: 0,
    spec,
    kick(amount = 1) { api.level = Math.min(1, api.level + 0.55 * amount); },
  };
  const freq = new Uint8Array(256);
  const parts = [];
  const MAX_PARTS = 900;

  // sprite de brilho pré-desenhado (muito mais leve que shadowBlur em cada partícula)
  const glowSprite = (() => {
    const s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(235,252,255,1)");
    grd.addColorStop(0.18, "rgba(150,235,255,.9)");
    grd.addColorStop(0.45, "rgba(60,190,255,.35)");
    grd.addColorStop(1, "rgba(30,140,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return s;
  })();
  const amberSprite = (() => {
    const s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,245,220,1)");
    grd.addColorStop(0.25, "rgba(255,180,80,.8)");
    grd.addColorStop(1, "rgba(255,120,30,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return s;
  })();

  // Desenha num espaço quadrado de 640×640 (unidades da arte); se a tela esticar
  // um pouco, o canvas estica junto com a imagem e o anel continua encaixado.
  const SZ = 640;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    w = SZ; h = SZ;
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    ctx.setTransform((dpr * r.width) / SZ, 0, 0, (dpr * r.height) / SZ, 0, 0);
  }
  window.addEventListener("evora:layout", resize);

  function readSpectrum(speaking) {
    let energy = 0;
    if (speaking && currentSource && analyser) {
      analyser.getByteFrequencyData(freq);
      // bins de voz (~80 Hz a ~5 kHz), espelhados para o círculo ficar simétrico
      const half = BINS / 2;
      for (let i = 0; i < half; i++) {
        // bandas embaralhadas pelo círculo, para a voz acender o anel todo e não só um lado
        const band = (i * 13) % half;
        const idx = 2 + Math.floor(Math.pow(band / half, 1.5) * 70);
        const v = Math.min(1, (freq[idx] / 255) * (1 + 1.4 * (band / half)));
        const target = Math.pow(v, 1.3);
        spec[i] += (target - spec[i]) * (target > spec[i] ? 0.55 : 0.12);
        spec[BINS - 1 - i] = spec[i];
        energy += v;
      }
      energy = Math.min(1, (energy / half) * 1.9);
    } else {
      const fake = speaking ? 0.25 + 0.35 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1)) : 0;
      for (let i = 0; i < BINS; i++) {
        const target = fake * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.37 + t * 6)));
        spec[i] += (target - spec[i]) * 0.2;
      }
      energy = fake;
    }
    return energy;
  }

  function emit(cx, cy, R, energy, thinking) {
    const n = Math.floor(energy * energy * 16 + energy * 7 + 1);
    for (let i = 0; i < n && parts.length < MAX_PARTS; i++) {
      const bin = Math.floor(Math.random() * BINS);
      const a = (bin / BINS) * Math.PI * 2 - Math.PI / 2 + (Math.random() - 0.5) * 0.05;
      const boost = 0.4 + spec[bin] * 1.6;
      const speed = (40 + Math.random() * 130) * boost * (0.5 + energy);
      const tangent = (Math.random() - 0.5) * 40;
      const r0 = R * (1.02 + Math.random() * 0.06);
      parts.push({
        x: cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0,
        vx: Math.cos(a) * speed - Math.sin(a) * tangent,
        vy: Math.sin(a) * speed + Math.cos(a) * tangent,
        life: 0, max: 0.7 + Math.random() * 1.3,
        size: 0.6 + Math.random() * 1.3 * boost,
        amber: thinking || Math.random() < 0.06,
      });
    }
  }
  function ambient(cx, cy, R) {
    // poeira de luz flutuando devagar em volta do núcleo, sempre
    if (parts.length < 120 && Math.random() < 0.35) {
      const a = Math.random() * Math.PI * 2;
      const r0 = R * (0.9 + Math.random() * 0.6);
      parts.push({
        x: cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0,
        vx: (Math.random() - 0.5) * 8, vy: -6 - Math.random() * 10,
        life: 0, max: 2 + Math.random() * 3, size: 0.6 + Math.random() * 1.2, amber: false, dust: true,
      });
    }
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    t += reduce ? 0 : dt;
    const speaking = state === "speaking";
    const thinking = state === "thinking";
    const listening = state === "listening";

    const energy = readSpectrum(speaking);
    api.level = Math.max(api.level * 0.92, energy);

    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const half = Math.min(w, h) / 2;
    const R = half * 0.54;           // raio do anel desenhado na imagem
    const amp = api.level;

    // 1) vinheta: assenta o núcleo sobre a arte sem esconder o nome
    const shade = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.15);
    shade.addColorStop(0, "rgba(0,10,22,.35)");
    shade.addColorStop(0.8, "rgba(0,12,26,.28)");
    shade.addColorStop(1, "rgba(0,12,26,0)");
    ctx.fillStyle = shade;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.15, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // 2) bloom do núcleo, respira com a voz
    const bloomR = R * (1.05 + amp * 0.25);
    const bloom = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, bloomR);
    const base = thinking ? "255,150,60" : "60,170,255";
    bloom.addColorStop(0, `rgba(${base},${0.05 + amp * 0.18})`);
    bloom.addColorStop(0.7, `rgba(${base},${0.03 + amp * 0.12})`);
    bloom.addColorStop(1, `rgba(${base},0)`);
    ctx.fillStyle = bloom;
    ctx.beginPath(); ctx.arc(cx, cy, bloomR, 0, Math.PI * 2); ctx.fill();

    // 3) anéis segmentados finos, girando em sentidos opostos (como no desktop)
    const speed = thinking ? 2.4 : listening ? 1.3 : 0.8;
    const rgb = thinking ? "255,170,80" : "120,225,255";
    [[1.0, 1, 9, 1.4], [0.9, -1, 6, 1], [0.8, 1, 4, 2.2], [1.12, -1, 24, 0.8]].forEach(([frac, dir, segs, lw], idx) => {
      const ring = R * frac * (1 + amp * 0.03);
      const angle = (t * speed * (14 + idx * 9) * dir * Math.PI) / 180;
      const gap = idx === 3 ? 0.12 : 0.2;
      ctx.lineWidth = lw + amp * 1.2;
      for (let k = 0; k < segs; k++) {
        const start = angle + (k * Math.PI * 2) / segs;
        const flick = 0.55 + 0.45 * Math.sin(t * 3 + k * 1.3 + idx);
        ctx.strokeStyle = `rgba(${rgb},${(0.25 + 0.4 * flick) * (idx === 3 ? 0.6 : 1)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, ring, start, start + (Math.PI * 2) / segs - gap);
        ctx.stroke();
      }
    });

    // 4) varredura de radar com rastro
    const sweepA = t * (thinking ? 3 : 1.1);
    for (let k = 0; k < 18; k++) {
      const a = sweepA - k * 0.035;
      ctx.strokeStyle = `rgba(${rgb},${0.5 * (1 - k / 18)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.95, a, a + 0.035); ctx.stroke();
    }

    // 5) espectro real da voz em volta do anel
    ctx.lineCap = "round";
    for (let i = 0; i < BINS; i++) {
      const v = spec[i] + (listening ? 0.03 + 0.02 * Math.sin(t * 5 + i * 0.5) : 0);
      if (v < 0.01) continue;
      const a = (i / BINS) * Math.PI * 2 - Math.PI / 2;
      const r0 = R * 1.035;
      const r1 = r0 + R * (0.02 + v * 0.3);
      const g = ctx.createLinearGradient(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.addColorStop(0, `rgba(${rgb},.9)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1.2, R * 0.012);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }

    // 6) partículas saindo do círculo
    if (!reduce) {
      if (speaking) emit(cx, cy, R, Math.max(energy, 0.15), false);
      if (thinking && Math.random() < 0.5) emit(cx, cy, R, 0.25, true);
      ambient(cx, cy, R);
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      // leve turbulência e arrasto
      const swirl = Math.sin(p.y * 0.02 + t * 2) * 12;
      p.vx = p.vx * (1 - 0.9 * dt) + swirl * dt;
      p.vy = p.vy * (1 - 0.9 * dt) - (p.dust ? 0 : 6 * dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = 1 - p.life / p.max;
      const alpha = (p.dust ? 0.35 : 0.9) * k * Math.min(1, p.life * 8);
      const s = p.size * (p.dust ? 2.6 : 3) * (0.4 + 0.6 * k);
      ctx.globalAlpha = alpha;
      if (!p.dust) {
        // rastro fino: dá a sensação de faísca em movimento, não de bolinha
        ctx.strokeStyle = p.amber ? "rgba(255,190,110,.55)" : "rgba(150,235,255,.55)";
        ctx.lineWidth = Math.max(0.6, p.size * 0.6);
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.drawImage(p.amber ? amberSprite : glowSprite, p.x - s, p.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
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
  if (!armed) arm();
  if (recog) recog.abort();
  const text = els.input.value;
  els.input.value = "";
  send(text);
});

els.mic.addEventListener("click", () => {
  ensureAudio();
  if (!armed) { arm(); paused = false; startListening(); return; }
  if (prefs.handsFree) {
    // no modo mãos-livres o botão liga/desliga o microfone
    if (state === "speaking") { stopSpeaking(); setState("idle"); paused = false; startListening(); return; }
    paused = !paused;
    if (paused) { clearTimeout(loopTimer); if (recog) recog.abort(); setState("idle", "MIC PAUSADO"); }
    else startListening();
    return;
  }
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
els.convoToggle.checked = prefs.handsFree;
els.convoToggle.addEventListener("change", () => {
  prefs.handsFree = els.convoToggle.checked;
  savePrefs(); refreshSystem();
  if (prefs.handsFree) { paused = false; keepListening(); } else { clearTimeout(loopTimer); if (recog) recog.abort(); }
});
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
if (SR && prefs.handsFree) {
  const btn = document.createElement("button");
  btn.id = "activate";
  btn.type = "button";
  btn.className = "activate";
  btn.innerHTML = "<span>▶</span> ATIVAR EVORA<small>toque para ligar o microfone e a voz</small>";
  btn.addEventListener("click", () => { arm(); paused = false; startListening(); });
  ($("screen") || document.body).appendChild(btn);
}
if (!history.length) addMessage("system", SR && prefs.handsFree ? "Toque em ATIVAR EVORA e fale normalmente: ela ouve, responde e volta a ouvir sozinha." : "Toque no microfone ou digite para falar com a Evora.");

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
  if (!$("gauge")) return;
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
    ["Mãos-livres", prefs.handsFree],
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

// Conversa: mostrar/ocultar (botão "–" e o ícone de enquadrar da barra)
const logWrap = $("logWrap");
function toggleLog(force) {
  const hide = force ?? !logWrap.classList.contains("hidden");
  logWrap.classList.toggle("hidden", hide);
  $("logToggle").textContent = hide ? "+" : "–";
}
$("logToggle").addEventListener("click", () => toggleLog());
$("scanBtn").addEventListener("click", () => toggleLog());

// Celular ou tela em pé: a conversa e o campo de texto saem da imagem e vão para baixo dela.
const mq = window.matchMedia("(max-width: 820px), (orientation: portrait)");
const dock = $("dock"), screenEl = $("screen");
function placeDock() {
  const mobile = mq.matches;
  document.body.classList.toggle("mobile", mobile);
  if (mobile && logWrap.parentElement !== dock) {
    logWrap.classList.remove("hidden");
    dock.append(logWrap, els.form);
  } else if (!mobile && logWrap.parentElement === dock) {
    screenEl.insertBefore(logWrap, $("wave"));
    screenEl.appendChild(els.form);
  }
  els.log.scrollTop = els.log.scrollHeight;
}
mq.addEventListener("change", placeDock);
placeDock();

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
  if (!c) return;
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

// ── Camada viva sobre a arte do painel ────────────────────────────────────
// Tudo aqui é desenhado por cima da imagem, nas coordenadas dela (1377×728),
// para os painéis se mexerem como uma interface de verdade:
// scanners, globo, radares, reator do peito, módulos acendendo, medidores e
// gráficos com dados reais da página, poeira de luz e reflexo de vidro.
const fx = (() => {
  const c = $("fx");
  if (!c) return null;
  const ctx = c.getContext("2d");
  const W = 1377, H = 728;
  let sx = 1, sy = 1, dpr = 1, t = 0, lastT = performance.now();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    sx = r.width / W; sy = r.height / H;
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("evora:layout", resize);
  resize();

  // ── métricas reais da página ──
  const metrics = { cpu: 8, gpu: 10, ram: null, ia: 0 };
  let lagExpected = performance.now() + 250;
  setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - lagExpected);
    lagExpected = now + 250;
    const cpuNow = Math.min(100, 4 + lag * 1.2 + frameLoad * 40);
    metrics.cpu += (cpuNow - metrics.cpu) * 0.35;
    if (performance.memory && performance.memory.jsHeapSizeLimit) {
      metrics.ram = (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100;
    }
  }, 250);
  let frameLoad = 0, frameAvg = 16.7;

  let searchFlash = 0;
  window.__evoraSearchHit = () => { searchFlash = 1; };

  const dust = Array.from({ length: 70 }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - 0.5) * 6, vy: -2 - Math.random() * 6,
    r: 0.4 + Math.random() * 1.1, p: Math.random() * Math.PI * 2,
  }));

  // desenha direto nas coordenadas da arte; a transformação do canvas faz a escala
  const P = (x) => x;

  // brilhos pré-desenhados por cor (gradiente a cada quadro é caro)
  const sprites = {};
  function sprite(color) {
    if (sprites[color]) return sprites[color];
    const sc = document.createElement("canvas");
    sc.width = sc.height = 64;
    const g = sc.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, `rgba(${color},1)`);
    grd.addColorStop(0.35, `rgba(${color},.45)`);
    grd.addColorStop(1, `rgba(${color},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return (sprites[color] = sc);
  }
  function glowDot(x, y, r, color, a) {
    if (a <= 0.01) return;
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(sprite(color), P(x - r), P(y - r), P(r * 2), P(r * 2));
    ctx.globalAlpha = 1;
  }
  function clipRect(x, y, w, h, fn) {
    ctx.save(); ctx.beginPath(); ctx.rect(P(x), P(y), P(w), P(h)); ctx.clip(); fn(); ctx.restore();
  }
  function scanLine(x, y, w, h, period, color = "120,230,255") {
    const k = (t % period) / period;
    const yy = y + k * h;
    clipRect(x, y, w, h, () => {
      const g = ctx.createLinearGradient(0, P(yy - 14), 0, P(yy + 2));
      g.addColorStop(0, `rgba(${color},0)`);
      g.addColorStop(0.85, `rgba(${color},.22)`);
      g.addColorStop(1, `rgba(${color},.75)`);
      ctx.fillStyle = g;
      ctx.fillRect(P(x), P(yy - 14), P(w), P(16));
    });
  }
  function radar(cx, cy, r, speed, color = "110,230,255") {
    const a = t * speed;
    ctx.save();
    ctx.translate(P(cx), P(cy));
    for (let k = 0; k < 24; k++) {
      ctx.strokeStyle = `rgba(${color},${0.13 * Math.pow(1 - k / 24, 1.5)})`;
      ctx.lineWidth = P(r) * 0.9;
      ctx.beginPath(); ctx.arc(0, 0, P(r) * 0.5, a - k * 0.045, a - k * 0.045 + 0.05); ctx.stroke();
    }
    ctx.restore();
  }

  function sysScore() {
    const voiceOk = prefs.style === "jarvis" ? sys.gemini !== false : Boolean(synth);
    const vals = [sys.gemini, voiceOk, sys.mic, sys.rede].filter((v) => v !== null && v !== undefined);
    if (!vals.length) return 0;
    return Math.round((vals.filter(Boolean).length / vals.length) * 100);
  }

  const shown = { cpu: 0, gpu: 0, ram: 0, ia: 0, score: 0 };

  function draw(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    frameAvg += ((dt * 1000) - frameAvg) * 0.05;
    frameLoad = Math.max(0, Math.min(1, (frameAvg - 16.7) / 16.7));
    t += reduce ? 0 : dt;
    const lvl = holo.level || 0;
    const speaking = state === "speaking", thinking = state === "thinking", listening = state === "listening";

    ctx.setTransform(dpr * sx, 0, 0, dpr * sy, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    // ── painel do rosto: varredura + pontos de leitura
    scanLine(270, 108, 74, 104, 3.2);
    for (let i = 0; i < 6; i++) {
      const on = Math.sin(t * 3 + i * 1.7) > 0.6;
      if (on) glowDot(282 + ((i * 37) % 52), 125 + ((i * 53) % 78), 3.5, "150,240,255", 0.8);
    }
    // ── DNA: faixa de luz subindo
    clipRect(250, 236, 58, 114, () => {
      const k = 1 - (t % 2.6) / 2.6;
      const yy = 236 + k * 130 - 10;
      const g = ctx.createLinearGradient(0, P(yy - 16), 0, P(yy + 16));
      g.addColorStop(0, "rgba(120,230,255,0)"); g.addColorStop(0.5, "rgba(140,240,255,.35)"); g.addColorStop(1, "rgba(120,230,255,0)");
      ctx.fillStyle = g; ctx.fillRect(P(250), P(yy - 16), P(58), P(32));
    });
    // ── globo: meridianos girando (só na parte que não fica atrás do cabelo)
    ctx.save();
    ctx.beginPath(); ctx.arc(P(383), P(298), P(71), 0, Math.PI * 2); ctx.clip();
    ctx.beginPath(); ctx.rect(P(300), P(220), P(128), P(160)); ctx.clip();
    ctx.translate(P(383), P(298));
    ctx.lineWidth = Math.max(0.6, P(0.8));
    for (let m = 0; m < 6; m++) {
      const ph = (t * 0.35 + m / 6) % 1;
      const rx = Math.abs(Math.cos(ph * Math.PI)) * P(70);
      const front = Math.sin(ph * Math.PI) > 0;
      ctx.strokeStyle = `rgba(120,220,255,${front ? 0.28 : 0.08})`;
      ctx.beginPath(); ctx.ellipse(0, 0, Math.max(0.5, rx), P(70), 0, 0, Math.PI * 2); ctx.stroke();
    }
    const sweepX = ((t * 0.25) % 1) * P(150) - P(75);
    const sg = ctx.createLinearGradient(sweepX - P(18), 0, sweepX + P(18), 0);
    sg.addColorStop(0, "rgba(120,220,255,0)"); sg.addColorStop(0.5, "rgba(150,235,255,.18)"); sg.addColorStop(1, "rgba(120,220,255,0)");
    ctx.fillStyle = sg; ctx.fillRect(sweepX - P(18), -P(72), P(36), P(144));
    ctx.restore();

    // ── radares pequenos
    radar(287, 467, 34, 1.6);
    radar(1110, 156, 21, -2.2);
    // ── scanner do corpo (direita)
    scanLine(1152, 338, 98, 160, 4.2);

    // ── reator do peito: pulsa com a voz
    const flick = 0.9 + 0.1 * Math.sin(t * 23) * Math.sin(t * 7);
    const core = (0.22 + lvl * 0.9 + (listening ? 0.12 : 0)) * flick;
    glowDot(657, 452, 30 + lvl * 26, "120,220,255", Math.min(0.85, core));
    glowDot(657, 452, 12 + lvl * 8, "235,252,255", Math.min(0.9, core * 0.9));

    // ── módulos ativos acendendo conforme o que a Evora está fazendo
    searchFlash = Math.max(0, searchFlash - dt * 0.35);
    const active = [
      speaking || thinking, thinking, false, typeof loopActive === "function" && loopActive(),
      searchFlash > 0.02, speaking, listening,
    ];
    const rows = [148, 172, 196, 222, 247, 272, 296];
    rows.forEach((y, i) => {
      const cx = 1183 + i * 1.6;
      const on = active[i];
      const pulse = 0.5 + 0.5 * Math.sin(t * 5 + i);
      if (on) {
        const g = ctx.createLinearGradient(P(1170), 0, P(1362), 0);
        g.addColorStop(0, `rgba(80,255,160,${0.07 + pulse * 0.06})`);
        g.addColorStop(1, "rgba(80,255,160,0)");
        ctx.fillStyle = g; ctx.fillRect(P(1170), P(y - 10), P(192), P(20));
        glowDot(cx, y, 13, "90,255,160", 0.3 + pulse * 0.25);
      } else {
        glowDot(cx, y, 9, "90,255,160", 0.08 + 0.05 * Math.sin(t * 1.3 + i * 0.9));
      }
    });

    // ── poeira de luz pela tela toda
    for (const d of dust) {
      d.x += d.vx * dt; d.y += d.vy * dt; d.p += dt * 2;
      if (d.y < -5) { d.y = H + 5; d.x = Math.random() * W; }
      if (d.x < -5) d.x = W + 5; if (d.x > W + 5) d.x = -5;
      const a = 0.18 + 0.22 * Math.sin(d.p);
      if (a > 0.05) glowDot(d.x, d.y, d.r * 4, "150,225,255", a);
    }

    // ── reflexo de vidro atravessando a tela a cada ~9 s
    const cyc = (t % 9) / 9;
    if (cyc < 0.35) {
      const x = -300 + (cyc / 0.35) * (W + 600);
      ctx.save();
      ctx.translate(P(x), 0); ctx.rotate(0.35);
      const g = ctx.createLinearGradient(-P(60), 0, P(60), 0);
      g.addColorStop(0, "rgba(160,230,255,0)"); g.addColorStop(0.5, "rgba(170,235,255,.045)"); g.addColorStop(1, "rgba(160,230,255,0)");
      ctx.fillStyle = g; ctx.fillRect(-P(60), -P(200), P(120), P(H + 600));
      ctx.restore();
    }

    // ── medidores (Status do sistema) com dados reais
    ctx.globalCompositeOperation = "source-over";
    const gpuNow = Math.min(100, 6 + frameLoad * 70 + lvl * 18 + (speaking ? 6 : 0));
    metrics.gpu += (gpuNow - metrics.gpu) * 0.05;
    const iaTarget = sys.gemini === false ? 0 : thinking ? 85 + 15 * Math.abs(Math.sin(t * 4)) : speaking ? 70 + lvl * 30 : 100;
    metrics.ia += (iaTarget - metrics.ia) * 0.08;
    const target = { cpu: metrics.cpu, gpu: metrics.gpu, ram: metrics.ram ?? 0, ia: metrics.ia, score: sysScore() };
    for (const k in shown) shown[k] += (target[k] - shown[k]) * 0.08;

    const bars = [["cpu", 530], ["gpu", 560], ["ram", 590], ["ia", 619]];
    for (const [k, y] of bars) {
      const v = Math.max(0, Math.min(100, shown[k]));
      const x0 = 98, w = 80;
      ctx.fillStyle = "rgba(83,224,255,.12)";
      ctx.fillRect(P(x0), P(y - 3), P(w), P(6));
      const g = ctx.createLinearGradient(P(x0), 0, P(x0 + w), 0);
      g.addColorStop(0, "#2fb6e6"); g.addColorStop(1, "#8ff0ff");
      ctx.fillStyle = g;
      ctx.fillRect(P(x0), P(y - 3), P(w * v / 100), P(6));
      ctx.fillStyle = "rgba(83,224,255,.18)";
      ctx.fillRect(P(x0), P(y - 5), P(w * v / 100), P(10));
      ctx.font = `600 ${P(14)}px Rajdhani, sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#dff3ff";
      const label = k === "ram" && metrics.ram === null ? "—" : `${Math.round(v)}%`;
      ctx.fillText(label, P(214), P(y + 1));
    }
    // anel do status geral
    const sc = shown.score;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(83,224,255,.14)"; ctx.lineWidth = P(5);
    ctx.beginPath(); ctx.arc(P(67), P(476), P(25), 0, Math.PI * 2); ctx.stroke();
    const arcEnd = -Math.PI / 2 + (Math.PI * 2 * sc) / 100;
    ctx.strokeStyle = "rgba(83,224,255,.25)"; ctx.lineWidth = P(9);
    ctx.beginPath(); ctx.arc(P(67), P(476), P(25), -Math.PI / 2, arcEnd); ctx.stroke();
    ctx.strokeStyle = "#53e0ff"; ctx.lineWidth = P(5);
    ctx.beginPath(); ctx.arc(P(67), P(476), P(25), -Math.PI / 2, arcEnd); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillStyle = "#eaf8ff";
    ctx.font = `600 ${P(14)}px Rajdhani, sans-serif`;
    ctx.fillText(`${Math.round(sc)}%`, P(67), P(477));
    const st = sc >= 99.5 ? ["OPERACIONAL", "#5dff9c"] : sc >= 50 ? ["PARCIAL", "#ffa53a"] : ["ATENÇÃO", "#ff6b6b"];
    ctx.textAlign = "left"; ctx.fillStyle = st[1];
    ctx.font = `600 ${P(16)}px Rajdhani, sans-serif`;
    ctx.fillText(st[0], P(107), P(477));

    // ── mini espectro (painel da direita)
    const spec = holo.spec || [];
    for (let i = 0; i < 22; i++) {
      const v = (spec[(i * 4) % (spec.length || 1)] || 0) * 0.9 + 0.08 + 0.06 * Math.abs(Math.sin(t * 2 + i));
      const bh = Math.min(1, v) * 32;
      ctx.fillStyle = `rgba(120,225,255,${0.5 + Math.min(0.5, v)})`;
      ctx.fillRect(P(1279 + i * 4), P(450 - bh), P(2.4), P(bh));
    }

    // ── gráfico de performance: tempo real das respostas
    drawPerfChart();
    requestAnimationFrame(draw);
  }

  function drawPerfChart() {
    const x0 = 1152, y0 = 545, w = 212, h = 72;
    ctx.strokeStyle = "rgba(83,224,255,.1)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(P(x0), P(y0 + (h * i) / 3)); ctx.lineTo(P(x0 + w), P(y0 + (h * i) / 3)); ctx.stroke(); }
    const data = perfData.slice(-14);
    ctx.font = `600 ${P(11)}px Rajdhani, sans-serif`;
    if (!data.length) {
      ctx.fillStyle = "rgba(170,210,230,.7)"; ctx.textAlign = "center";
      ctx.fillText("AGUARDANDO A PRIMEIRA RESPOSTA", P(x0 + w / 2), P(y0 + h / 2));
      return;
    }
    const max = Math.max(...data, 3000);
    const n = 14, bw = w / n;
    const pts = data.map((v, i) => {
      const x = x0 + (n - data.length + i) * bw + bw / 2;
      return [x, y0 + h - (v / max) * (h - 6)];
    });
    data.forEach((v, i) => {
      const [x, y] = pts[i];
      const g = ctx.createLinearGradient(0, P(y), 0, P(y0 + h));
      g.addColorStop(0, "rgba(83,224,255,.75)"); g.addColorStop(1, "rgba(83,224,255,.08)");
      ctx.fillStyle = g; ctx.fillRect(P(x - bw * 0.28), P(y), P(bw * 0.56), P(y0 + h - y));
    });
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(P(x), P(y)) : ctx.moveTo(P(x), P(y))));
    ctx.strokeStyle = "rgba(83,224,255,.35)"; ctx.lineWidth = P(4); ctx.stroke();
    ctx.strokeStyle = "#cfefff"; ctx.lineWidth = P(1.4); ctx.stroke();
    pts.forEach(([x, y], i) => {
      const lastOne = i === pts.length - 1;
      ctx.fillStyle = lastOne ? "#ffd28a" : "#eaf8ff";
      ctx.beginPath(); ctx.arc(P(x), P(y), P(lastOne ? 2.6 + Math.sin(t * 6) : 1.8), 0, Math.PI * 2); ctx.fill();
    });
    const lastV = data[data.length - 1], avg = data.reduce((a, b) => a + b, 0) / data.length;
    ctx.fillStyle = "rgba(200,235,250,.85)"; ctx.textAlign = "right";
    ctx.fillText(`ÚLTIMA ${(lastV / 1000).toFixed(1)} s · MÉDIA ${(avg / 1000).toFixed(1)} s`, P(x0 + w), P(y0 - 6));
  }

  requestAnimationFrame(draw);
  return { resize };
})();

// Tamanho da tela: ocupa a janela inteira. Se a proporção da janela for bem
// diferente da arte, estica até ~15% e o que sobrar recebe o fundo desfocado.
(() => {
  const el = $("screen");
  const AR = 1377 / 728;
  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    let w, h;
    if (document.body.classList.contains("mobile")) { w = vw; h = vw / AR; }
    else {
      const ratio = vw / vh;
      const a = Math.min(AR * 1.16, Math.max(AR * 0.86, ratio));
      if (Math.abs(a - ratio) < 1e-3) { w = vw; h = vh; }
      else if (ratio > a) { h = vh; w = vh * a; }
      else { w = vw; h = vw / a; }
    }
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
    window.dispatchEvent(new Event("evora:layout"));
  }
  window.addEventListener("resize", layout);
  if (typeof mq !== "undefined") mq.addEventListener("change", layout);
  layout();
})();
