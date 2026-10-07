import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { startTestServer } from "../src/index.js";
import {
  fakeClockHandler,
  fakeClockNow,
  receiveFakeClock,
  refreshFakeClock,
} from "../src/clock.js";

const TOKEN = "123456:OBSERVE-SECRET";
const BOT = 123456;
const SECOND_TOKEN = "654321:SECOND-SECRET";
const CHAT = -1001000000001;
const OWNER = 5000000001;
const NOW = 1_800_000_000_000;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(options = {}) {
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: CHAT, title: "Observe", ownerId: OWNER }],
    ...options,
  });
  cleanups.push(() => fake.stop());
  const api = async (method, params = {}, token = TOKEN) => {
    const response = await fetch(`${fake.origin}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json()) };
  };
  const user = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, user);
  return { fake, api, user };
}

/** A second bot, administrator of the group. */
async function secondBot(fake) {
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
  });
  await fake.setBotMembership(CHAT, second.id);
  return second;
}

/** Confirm every update the bot was sent, so its queue is empty. */
async function confirmAll(api, token = TOKEN) {
  const { result } = await api("getUpdates", {}, token);
  if (result.length) {
    await api("getUpdates", { offset: result.at(-1).update_id + 1 }, token);
  }
}

/** A local HTTP server answering with `handle`; closed after the test. */
async function listen(handle) {
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "null");
}

const ids = (log) => log.messages.map((entry) => entry.message.message_id);

it("lists every message after a mark, deletions flagged with the bot, method and call", async () => {
  const { fake, api, user } = await setup();
  const before = await fake.post(CHAT, user, "before the mark");
  const mark = await fake.getMessageLog(CHAT);
  expect(mark).toMatchObject({ chat_id: CHAT, epoch: 0 });
  const first = await fake.post(CHAT, user, "first");
  const second = await fake.post(CHAT, user, "second");
  await api("deleteMessage", { chat_id: CHAT, message_id: first });
  await api("deleteMessage", { chat_id: CHAT, message_id: before });
  const { calls } = await fake.getCalls();
  const deletions = calls.filter((call) => call.method === "deleteMessage");

  const all = await fake.getMessageLog(CHAT, {
    since: mark.cursor,
    includeDeleted: true,
  });
  // The message posted before the mark is there because its deletion is not.
  expect(ids(all)).toEqual([before, first, second]);
  const [old, deleted, kept] = all.messages;
  expect(deleted).toMatchObject({
    author: user,
    deleted: true,
    ephemeral: false,
    request_id: null,
    deleted_by: {
      bot_id: BOT,
      method: "deleteMessage",
      request_id: deletions[0].request_id,
    },
  });
  expect(deleted.deleted_by.seq).toBeGreaterThan(kept.seq);
  expect(old.seq).toBeLessThanOrEqual(mark.cursor);
  expect(old.deleted_by).toMatchObject({
    request_id: deletions[1].request_id,
  });
  expect(old.deleted_by.seq).toBeGreaterThan(mark.cursor);
  expect(kept).toMatchObject({ deleted: false, deleted_by: null });

  const live = await fake.getMessageLog(CHAT, { since: mark.cursor });
  expect(ids(live)).toEqual([second]);

  const third = await fake.post(CHAT, user, "third");
  const next = await fake.getMessageLog(CHAT, {
    since: all.cursor,
    includeDeleted: true,
  });
  expect(ids(next)).toEqual([third]);

  // Without the new parameters the route answers as before.
  const plain = await fetch(`${fake.origin}/_fake/chats/${CHAT}/messages`);
  expect((await plain.json()).map((message) => message.message_id)).toEqual([
    third,
    second,
    expect.any(Number),
  ]);
  const bad = await fetch(
    `${fake.origin}/_fake/chats/${CHAT}/messages?since=-1`,
  );
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({
    error: "since must be a non-negative integer",
  });
});

it("records deleteMessages and deleteEphemeralMessage, and logs ephemeral messages in order", async () => {
  const { fake, api, user } = await setup();
  const second = await secondBot(fake);
  const mark = await fake.getMessageLog(CHAT);
  const a = await fake.post(CHAT, user, "a");
  const ephemeral = await api("sendMessage", {
    chat_id: CHAT,
    text: "only Ann sees this",
    ephemeral_message_parameters: { receiver_user_id: user },
  });
  const b = await fake.post(CHAT, user, "b");
  await api(
    "deleteMessages",
    { chat_id: CHAT, message_ids: [a, b] },
    SECOND_TOKEN,
  );
  await api("deleteEphemeralMessage", {
    chat_id: CHAT,
    receiver_user_id: user,
    ephemeral_message_id: ephemeral.result.ephemeral_message_id,
  });
  const log = await fake.getMessageLog(CHAT, {
    since: mark.cursor,
    includeDeleted: true,
  });
  expect(
    log.messages.map((entry) => [
      entry.message.text,
      entry.ephemeral,
      entry.deleted_by.bot_id,
      entry.deleted_by.method,
    ]),
  ).toEqual([
    ["a", false, second.id, "deleteMessages"],
    ["only Ann sees this", true, BOT, "deleteEphemeralMessage"],
    ["b", false, second.id, "deleteMessages"],
  ]);
  expect(log.messages[1].request_id).toMatch(/:\d+$/);
});

it("reads a user's private chat after a mark, split by bot", async () => {
  const { fake, api } = await setup();
  const second = await secondBot(fake);
  const invite = (
    await api("createChatInviteLink", {
      chat_id: CHAT,
      creates_join_request: true,
    })
  ).result.invite_link;
  const carol = await fake.createUser({ first_name: "Carol" });
  await fake.sendDirectMessage(carol, "/start");
  const mark = await fake.getMessageLog(carol);
  await fake.sendDirectMessage(carol, "hello first bot");
  await api("sendMessage", { chat_id: carol, text: "first bot answers" });
  await fake.joinByLink(invite, carol);
  await api(
    "sendMessage",
    { chat_id: carol, text: "answer 2+2 to join" },
    SECOND_TOKEN,
  );
  const text = (log) => log.messages.map((entry) => entry.message.text);
  expect(text(await fake.getMessageLog(carol, { since: mark.cursor }))).toEqual(
    ["hello first bot", "first bot answers", "answer 2+2 to join"],
  );
  expect(
    text(
      await fake.getMessageLog(carol, {
        since: mark.cursor,
        botId: second.id,
      }),
    ),
  ).toEqual(["answer 2+2 to join"]);
  expect(text(await fake.getMessageLog(carol, { botId: BOT }))).toEqual([
    "/start",
    "hello first bot",
    "first bot answers",
  ]);
  await expect(fake.getMessageLog(carol, { botId: 999 })).rejects.toThrow(
    "Bad Request: bot not found",
  );
});

it("puts the log and its cursor back on restore and refuses a mark from before it", async () => {
  const { fake, user } = await setup();
  const saved = await fake.snapshot();
  const mark = await fake.getMessageLog(CHAT);
  await fake.post(CHAT, user, "after the snapshot");
  expect((await fake.getMessageLog(CHAT)).cursor).toBeGreaterThan(mark.cursor);
  await fake.restore(saved);
  const restored = await fake.getMessageLog(CHAT);
  expect(restored).toEqual({ ...mark, epoch: mark.epoch + 1 });
  const stale = await fetch(
    `${fake.origin}/_fake/chats/${CHAT}/messages?since=${mark.cursor}&epoch=${mark.epoch}`,
  );
  expect(stale.status).toBe(409);
  expect((await stale.json()).error).toMatch(/before a restore/);
  await expect(
    fake.getMessageLog(CHAT, { since: mark.cursor, epoch: mark.epoch }),
  ).rejects.toThrow(/before a restore/);
});

it("lists the updates each bot was sent: a bot subscribed to my_chat_member gets nothing else", async () => {
  const { fake, api } = await setup();
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
  });
  await api(
    "getUpdates",
    { allowed_updates: ["my_chat_member"] },
    SECOND_TOKEN,
  );
  await fake.setBotMembership(CHAT, second.id);
  const bob = await fake.createUser({ first_name: "Bob" });
  await fake.join(CHAT, bob);
  await fake.post(CHAT, bob, "hello");

  const seen = await fake.getBotUpdates(second.id, { chatId: CHAT });
  expect(seen.bot_id).toBe(second.id);
  expect(seen.updates).toHaveLength(1);
  expect(seen.updates[0]).toMatchObject({
    type: "my_chat_member",
    chat_id: CHAT,
    state: "pending",
    received: false,
    update: {
      my_chat_member: { new_chat_member: { status: "administrator" } },
    },
  });
  expect(seen.updates[0].update.update_id).toBe(seen.updates[0].update_id);

  // A type filter leaves the rest out: the second bot got no message.
  expect(
    (await fake.getBotUpdates(second.id, { type: "message" })).updates,
  ).toEqual([]);

  const first = await fake.getBotUpdates(BOT, { chatId: CHAT });
  expect(first.updates.map((update) => update.type)).toEqual([
    "message",
    "message",
    "message",
    "message",
  ]);
  const messages = await fake.getBotUpdates(BOT, { type: "message" });
  expect(messages.updates.at(-1).update.message.text).toBe("hello");
  const later = await fake.getBotUpdates(BOT, {
    type: ["message", "chat_member"],
    since: messages.updates.at(-2).update_id,
  });
  expect(later.updates.map((update) => update.update.message.text)).toEqual([
    "hello",
  ]);
  expect((await fake.getBotUpdates(BOT, { chatId: 42 })).updates).toEqual([]);
  await expect(fake.getBotUpdates(999)).rejects.toThrow(
    "Bad Request: bot not found",
  );
});

it("says whether each update is pending, delivered or dropped, and whether the bot received it", async () => {
  const { fake, api, user } = await setup();
  await confirmAll(api);
  const latest = async () => (await fake.getBotUpdates(BOT)).updates.at(-1);
  await fake.post(CHAT, user, "dropped unseen");
  await fake.post(CHAT, user, "kept");
  // A negative offset keeps only the last update; the one before goes unseen.
  const kept = await api("getUpdates", { offset: -1 });
  expect(kept.result.map((update) => update.message.text)).toEqual(["kept"]);
  const updates = (await fake.getBotUpdates(BOT, { type: "message" })).updates;
  expect(updates.at(-2)).toMatchObject({
    state: "dropped",
    received: false,
    update: { message: { text: "dropped unseen" } },
  });
  expect(updates.at(-1)).toMatchObject({ state: "pending", received: true });
  await api("deleteWebhook", { drop_pending_updates: true });
  expect(await latest()).toMatchObject({ state: "dropped", received: true });

  await fake.post(CHAT, user, "one");
  expect(await latest()).toMatchObject({ state: "pending", received: false });
  const { result } = await api("getUpdates");
  expect(await latest()).toMatchObject({ state: "pending", received: true });
  const delivered = fake.waitFor(
    {
      kind: "update",
      botId: BOT,
      state: "delivered",
      afterUpdateId: result[0].update_id - 1,
    },
    { timeoutMs: 2000 },
  );
  // A long poll confirms it and stays open.
  void api("getUpdates", {
    offset: result.at(-1).update_id + 1,
    timeout: 20,
  }).catch(() => {});
  expect(await delivered).toMatchObject({
    state: "delivered",
    received: true,
    update: { message: { text: "one" } },
  });
});

it("matches messages by substring, pattern, button text and callback data, after a cursor", async () => {
  const { fake, api, user } = await setup();
  await fake.post(CHAT, user, "Hello World");
  expect(
    await fake.waitFor({ kind: "message", chatId: CHAT, contains: "World" }),
  ).toMatchObject({ message: { text: "Hello World" }, author: user });
  expect(
    await fake.waitFor({
      kind: "message",
      chatId: CHAT,
      matches: /hello\s+w/i,
    }),
  ).toMatchObject({ message: { text: "Hello World" } });
  // The g and y flags are dropped: a sticky pattern would match only at 0.
  expect(
    await fake.waitFor({ kind: "message", chatId: CHAT, matches: /World/gy }),
  ).toMatchObject({ message: { text: "Hello World" } });
  const overHttp = await fetch(`${fake.origin}/_fake/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      condition: {
        kind: "message",
        chatId: CHAT,
        matches: { source: "^HELLO", flags: "i" },
      },
    }),
  });
  expect(overHttp.status).toBe(200);
  expect((await overHttp.json()).message.text).toBe("Hello World");
  const invalid = await fetch(`${fake.origin}/_fake/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      condition: { kind: "message", chatId: CHAT, matches: { source: "(" } },
    }),
  });
  expect(invalid.status).toBe(400);

  await fake.post(CHAT, user, {
    photo: Buffer.from("not really an image"),
    caption: "receipt 42",
  });
  expect(
    await fake.waitFor({
      kind: "message",
      chatId: CHAT,
      userId: user,
      contains: "receipt",
    }),
  ).toMatchObject({ message: { caption: "receipt 42" } });

  await api("sendMessage", {
    chat_id: CHAT,
    text: "Pick one",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "y" },
          { text: "No", callback_data: "n" },
        ],
      ],
    },
  });
  expect(
    await fake.waitFor({
      kind: "message",
      chatId: CHAT,
      buttonText: "Yes",
      buttonData: "y",
    }),
  ).toMatchObject({ message: { text: "Pick one" }, author: BOT });
  await expect(
    fake.waitFor(
      { kind: "message", chatId: CHAT, buttonText: "Yes", buttonData: "n" },
      { timeoutMs: 30 },
    ),
  ).rejects.toThrow(/deadline/);

  const mark = (await fake.getMessageLog(CHAT)).cursor;
  await fake.post(CHAT, user, "Hello again");
  expect(
    await fake.waitFor({
      kind: "message",
      chatId: CHAT,
      contains: "Hello",
      since: mark,
    }),
  ).toMatchObject({ message: { text: "Hello again" } });
  await expect(
    fake.waitFor({ kind: "message", chatId: CHAT, since: mark }),
  ).rejects.toThrow(TypeError);
});

it("waits for quiet: nothing unconfirmed, and a long poll that confirmed it does not count", async () => {
  const { fake, api, user } = await setup();
  await confirmAll(api);
  await fake.post(CHAT, user, "unconfirmed");
  let quietAt = null;
  const quiet = fake
    .waitFor({ kind: "quiet", ms: 50 }, { timeoutMs: 3000 })
    .then((result) => {
      quietAt = Date.now();
      return result;
    });
  await sleep(200);
  expect(quietAt).toBe(null);
  const { result } = await api("getUpdates");
  let pollDone = false;
  void api("getUpdates", {
    offset: result.at(-1).update_id + 1,
    timeout: 20,
  })
    .catch(() => {})
    .then(() => {
      pollDone = true;
    });
  expect(await quiet).toMatchObject({ quiet: true });
  expect(pollDone).toBe(false);
});

it("waits for quiet only for the bots named, and reports what it waited for", async () => {
  const { fake, user } = await setup();
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
  });
  await fake.post(CHAT, user, "unconfirmed");
  expect(
    await fake.waitFor(
      { kind: "quiet", ms: 20, botIds: [second.id] },
      { timeoutMs: 1000 },
    ),
  ).toMatchObject({ quiet: true });
  const error = await fake
    .waitFor({ kind: "quiet", ms: 20 }, { timeoutMs: 100 })
    .catch((caught) => caught);
  expect(error.message).toMatch(/"pendingUpdates":\{"123456":[1-9]/);
  expect(error.message).toMatch(/"callsInProgress":\{"123456":0/);
  expect(error.message).toMatch(/"attemptsInProgress":\{"123456":0/);
  await expect(fake.waitFor({ kind: "quiet", ms: 1000 })).rejects.toThrow(
    TypeError,
  );
  await expect(fake.waitFor({ kind: "quiet", ms: 0 })).rejects.toThrow(
    TypeError,
  );
  await expect(
    fake.waitFor({ kind: "quiet", ms: 10, botIds: [999] }),
  ).rejects.toThrow("Unknown botId");
});

it("waits for quiet until ms after the last call", async () => {
  const { fake, api } = await setup();
  await confirmAll(api);
  const quiet = fake.waitFor({ kind: "quiet", ms: 300 }, { timeoutMs: 3000 });
  await sleep(150);
  await api("getMe");
  const calledAt = Date.now();
  await quiet;
  expect(Date.now() - calledAt).toBeGreaterThanOrEqual(280);
});

it("waits for quiet until a delayed call has answered", async () => {
  const { fake, api } = await setup();
  await confirmAll(api);
  await fake.failNext({ method: "getMe", delayMs: 400 });
  const answered = api("getMe").then(() => Date.now());
  await sleep(20);
  await fake.waitFor({ kind: "quiet", ms: 50 }, { timeoutMs: 3000 });
  const quietAt = Date.now();
  expect(quietAt - (await answered)).toBeGreaterThanOrEqual(40);
});

it("waits for quiet until the call a webhook answered with has run", async () => {
  const { fake, api } = await setup();
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
  });
  const first = await listen((request, response) => {
    request.resume();
    response.end();
  });
  const replying = await listen(async (request, response) => {
    const update = await readJson(request);
    if (!update.message?.new_chat_title) return response.end();
    await sleep(50);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        method: "sendMessage",
        chat_id: CHAT,
        text: "from the webhook answer",
        // A large answer: the call takes a while to reach the server.
        padding: "x".repeat(2_000_000),
      }),
    );
  });
  await api("setWebhook", { url: first });
  await api("setWebhook", { url: replying }, SECOND_TOKEN);
  await fake.setBotMembership(CHAT, second.id);
  await fake.drainDeliveries();
  // Other controls keep changing the server's state meanwhile.
  let busy = true;
  const loop = (async () => {
    while (busy) {
      await fake.getClock();
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  await api("setChatTitle", { chat_id: CHAT, title: "Renamed" });
  await fake.waitFor({ kind: "quiet", ms: 20 }, { timeoutMs: 3000 });
  busy = false;
  await loop;
  expect(
    (await fake.getMessages(CHAT)).map((message) => message.text),
  ).toContain("from the webhook answer");
});

it("waits for quiet until a clock advance has pushed the time and test actions have finished", async () => {
  let pushedAt = null;
  const clockWebhook = await listen(async (request, response) => {
    await readJson(request);
    await sleep(300);
    pushedAt = Date.now();
    response.end();
  });
  const { fake, api } = await setup({ clock: { now: NOW }, clockWebhook });
  await confirmAll(api);
  const advanced = fake.advanceTime(1000);
  await sleep(20);
  await fake.waitFor({ kind: "quiet", ms: 20 }, { timeoutMs: 3000 });
  expect(pushedAt).not.toBe(null);
  await advanced;

  // A test action in progress: a press the bot has not answered yet.
  const sent = await api("sendMessage", {
    chat_id: CHAT,
    text: "Press",
    reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
  });
  const user = await fake.createUser();
  await fake.join(CHAT, user);
  const press = fake.pressButton(CHAT, sent.result.message_id, user, "go");
  await sleep(20);
  await expect(
    fake.waitFor({ kind: "quiet", ms: 10, botIds: [] }, { timeoutMs: 150 }),
  ).rejects.toThrow(/"controls":1/);
  const { result } = await api("getUpdates");
  const query = result.find((update) => update.callback_query).callback_query;
  await api("answerCallbackQuery", { callback_query_id: query.id });
  await press;
  expect(
    await fake.waitFor({ kind: "quiet", ms: 10, botIds: [] }),
  ).toMatchObject({ quiet: true });
});

it("waits for an update a bot was sent: a later one, a delivered one, a dropped one", async () => {
  const { fake, api, user } = await setup({ clock: { now: NOW } });
  const after = (await fake.getBotUpdates(BOT)).updates.at(-1).update_id;
  const next = fake.waitFor({
    kind: "update",
    botId: BOT,
    type: "message",
    afterUpdateId: after,
  });
  await fake.post(CHAT, user, "later");
  expect(await next).toMatchObject({
    update_id: after + 1,
    type: "message",
    chat_id: CHAT,
    state: "pending",
    update: { message: { text: "later" } },
  });

  // A webhook that keeps failing until the update expires a day later.
  const failing = await listen((request, response) => {
    request.resume();
    response.writeHead(500).end();
  });
  await confirmAll(api);
  await api("setWebhook", { url: failing });
  const dropped = fake.waitFor(
    { kind: "update", botId: BOT, type: "message", state: "dropped" },
    { timeoutMs: 3000 },
  );
  await fake.post(CHAT, user, "never confirmed");
  await fake.advanceTime(86_400_000 + 60_000);
  expect(await dropped).toMatchObject({
    state: "dropped",
    received: true,
    update: { message: { text: "never confirmed" } },
  });
  await expect(fake.waitFor({ kind: "update", botId: 999 })).rejects.toThrow(
    "Unknown botId",
  );
  await expect(
    fake.waitFor({ kind: "update", botId: BOT, state: "lost" }),
  ).rejects.toThrow(TypeError);
});

it("pushes the manual clock to clockWebhook before an advance or restore answers", async () => {
  const pushes = [];
  const clockWebhook = await listen(async (request, response) => {
    pushes.push({
      body: await readJson(request),
      type: request.headers["content-type"],
    });
    response.end();
  });
  const { fake } = await setup({ clock: { now: NOW }, clockWebhook });
  await fake.advanceTime(5000);
  expect(pushes).toEqual([
    { body: { now: NOW + 5000, mode: "manual" }, type: "application/json" },
  ]);
  const saved = await fake.snapshot();
  await fake.advanceTime(1000);
  await fake.restore(saved);
  expect(pushes.map((push) => push.body.now)).toEqual([
    NOW + 5000,
    NOW + 6000,
    NOW + 5000,
  ]);

  const lines = [];
  const dead = await startTestServer({
    botToken: TOKEN,
    clock: { now: NOW },
    clockWebhook: "http://127.0.0.1:1/",
    log: (line) => lines.push(line),
  });
  cleanups.push(() => dead.stop());
  expect(await dead.advanceTime(1000)).toMatchObject({ now: NOW + 1000 });
  expect(lines.some((line) => line.startsWith("clock webhook failed:"))).toBe(
    true,
  );
  await expect(
    startTestServer({ botToken: TOKEN, clockWebhook: "ftp://example.com" }),
  ).rejects.toThrow("clockWebhook must be an http(s) URL");
});

it("gives the app the server's clock through fakeClockNow", async () => {
  const saved = process.env.TELEGRAM_FAKE_CLOCK_URL;
  cleanups.push(() => {
    if (saved === undefined) delete process.env.TELEGRAM_FAKE_CLOCK_URL;
    else process.env.TELEGRAM_FAKE_CLOCK_URL = saved;
  });
  delete process.env.TELEGRAM_FAKE_CLOCK_URL;
  expect(Math.abs(fakeClockNow() - Date.now())).toBeLessThan(1000);
  expect(Math.abs((await refreshFakeClock()) - Date.now())).toBeLessThan(1000);

  // A server on real time: the app reads the wall clock, not the cached read.
  const real = await startTestServer({ botToken: TOKEN });
  cleanups.push(() => real.stop());
  process.env.TELEGRAM_FAKE_CLOCK_URL = real.origin;
  const read = await refreshFakeClock();
  await sleep(30);
  expect(fakeClockNow()).toBeGreaterThanOrEqual(read + 25);
  delete process.env.TELEGRAM_FAKE_CLOCK_URL;

  const app = await listen(fakeClockHandler);
  const { fake } = await setup({ clock: { now: NOW }, clockWebhook: app });
  process.env.TELEGRAM_FAKE_CLOCK_URL = fake.origin;
  expect(() => fakeClockNow()).toThrow(/refreshFakeClock/);
  expect(await refreshFakeClock()).toBe(NOW);
  expect(fakeClockNow()).toBe(NOW);
  await fake.advanceTime(60_000);
  expect(fakeClockNow()).toBe(NOW + 60_000);

  const other = await startTestServer({
    botToken: TOKEN,
    clock: { now: NOW + 1 },
  });
  cleanups.push(() => other.stop());
  process.env.TELEGRAM_FAKE_CLOCK_URL = `${other.origin}/_fake/clock`;
  expect(() => fakeClockNow()).toThrow(/refreshFakeClock/);
  expect(await refreshFakeClock()).toBe(NOW + 1);

  // A push that arrives while a slow read is out is newer than its answer.
  let answer;
  const held = new Promise((resolve) => {
    answer = resolve;
  });
  const slow = await listen(async (request, response) => {
    request.resume();
    await held;
    response.end(JSON.stringify({ mode: "manual", now: NOW, scheduled: 0 }));
  });
  process.env.TELEGRAM_FAKE_CLOCK_URL = slow;
  const reading = refreshFakeClock();
  await sleep(20);
  receiveFakeClock({ now: NOW + 99, mode: "manual" });
  answer();
  expect(await reading).toBe(NOW + 99);
  expect(fakeClockNow()).toBe(NOW + 99);
});

it("pushes a running clock's offset, and fakeClockNow keeps moving between reads", async () => {
  const HOUR = 3_600_000;
  const saved = process.env.TELEGRAM_FAKE_CLOCK_URL;
  cleanups.push(() => {
    if (saved === undefined) delete process.env.TELEGRAM_FAKE_CLOCK_URL;
    else process.env.TELEGRAM_FAKE_CLOCK_URL = saved;
  });
  const pushes = [];
  const app = await listen(async (request, response) => {
    const body = await readJson(request);
    pushes.push(body);
    receiveFakeClock(body);
    response.end();
  });
  const { fake } = await setup({ clock: { offset: 0 }, clockWebhook: app });
  process.env.TELEGRAM_FAKE_CLOCK_URL = fake.origin;
  // The app's time, checked against the wall clock read around it.
  const appNow = (offset) => {
    const before = Date.now();
    const time = fakeClockNow();
    expect(time).toBeGreaterThanOrEqual(before + offset);
    expect(time).toBeLessThanOrEqual(Date.now() + offset);
    return time;
  };

  const read = await refreshFakeClock();
  expect(read).toBeLessThanOrEqual(appNow(0));
  await sleep(30);
  expect(appNow(0)).toBeGreaterThanOrEqual(read + 25);

  await fake.advanceTime(HOUR);
  expect(pushes).toEqual([
    { now: expect.any(Number), mode: "running", offset: HOUR },
  ]);
  const jumped = appNow(HOUR);
  await sleep(30);
  expect(appNow(HOUR)).toBeGreaterThanOrEqual(jumped + 25);

  const snapshot = await fake.snapshot();
  await fake.advanceTime(HOUR);
  appNow(2 * HOUR);
  await fake.restore(snapshot);
  expect(pushes.map((push) => push.offset)).toEqual([HOUR, 2 * HOUR, HOUR]);
  appNow(HOUR);
  await fake.releaseSnapshot(snapshot);
  // A read after a jump keeps the offset too.
  await fake.advanceTime(HOUR);
  await refreshFakeClock();
  appNow(2 * HOUR);

  expect(() => receiveFakeClock({ now: NOW, mode: "running" })).toThrow(
    TypeError,
  );
});
