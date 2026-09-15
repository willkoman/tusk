// Emit a Flathub-ready manifest for a PUBLISHED release.
//
//   node scripts/flathub-manifest.mjs v0.11.0 > com.willko.tusk.yml
//
// The repository manifest (packaging/flatpak/com.willko.tusk.yml) takes the .deb
// files from disk, because CI hands it the bundles it just built. Flathub builds
// from URLs with checksums instead, so this swaps the block between the
// `# sources:begin` / `# sources:end` markers for the release's .deb assets and
// their sha256 (GitHub reports one per asset; it is downloaded and hashed when
// the API does not). Submit the output to https://github.com/flathub/flathub
// per https://docs.flathub.org/docs/for-app-authors/submission.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const REPO = "willkoman/tusk";
const ARCHES = [
  { flatpak: "x86_64", deb: "amd64" },
  { flatpak: "aarch64", deb: "arm64" },
];

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("usage: node scripts/flathub-manifest.mjs vX.Y.Z");
  process.exit(2);
}
const version = tag.slice(1);

const headers = { accept: "application/vnd.github+json", "user-agent": "tusk-flathub-manifest" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers });
if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${tag}: is the release published?`);
const release = await res.json();

async function sha256Of(asset) {
  const digest = asset.digest ?? "";
  if (digest.startsWith("sha256:")) return digest.slice("sha256:".length);
  const body = await fetch(asset.browser_download_url, { headers: { "user-agent": headers["user-agent"] } });
  if (!body.ok) throw new Error(`download of ${asset.name} failed: ${body.status}`);
  return createHash("sha256").update(Buffer.from(await body.arrayBuffer())).digest("hex");
}

const blocks = [];
for (const arch of ARCHES) {
  const name = `tusk_${version}_${arch.deb}.deb`;
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`${tag} has no asset named ${name}`);
  const sha256 = await sha256Of(asset);
  blocks.push(
    [
      "      - type: file",
      `        url: ${asset.browser_download_url}`,
      `        sha256: ${sha256}`,
      "        dest-filename: tusk.deb",
      `        only-arches: [${arch.flatpak}]`,
    ].join("\n"),
  );
}

const manifest = await readFile(new URL("../packaging/flatpak/com.willko.tusk.yml", import.meta.url), "utf8");
const begin = manifest.indexOf("      # sources:begin");
const end = manifest.indexOf("      # sources:end");
if (begin < 0 || end < 0 || end < begin) throw new Error("manifest lacks the sources:begin / sources:end markers");
const endOfEndLine = manifest.indexOf("\n", end) + 1;
process.stdout.write(manifest.slice(0, begin) + blocks.join("\n") + "\n" + manifest.slice(endOfEndLine));
