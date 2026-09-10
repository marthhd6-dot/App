// public/sw.js
// Minimaler Service Worker, damit sich Rumble Poker als PWA installieren
// lässt und die Oberfläche auch bei wackeliger Verbindung sofort erscheint.
//
// Bewusst eng gefasst, weil ein zu gieriger Cache in einer Live-App
// schlimmer ist als gar keiner: Zwischengespeichert wird ausschließlich die
// bekannte, statische Oberfläche (SHELL) und auch die nur per
// "network-first" – so ist nach einem Deploy sofort die neue Version aktiv
// und der Cache dient nur als Rückfallebene, wenn das Netz nicht antwortet.
// Alles andere (vor allem /socket.io/ – die Live-Verbindung zum Spiel –
// sowie alle Nicht-GET-Anfragen und fremde Hosts) geht unangetastet ins
// Netz.

const CACHE_VERSION = 'rumble-poker-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './sound.js',
  './server-config.js',
  './vendor/socket.io.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // Einzelne fehlende Dateien dürfen die Installation nicht scheitern
      // lassen (addAll bricht sonst komplett ab).
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Die Socket.io-Verbindung (Polling/Upgrade) darf niemals über den Cache
  // laufen – sonst bekäme der Client veraltete oder gar keine Spielzustände.
  if (url.pathname.startsWith('/socket.io/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
