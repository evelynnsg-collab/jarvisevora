// Evora — service worker (deixa a Evora instalável como app e abre mesmo com a internet instável).
// Estratégia: rede primeiro para tudo, guardando uma cópia; sem rede, usa a cópia.
// Assim uma atualização publicada aparece já na próxima abertura, sem ficar presa no cache.
// As chamadas /api/* (conversa, voz, e-mails, login) nunca são guardadas.

const CACHE = "evora-v1";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/painel.webp", "/painel-blur.webp", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
        return hit || (req.mode === "navigate" ? caches.match("/index.html") : Response.error());
      })
  );
});
