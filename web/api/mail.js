// E-mails para a Evora (Gmail e/ou Hotmail).
//   GET    /api/mail                     → status das contas + e-mails dos últimos 2 dias
//   GET    /api/mail?since=<ms>          → só os que chegaram depois de <ms> (para avisos)
//   DELETE /api/mail?provider=google|microsoft → desconecta a conta (e revoga no Google)
import { requireSession } from "../lib/auth.js";
import { readGoogle, clearGoogle } from "../lib/google.js";
import { clearMs } from "../lib/microsoft.js";
import { readMailboxes } from "../lib/mailbox.js";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (!requireSession(req, res)) return;
  const url = new URL(req.url, "https://x");

  if (req.method === "DELETE") {
    const provider = url.searchParams.get("provider") || "google";
    if (provider === "microsoft") {
      // A Microsoft não tem revogação por token: apagamos aqui e você pode remover
      // o app em account.live.com/consent/Manage.
      clearMs(res);
    } else {
      const g = readGoogle(req);
      if (g?.refresh) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.refresh)}`, { method: "POST" }).catch(() => {});
      }
      clearGoogle(res);
    }
    return json(res, 200, { ok: true });
  }
  if (req.method !== "GET") return json(res, 405, { error: "Método não permitido." });

  const since = Number(url.searchParams.get("since")) || 0;
  try {
    const box = await readMailboxes(req, res, { sinceMs: since });
    const unread = box.mails.filter((m) => m.unread).length;
    return json(res, 200, { ...box, unread, now: Date.now() });
  } catch (e) {
    return json(res, 502, { error: "Não consegui ler os e-mails agora.", detail: e.message });
  }
}
