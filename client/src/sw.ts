/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { clientsClaim } from 'workbox-core'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }

self.skipWaiting()
clientsClaim()
precacheAndRoute(self.__WB_MANIFEST)

// ── Web Share Target ─────────────────────────────────────────────────────────
// เมื่อผู้ใช้กด "แชร์" รูปจากแอปอื่น (ไลน์/แกลเลอรี) มายังแอปนี้ (Android) → POST /share-target
// เก็บไฟล์ลง Cache Storage ชั่วคราว แล้ว redirect ไปหน้าแอปพร้อม ?shared=1 (แอปอ่านไปเติมฟอร์ม)
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url)
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith((async () => {
      try {
        const form = await event.request.formData()
        const files = form.getAll('images').filter((f): f is File => f instanceof File)
        const cache = await caches.open('shared-media')
        await cache.put('/__shared_count', new Response(String(files.length)))
        for (let i = 0; i < files.length; i++) {
          await cache.put(`/__shared_${i}`, new Response(files[i], { headers: { 'content-type': files[i].type || 'image/jpeg' } }))
        }
      } catch { /* เก็บไม่ได้ก็ redirect เปล่าๆ */ }
      return Response.redirect('/?shared=1', 303)
    })())
  }
})
