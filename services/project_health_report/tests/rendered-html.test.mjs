import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("build emits the project health worker and finished metadata", async () => {
  const [layout, dashboard] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/Dashboard.tsx", import.meta.url), "utf8"),
    access(new URL("../dist/server/index.js", import.meta.url)),
  ]);
  assert.match(layout, /Graphing · Project Health Report/);
  assert.match(dashboard, /Building the health report/);
  assert.doesNotMatch(`${layout}\n${dashboard}`, /codex-preview|react-loading-skeleton|Starter Project/i);
});
