import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// Most unit tests cover pure TS modules (plan parsers, SQL builders, graph layouts) and
// run in the node environment. A few render real Solid components — those opt in per
// file with a `// @vitest-environment jsdom` docblock, which is why the Solid plugin
// (JSX compilation) and the browser resolve conditions are configured here for everyone.
export default defineConfig({
  // `hot: false` — solid-refresh's HMR shim resolves `/@solid-refresh`, which the test
  // runner has no dev server to serve.
  plugins: [solid({ hot: false })],
  resolve: { conditions: ["development", "browser"] },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
