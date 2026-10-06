import os from "node:os";
import { performance } from "node:perf_hooks";
import { startTestServer } from "../src/index.js";
const token = "123456:REUSE";
const chatId = -1001000000001;
const rounds = Number(process.env.BENCH_ROUNDS ?? 10);
const cases = 20;
let fake;
async function fixture() {
  fake = await startTestServer({
    botToken: token,
    clock: { now: 1800000000000 },
    chats: [{ id: chatId, title: "Reuse", ownerId: 5000000001 }],
  });
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const id = await fake.createUser();
    ids.push(id);
    await fake.join(chatId, id);
    await fake.post(chatId, id, "literal <b>😀</b>");
    await api("sendMessage", {
      chat_id: chatId,
      text: "<b>😀 fixture</b>",
      parse_mode: "HTML",
    });
  }
  return ids[0];
}
async function api(method, params) {
  const r = await fetch(`${fake.origin}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(JSON.stringify(body));
  return body.result;
}
async function exercise(user) {
  await api("banChatMember", { chat_id: chatId, user_id: user });
  if ((await fake.getMember(chatId, user)).status !== "kicked")
    throw new Error("Ban missing");
  // A ban leaves the user's messages, as on Telegram; the bot deletes them itself.
  const theirs = (await fake.getMessages(chatId))
    .filter((m) => m.from?.id === user)
    .map((m) => m.message_id);
  await api("deleteMessages", { chat_id: chatId, message_ids: theirs });
  if ((await fake.getMessages(chatId)).some((m) => m.from?.id === user))
    throw new Error("History not deleted");
}
async function run(strategy) {
  const at = performance.now();
  try {
    if (strategy === "restart") {
      for (let i = 0; i < cases; i++) {
        const user = await fixture();
        await exercise(user);
        await fake.stop();
        fake = null;
      }
    } else {
      const user = await fixture();
      const saved = await fake.snapshot();
      for (let i = 0; i < cases; i++) {
        await fake.restore(saved);
        if ((await fake.getMember(chatId, user)).status !== "member")
          throw new Error("Restore missing");
        await exercise(user);
      }
      await fake.releaseSnapshot(saved);
    }
  } finally {
    if (fake) {
      await fake.stop();
      fake = null;
    }
  }
  return performance.now() - at;
}
const samples = [];
for (let round = -1; round < rounds; round++) {
  const row = {};
  // Alternate order to reduce order-related bias; one unreported warmup round.
  for (const strategy of round % 2 === 0
    ? ["restart", "restore"]
    : ["restore", "restart"])
    row[strategy] = await run(strategy);
  if (round >= 0) samples.push(row);
}
const phases = Object.fromEntries(
  ["restart", "restore"].map((key) => {
    const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
    return [
      key,
      {
        median_ms: sorted[Math.floor(sorted.length / 2)],
        p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      },
    ];
  }),
);
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpu: os.cpus()[0].model,
      rounds,
      warmup: 1,
      cases,
      workload:
        "same 0.10.0 source; 20 users/joins/inbound messages and 20 formatted HTTP sends per fixture, then verified ban/revocation per case; includes initial fixture/snapshot/cleanup; no consuming application",
      phases,
      samples,
    },
    null,
    2,
  ),
);
