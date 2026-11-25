import { defineConfig } from "vitest/config";

// The root vitest config excludes app/**; app tests run from here (`pnpm test` inside app/).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", ".next"],
  },
});
