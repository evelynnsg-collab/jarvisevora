// Começa a conexão com a conta Microsoft (Hotmail / Outlook.com).
import { hasSession, signState } from "../../lib/auth.js";
import { msConfigured, msRedirectUri, msAuthorizeUrl, MS_SCOPES } from "../../lib/microsoft.js";

export default function handler(req, res) {
  const go = (loc) => { res.statusCode = 302; res.setHeader("Location", loc); res.end(); };
  if (!hasSession(req)) return go("/?ms=login");
  if (!msConfigured()) return go("/?ms=noconfig");
  go(
    msAuthorizeUrl({
      client_id: process.env.MS_CLIENT_ID,
      redirect_uri: msRedirectUri(req),
      response_type: "code",
      response_mode: "query",
      scope: MS_SCOPES.join(" "),
      prompt: "select_account",
      state: signState({ n: Math.random().toString(36).slice(2) }, 10 * 60 * 1000),
    })
  );
}
