// يحفظ ملفات التطبيق والمكتبات على الجوال ليعمل بدون إنترنت بعد أول فتح.
// لا يرسل أي ملف من ملفات المستخدم لأي مكان.
const CACHE = 'arshifi-v3';
const SHELL = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const CDN = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !CDN.includes(url.hostname)) return;

  if (sameOrigin) {
    // الشبكة أولاً حتى تصل التحديثات، والنسخة المحفوظة عند انقطاع الإنترنت
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
  } else {
    // المكتبات بإصدار ثابت: من المحفوظ أولاً
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    })));
  }
});
