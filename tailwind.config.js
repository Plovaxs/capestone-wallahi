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
    extend: {},
  },
  plugins: [],
}