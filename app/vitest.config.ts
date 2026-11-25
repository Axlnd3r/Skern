import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The root vitest config excludes app/**; app tests run from here (`pnpm test` inside app/).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
  },
});
