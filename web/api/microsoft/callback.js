// Volta da autorização da Microsoft: troca o código pelo token e guarda criptografado.
import { hasSession, verifyState } from "../../lib/auth.js";
import { msExchangeCode, saveMs, emailFromIdToken } from "../../lib/microsoft.js";

function back(res, status, code = "") {
  res.statusCode = 302;
  res.setHeader("Location", `/?ms=${status}${code ? "&code=" + encodeURIComponent(String(code).slice(0, 40)) : ""}`);
  res.end();
}
// "AADSTS7000215: Invalid client secret..." → "AADSTS7000215"
const aadCode = (d) => (String(d?.error_description || "").match(/AADSTS\d+/) || [])[0] || (d?.error_codes?.[0] ? `AADSTS${d.error_codes[0]}` : d?.error || "");

export default async function handler(req, res) {
  const url = new URL(req.url, "https://x");
  if (!hasSession(req)) return back(res, "login");
  if (url.searchParams.get("error")) {
    const err = url.searchParams.get("error");
    return back(res, err === "access_denied" ? "denied" : "error", aadCode({ error_description: url.searchParams.get("error_description"), error: err }));
  }
  if (!verifyState(url.searchParams.get("state"))) return back(res, "error", "STATE");
  const code = url.searchParams.get("code");
  if (!code) return back(res, "error");

  const out = await msExchangeCode(code, req);
  if (!out.ok || !out.data.refresh_token) {
    console.error("[evora-ms] token:", out.status, out.data?.error, out.data?.error_description);
    return back(res, out.ok ? "norefresh" : "error", out.ok ? "" : aadCode(out.data) || `HTTP${out.status}`);
  }
  saveMs(res, {
    refresh: out.data.refresh_token,
    access: out.data.access_token,
    exp: Date.now() + (out.data.expires_in || 3600) * 1000,
    email: emailFromIdToken(out.data.id_token),
  });
  return back(res, "ok");
}
