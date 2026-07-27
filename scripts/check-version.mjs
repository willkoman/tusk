import { readFile } from "node:fs/promises";

function packageVersion(cargo) {
  const section = cargo.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[)/m)?.[1];
  const version = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error("Could not read [package].version from src-tauri/Cargo.toml");
  return version;
}

const [pkgText, tauriText, cargoText] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
]);

const versions = {
  "package.json": JSON.parse(pkgText).version,
  "src-tauri/tauri.conf.json": JSON.parse(tauriText).version,
  "src-tauri/Cargo.toml": packageVersion(cargoText),
};
const unique = new Set(Object.values(versions));
if (unique.size !== 1 || unique.has(undefined)) {
  throw new Error(`Version mismatch: ${JSON.stringify(versions)}`);
}

const tagArg = process.argv.indexOf("--tag");
const tag = tagArg >= 0 ? process.argv[tagArg + 1] : process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tagArg >= 0 && !tag) throw new Error("--tag requires a value");
if (tag && tag !== `v${versions["package.json"]}`) {
  throw new Error(`Release tag ${tag} does not match v${versions["package.json"]}`);
}

console.log(`Version ${versions["package.json"]}${tag ? ` matches ${tag}` : " matches all manifests"}`);
