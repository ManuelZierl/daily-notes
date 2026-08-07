import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { packageDigest } from "../scripts/package-digest.mjs";

const run = () => {
  const result = spawnSync(process.execPath, ["build.mjs"], { cwd: new URL("..", import.meta.url), stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const checkedIn = await packageDigest(new URL("../dist/", import.meta.url));
run();
const first = await packageDigest(new URL("../dist/", import.meta.url));
assert.equal(first, checkedIn, "checked-in dist must match a clean build");
run();
assert.equal(await packageDigest(new URL("../dist/", import.meta.url)), first, "two clean builds must produce identical package digests");
console.log(`Reproducible package checksum: ${first}`);
