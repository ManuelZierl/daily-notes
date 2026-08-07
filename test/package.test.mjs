import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageRoot = new URL("../dist/", import.meta.url);

test("the installable package is backend-free and declares host-managed data", async () => {
  const manifest = JSON.parse(await readFile(new URL("app.json", packageRoot), "utf8"));
  assert.equal(manifest.version, "0.2.1");
  assert.equal(manifest.id, "kestral.daily-notes");
  assert.deepEqual(manifest.backend, { kind: "none" });
  assert.deepEqual(manifest.manifest.capabilities.map((capability) => capability.name), ["propose-task-changes"]);
  assert.deepEqual(Object.keys(manifest.data.collections).sort(), ["applied-proposals", "days", "notes", "tasks"]);
  assert.equal(manifest.data.kind, "host-managed");
  assert.equal(manifest.data.contract_version, 2);
  assert.equal(manifest.data.limits.batch_operations, 2048);
  assert.equal(manifest.data.documents, undefined);
  assert.equal(manifest.data.proposals[0].target.collection, "tasks");
  assert.equal(manifest.data.proposals[0].max_payload_bytes, 16384);
  assert.equal(await readFile(new URL("ui/LICENSE", packageRoot), "utf8"), await readFile(new URL("../LICENSE", import.meta.url), "utf8"));
  assert.match(await readFile(new URL("ui/THIRD-PARTY-NOTICES.txt", packageRoot), "utf8"), /^Daily Notes third-party notices\n/);
  assert.deepEqual(manifest.consumer_grant_requests[0], {
    holder: "chat",
    request: {
      scope: { kind: "exact-capability", provider: "kestral.daily-notes", capability: "propose-task-changes" },
      data_scope: { kind: "all-resources" },
      condition: "requires-approval",
      reason: "Allow Chat to create reviewable task proposals in Daily Notes; proposals never change tasks until you review and apply them.",
      duration: { kind: "non-expiring" },
    },
  });
  assert.equal(manifest.manifest.artifact_types[0].json_schema.required.includes("payload"), true);
  const declaredBindings = new Set([...manifest.data.exports.map((entry) => entry.capability), ...manifest.data.proposals.map((entry) => entry.capability)]);
  assert.deepEqual(manifest.manifest.capabilities.map((capability) => capability.name).filter((name) => !declaredBindings.has(name)), []);
  assert.deepEqual(manifest.integrity.assets && Object.keys(manifest.integrity.assets).sort(), ["ui/LICENSE", "ui/THIRD-PARTY-NOTICES.txt", "ui/icon.svg", "ui/index.html"]);
  assert.ok(!Object.keys(manifest.integrity.assets).some((path) => path.startsWith("backend/")));
  await assert.rejects(access(new URL("backend", packageRoot)));
});

test("the surface contains no native backend or direct provider runtime", async () => {
  const html = await readFile(new URL("ui/index.html", packageRoot), "utf8");
  assert.match(html, /appHost/);
  assert.match(html, /data\.v2/);
  assert.doesNotMatch(html, /__TAURI__|APP_HOST_DATA_DIR|mcp|backend\/server|api[_-]?key/i);
  assert.doesNotMatch(html, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.match(html, /var\(--color-text\)/);
});

test("package integrity covers every declared payload asset", async () => {
  const manifest = JSON.parse(await readFile(new URL("app.json", packageRoot), "utf8"));
  for (const [path, expected] of Object.entries(manifest.integrity.assets)) {
    const bytes = await readFile(new URL(path, packageRoot));
    assert.equal(`sha256-${createHash("sha256").update(bytes).digest("hex")}`, expected);
  }
});
