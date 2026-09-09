import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// A git worktree shares node_modules with the main checkout through a junction, so the
// jsdom suites' dependencies resolve to a real path OUTSIDE the project root and Vite's
// fs guard refuses to serve them. Allow the directory's real location explicitly; in a
// plain checkout this resolves back inside the root and changes nothing.
const nodeModules = resolve(process.cwd(), "node_modules");
const fsAllow = existsSync(nodeModules) ? [process.cwd(), realpathSync(nodeModules)] : [process.cwd()];

// Most unit tests cover pure TS modules (plan parsers, SQL builders, graph layouts) and
// run in the node environment. A few render real Solid components — those opt in per
// file with a `// @vitest-environment jsdom` docblock, which is why the Solid plugin
// (JSX compilation) and the browser resolve conditions are configured here for everyone.
export default defineConfig({
  // `hot: false` — solid-refresh's HMR shim resolves `/@solid-refresh`, which the test
  // runner has no dev server to serve.
  plugins: [solid({ hot: false })],
  resolve: { conditions: ["development", "browser"] },
  server: { fs: { allow: fsAllow } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
