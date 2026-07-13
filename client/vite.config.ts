import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',   // ใช้ service worker เอง (src/sw.ts) เพื่อรับ Web Share Target
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: { maximumFileSizeToCacheInBytes: 6 * 1024 * 1024 },
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Back Wash / CIP',
        short_name: 'BackWash',
        description: 'ระบบบันทึกผลิต/CIP + งานประจำวัน',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ff6b00',
        lang: 'th',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // แชร์รูปจากแอปอื่น (ไลน์/แกลเลอรี) เข้าแอปนี้ — Android เท่านั้น
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { files: [{ name: 'images', accept: ['image/*'] }] },
        },
      },
    }),
  ],
  server: {
    host: true, // Listen on all network interfaces (0.0.0.0)
    port: 5173,
    strictPort: true, // Don't try other ports if 5173 is busy
    allowedHosts: ['.loca.lt'], // allow localtunnel public URLs for phone testing
  },
})
