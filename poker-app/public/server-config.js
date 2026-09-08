// public/server-config.js
// Bestimmt, welchen Server socket.io in app.js ansprechen soll – wird VOR
// app.js geladen (siehe index.html) und setzt dafür window.POKER_SERVER_URL.
//
// Zwei Fälle:
// 1. Diese Seite läuft normal im Browser, ausgeliefert vom Express-Server
//    selbst (lokal per `npm start` oder z. B. über Render) – dann soll
//    socket.io wie bisher denselben Origin ansprechen wie die Seite selbst
//    (window.POKER_SERVER_URL bleibt leer, io() verbindet sich ohne
//    explizite URL automatisch mit dem eigenen Origin).
// 2. Diese Seite läuft als lokal gebündelte Kopie in einer nativen App
//    (siehe capacitor.config.json/README "Native App (iOS/Android, über
//    Capacitor)") – der Origin ist dann z. B. "capacitor://localhost",
//    dort läuft kein eigener Server. window.Capacitor.isNativePlatform()
//    wird automatisch von der Capacitor-Laufzeit bereitgestellt, ganz ohne
//    ein eigenes <script>-Tag dafür laden zu müssen. In diesem Fall muss
//    explizit der echte, dauerhaft erreichbare Server angesprochen werden.
(function () {
  // TODO: An die eigene Produktions-URL anpassen, falls abweichend vom
  // aktuellen Render-Deployment (siehe public/sitemap.xml).
  var NATIVE_SERVER_URL = 'https://poker-app-njw8.onrender.com';

  var isNative =
    typeof window.Capacitor !== 'undefined' &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();

  window.POKER_SERVER_URL = isNative ? NATIVE_SERVER_URL : '';
})();
