// Evora Web — função serverless (Vercel) que conversa com o Gemini.
// A chave fica só no servidor: defina GEMINI_API_KEY nas variáveis de ambiente do Vercel.
//
// Variáveis de ambiente:
//   GEMINI_API_KEY     (obrigatória) chave do Google AI Studio
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

async function callGemini({ apiKey, model, system, contents, useSearch }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return json(res, 200, {
      ok: true,
      configured: Boolean(process.env.GEMINI_API_KEY),
      locked: Boolean(process.env.EVORA_ACCESS_CODE),
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "Método não permitido." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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

  const system = buildSystemPrompt({ now: new Date() });

  // Ordem de tentativas: cada modelo/recurso tem cota própria no plano gratuito.
  // Se um esbarrar no limite (429), não existir (404) ou não aceitar a busca (400),
  // passa para o próximo em vez de desistir.
  const preferred = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const attempts = [
    { model: preferred, useSearch: true },
    { model: preferred, useSearch: false },
    { model: "gemini-2.5-flash", useSearch: false },
    { model: "gemini-flash-lite-latest", useSearch: false },
    { model: "gemini-2.5-flash-lite", useSearch: false },
  ].filter((a, i, all) => all.findIndex((b) => b.model === a.model && b.useSearch === a.useSearch) === i);

  let last = null;
  let quota = null; // guarda o erro de cota, se algum modelo recusou por isso
  try {
    for (const a of attempts) {
      const out = await callGemini({ apiKey, system, contents, ...a });
      if (out.ok) {
        const text = extractText(out.data);
        if (text) return json(res, 200, { text, model: a.model, search: a.useSearch });
        last = { status: 502, data: {} };
        continue;
      }
      last = out;
      if (out.status === 429) quota = out;
      console.error(`[evora] ${a.model}${a.useSearch ? "+search" : ""} -> ${out.status}: ${out.data?.error?.message || ""}`);
      // 401/403 = problema da chave: não adianta trocar de modelo.
      if (out.status === 401 || out.status === 403) break;
    }
  } catch {
    return json(res, 502, { error: "Falha ao falar com o Gemini. Tente de novo em instantes." });
  }

  if (quota && last?.status !== 401 && last?.status !== 403) last = quota;
  const raw = last?.data?.error?.message || "";
  if (last?.status === 429) {
    return json(res, 429, {
      error:
        "A cota gratuita da sua chave do Gemini acabou por agora. Ela volta sozinha (o limite diário zera de madrugada), " +
        "ou você pode ativar o faturamento da chave no Google AI Studio.",
      detail: raw,
    });
  }
  if (last?.status === 400 && /api key/i.test(raw)) {
    return json(res, 401, { error: "A chave do Gemini configurada no Vercel é inválida.", detail: raw });
  }
  if (last?.status === 403) {
    return json(res, 403, { error: "A chave do Gemini não tem permissão para esse uso.", detail: raw });
  }
  return json(res, 502, {
    error: `O Gemini não respondeu (erro ${last?.status || "?"}). Tente de novo em instantes.`,
    detail: raw,
  });
}
