import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: { "@": path.join(root, "renderer-src") } },
  build: {
    target: "chrome130",
    outDir: path.join(root, "renderer/assets"),
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: path.join(root, "renderer-src/main.tsx"), name: "FatFishUI", formats: ["iife"], fileName: () => "ui.min.js", cssFileName: "ui.min" },
  },
});
