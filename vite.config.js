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
        short_name: 'OMS Portal',
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
  build: {
    rollupOptions: {
      output: {
        // 🟩 BUNDLE SIZE: vendor libraries change far less often than app
        // code, but without explicit grouping Rollup was folding them into
        // the same entry chunk as App.jsx — so every deploy invalidated the
        // browser's cached copy of React/Supabase/i18next too, not just the
        // app code that actually changed. Splitting them into their own
        // chunks lets returning users skip re-downloading these on a deploy
        // that only touched app code.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'vendor-react';
          if (id.includes('@supabase')) return 'vendor-supabase';
          if (id.includes('i18next')) return 'vendor-i18n';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
  },
})
