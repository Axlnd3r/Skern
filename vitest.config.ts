import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/**/*.test.ts", "keeper/**/*.test.ts", "agents/**/*.test.ts"],
    exclude: ["node_modules", "contracts/lib", "app/**"],
  },
});
