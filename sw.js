// Offline support: cache the app files on first load, serve them from the cache afterwards.
// Bump VERSION whenever any file below changes so phones pick up the update.
const VERSION = "gymplan-v18";
const FILES = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/app.js", "js/db.js", "js/plan.js", "js/ui.js", "js/beep.js", "js/workout.js",
  "js/run.js", "js/kick.js", "js/symptoms.js", "js/settings.js",
  "js/charts.js", "js/progress.js", "js/history.js", "js/checkin.js", "js/planview.js", "js/coach.js",
  "data/plan.json", "data/pictos.json",
  "img/phase-1.jpg", "img/phase-2.jpg", "img/phase-3.jpg",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
