// Login privado da Evora: senha → cookie de sessão assinado (HMAC).
// Também guarda segredos (como o token do Google) criptografados em cookie,
// para não precisar de banco de dados num app de uma pessoa só.
//
// Variáveis de ambiente:
//   EVORA_PASSWORD  senha para entrar no site (se vazia, o site fica aberto)
//   EVORA_SECRET    texto aleatório longo usado para assinar e criptografar
//                   (se faltar, usa um derivado da senha — funciona, mas defina um)

import crypto from "node:crypto";

const SESSION_COOKIE = "evora_session";
const SESSION_DAYS = 30;

export function password() {
  return process.env.EVORA_PASSWORD || process.env.EVORA_ACCESS_CODE || "";
}
export function isLocked() {
  return Boolean(password());
}
function secret() {
  return process.env.EVORA_SECRET || `evora:${password()}:${process.env.GOOGLE_CLIENT_SECRET || ""}`;
}
function key(purpose) {
  return crypto.createHash("sha256").update(`${purpose}|${secret()}`).digest();
}

// ── cookies ──
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setCookie(res, name, value, { maxAge, path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader?.("Set-Cookie");
  const list = Array.isArray(prev) ? prev : prev ? [prev] : [];
  res.setHeader("Set-Cookie", [...list, parts.join("; ")]);
}

// ── assinatura ──
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", key("sign")).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verify(token) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const good = crypto.createHmac("sha256", key("sign")).update(body).digest("base64url");
  if (good.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(mac))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}
export const signState = (data, ttlMs) => sign({ ...data, exp: Date.now() + ttlMs });
export const verifyState = verify;

// ── criptografia (AES-256-GCM) ──
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key("enc"), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}
export function decrypt(blob) {
  try {
    const raw = Buffer.from(String(blob || ""), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key("enc"), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ── sessão ──
export function hasSession(req) {
  if (!isLocked()) return true;
  const data = verify(parseCookies(req)[SESSION_COOKIE]);
  return Boolean(data && data.v === 1);
}
export function startSession(res) {
  setCookie(res, SESSION_COOKIE, sign({ v: 1, exp: Date.now() + SESSION_DAYS * 864e5 }), { maxAge: SESSION_DAYS * 86400 });
}
export function endSession(res) {
  setCookie(res, SESSION_COOKIE, "", { maxAge: 0 });
}
export function checkPassword(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(password()).digest();
  return crypto.timingSafeEqual(a, b);
}

// Resposta padrão para quem não está logado.
export function requireSession(req, res) {
  if (hasSession(req)) return true;
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Faça login para usar a Evora.", code: "LOCKED" }));
  return false;
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
