// Conexão com a conta Google (Gmail, somente leitura).
// O "refresh token" fica criptografado num cookie HttpOnly no seu navegador:
// sem banco de dados, e só quem tem a sessão da Evora consegue usá-lo.
//
// Variáveis de ambiente:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  (credencial OAuth "Aplicativo da Web")

import { parseCookies, setCookie, encrypt, decrypt } from "./auth.js";

export const GOOGLE_COOKIE = "evora_google";
export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"];

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
export function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
export function redirectUri(req) {
  return `${baseUrl(req)}/api/google/callback`;
}

export function readGoogle(req) {
  const raw = decrypt(parseCookies(req)[GOOGLE_COOKIE]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export function saveGoogle(res, data) {
  setCookie(res, GOOGLE_COOKIE, encrypt(JSON.stringify(data)), { maxAge: 180 * 86400 });
}
export function clearGoogle(res) {
  setCookie(res, GOOGLE_COOKIE, "", { maxAge: 0 });
}

async function tokenRequest(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
export const exchangeCode = (code, req) =>
  tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri(req) });

// Token de acesso válido (renova pelo refresh token quando precisa).
export async function accessToken(req, res) {
  const g = readGoogle(req);
  if (!g?.refresh) return { error: "NOT_CONNECTED" };
  if (g.access && g.exp && Date.now() < g.exp - 60_000) return { token: g.access, account: g.email };
  const out = await tokenRequest({ refresh_token: g.refresh, grant_type: "refresh_token" });
  if (!out.ok) {
    // invalid_grant = autorização revogada ou expirada: precisa conectar de novo
    if (out.data?.error === "invalid_grant") { clearGoogle(res); return { error: "EXPIRED" }; }
    return { error: "TOKEN_FAILED", detail: out.data?.error_description || out.data?.error };
  }
  const next = { ...g, access: out.data.access_token, exp: Date.now() + (out.data.expires_in || 3600) * 1000 };
  saveGoogle(res, next);
  return { token: next.access, account: g.email };
}

// ── Gmail ──
async function gmail(token, path) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Gmail ${r.status}`), { status: r.status });
  return data;
}

function header(msg, name) {
  return (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}
function cleanFrom(from) {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: from.trim(), email: from.trim() };
}
function decodeEntities(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// Lista e-mails com remetente, assunto, data, trecho e marcadores.
export async function listMail(token, { q = "in:inbox newer_than:2d", max = 15 } = {}) {
  const list = await gmail(token, `messages?maxResults=${Math.min(25, max)}&q=${encodeURIComponent(q)}`);
  const ids = (list.messages || []).map((m) => m.id);
  const msgs = await Promise.all(
    ids.map((id) =>
      gmail(token, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null)
    )
  );
  return msgs.filter(Boolean).map((m) => {
    const from = cleanFrom(header(m, "From"));
    return {
      id: m.id,
      threadId: m.threadId,
      from: from.name,
      fromEmail: from.email,
      subject: header(m, "Subject") || "(sem assunto)",
      date: Number(m.internalDate) || Date.parse(header(m, "Date")) || 0,
      snippet: decodeEntities(m.snippet || "").slice(0, 300),
      unread: (m.labelIds || []).includes("UNREAD"),
      important: (m.labelIds || []).includes("IMPORTANT"),
      starred: (m.labelIds || []).includes("STARRED"),
    };
  });
}
