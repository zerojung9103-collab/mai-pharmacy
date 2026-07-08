// Service Worker — ใหม่เภสัช PWA
// เวอร์ชัน cache (เปลี่ยนเลขนี้ทุกครั้งที่อัปเดตแอพ เพื่อให้ผู้ใช้ได้ของใหม่)
const CACHE = 'maipharmacy-v284';
const ASSETS = [
  './app.html',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ติดตั้ง: เก็บไฟล์หลักไว้
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// เปิดใช้งาน: ลบ cache เก่า
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ดึงข้อมูล: network-first สำหรับ Firebase/API, cache-first สำหรับไฟล์แอพ
self.addEventListener('fetch', e => {
  const url = e.request.url;
  // ไม่แตะ request ที่ไม่ใช่ GET หรือเป็น Firebase/Google API (ต้องสดเสมอ)
  if (e.request.method !== 'GET' ||
      url.includes('firestore') ||
      url.includes('googleapis') ||
      url.includes('firebaseio') ||
      url.includes('identitytoolkit') ||
      url.includes('netlify/functions')) {
    return; // ปล่อยให้ไปเครือข่ายปกติ
  }
  // ไฟล์แอพ: ลองเครือข่ายก่อน ถ้าไม่ได้ใช้ cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
