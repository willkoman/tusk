import { readFile } from "node:fs/promises";

const allowed = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
]);
const operators = new Set(["AND", "OR", "WITH"]);
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const rejected = [];

for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!path || info.dev === true) continue;
  const license = info.license;
  if (typeof license !== "string" || !license.trim()) {
    rejected.push(`${path}: missing license metadata`);
    continue;
  }
  const ids = license.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g)?.filter((id) => !operators.has(id)) ?? [];
  if (!ids.length || ids.some((id) => !allowed.has(id))) rejected.push(`${path}: ${license}`);
}

if (rejected.length) {
  throw new Error(`Unapproved production dependency licenses:\n${rejected.join("\n")}`);
}
console.log("Production JavaScript dependency licenses approved");
