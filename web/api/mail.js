// E-mails para a Evora.
//   GET  /api/mail                 → status da conexão + e-mails recentes da caixa de entrada
//   GET  /api/mail?since=<ms>      → só os que chegaram depois de <ms> (para avisos)
//   DELETE /api/mail               → desconecta a conta Google
import { requireSession } from "../lib/auth.js";
import { googleConfigured, accessToken, listMail, readGoogle, clearGoogle } from "../lib/google.js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (!requireSession(req, res)) return;

  if (req.method === "DELETE") {
    const g = readGoogle(req);
    if (g?.refresh) {
      // revoga no Google também, não só apaga o cookie
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.refresh)}`, { method: "POST" }).catch(() => {});
    }
    clearGoogle(res);
    return json(res, 200, { ok: true });
  }
  if (req.method !== "GET") return json(res, 405, { error: "Método não permitido." });

  if (!googleConfigured()) return json(res, 200, { configured: false, connected: false });
  const tok = await accessToken(req, res);
  if (tok.error) return json(res, 200, { configured: true, connected: false, reason: tok.error });

  const url = new URL(req.url, "https://x");
  const since = Number(url.searchParams.get("since")) || 0;
  try {
    let mails;
    if (since) {
      const secs = Math.floor(since / 1000);
      mails = (await listMail(tok.token, { q: `in:inbox after:${secs}`, max: 10 })).filter((m) => m.date > since);
    } else {
      mails = await listMail(tok.token, { q: "in:inbox newer_than:2d", max: 15 });
    }
    const unread = mails.filter((m) => m.unread).length;
    return json(res, 200, { configured: true, connected: true, account: tok.account, unread, mails, now: Date.now() });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return json(res, 200, { configured: true, connected: false, reason: "FORBIDDEN", detail: e.message });
    }
    return json(res, 502, { error: "Não consegui ler o Gmail agora.", detail: e.message });
  }
}
