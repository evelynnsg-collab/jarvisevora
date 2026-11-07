// Evora Web — função serverless (Vercel) que conversa com o Gemini.
// A chave fica só no servidor: defina GEMINI_API_KEY nas variáveis de ambiente do Vercel.
//
// Variáveis de ambiente:
//   GEMINI_API_KEY     chave do Google AI Studio (pesquisa na internet e voz)
//   GROQ_API_KEY       (opcional, recomendada) chave do Groq — muito rápido e com
//                      cota grátis bem maior; vira o cérebro principal da conversa
//   GEMINI_MODEL       (opcional)   modelo; padrão "gemini-flash-latest"
//   EVORA_ACCESS_CODE  (opcional)   se definida, o site pede este código antes de responder

import { buildSystemPrompt } from "../lib/prompt.js";

const MAX_TURNS = 30;          // quantas mensagens anteriores vão para o modelo
const MAX_CHARS = 8000;        // tamanho máximo de uma mensagem

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string")
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, MAX_CHARS) }] }));
}

async function callGemini({ apiKey, model, system, contents, useSearch, fast = true, timeoutMs = 15000 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 800,
      // sem "raciocínio" longo: para conversa por voz, responder rápido vale mais
      ...(fast ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  // Cada tentativa tem prazo próprio: se o Gemini travar, passamos para a próxima
  // antes de estourar o tempo máximo da função no Vercel (que devolveria 504).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 504, data: { error: { message: e?.name === "AbortError" ? "Tempo esgotado esperando o Gemini." : String(e?.message || e) } } };
  } finally {
    clearTimeout(timer);
  }
}

// ── Groq (API compatível com OpenAI) ──────────────────────────────────────
async function callGroq({ apiKey, model, system, contents, timeoutMs = 12000 }) {
  const messages = [
    { role: "system", content: system },
    ...contents.map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: c.parts[0].text })),
  ];
  const body = { model, messages, temperature: 0.7, max_tokens: 800 };
  if (/gpt-oss/.test(model)) body.reasoning_effort = "low";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    return { ok: r.ok && Boolean(text), status: r.ok && !text ? 502 : r.status, text, data };
  } catch (e) {
    return { ok: false, status: 504, data: { error: { message: e?.name === "AbortError" ? "Tempo esgotado esperando o Groq." : String(e?.message || e) } } };
  } finally {
    clearTimeout(timer);
  }
}

