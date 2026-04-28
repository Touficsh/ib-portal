import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the Agent Portal SPA.
// - Served at /portal by the Express backend in production (see ../backend/src/server.js).
// - `base: '/portal/'` rewrites asset paths so /portal/assets/foo.js resolves correctly.
// - Dev server proxies /api to the backend so auth + data calls work in `vite dev`.
//   Backend PORT defaults to 80 in the user's ecosystem config; override via env.
export default defineConfig({
  base: '/portal/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5201,
    // Bind to all interfaces (both IPv4 127.0.0.1 and IPv6 ::1) so Chrome's
    // localhost resolution works regardless of the address family it picks.
    host: true,
    proxy: {
      '/api': {
        // Force IPv4 explicitly. On Windows Node 18+ resolves 'localhost'
        // to IPv6 (::1) first, and Vite's proxy has been observed to hang
        // indefinitely on that resolution path. 127.0.0.1 is deterministic.
        target: process.env.BACKEND_URL || 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
