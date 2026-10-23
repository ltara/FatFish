import { defineConfig } from "vite";

// Vanilla HTML/JS under src/. Tauri loads this via beforeDevCommand / frontendDist.
export default defineConfig({
  root: "src",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
