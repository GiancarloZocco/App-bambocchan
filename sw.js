/* === SERVICE WORKER === */
// Prima prova la rete (così vedi sempre l'ultima versione), se manca usa la copia salvata
const CACHE_NAME = 'bambocchan-care-v2';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) { return name !== CACHE_NAME; }).map(function (name) { return caches.delete(name); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') { return; }
  event.respondWith(
    fetch(event.request).then(function (response) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
      return response;
    }).catch(function () {
      return caches.match(event.request);
    })
  );
});

// Toccando la notifica si apre l'app
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function (clients) {
      if (clients.length > 0) { return clients[0].focus(); }
      return self.clients.openWindow('index.html');
    })
  );
});
