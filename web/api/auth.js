// Login da Evora.
//   GET    /api/auth  → { locked, loggedIn }
//   POST   /api/auth  { password } → entra (cookie de sessão)
//   DELETE /api/auth  → sai
import { isLocked, hasSession, checkPassword, startSession, endSession, readJson } from "../lib/auth.js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === "GET") return json(res, 200, { locked: isLocked(), loggedIn: hasSession(req) });
  if (req.method === "DELETE") { endSession(res); return json(res, 200, { ok: true }); }
  if (req.method !== "POST") return json(res, 405, { error: "Método não permitido." });
  if (!isLocked()) return json(res, 200, { ok: true });

  let body = {};
  try { body = await readJson(req); } catch { /* corpo inválido = senha vazia */ }
  if (!checkPassword(body.password)) {
    await new Promise((r) => setTimeout(r, 1200)); // freia tentativas em sequência
    return json(res, 401, { error: "Senha incorreta." });
  }
  startSession(res);
  return json(res, 200, { ok: true });
}
