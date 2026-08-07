import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the packaged surface keeps the mobile and reduced-motion safeguards", async () => {
  const html = await readFile(new URL("../dist/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /viewport[^>]+width=device-width/);
  assert.match(html, /grid-template-columns:\s*1fr/);
  assert.match(html, /@media \(max-width: 44em\)/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(html, /@media \([^)]*px/);
});
