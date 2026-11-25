import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      generator: "tsgo",
    },
    // Workspace packages and tests use the sources; the published package uses dist
    exports: { devExports: true },
  },
});
