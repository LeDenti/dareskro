// Adapted from LedgerHQ/device-management-kit-ts-workshop (Apache-2.0), see THIRD_PARTY_NOTICES.md
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // accès privé via un tunnel Cloudflare rapide (URL aléatoire, non publiée)
    allowedHosts: ['.trycloudflare.com'],
  },
})
