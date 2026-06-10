import { defineConfig } from "vitest/config";

// Unit tests cover only pure TS modules (plan parsers, graph layouts) — node
// environment, no jsdom, no Solid rendering.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
