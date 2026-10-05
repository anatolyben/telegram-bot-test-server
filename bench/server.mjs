import http from "node:http";
import os from "node:os";
import { performance } from "node:perf_hooks";
const { startTestServer } = await import(
  process.env.BENCH_SOURCE ?? "../src/index.js"
);

const iterations = Number(process.env.BENCH_ITERATIONS ?? 20);
const token = "123456:BENCH";
const chatId = -1001000000001;
const samples = [];
let fake;
let receiver;
try {
  for (let n = -2; n < iterations; n++) {
    const row = {};
    let at = performance.now();
    fake = await startTestServer({
      botToken: token,
      chats: [{ id: chatId, title: "Bench", ownerId: 5000000001 }],
    });
    row.startup = performance.now() - at;
    if (process.env.BENCH_LOGIN === "1") {
      at = performance.now();
      const keys = await (
        await fetch(`${fake.origin}/.well-known/jwks.json`)
      ).json();
      if (keys.keys?.[0]?.kty !== "RSA") throw new Error("Missing login keys");
      row.firstLoginKeys = performance.now() - at;
    }
    const api = async (method, params = {}) => {
      const r = await fetch(`${fake.origin}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = await r.json();
      if (!body.ok) throw new Error(JSON.stringify(body));
      return body.result;
    };
    at = performance.now();
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const id = await fake.createUser({ first_name: `Member ${i}` });
      ids.push(id);
      await fake.join(chatId, id);
      await fake.post(chatId, id, "literal <b>😀</b>");
    }
    row.fixture20 = performance.now() - at;
    at = performance.now();
    for (const id of ids)
      await api("getChatMember", { chat_id: chatId, user_id: id });
    row.api20 = performance.now() - at;
    const callbackErrors = [];
    const callbackWork = [];
    receiver = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const update = JSON.parse(Buffer.concat(chunks));
      // Answer after the receiver acknowledged delivery. This models a bot
      // processing an update asynchronously, and exercises callback waiting.
      res.end();
      if (update.callback_query) {
        callbackWork.push(
          new Promise((resolve) =>
            setImmediate(async () => {
              try {
                await api("answerCallbackQuery", {
                  callback_query_id: update.callback_query.id,
                  text: "ok",
                });
              } catch (error) {
                callbackErrors.push(error);
              } finally {
                resolve();
              }
            }),
          ),
        );
      }
    });
    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    await api("setWebhook", {
      url: `http://127.0.0.1:${receiver.address().port}`,
    });
    at = performance.now();
    for (let i = 0; i < 20; i++) await fake.post(chatId, ids[i], "delivered");
    row.delivery20 = performance.now() - at;
    const button = await api("sendMessage", {
      chat_id: chatId,
      text: "Button",
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "ok" }]],
      },
    });
    at = performance.now();
    for (let i = 0; i < 5; i++) {
      const answer = await fake.pressButton(
        chatId,
        button.message_id,
        ids[0],
        "ok",
      );
      if (!answer.answered || answer.text !== "ok")
        throw new Error("Missing callback answer");
    }
    await Promise.all(callbackWork);
    if (callbackErrors.length) throw callbackErrors[0];
    row.callback5 = performance.now() - at;
    at = performance.now();
    await fake.stop();
    fake = null;
    await new Promise((resolve) => {
      receiver.close(resolve);
      receiver.closeAllConnections();
    });
    receiver = null;
    row.teardown = performance.now() - at;
    if (n >= 0) samples.push(row);
  }
} finally {
  if (fake) await fake.stop();
  if (receiver)
    await new Promise((resolve) => {
      receiver.close(resolve);
      receiver.closeAllConnections();
    });
}
const phases = Object.fromEntries(
  Object.keys(samples[0]).map((key) => {
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
      iterations,
      warmup: 2,
      workload:
        "20 users/joins/messages; 20 HTTP reads; 20 webhook deliveries; 5 async callbacks; no application jobs",
      phases,
      samples,
    },
    null,
    2,
  ),
);
