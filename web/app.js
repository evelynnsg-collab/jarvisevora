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
  { voice: "", rate: 1, speak: true, convo: false },
  store.get("evora.prefs", {})
);
let history = store.get("evora.history", []);
let accessCode = store.get("evora.code", "");

// ── Estado ────────────────────────────────────────────────────────────────
const STATUS = {
  idle: "Pronta",
  listening: "Ouvindo…",
  thinking: "Pensando…",
  speaking: "Falando…",
  error: "Erro",
  offline: "Sem chave",
};
let state = "idle";
function setState(s, label) {
  state = s;
  els.body.dataset.state = s === "offline" ? "error" : s;
  els.statusText.textContent = label || STATUS[s] || s;
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

function speak(text) {
  return new Promise((resolve) => {
    if (!synth || !prefs.speak) return resolve();
    synth.cancel();
    const pieces = chunk(speechText(text));
    if (!pieces.length) return resolve();
    const voice = voices.find((v) => v.name === els.voiceSelect.value) || voices[0];
    setState("speaking");
    let i = 0;
    const next = () => {
      if (i >= pieces.length) { holo.level = 0; return resolve(); }
      const u = new SpeechSynthesisUtterance(pieces[i++]);
      u.lang = voice?.lang || "pt-BR";
      if (voice) u.voice = voice;
      u.rate = prefs.rate;
      u.pitch = 1.05;
      u.onboundary = () => { holo.kick(); };
      u.onend = next;
      u.onerror = () => resolve();
      synth.speak(u);
    };
    next();
  });
}
function stopSpeaking() {
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

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessCode ? { "x-evora-code": accessCode } : {}) },
      body: JSON.stringify({ messages: history.slice(-30) }),
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
      addMessage("system error", data.error || `Erro ${res.status}.`);
      setState(data.code === "NO_KEY" ? "offline" : "error");
      busy = false;
      return;
    }

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
    if (speaking) api.level = Math.max(api.level, 0.25 + 0.35 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1)));
    api.level *= 0.94;

    ctx.clearRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.36;
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
  const text = els.input.value;
  els.input.value = "";
  send(text);
});

els.mic.addEventListener("click", () => {
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
els.speakToggle.checked = prefs.speak;
els.speakToggle.addEventListener("change", () => { prefs.speak = els.speakToggle.checked; if (!prefs.speak) stopSpeaking(); savePrefs(); });
els.convoToggle.checked = prefs.convo;
els.convoToggle.addEventListener("change", () => { prefs.convo = els.convoToggle.checked; savePrefs(); });
els.testVoice.addEventListener("click", async () => {
  const was = prefs.speak; prefs.speak = true;
  await speak("Oi, eu sou a Evora. Estou pronta.");
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
    if (!info.configured) {
      setState("offline");
      addMessage("system error", "A Evora ainda não tem a chave do Gemini. Adicione GEMINI_API_KEY nas variáveis de ambiente do projeto no Vercel e faça um novo deploy.");
    } else {
      setState("idle");
    }
  })
  .catch(() => setState("idle"));
