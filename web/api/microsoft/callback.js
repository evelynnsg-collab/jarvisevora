// Volta da autorização da Microsoft: troca o código pelo token e guarda criptografado.
import { hasSession, verifyState } from "../../lib/auth.js";
import { msExchangeCode, saveMs, emailFromIdToken } from "../../lib/microsoft.js";

function back(res, status) {
  res.statusCode = 302;
  res.setHeader("Location", `/?ms=${status}`);
  res.end();
}

export default async function handler(req, res) {
  const url = new URL(req.url, "https://x");
  if (!hasSession(req)) return back(res, "login");
  if (url.searchParams.get("error")) return back(res, url.searchParams.get("error") === "access_denied" ? "denied" : "error");
  if (!verifyState(url.searchParams.get("state"))) return back(res, "error");
  const code = url.searchParams.get("code");
  if (!code) return back(res, "error");

  const out = await msExchangeCode(code, req);
  if (!out.ok || !out.data.refresh_token) {
    console.error("[evora-ms] token:", out.status, out.data?.error, out.data?.error_description);
    return back(res, out.ok ? "norefresh" : "error");
  }
  saveMs(res, {
    refresh: out.data.refresh_token,
    access: out.data.access_token,
    exp: Date.now() + (out.data.expires_in || 3600) * 1000,
    email: emailFromIdToken(out.data.id_token),
  });
  return back(res, "ok");
}
