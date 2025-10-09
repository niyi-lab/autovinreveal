// tailwind.config.js
export default {
  darkMode: 'class',
  content: [
    "./public/**/*.html",
    "./public/**/*.js",
    "./app.js"
  ],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#2563eb', dark: '#1d4ed8' }
      }
    }
  },
  corePlugins: { preflight: false }, // keeps your own reset/styles intact
  plugins: []
};
