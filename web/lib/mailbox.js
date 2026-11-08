// Junta as caixas de entrada conectadas (Gmail e/ou Hotmail) num formato só.
import { googleConfigured, accessToken, listMail } from "./google.js";
import { msConfigured, msAccessToken, msListMail } from "./microsoft.js";

const PROVIDERS = [
  {
    id: "google", label: "Gmail",
    configured: googleConfigured,
    token: accessToken,
    list: (token, { sinceMs }) => sinceMs
      ? listMail(token, { q: `in:inbox after:${Math.floor(sinceMs / 1000)}`, max: 10 }).then((l) => l.filter((m) => m.date > sinceMs))
      : listMail(token, { q: "in:inbox newer_than:2d", max: 15 }),
  },
  {
    id: "microsoft", label: "Hotmail",
    configured: msConfigured,
    token: msAccessToken,
    list: (token, { sinceMs }) => msListMail(token, sinceMs ? { sinceMs, max: 10 } : { days: 2, max: 15 }),
  },
];

// Estado de cada conta + e-mails (todas as contas conectadas, mais recentes primeiro).
export async function readMailboxes(req, res, { sinceMs = 0 } = {}) {
  const status = {};
  const all = [];
  await Promise.all(
    PROVIDERS.map(async (p) => {
      if (!p.configured()) { status[p.id] = { configured: false, connected: false }; return; }
      const tok = await p.token(req, res);
      if (tok.error) { status[p.id] = { configured: true, connected: false, reason: tok.error }; return; }
      try {
        const mails = await p.list(tok.token, { sinceMs });
        status[p.id] = { configured: true, connected: true, account: tok.account || "" };
        for (const m of mails) all.push({ ...m, box: p.label, account: tok.account || "" });
      } catch (e) {
        const forbidden = e.status === 401 || e.status === 403;
        status[p.id] = { configured: true, connected: !forbidden, account: tok.account || "", reason: forbidden ? "FORBIDDEN" : "READ_FAILED", detail: e.message };
      }
    })
  );
  all.sort((a, b) => b.date - a.date);
  const connected = Object.values(status).some((s) => s.connected);
  const configured = Object.values(status).some((s) => s.configured);
  return { status, connected, configured, mails: all };
}
