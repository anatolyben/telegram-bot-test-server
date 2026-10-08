#!/usr/bin/env node
/**
 * Run the test server from the command line.
 *
 *   telegram-bot-test-server --token 123456:TEST --port 8081 [--host 127.0.0.1] [--config chats.json] [--ui] [--record-dir recordings]
 *     [--clock-now <ms or ISO date> | --clock-offset <ms>] [--clock-webhook <url>]
 *
 * The optional config file holds { "chats": [...], "publicChats": [...] }, in the
 * shape startTestServer() takes. Point the bot's Bot API base URL at the
 * printed origin.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { startTestServer } from "../src/index.js";

let values;
try {
  ({ values } = parseArgs({
    options: {
      token: { type: "string" },
      port: { type: "string", default: "8081" },
      host: { type: "string", default: "127.0.0.1" },
      username: { type: "string" },
      config: { type: "string" },
      "unimplemented-ok": { type: "boolean", default: false },
      ui: { type: "boolean", default: false },
      "record-dir": { type: "string" },
      "clock-now": { type: "string" },
      "clock-offset": { type: "string" },
      "clock-webhook": { type: "string" },
    },
  }));
} catch (error) {
  fail(error.message);
}

/** Stop with the usage error, as for a missing token. */
function fail(message) {
  console.error(`telegram-bot-test-server: ${message}`);
  process.exit(2);
}

// The clock options, as startTestServer's clock and clockWebhook take them:
// --clock-now starts a manual clock at a Unix time in milliseconds or an ISO
// date, and --clock-offset runs one at real time plus the offset.
let clock;
if (values["clock-now"] !== undefined) {
  const text = values["clock-now"];
  const now = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isSafeInteger(now)) {
    fail("--clock-now takes Unix milliseconds or an ISO date");
  }
  clock = { now };
}
if (values["clock-offset"] !== undefined) {
  if (clock) fail("give --clock-now or --clock-offset, not both");
  if (!/^\d+$/.test(values["clock-offset"])) {
    fail("--clock-offset takes milliseconds");
  }
  clock = { offset: Number(values["clock-offset"]) };
}

if (!values.token) {
  console.error(
    "Usage: telegram-bot-test-server --token <id>:<secret> [--port 8081] [--host 127.0.0.1] [--username name] [--config chats.json] [--unimplemented-ok] [--ui] [--record-dir dir] [--clock-now ms|date | --clock-offset ms] [--clock-webhook url]",
  );
  process.exit(2);
}

const config = values.config
  ? JSON.parse(await readFile(values.config, "utf8"))
  : {};

const fake = await startTestServer({
  ...(clock ? { clock } : {}),
  ...(values["clock-webhook"] !== undefined
    ? { clockWebhook: values["clock-webhook"] }
    : {}),
  botToken: values.token,
  port: Number(values.port),
  host: values.host,
  ...(values.username ? { botUsername: values.username } : {}),
  chats: config.chats ?? [],
  publicChats: config.publicChats ?? [],
  unimplemented: values["unimplemented-ok"] ? "ok" : "error",
  ui: values.ui,
  ...(values["record-dir"] !== undefined
    ? { recordDir: values["record-dir"] }
    : {}),
  log: (line) => console.log(`[telegram-bot-test-server] ${line}`),
});
console.log(`[telegram-bot-test-server] listening at ${fake.origin}`);
if (fake.viewerUrl) {
  console.log(`[telegram-bot-test-server] viewer at ${fake.viewerUrl}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await fake.stop();
    process.exit(0);
  });
}
