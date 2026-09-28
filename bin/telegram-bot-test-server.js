#!/usr/bin/env node
/**
 * Run the fake as a standalone server.
 *
 *   telegram-bot-test-server --token 123456:TEST --port 8081 [--host 127.0.0.1] [--config chats.json]
 *
 * The optional config file holds { "chats": [...], "publicChats": [...] }, in the
 * shape startTestServer() takes. Point the bot's Bot API base URL at the
 * printed origin.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { startTestServer } from "../src/index.js";

const { values } = parseArgs({
  options: {
    token: { type: "string" },
    port: { type: "string", default: "8081" },
    host: { type: "string", default: "127.0.0.1" },
    username: { type: "string" },
    config: { type: "string" },
    "unimplemented-ok": { type: "boolean", default: false },
  },
});

if (!values.token) {
  console.error(
    "Usage: telegram-bot-test-server --token <id>:<secret> [--port 8081] [--host 127.0.0.1] [--username name] [--config chats.json] [--unimplemented-ok]",
  );
  process.exit(2);
}

const config = values.config
  ? JSON.parse(await readFile(values.config, "utf8"))
  : {};

const fake = await startTestServer({
  botToken: values.token,
  port: Number(values.port),
  host: values.host,
  ...(values.username ? { botUsername: values.username } : {}),
  chats: config.chats ?? [],
  publicChats: config.publicChats ?? [],
  unimplemented: values["unimplemented-ok"] ? "ok" : "error",
  log: (line) => console.log(`[telegram-bot-test-server] ${line}`),
});
console.log(`[telegram-bot-test-server] listening at ${fake.origin}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await fake.stop();
    process.exit(0);
  });
}
