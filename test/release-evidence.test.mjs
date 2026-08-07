import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";
import {
  LIFECYCLE_CHECKS,
  createEvidence,
  validateObservations,
  workflowUrl,
} from "../scripts/release-evidence.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function observations() {
  return {
    tested_at: "2026-08-06T12:00:00Z",
    platforms: ["windows-x86_64", "linux-x86_64"],
    lifecycle: Object.fromEntries(LIFECYCLE_CHECKS.map((check) => [check, {
      status: "passed",
      observation: `Manual Daily Notes host observation for ${check}.`,
    }])),
  };
}

test("derives an Actions URL only from GitHub run environment", () => {
  assert.equal(workflowUrl({
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "ManuelZierl/daily-notes",
    GITHUB_RUN_ID: "12345",
  }), "https://github.com/ManuelZierl/daily-notes/actions/runs/12345");
  assert.throws(() => workflowUrl({ GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "1" }), /GITHUB_SERVER_URL/);
});

test("rejects missing, unknown, malformed, and non-passed observations", () => {
  const value = observations();
  assert.throws(() => validateObservations({ ...value, unexpected: true }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, extra: { status: "passed", observation: "x" } } }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, activation: { status: "failed", observation: "x" } } }), /must be 'passed'/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, restart: undefined } }), /must be an object/);
  assert.throws(() => validateObservations({ ...value, platforms: ["linux-x86_64", "linux-x86_64"] }), /must not contain duplicates/);
});

test("creates evidence for a valid declared backend without executing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-notes-release-evidence-"));
  await mkdir(join(root, "dist", "ui"), { recursive: true });
  await writeFile(join(root, "dist", "ui", "index.html"), "<!doctype html>\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "kestral-daily-notes", version: "0.2.1" }));
  await writeFile(join(root, "dist", "app.json"), JSON.stringify({
    id: "kestral.daily-notes",
    version: "0.2.1",
    backend: { kind: "mcp-stdio", authority_mode: "unsandboxed", command: "daily-notes" },
    manifest: {},
    integrity: { algorithm: "sha256", assets: { "ui/index.html": "sha256-ignored" } },
  }));
  const digest = await packageDigest(join(root, "dist"));
  const context = {
    root,
    observations: observations(),
    expectedPackageDigest: digest,
    hostVersion: "0.1.0-alpha.1",
    hostCommit: HEAD,
    env: {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "ManuelZierl/daily-notes",
      GITHUB_RUN_ID: "12345",
      GITHUB_SHA: HEAD,
    },
    git: (args) => args[0] === "rev-parse" ? HEAD : "",
    expectedAppId: "kestral.daily-notes",
    expectedRepository: "https://github.com/ManuelZierl/daily-notes",
  };
  const evidence = await createEvidence(context);
  assert.deepEqual(evidence.app, { id: "kestral.daily-notes", version: "0.2.1" });
  assert.equal(evidence.source.clean, true);
  assert.equal(evidence.package.digest, digest);
  assert.equal(evidence.run.workflow_url, "https://github.com/ManuelZierl/daily-notes/actions/runs/12345");
  assert.deepEqual(evidence.extension_contributions, []);
  await assert.rejects(() => createEvidence({ ...context, expectedPackageDigest: "sha256-0000000000000000000000000000000000000000000000000000000000000000" }), /package digest mismatch/);
  await assert.rejects(() => createEvidence({ ...context, env: { ...context.env, GITHUB_SHA: "fedcba9876543210fedcba9876543210fedcba98" } }), /does not match source HEAD/);
  await assert.rejects(() => createEvidence({ ...context, git: (args) => args[0] === "rev-parse" ? HEAD : " M package.json" }), /source checkout is not clean/);
});
