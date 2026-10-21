import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// https://vite.dev/config/
// Zwei Seiten (Audit/Website-Redesign 2026-09-28):
//   index.html - statische Startseite (Vorstellung, kein Login, keine Daten)
//   app.html   - die eigentliche Web-App (React, Ende-zu-Ende-verschluesselt)
// Beide werden vom Relay aus web/dist ausgeliefert (relay.js tryServeStatic).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
})
