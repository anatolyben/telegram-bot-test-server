/**
 * The live chat viewer's HTTP side, under /_fake/ui: the page and its
 * assets, the chat data (state.js), stored images, and one event stream that
 * tells open pages the server changed.
 *
 * It answers only requests made on this computer to the server's own
 * address, and only GET. It is a test tool beside the Bot API, not part of
 * it: nothing here reaches a bot.
 */
import { readFile } from "node:fs/promises";
import { createUiState } from "./state.js";

// The page's files, all from this directory.
const ASSETS = {
  "boot.js": "text/javascript; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "views.js": "text/javascript; charset=utf-8",
  "render.js": "text/javascript; charset=utf-8",
  "interact.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
};
// The page loads only its own scripts, styles, images and data.
const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};
// The headers a proxy or tunnel adds: a request through one is not local,
// though it arrives from loopback.
const FORWARDING = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
];
// Changes are told at most this often, and a quiet stream pinged this often.
const CHANGE_MS = 100;
const PING_MS = 15_000;

/**
 * The viewer for a server listening on `port`, reading `model`; `url` is the
 * page's address, which a refused request is told.
 */
export function createViewer({ port, url, model, log = () => {} }) {
  const ui = createUiState(model);
  const assets = new Map();
  const streams = new Set();
  let told = model.version();
  let toldAt = 0;
  let pending = null;
  let ping = null;
  let closed = false;

  /**
   * A request from this computer to this server: from a loopback address,
   * for a loopback host name with the server's port (so a page on another
   * site cannot reach it by rebinding its name), and through no proxy.
   */
  function local(request) {
    const remote = request.socket.remoteAddress ?? "";
    const host = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]):(\d+)$/i.exec(
      String(request.headers.host ?? ""),
    );
    return (
      (remote.startsWith("127.") ||
        remote === "::1" ||
        remote.startsWith("::ffff:127.")) &&
      host !== null &&
      Number(host[2]) === port &&
      !FORWARDING.some((name) => request.headers[name] !== undefined)
    );
  }

  function answer(response, status, type, body, headers = {}) {
    response.writeHead(status, {
      ...HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": type,
      ...headers,
    });
    response.end(body);
  }

  function text(response, status, body, headers) {
    answer(response, status, "text/plain; charset=utf-8", body, headers);
  }

  function json(response, status, value) {
    answer(
      response,
      status,
      "application/json; charset=utf-8",
      JSON.stringify(value),
    );
  }

  /** A file of the page, read once. */
  function asset(name) {
    if (!assets.has(name)) {
      assets.set(
        name,
        readFile(new URL(`./${name}`, import.meta.url)).catch(() => null),
      );
    }
    return assets.get(name);
  }

  async function handle(request, response) {
    try {
      if (!local(request)) {
        text(response, 403, `The viewer answers only on this computer: ${url}`);
        return;
      }
      if (request.method !== "GET") {
        text(response, 405, "The viewer answers only GET", { Allow: "GET" });
        return;
      }
      const target = new URL(request.url, "http://localhost");
      const path = target.pathname;
      const query = Object.fromEntries(target.searchParams);
      if (path === "/_fake/ui") {
        const page = await asset("viewer.html");
        if (!page) text(response, 404, "Not found");
        else {
          answer(response, 200, "text/html; charset=utf-8", page, {
            "Content-Security-Policy": PAGE_POLICY,
          });
        }
        return;
      }
      if (path.startsWith("/_fake/ui/assets/")) {
        const name = path.slice("/_fake/ui/assets/".length);
        const body = Object.hasOwn(ASSETS, name) ? await asset(name) : null;
        if (!body) text(response, 404, "Not found");
        else answer(response, 200, ASSETS[name], body);
        return;
      }
      if (path === "/_fake/ui/api/state") {
        json(response, 200, ui.state(query));
        return;
      }
      if (path.startsWith("/_fake/ui/api/chats/")) {
        const ref = decodeURIComponent(
          path.slice("/_fake/ui/api/chats/".length),
        );
        json(response, 200, ui.page(ref, query));
        return;
      }
      if (path.startsWith("/_fake/ui/files/")) {
        const file = ui.file(
          decodeURIComponent(path.slice("/_fake/ui/files/".length)),
        );
        if (!file) text(response, 404, "Not found");
        else {
          // A file_id is random and its bytes never change.
          answer(response, 200, file.mime_type, file.bytes, {
            "Cache-Control": "private, max-age=31536000, immutable",
          });
        }
        return;
      }
      if (path === "/_fake/ui/events") {
        subscribe(request, response);
        return;
      }
      text(response, 404, "Not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else if (error.status) {
        json(response, error.status, { error: error.message });
      } else if (error instanceof URIError) {
        text(response, 400, "Bad Request");
      } else {
        log(`viewer error: ${error.stack ?? error.message}`);
        json(response, 500, { error: "Internal Server Error" });
      }
    }
  }

  function send(stream, event, data, id) {
    stream.write(
      `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  }

  function versionData() {
    return {
      instance: model.instance(),
      version: model.version(),
      epoch: model.epoch(),
    };
  }

  /**
   * Server-sent events: `hello` on connecting, then `change` whenever the
   * server's state changed, and `stopped` when it stops. They carry only the
   * version: a page refetches what it shows.
   */
  function subscribe(request, response) {
    response.writeHead(200, {
      ...HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    request.socket.setNoDelay(true);
    response.write("retry: 1000\n\n");
    if (closed) {
      send(response, "stopped", {});
      response.end();
      return;
    }
    streams.add(response);
    const hello = versionData();
    send(response, "hello", hello, hello.version);
    response.once("close", () => {
      streams.delete(response);
      if (streams.size === 0) {
        clearInterval(ping);
        ping = null;
      }
    });
    if (!ping) {
      ping = setInterval(() => {
        for (const stream of streams) stream.write(": ping\n\n");
      }, PING_MS);
      ping.unref();
    }
  }

  /** Tell the streams of a change: at most once per CHANGE_MS. */
  function changed() {
    if (closed || pending || streams.size === 0) return;
    pending = setTimeout(
      () => {
        pending = null;
        toldAt = Date.now();
        const data = versionData();
        if (data.version === told) return;
        told = data.version;
        for (const stream of streams)
          send(stream, "change", data, data.version);
      },
      Math.max(0, toldAt + CHANGE_MS - Date.now()),
    );
    pending.unref();
  }

  /** The server stopped: say so on every stream and end it. */
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(pending);
    clearInterval(ping);
    for (const stream of streams) {
      send(stream, "stopped", {});
      stream.end();
    }
    streams.clear();
  }

  return { handle, changed, close };
}
