import path from "node:path";
import { defineConfig } from "vite-plus";
import { omrSimulator } from "./server/plugin.ts";

// The Mini Program to serve: OMR_PROJECT, or the bundled example
const project = path.resolve(
  process.env.OMR_PROJECT ?? path.join(import.meta.dirname, "../../examples/auth-demo"),
);

export default defineConfig({
  plugins: [omrSimulator({ project })],
  build: { target: "es2023" },
  worker: { format: "es" },
  server: { host: true, allowedHosts: true },
  test: { passWithNoTests: true },
});
