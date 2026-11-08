// Começa a conexão com o Google: redireciona para a tela de autorização.
import { hasSession, signState } from "../../lib/auth.js";
import { googleConfigured, redirectUri, SCOPES } from "../../lib/google.js";

export default function handler(req, res) {
  if (!hasSession(req)) { res.statusCode = 302; res.setHeader("Location", "/?google=login"); return res.end(); }
  if (!googleConfigured()) { res.statusCode = 302; res.setHeader("Location", "/?google=noconfig"); return res.end(); }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: signState({ n: Math.random().toString(36).slice(2) }, 10 * 60 * 1000),
  });
  res.statusCode = 302;
  res.setHeader("Location", `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  res.end();
}
