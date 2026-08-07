import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIGNATURE_FILE = "app.signature.json";

export async function packageDigest(packageDirectory) {
  const root = resolve(packageDirectory instanceof URL ? fileURLToPath(packageDirectory) : packageDirectory);
  const document = JSON.parse(await readFile(join(root, "app.json"), "utf8"));
  const assets = document?.integrity?.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    throw new Error("app.json must declare integrity.assets");
  }

  const declared = new Set(["app.json", ...Object.keys(assets)]);
  const actual = await packageFiles(root);
  actual.delete(SIGNATURE_FILE);
  const extra = [...actual].filter((path) => !declared.has(path));
  const missing = [...declared].filter((path) => !actual.has(path));
  if (extra.length || missing.length) {
    throw new Error(`package file declaration mismatch; extra=${JSON.stringify(extra.sort())}, missing=${JSON.stringify(missing.sort())}`);
  }

  const hash = createHash("sha256");
  for (const path of [...declared].sort(compareUtf8)) {
    const bytes = await readFile(join(root, ...path.split("/")));
    const pathBytes = Buffer.from(path, "utf8");
    const pathLength = Buffer.alloc(8);
    const fileLength = Buffer.alloc(8);
    pathLength.writeBigUInt64LE(BigInt(pathBytes.length));
    fileLength.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(fileLength);
    hash.update(bytes);
  }
  return `sha256-${hash.digest("hex")}`;
}

async function packageFiles(root, current = root, files = new Set()) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`package symlinks are unsupported: ${path}`);
    if (entry.isDirectory()) {
      await packageFiles(root, path, files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported package file type: ${path}`);
    const normalized = relative(root, path).replaceAll("\\", "/");
    if (files.has(normalized)) throw new Error(`duplicate normalized package path '${normalized}'`);
    files.add(normalized);
  }
  return files;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDirectory = process.argv[2] ?? "dist";
  packageDigest(packageDirectory)
    .then((digest) => console.log(digest))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
