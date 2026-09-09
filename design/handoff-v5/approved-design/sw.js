// Design preview: always request the selected page, never substitute another document.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// No fetch interception. Existing app data in localStorage is untouched.
