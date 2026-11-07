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

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const system = buildSystemPrompt({ now: new Date() });

  try {
    let out = await callGemini({ apiKey, model, system, contents, useSearch: true });
    // Se a busca do Google não estiver disponível para esse modelo/chave, tenta sem ela.
    if (!out.ok && out.status === 400) {
      out = await callGemini({ apiKey, model, system, contents, useSearch: false });
    }
    if (!out.ok) {
      const msg = out.data?.error?.message || `Erro ${out.status} no Gemini.`;
      return json(res, out.status === 429 ? 429 : 502, { error: msg });
    }
    const text = extractText(out.data);
    if (!text) return json(res, 502, { error: "O Gemini não devolveu resposta." });
    return json(res, 200, { text, model });
  } catch (e) {
    return json(res, 502, { error: "Falha ao falar com o Gemini." });
  }
}
