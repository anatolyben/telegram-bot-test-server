/**
 * Watch several servers at once. Every server started with `ui: true`
 * announces its viewer in a shared folder on this computer and withdraws it
 * when it stops; `telegram-bot-test-server watch` serves one page that shows
 * each announced viewer side by side, adding and removing them as servers
 * start and stop.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/** Where servers announce their viewers (override for tests). */
export function announceDir() {
  return (
    process.env.TELEGRAM_TEST_SERVER_WATCH_DIR ||
    path.join(tmpdir(), "telegram-bot-test-server", "viewers")
  );
}

/** Announce a viewer; returns the function that withdraws it. */
export function announceViewer({ url, name, port }) {
  const dir = announceDir();
  const file = path.join(dir, `${process.pid}-${port}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        url,
        name: name ?? null,
        pid: process.pid,
        startedAt: Date.now(),
      }),
    );
  } catch {
    // Watching is optional: a server never fails to start over it.
    return () => {};
  }
  return () => rmSync(file, { force: true });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The announced viewers of running servers, oldest first. */
export function announcedViewers() {
  const dir = announceDir();
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const viewers = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8"));
      // A server that ended without stopping leaves its file behind.
      if (!alive(entry.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      viewers.push(entry);
    } catch {
      // Being written or removed right now.
    }
  }
  return viewers.sort((a, b) => a.startedAt - b.startedAt);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test servers</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f172a; color: #e2e8f0;
    font: 13px system-ui, sans-serif; }
  #wall { display: flex; height: 100%; }
  .pane { display: flex; flex-direction: column; min-width: 120px; flex: 1 1 0; }
  .pane header { padding: 4px 8px; background: #1e293b; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .pane iframe { flex: 1; border: 0; background: #fff; width: 100%; }
  .divider { flex: 0 0 6px; cursor: col-resize; background: #334155; }
  .divider:hover, .divider.dragging { background: #38bdf8; }
  #empty { margin: auto; color: #94a3b8; }
  body.dragging iframe { pointer-events: none; }
</style></head>
<body><div id="wall"><p id="empty">No test server with a viewer is running.</p></div>
<script>
const wall = document.getElementById("wall");
const panes = new Map();
function addDivider(before) {
  const divider = document.createElement("div");
  divider.className = "divider";
  divider.addEventListener("pointerdown", (event) => {
    const left = divider.previousElementSibling;
    const right = divider.nextElementSibling;
    const startX = event.clientX;
    const leftW = left.getBoundingClientRect().width;
    const rightW = right.getBoundingClientRect().width;
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("dragging");
    document.body.classList.add("dragging");
    const move = (e) => {
      const dx = Math.max(120 - leftW, Math.min(rightW - 120, e.clientX - startX));
      left.style.flex = "0 0 " + (leftW + dx) + "px";
      right.style.flex = "0 0 " + (rightW - dx) + "px";
    };
    const up = () => {
      divider.classList.remove("dragging");
      document.body.classList.remove("dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });
  wall.insertBefore(divider, before);
}
async function refresh() {
  let viewers = [];
  try { viewers = await (await fetch("servers")).json(); } catch {}
  const live = new Set(viewers.map((v) => v.url));
  let changed = false;
  for (const [url, pane] of panes) {
    if (!live.has(url)) { pane.remove(); panes.delete(url); changed = true; }
  }
  for (const viewer of viewers) {
    if (panes.has(viewer.url)) continue;
    const pane = document.createElement("section");
    pane.className = "pane";
    const header = document.createElement("header");
    header.textContent = viewer.name || viewer.url;
    header.title = viewer.url;
    const frame = document.createElement("iframe");
    frame.src = viewer.url;
    pane.append(header, frame);
    wall.append(pane);
    panes.set(viewer.url, pane);
    changed = true;
  }
  if (!changed) return;
  for (const divider of [...wall.querySelectorAll(".divider")]) divider.remove();
  const list = [...wall.querySelectorAll(".pane")];
  for (const pane of list) pane.style.flex = "";
  list.forEach((pane, i) => { if (i > 0) addDivider(pane); });
  document.getElementById("empty").hidden = list.length > 0;
}
refresh();
setInterval(refresh, 2000);
</script></body></html>`;

/**
 * Serve the watch page. With idleExitMs, close once no server has been
 * announced for that long (for a page started by the tests themselves).
 */
export async function startWatch({
  port = 8090,
  host = "127.0.0.1",
  idleExitMs = null,
} = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/servers") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify(
          announcedViewers().map(({ url: viewerUrl, name }) => ({
            url: viewerUrl,
            name,
          })),
        ),
      );
      return;
    }
    if (url.pathname !== "/") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src http://127.0.0.1:* http://localhost:* http://[::1]:*; base-uri 'none'; form-action 'none'",
    });
    response.end(PAGE);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  let idleTimer = null;
  if (idleExitMs) {
    let lastSeen = Date.now();
    idleTimer = setInterval(() => {
      if (announcedViewers().length > 0) lastSeen = Date.now();
      else if (Date.now() - lastSeen > idleExitMs) close();
    }, Math.min(idleExitMs, 5_000));
  }
  const address = server.address();
  const close = () =>
    new Promise((resolve) => {
      clearInterval(idleTimer);
      server.close(resolve);
      server.closeAllConnections();
    });
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}/`,
    closed: new Promise((resolve) => server.once("close", resolve)),
    close,
  };
}
