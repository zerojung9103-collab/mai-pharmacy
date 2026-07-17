// Service Worker — ใหม่เภสัช PWA
// เวอร์ชัน cache (เปลี่ยนเลขนี้ทุกครั้งที่อัปเดตแอพ เพื่อให้ผู้ใช้ได้ของใหม่)
const CACHE = 'maipharmacy-v355';
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

// ===== 🔔 การแจ้งเตือนเด้ง (Push Notifications) =====
// รับข้อความจากเซิร์ฟเวอร์ (Cloudflare Worker → FCM) แล้วแสดงเป็นแจ้งเตือนบนเครื่อง
self.addEventListener('push', e => {
  let d = {};
  try {
    const j = e.data ? e.data.json() : {};
    d = j.data || j.notification || j; // รองรับหลายรูปแบบ payload
  } catch (err) {
    d = { title: 'ใหม่เภสัช', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(self.registration.showNotification(d.title || 'ใหม่เภสัช', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || 'nm',   // เรื่องเดียวกันทับข้อความเก่า ไม่กองซ้อน
    data: { url: d.url || './app.html' }
  }));
});

// แตะแจ้งเตือน → เปิด/สลับไปที่แอป
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './app.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.includes('app.html') && 'focus' in c) return c.focus();
    }
    return clients.openWindow(url);
  }));
});
