import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startTestServer } from "../src/index.js";
import { startWatch } from "../src/watch.js";

let dir;
const open = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "watch-test-"));
  process.env.TELEGRAM_TEST_SERVER_WATCH_DIR = dir;
});
afterEach(async () => {
  for (const item of open.splice(0)) await (item.stop ?? item.close)();
  delete process.env.TELEGRAM_TEST_SERVER_WATCH_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function servers(watch) {
  return (await fetch(`${watch.url}servers`)).json();
}

it("lists each running server's viewer by name, and drops it when it stops", async () => {
  const first = await startTestServer({ botToken: "1:A", ui: true, name: "worker 1" });
  const second = await startTestServer({ botToken: "2:B", ui: true });
  const quiet = await startTestServer({ botToken: "3:C" });
  open.push(first, second, quiet);
  const watch = await startWatch({ port: 0 });
  open.push(watch);

  expect(await servers(watch)).toEqual([
    { url: first.viewerUrl, name: "worker 1" },
    { url: second.viewerUrl, name: null },
  ]);
  await first.stop();
  expect(await servers(watch)).toEqual([{ url: second.viewerUrl, name: null }]);
});

it("forgets a server that ended without stopping", async () => {
  // A process id that is not running.
  writeFileSync(
    path.join(dir, "999999-1.json"),
    JSON.stringify({ url: "http://127.0.0.1:1/_fake/ui", pid: 999999, startedAt: 1 }),
  );
  const watch = await startWatch({ port: 0 });
  open.push(watch);
  expect(await servers(watch)).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

it("serves the page that frames the viewers, and nothing else", async () => {
  const watch = await startWatch({ port: 0 });
  open.push(watch);
  const page = await fetch(watch.url);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(
    "frame-src http://127.0.0.1:* http://localhost:* http://[::1]:*",
  );
  expect((await fetch(`${watch.url}other`)).status).toBe(404);
});
