// Print the CHANGELOG.md section for one version (exactly what the What's-new
// popup shows in-app) — the release workflow publishes it as the GitHub release
// body, so users see the same story in both places.
//
//   node scripts/release-notes.mjs 0.9.1
//   node scripts/release-notes.mjs v0.9.1   (tag form accepted)

import { readFile } from "node:fs/promises";

const arg = process.argv[2];
if (!arg) throw new Error("usage: release-notes.mjs <version|vX.Y.Z>");
const version = arg.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${arg}`);

const text = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = text.split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty`);
console.log(body);
