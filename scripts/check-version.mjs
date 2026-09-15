import { readFile } from "node:fs/promises";

function packageVersion(cargo) {
  const section = cargo.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[)/m)?.[1];
  const version = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error("Could not read [package].version from src-tauri/Cargo.toml");
  return version;
}

function pkgbuildVersion(pkgbuild) {
  const version = pkgbuild.match(/^pkgver=(\S+)\s*$/m)?.[1];
  if (!version) throw new Error("Could not read pkgver from packaging/arch/PKGBUILD");
  return version;
}

function metainfoVersion(xml) {
  // The first <release> is the newest; Flathub reads it as the current version.
  const version = xml.match(/<release\s[^>]*\bversion="([^"]+)"/)?.[1];
  if (!version) throw new Error("Could not read the first <release version> from packaging/flatpak/com.willko.tusk.metainfo.xml");
  return version;
}

const [pkgText, tauriText, cargoText, pkgbuildText, metainfoText] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  readFile(new URL("../packaging/arch/PKGBUILD", import.meta.url), "utf8"),
  readFile(new URL("../packaging/flatpak/com.willko.tusk.metainfo.xml", import.meta.url), "utf8"),
]);

const versions = {
  "package.json": JSON.parse(pkgText).version,
  "src-tauri/tauri.conf.json": JSON.parse(tauriText).version,
  "src-tauri/Cargo.toml": packageVersion(cargoText),
  "packaging/arch/PKGBUILD": pkgbuildVersion(pkgbuildText),
  "packaging/flatpak/com.willko.tusk.metainfo.xml": metainfoVersion(metainfoText),
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
