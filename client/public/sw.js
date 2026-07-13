// Self-destroying service worker — ล้าง PWA/แคชเก่า แล้วถอนตัวเอง
// (เคยทำแอปเป็น PWA ชั่วคราว → ถอดออกแล้ว ไฟล์นี้กันเครื่องที่ยังมี SW เก่าค้างไม่ให้เห็นแอปเวอร์ชันเก่า)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));   // ล้างแคชทั้งหมด
      await self.registration.unregister();                    // ถอน service worker
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.navigate(c.url));               // รีโหลดหน้าให้เห็นเวอร์ชันล่าสุด
    } catch { /* เงียบไว้ */ }
  })());
});
