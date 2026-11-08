// Conexão com conta Microsoft (Hotmail / Outlook.com / Live), somente leitura.
// Usa o Microsoft Graph com a permissão Mail.Read. O token fica criptografado
// num cookie HttpOnly, igual ao do Google.
//
// Variáveis de ambiente:
//   MS_CLIENT_ID, MS_CLIENT_SECRET   (registro de app no Microsoft Entra)
//   MS_TENANT                        (opcional) padrão "common"; use "consumers" se o app
//                                    foi registrado só para contas pessoais

import { parseCookies, setCookie, encrypt, decrypt } from "./auth.js";
import { baseUrl } from "./google.js";

export const MS_COOKIE = "evora_ms";
export const MS_SCOPES = ["openid", "email", "profile", "offline_access", "https://graph.microsoft.com/Mail.Read", "https://graph.microsoft.com/User.Read"];

const tenant = () => process.env.MS_TENANT || "common";
const authority = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;

export function msConfigured() {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}
export const msRedirectUri = (req) => `${baseUrl(req)}/api/microsoft/callback`;
export const msAuthorizeUrl = (params) => `${authority()}/authorize?${new URLSearchParams(params)}`;

export function readMs(req) {
  const raw = decrypt(parseCookies(req)[MS_COOKIE]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export function saveMs(res, data) {
  setCookie(res, MS_COOKIE, encrypt(JSON.stringify(data)), { maxAge: 180 * 86400 });
}
export function clearMs(res) {
  setCookie(res, MS_COOKIE, "", { maxAge: 0 });
}

async function tokenRequest(params) {
  const r = await fetch(`${authority()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: MS_SCOPES.join(" "),
      ...params,
    }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
export const msExchangeCode = (code, req) =>
  tokenRequest({ code, grant_type: "authorization_code", redirect_uri: msRedirectUri(req) });

// Token válido; a Microsoft troca o refresh token a cada renovação, então guardamos o novo.
export async function msAccessToken(req, res) {
  const m = readMs(req);
  if (!m?.refresh) return { error: "NOT_CONNECTED" };
  if (m.access && m.exp && Date.now() < m.exp - 60_000) return { token: m.access, account: m.email };
  const out = await tokenRequest({ refresh_token: m.refresh, grant_type: "refresh_token" });
  if (!out.ok) {
    if (out.data?.error === "invalid_grant") { clearMs(res); return { error: "EXPIRED" }; }
    return { error: "TOKEN_FAILED", detail: out.data?.error_description || out.data?.error };
  }
  const next = {
    ...m,
    access: out.data.access_token,
    refresh: out.data.refresh_token || m.refresh,
    exp: Date.now() + (out.data.expires_in || 3600) * 1000,
  };
  saveMs(res, next);
  return { token: next.access, account: m.email };
}

export function emailFromIdToken(idToken) {
  try {
    const p = JSON.parse(Buffer.from(String(idToken || "").split(".")[1] || "", "base64url").toString());
    return p.email || p.preferred_username || "";
  } catch {
    return "";
  }
}

// Lista e-mails da caixa de entrada no mesmo formato do Gmail.
export async function msListMail(token, { sinceMs, days = 2, max = 15 } = {}) {
  const from = new Date(sinceMs || Date.now() - days * 864e5).toISOString();
  // o Graph quer espaços como %20 (URLSearchParams usaria "+")
  const params = Object.entries({
    $top: String(Math.min(25, max)),
    $select: "id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead,importance,flag",
    $filter: `receivedDateTime ${sinceMs ? "gt" : "ge"} ${from}`,
    $orderby: "receivedDateTime desc",
  }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Graph ${r.status}`), { status: r.status });
  return (data.value || []).map((m) => ({
    id: m.id,
    threadId: m.conversationId,
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "(desconhecido)",
    fromEmail: m.from?.emailAddress?.address || "",
    subject: m.subject || "(sem assunto)",
    date: Date.parse(m.receivedDateTime) || 0,
    snippet: String(m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 300),
    unread: m.isRead === false,
    important: m.importance === "high",
    starred: m.flag?.flagStatus === "flagged",
  }));
}
