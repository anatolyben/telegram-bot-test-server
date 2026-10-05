import os from "node:os";
import { performance } from "node:perf_hooks";
const { startTestServer } = await import(
  process.env.BENCH_SOURCE ?? "../src/index.js"
);
const rounds = Number(process.env.BENCH_ROUNDS ?? 10);
const history = Number(process.env.BENCH_HISTORY ?? 3000);
const messages = Number(process.env.BENCH_MESSAGES ?? 1000);
const observers = Number(process.env.BENCH_OBSERVERS ?? 100);
const requests = 20;
const token = "123456:SCALE";
const chatId = -1001000000001;
const botId = 123456;
const samples = [];
for (let round = -1; round < rounds; round++) {
  let fake;
  const waits = [];
  try {
    fake = await startTestServer({
      botToken: token,
      clock: { now: 1800000000000 },
      chats: [{ id: chatId, title: "Scale", ownerId: 5000000001 }],
    });
    const api = async (method, params = {}) => {
      const res = await fetch(`${fake.origin}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      const value = await res.json();
      if (!value.ok)
        throw new Error(`Benchmark ${method} failed: ${value.description}`);
      return value.result;
    };
    const user = await fake.createUser();
    await fake.join(chatId, user);
    for (let i = 0; i < messages; i++)
      await fake.post(chatId, user, `fixture ${i}`);
    for (let start = 0; start < history; start += 20)
      await Promise.all(
        Array.from({ length: Math.min(20, history - start) }, () =>
          api("getMe"),
        ),
      );
    const atSnapshot = performance.now();
    const saved = await fake.snapshot();
    const snapshot_ms = performance.now() - atSnapshot;
    const atRestore = performance.now();
    await fake.restore(saved);
    const restore_ms = performance.now() - atRestore;
    if (global.gc) global.gc();
    const heap_bytes = process.memoryUsage().heapUsed;
    const atRegister = performance.now();
    for (let i = 0; i < observers; i++) {
      // The receipt must survive reindexing on restore and exclude unrelated calls.
      const condition = {
        kind: "call",
        botId,
        method: "banChatMember",
        chatId,
        userId: user,
        afterSeq: history,
        stage: "response_sent",
      };
      waits.push(
        fake.waitFor(condition, { timeoutMs: 30000 }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      );
    }
    const register_ms = performance.now() - atRegister;
    const atRequests = performance.now();
    for (let i = 0; i < requests; i++) await api("getMe");
    const unrelated_api_ms = performance.now() - atRequests;
    if ((await fake.getMember(chatId, user)).status !== "member")
      throw new Error("Unrelated calls changed membership");
    const atResolve = performance.now();
    await api("banChatMember", { chat_id: chatId, user_id: user });
    const results = await Promise.all(waits);
    if (
      results.some(
        ({ value, error }) =>
          error ||
          value.params.user_id !== user ||
          value.seq !== history + requests + 1 ||
          value.outcome !== "succeeded",
      )
    )
      throw new Error("A wait matched the wrong receipt or failed");
    const resolve_ms = performance.now() - atResolve;
    if ((await fake.getMember(chatId, user)).status !== "kicked")
      throw new Error("Physical ban missing");
    const journal = await fake.getCalls();
    if (journal.calls.length !== history + requests + 1)
      throw new Error("Journal lost calls");
    await fake.releaseSnapshot(saved);
    if (round >= 0)
      samples.push({
        snapshot_ms,
        restore_ms,
        register_ms,
        unrelated_api_ms,
        resolve_ms,
        heap_bytes,
      });
  } finally {
    if (fake) await fake.stop();
    await Promise.all(waits);
  }
}
const phases = Object.fromEntries(
  Object.keys(samples[0]).map((key) => {
    const sorted = samples.map((row) => row[key]).sort((a, b) => a - b);
    return [
      key,
      {
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
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
      gc: typeof global.gc === "function",
      rounds,
      warmup: 1,
      history,
      messages,
      observers,
      requests,
      workload: `local fake-only HTTP; identical source-independent fixture; snapshot/restore with saved journal; ${observers} exact ban-call observers during ${requests} unrelated getMe calls; verified receipts and physical ban; heap sample is process heapUsed after optional forced GC outside timing phases, not a leak test or total process memory`,
      phases,
      samples,
    },
    null,
    2,
  ),
);