// Modelos que já disseram "cota esgotada": ficam de fora até liberar, para não
// gastar segundos tentando de novo a cada pergunta (vale enquanto a função estiver quente).
const blockedUntil = new Map();
function retryAfterMs(msg) {
  const m = String(msg || "").match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  if (!m) return 60_000;
  const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  return Math.max(30_000, ms);
}
function fmtWait(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

const SEARCH_HINTS = new RegExp(
  [
    "hoje", "agora", "atual", "ultim", "último", "recente", "nesta semana", "este ano", "ontem", "amanh",
    "not[ií]cia", "aconteceu", "pre[cç]o", "cota[cç][aã]o", "d[oó]lar", "euro", "bitcoin", "bolsa", "a[cç][oõ]es", "dividend",
    "clima", "tempo em", "previs[aã]o", "temperatura", "jogo", "placar", "resultado", "campeonato", "elei[cç]",
    "quem [eé]", "quem foi", "quem ganhou", "quando (vai|ser[aá]|come[cç]a)", "onde fica", "endere[cç]o", "hor[aá]rio",
    "lan[cç]amento", "vers[aã]o", "pesquis", "procur", "busca", "na internet", "site", "20[2-3][0-9]",
  ].join("|"),
  "i"
);
function needsSearch(text) {
  return SEARCH_HINTS.test(String(text || ""));
}

// Pesquisas feitas pelo Gemini (Google Search) e as páginas usadas na resposta.
function extractSources(data) {
  const meta = data?.candidates?.[0]?.groundingMetadata;
  if (!meta) return {};
  const queries = (meta.webSearchQueries || []).filter((q) => typeof q === "string").slice(0, 3);
  const seen = new Set();
  const sources = [];
  for (const c of meta.groundingChunks || []) {
    const uri = c?.web?.uri;
    const title = c?.web?.title || "";
    if (!uri || !/^https?:\/\//.test(uri) || seen.has(title + uri)) continue;
    seen.add(title + uri);
    sources.push({ uri, title: title.slice(0, 120) });
    if (sources.length >= 5) break;
  }
  return queries.length || sources.length ? { queries, sources } : {};
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY),
      providers: { gemini: Boolean(process.env.GEMINI_API_KEY), groq: Boolean(process.env.GROQ_API_KEY) },
      locked: Boolean(process.env.EVORA_ACCESS_CODE),
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "Método não permitido." });

  const apiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!apiKey && !groqKey) {
    return json(res, 503, {
      error: "A chave do Gemini ainda não foi configurada no Vercel (GEMINI_API_KEY).",
      code: "NO_KEY",
    });
  }

  const access = process.env.EVORA_ACCESS_CODE;
  if (access && req.headers["x-evora-code"] !== access) {
    return json(res, 401, { error: "Código de acesso inválido.", code: "LOCKED" });
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch {
    return json(res, 400, { error: "Requisição inválida." });
  }

  const contents = sanitizeHistory(payload.messages);
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return json(res, 400, { error: "Nenhuma mensagem para responder." });
  }

  const system = buildSystemPrompt({ now: new Date(), male: payload.voiceStyle === "jarvis" });

  // Ordem de tentativas: cada modelo/recurso tem cota própria no plano gratuito.
  // Se um esbarrar no limite (429), não existir (404) ou não aceitar a busca (400),
  // passa para o próximo em vez de desistir.
  const preferred = process.env.GEMINI_MODEL || "gemini-flash-latest";
  // A pesquisa no Google deixa a resposta bem mais lenta: só usa quando a pergunta
  // depende de informação atual (notícias, preços, clima, "hoje", "quem é"...).
  const lastUser = contents[contents.length - 1].parts[0].text;
  const search = needsSearch(lastUser);
  const gemini = apiKey
    ? [
        { provider: "gemini", model: preferred, useSearch: false },
        { provider: "gemini", model: "gemini-2.5-flash", useSearch: false },
        { provider: "gemini", model: "gemini-flash-lite-latest", useSearch: false },
        { provider: "gemini", model: "gemini-2.5-flash-lite", useSearch: false },
      ]
    : [];
  const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const groq = groqKey
    ? [
        { provider: "groq", model: groqModel },
        { provider: "groq", model: "llama-3.3-70b-versatile" },
        { provider: "groq", model: "llama-3.1-8b-instant" },
      ]
    : [];
  // Pergunta que precisa de pesquisa: Gemini com Google primeiro.
  // Conversa comum: Groq primeiro (responde em menos de 1 s), Gemini de reserva.
  const attempts = [
    ...(search && apiKey ? [{ provider: "gemini", model: preferred, useSearch: true }] : []),
    ...groq,
    ...gemini,
  ]
    .filter((a, i, all) => all.findIndex((b) => b.provider === a.provider && b.model === a.model && b.useSearch === a.useSearch) === i)
    .filter((a) => !(blockedUntil.get(`${a.provider}:${a.model}`) > Date.now()));

  const started = Date.now();
  const BUDGET = 50000; // ms — abaixo do maxDuration (60 s) configurado no vercel.json
  let last = null;
  let groqDead = false;
  let quota = null; // guarda o erro de cota, se algum modelo recusou por isso
  try {
    for (const a of attempts) {
      const left = BUDGET - (Date.now() - started);
      if (left < 4000) break;
      // a primeira tentativa (com pesquisa) pode demorar mais; as outras recebem menos tempo
      const timeoutMs = Math.min(left - 1000, a.useSearch ? 10000 : 9000);
      if (a.provider === "groq") {
        if (groqDead) continue;
        const out = await callGroq({ apiKey: groqKey, model: a.model, system, contents, timeoutMs: Math.min(timeoutMs, 10000) });
        if (out.ok) return json(res, 200, { text: out.text, model: a.model, provider: "groq" });
        last = out;
        const msg = out.data?.error?.message || "";
        console.error(`[evora] groq ${a.model} -> ${out.status}: ${msg}`);
        if (out.status === 429) { quota = out; blockedUntil.set(`groq:${a.model}`, Date.now() + retryAfterMs(msg)); }
        if (out.status === 401 || out.status === 403) groqDead = true; // chave do Groq inválida: segue no Gemini
        continue;
      }
      let out = await callGemini({ apiKey, system, contents, ...a, timeoutMs });
      if (!out.ok && out.status === 400 && /thinking/i.test(out.data?.error?.message || "")) {
        out = await callGemini({ apiKey, system, contents, ...a, fast: false, timeoutMs });
      }
      if (out.ok) {
        const text = extractText(out.data);
        if (text) return json(res, 200, { text, model: a.model, provider: "gemini", search: a.useSearch, ...extractSources(out.data) });
        last = { status: 502, data: {} };
        continue;
      }
      last = out;
      const msg = out.data?.error?.message || "";
      if (out.status === 429) {
        quota = out;
        if (!a.useSearch) blockedUntil.set(`gemini:${a.model}`, Date.now() + retryAfterMs(msg));
      }
      console.error(`[evora] ${a.model}${a.useSearch ? "+search" : ""} -> ${out.status}: ${msg}`);
      // 401/403 = problema da chave do Gemini: não adianta trocar de modelo do Gemini.
      if (out.status === 401 || out.status === 403) { if (!groqKey || groqDead) break; }
    }
  } catch {
    return json(res, 502, { error: "Falha ao falar com o Gemini. Tente de novo em instantes." });
  }

  if (quota && last?.status !== 401 && last?.status !== 403) last = quota;
  const raw = last?.data?.error?.message || "";
  if (last?.status === 429 || (!attempts.length && blockedUntil.size)) {
    const soonest = Math.min(...[...blockedUntil.values()].filter((v) => v > Date.now()), Date.now() + retryAfterMs(raw));
    const wait = fmtWait(soonest - Date.now());
    return json(res, 429, {
      error: groqKey
        ? `A cota grátis de hoje acabou nos dois provedores. Volta em cerca de ${wait}.`
        : `A cota grátis do Gemini acabou (são poucos pedidos por dia no plano gratuito). Volta em cerca de ${wait}. ` +
          "Para não parar mais: adicione uma chave grátis do Groq (GROQ_API_KEY) no Vercel ou ative o faturamento da chave do Gemini.",
      code: "QUOTA",
    });
  }
  if (last?.status === 400 && /api key/i.test(raw)) {
    return json(res, 401, { error: "A chave do Gemini configurada no Vercel é inválida.", detail: raw });
  }
  if (last?.status === 403) {
    return json(res, 403, { error: "A chave do Gemini não tem permissão para esse uso.", detail: raw });
  }
  if (last?.status === 504) {
    return json(res, 504, { error: "O Gemini está demorando para responder agora. Tente de novo em instantes.", detail: raw, code: "SLOW" });
  }
  return json(res, 502, {
    error: `O Gemini não respondeu (erro ${last?.status || "?"}). Tente de novo em instantes.`,
    detail: raw,
  });
}
