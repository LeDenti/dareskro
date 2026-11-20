import { resolve } from "node:path";
import { defineConfig } from "vite";

// two pages: index.html (devnet, the hackathon page) and connect.html (mainnet, Intents Connect)
export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), connect: resolve(import.meta.dirname, "connect.html") } },
  },
});
