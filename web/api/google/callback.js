// Volta da autorização do Google: troca o código pelo token e guarda criptografado.
import { hasSession, verifyState } from "../../lib/auth.js";
import { exchangeCode, saveGoogle } from "../../lib/google.js";

function back(res, status) {
  res.statusCode = 302;
  res.setHeader("Location", `/?google=${status}`);
  res.end();
}

export default async function handler(req, res) {
  const url = new URL(req.url, "https://x");
  if (!hasSession(req)) return back(res, "login");
  if (url.searchParams.get("error")) {
    // access_denied = você cancelou, ou o administrador do Workspace bloqueou o app
    return back(res, url.searchParams.get("error") === "access_denied" ? "denied" : "error");
  }
  if (!verifyState(url.searchParams.get("state"))) return back(res, "error");
  const code = url.searchParams.get("code");
  if (!code) return back(res, "error");

  const out = await exchangeCode(code, req);
  if (!out.ok || !out.data.refresh_token) return back(res, out.ok ? "norefresh" : "error");

  let email = "";
  try {
    const payload = JSON.parse(Buffer.from(String(out.data.id_token || "").split(".")[1] || "", "base64url").toString());
    email = payload.email || "";
  } catch { /* sem e-mail no token: segue sem */ }

  saveGoogle(res, {
    refresh: out.data.refresh_token,
    access: out.data.access_token,
    exp: Date.now() + (out.data.expires_in || 3600) * 1000,
    email,
  });
  return back(res, "ok");
}
