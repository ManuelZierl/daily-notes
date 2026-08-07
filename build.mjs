import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { compile } from "svelte/compiler";
import { APP_VERSION, dataCollections, dataLimits, proposalCapability } from "./src/contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const dist = join(here, "dist");
const staging = join(here, `.dist-build-${process.pid}`);
const backup = join(here, `.dist-backup-${process.pid}`);
const APP = "kestral.daily-notes";

const sveltePlugin = {
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const { js, warnings } = compile(source, { filename: args.path, generate: "client", css: "injected", runes: true });
      for (const warning of warnings) console.warn(`svelte: ${warning.message}`);
      return { contents: js.code, loader: "js" };
    });
  },
};

async function bundle(entry) {
  const result = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, metafile: true, logLevel: "warning", format: "iife", platform: "browser", target: "es2022", plugins: [sveltePlugin], loader: { ".css": "text" } });
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll("\\\\", "/");
    const marker = "node_modules/";
    const at = normalized.lastIndexOf(marker);
    if (at < 0) continue;
    const parts = normalized.slice(at + marker.length).split("/");
    packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  return { text: result.outputFiles[0].text, packages };
}

const sha256 = (content) => `sha256-${createHash("sha256").update(content).digest("hex")}`;

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function thirdPartyNotices(packageNames) {
  const packages = [];
  for (const name of [...packageNames].sort()) {
    const directory = join(here, "node_modules", ...name.split("/"));
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    let licenseText = null;
    for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "COPYING"]) {
      try { licenseText = await readFile(join(directory, candidate), "utf8"); break; } catch { /* Try the next conventional name. */ }
    }
    if (!licenseText) throw new Error(`runtime dependency ${name}@${metadata.version} has no readable license file`);
    packages.push({ name, version: metadata.version, license: metadata.license, licenseText: licenseText.trim() });
  }
  const sections = packages.map((dependency) => `${dependency.name}@${dependency.version}\nSPDX license: ${dependency.license}\n\n${dependency.licenseText}`);
  return `Daily Notes third-party notices\n\nThe following dependencies are bundled in the installable package payload.\n\n${sections.join(`\n\n${"=".repeat(72)}\n\n`)}\n`;
}

async function replaceDist() {
  await rm(backup, { recursive: true, force: true });
  if (!(await pathExists(dist))) return rename(staging, dist);
  await rename(dist, backup);
  try { await rename(staging, dist); } catch (error) { await rename(backup, dist); throw error; }
  await rm(backup, { recursive: true, force: true });
}

async function main() {
  const packageDocument = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
  if (packageDocument.version !== APP_VERSION) throw new Error(`package.json version ${packageDocument.version} does not match app version ${APP_VERSION}`);
  const [surfaceBundle, icon, appLicense] = await Promise.all([
    bundle(join(src, "surface", "main.ts")),
    readFile(join(src, "icon.svg")),
    readFile(join(here, "LICENSE")),
  ]);
  const notices = await thirdPartyNotices(surfaceBundle.packages);
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body></body><script>${surfaceBundle.text}</script></html>\n`;
  const manifest = {
    format_version: 1,
    id: APP,
    version: APP_VERSION,
    display_name: "Daily Notes",
    description: "A backend-free local daily workspace with shared hierarchical tasks, plain-text notes, and explicit LLM drafts.",
    publisher: { name: "Kestral reference apps" },
    license: "MIT",
    icon: "ui/icon.svg",
    min_host_version: "0.1.0-alpha.1",
    manifest: {
      capabilities: [proposalCapability],
      surfaces: [{ name: "daily-notes", kind: "dashboard", title: "Daily Notes", description: "Today's shared tasks and daily note blocks.", intents: [{ provider: "llm-provider", capability: "llm.generate" }], ui: { entry: "ui/index.html" } }],
      artifact_types: [{ name: "task-change-proposal", description: "A reviewable Daily Notes task change proposal.", json_schema: proposalCapability.output_schema }],
      grant_requests: [{ scope: { kind: "exact-capability", provider: "llm-provider", capability: "llm.generate" }, data_scope: { kind: "none" }, condition: "requires-approval", reason: "Send only the notes and tasks you explicitly choose to the configured LLM provider.", duration: { kind: "non-expiring" } }],
    },
    consumer_grant_requests: [{ holder: "chat", request: { scope: { kind: "exact-capability", provider: APP, capability: proposalCapability.name }, data_scope: { kind: "all-resources" }, condition: "requires-approval", reason: "Allow Chat to create reviewable task proposals in Daily Notes; proposals never change tasks until you review and apply them.", duration: { kind: "non-expiring" } } }],
    backend: { kind: "none" },
    data: { kind: "host-managed", contract_version: 2, collections: dataCollections, limits: dataLimits, exports: [], proposals: [{ capability: proposalCapability.name, artifact_type: "task-change-proposal", title: "Review task changes", description: "Create a bounded proposal to add or update Daily Notes tasks.", target: { kind: "collection", collection: "tasks" }, payload_schema: proposalCapability.input_schema.properties.payload, max_payload_bytes: 16384 }] },
    integrity: { algorithm: "sha256", assets: { "ui/index.html": sha256(html), "ui/icon.svg": sha256(icon), "ui/LICENSE": sha256(appLicense), "ui/THIRD-PARTY-NOTICES.txt": sha256(notices) } },
  };
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(join(staging, "ui"), { recursive: true });
    await Promise.all([
      writeFile(join(staging, "ui", "index.html"), html),
      writeFile(join(staging, "ui", "icon.svg"), icon),
      writeFile(join(staging, "ui", "LICENSE"), appLicense),
      writeFile(join(staging, "ui", "THIRD-PARTY-NOTICES.txt"), notices),
      writeFile(join(staging, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    ]);
    await replaceDist();
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log("Built Daily Notes package -> dist/");
}

main().catch((error) => { console.error(error); process.exit(1); });
