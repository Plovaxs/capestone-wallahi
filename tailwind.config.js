// tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  // --- ADD THIS LINE ---
  darkMode: 'class', 
  // --- END ---
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // 🟩 DESIGN SYSTEM: named brand tokens so new UI (Button/Card/etc.)
      // references `brand-*` instead of hardcoding `blue-600` like the
      // rest of the app historically did. Values matched to the existing
      // dominant blue so this doesn't shift any current screen's color.
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
      },
      boxShadow: {
        'brand-glow': '0 8px 24px -8px rgba(37, 99, 235, 0.35)',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
}