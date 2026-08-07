import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";

test("package digest matches Kestral's length-prefixed UTF-8 stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-notes-digest-"));
  try {
    await mkdir(join(root, "ui"), { recursive: true });
    await writeFile(join(root, "app.json"), JSON.stringify({ integrity: { assets: { "ui/z.txt": "", "ui/a.txt": "" } } }));
    await writeFile(join(root, "ui/z.txt"), "z\n");
    await writeFile(join(root, "ui/a.txt"), "a");
    await writeFile(join(root, "app.signature.json"), "detached signature is excluded");

    const hash = createHash("sha256");
    for (const path of ["app.json", "ui/a.txt", "ui/z.txt"]) {
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

    assert.equal(await packageDigest(root), `sha256-${hash.digest("hex")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package digest rejects undeclared payload files", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-notes-digest-"));
  try {
    await mkdir(join(root, "ui"), { recursive: true });
    await writeFile(join(root, "app.json"), JSON.stringify({ integrity: { assets: {} } }));
    await writeFile(join(root, "ui", "unexpected.txt"), "not declared");
    await assert.rejects(packageDigest(root), /package file declaration mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
