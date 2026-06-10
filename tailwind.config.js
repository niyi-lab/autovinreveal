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
  corePlugins: { preflight: true }, // matches the Play CDN (which applied preflight) now that we ship built CSS
  plugins: []
};
