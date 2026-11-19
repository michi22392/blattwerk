/* =====================================================================
   Blattwerk – Service Worker für Push-Benachrichtigungen
   ---------------------------------------------------------------------
   Liegt im Hauptverzeichnis neben index.html.
   - Empfängt Push-Nachrichten von Firebase Cloud Messaging (FCM) und
     zeigt sie mit Titel, Text und App-Icon an.
   - Beim Antippen wird Blattwerk geöffnet bzw. in den Vordergrund geholt
     und der Reiter "Pflanzen" angezeigt.
   Das Firebase-SDK wird hier absichtlich NICHT geladen: FCM liefert die
   Nachricht als normale Web-Push-Nachricht, die wir selbst anzeigen.
   ===================================================================== */

// Adresse der App (Ordner, in dem diese Datei liegt) und App-Icon
const APP_URL = self.registration.scope;
const ICON_URL = new URL('icons/icon-192.png', APP_URL).href;

// Neue Version sofort aktivieren
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Push-Nachricht empfangen und anzeigen
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { notification: { body: event.data ? event.data.text() : '' } };
  }
  const n = payload.notification || {};
  const d = payload.data || {};
  const link = (payload.fcmOptions && payload.fcmOptions.link) || n.click_action || d.link || APP_URL;

  const title = n.title || d.title || 'Blattwerk';
  const options = {
    body: n.body || d.body || '',
    icon: n.icon || ICON_URL,
    badge: n.badge || ICON_URL,
    tag: n.tag || 'giess-erinnerung',   // neue Erinnerung ersetzt die alte
    data: { link }
  };
  // iOS verlangt, dass jede Push-Nachricht sichtbar angezeigt wird
  event.waitUntil(self.registration.showNotification(title, options));
});

// Benachrichtigung angetippt: App öffnen bzw. nach vorne holen, Reiter "Pflanzen" zeigen
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || APP_URL;
  const target = String(link).startsWith(APP_URL) ? link : APP_URL;   // nur die eigene App öffnen

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of windows) {
      if (win.url.startsWith(APP_URL)) {
        win.postMessage({ type: 'blattwerk-show-tab', tab: 'plants' });
        if ('focus' in win) return win.focus();
        return undefined;
      }
    }
    return self.clients.openWindow(target);
  })());
});
