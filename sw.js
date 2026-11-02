/* === SERVICE WORKER === */
// 1) Prima prova la rete (così vedi sempre l'ultima versione), se manca usa la copia salvata
// 2) Riceve le notifiche anche ad app chiusa (Firebase Cloud Messaging)
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCLCZ3-DeYAZ9y607XCXw3_8XcEUCbRxzw",
  authDomain: "bambocchan-app.firebaseapp.com",
  projectId: "bambocchan-app",
  storageBucket: "bambocchan-app.firebasestorage.app",
  messagingSenderId: "644308386286",
  appId: "1:644308386286:web:255a25b937622086090eff"
});

const messaging = firebase.messaging();

// Arriva un messaggio mentre l'app è chiusa: mostro la notifica con la tua foto
messaging.onBackgroundMessage(function (payload) {
  const data = payload.data || {};
  self.registration.showNotification(data.title || 'Bambocchan Care', {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || undefined
  });
});

const CACHE_NAME = 'bambocchan-care-v3';

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
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) { return; }
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
      return self.clients.openWindow('./');
    })
  );
});
