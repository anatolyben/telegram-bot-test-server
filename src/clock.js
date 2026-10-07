/**
 * The time an app under test should use: the test server's clock in tests,
 * Date.now() otherwise.
 *
 * Point TELEGRAM_FAKE_CLOCK_URL at a running server (its origin, or its
 * /_fake/clock URL), call `await refreshFakeClock()` once, then read
 * `fakeClockNow()` wherever the app read Date.now(). The time is cached, so a
 * read costs nothing: refresh it before time-dependent work, or have the
 * server push every change to `fakeClockHandler` (its clockWebhook option).
 *
 * No imports and no dependencies, so an app can load it in production too.
 */

// The last time read or pushed, and the server it came from.
let cache = null;
// Counts pushes, so a slower read never overwrites a newer push.
let generation = 0;

/** The clock URL TELEGRAM_FAKE_CLOCK_URL names, or null when it is unset. */
function clockUrl() {
  const value = process.env.TELEGRAM_FAKE_CLOCK_URL;
  if (!value) return null;
  const url = value.replace(/\/+$/, "");
  return url.endsWith("/_fake/clock") ? url : `${url}/_fake/clock`;
}

/** The time the app should use: the test server's clock in tests, Date.now() otherwise. Synchronous. */
export function fakeClockNow() {
  const url = clockUrl();
  if (url === null) return Date.now();
  if (cache?.url !== url) {
    throw new Error(
      "fakeClockNow: call await refreshFakeClock() once first (TELEGRAM_FAKE_CLOCK_URL is set)",
    );
  }
  // A server on real time uses the wall clock, as this process does.
  return cache.mode === "manual" ? cache.now : Date.now();
}

/** Read GET /_fake/clock now; caches and returns its time (Date.now() when the variable is unset). */
export async function refreshFakeClock() {
  const url = clockUrl();
  if (url === null) return Date.now();
  const before = generation;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`refreshFakeClock: ${url} answered ${response.status}`);
  }
  const { now, mode } = await response.json();
  // A push that arrived meanwhile is newer than this answer.
  if (generation === before) cache = { url, now, mode };
  return fakeClockNow();
}

/** Take a clockWebhook push ({ now, mode }) into the cache. */
export function receiveFakeClock(body) {
  if (
    !Number.isSafeInteger(body?.now) ||
    !["manual", "real"].includes(body?.mode)
  ) {
    throw new TypeError("a clock push is { now, mode }");
  }
  generation += 1;
  cache = { url: clockUrl(), now: body.now, mode: body.mode };
}

/**
 * A Node (request, response) handler to mount at the clockWebhook URL: reads
 * the JSON body, receiveFakeClock, answers 204.
 */
export function fakeClockHandler(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      receiveFakeClock(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(204).end();
    } catch {
      response.writeHead(400).end();
    }
  });
}
