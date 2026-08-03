import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Attendance depends on live GPS + webcam + Supabase auth, none of
      // which work meaningfully offline — this only exists so the app is
      // installable and loads instantly on repeat visits, not for offline use.
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        navigateFallbackDenylist: [/^\/api\//],
        // The main bundle pulls in face-api.js/transformers and clears 2MB;
        // .wasm model runtimes are intentionally left out of globPatterns
        // above (multi-MB, loaded on demand) rather than precached.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'Employee Monitoring Portal',
        short_name: 'CESD Portal',
        description: 'Internship attendance, tasks, leave, and performance monitoring.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
  },
})
