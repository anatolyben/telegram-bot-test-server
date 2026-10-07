import { afterEach, expect, it } from "vitest";
import { startTestServer } from "../src/index.js";
import {
  makeContext,
  mergeStream,
  renderCall,
  renderCallFilters,
} from "../src/ui/render.js";

const TOKEN = "123456:TIMELINE-SECRET";
const BOT = 123456;
const CHAT = -1001000000001;
const OTHER = -1001000000002;
const OWNER = 5000000001;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup() {
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [
      { id: CHAT, title: "Timeline", ownerId: OWNER },
      { id: OTHER, title: "Log", ownerId: OWNER },
    ],
    ui: true,
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
  const page = async (ref, query = "") => {
    const response = await fetch(
      `${fake.viewerUrl}/api/chats/${encodeURIComponent(ref)}${query}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  return { fake, api, page, ann };
}

/** A page's stream as short labels: messages by text, calls by method. */
const labels = (list) =>
  list.map((item) =>
    item.kind === "call"
      ? `call ${item.method}`
      : item.kind === "message"
        ? `message ${item.message.text ?? Object.keys(item.message).at(-1)}`
        : `event ${item.type}`,
  );

it("keeps on each receipt the description its answer carried, already when the outcome is known", async () => {
  const { fake, api } = await setup();
  expect(
    (await api("deleteMessage", { chat_id: CHAT, message_id: 999 }))
      .description,
  ).toBe("Bad Request: message to delete not found");
  await api("setMyDescription", { description: "x" });
  await api("setWebhook", { url: "http://127.0.0.1:9/hook" });
  await api("deleteWebhook");
  await api("getMe", {}, "999:WRONG");
  await fake.failNext({
    method: "getChat",
    errorCode: 400,
    description: "Bad Request: chat <b>gone</b>",
    delayMs: 300,
  });
  const refused = api("getChat", { chat_id: CHAT });
  // The refusal is recorded before its delayed answer is sent.
  const seen = await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "getChat",
    outcome: "rejected",
  });
  expect(seen.description).toBe("Bad Request: chat <b>gone</b>");
  await refused;
  const { calls, rejected_requests } = await fake.getCalls();
  expect(
    Object.fromEntries(calls.map((call) => [call.method, call.description])),
  ).toEqual({
    deleteMessage: "Bad Request: message to delete not found",
    setMyDescription: "Not Found: method not found",
    setWebhook: "Webhook was set",
    deleteWebhook: "Webhook was deleted",
    getChat: "Bad Request: chat <b>gone</b>",
  });
  expect(rejected_requests[0].description).toBe("Unauthorized");
});

it("puts each call in the chat it acted on, and calls without one under calls", async () => {
  const { fake, api, page, ann } = await setup();
  await fake.sendDirectMessage(ann, "/start");
  await api("sendMessage", { chat_id: ann, text: "welcome" });
  const asked = (
    await api("sendMessage", {
      chat_id: CHAT,
      text: "Rules?",
      reply_markup: {
        inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
      },
    })
  ).result.message_id;
  const press = fake.pressButton(CHAT, asked, ann, "ok");
  await fake.waitFor({ kind: "update", botId: BOT, type: "callback_query" });
  const { result: updates } = await api("getUpdates");
  const pressed = updates.find((update) => update.callback_query);
  await api("answerCallbackQuery", {
    callback_query_id: pressed.callback_query.id,
    text: "Thanks",
  });
  expect((await press).answered).toBe(true);
  const posted = await fake.post(CHAT, ann, "worth keeping");
  const forwarded = (
    await api("forwardMessage", {
      chat_id: OTHER,
      from_chat_id: CHAT,
      message_id: posted,
    })
  ).result.message_id;
  await api("setWebhook", {
    url: "http://127.0.0.1:9/hook",
    secret_token: "do-not-show",
  });
  await api("deleteWebhook");
  const { connection } = await fake.connectBusiness({
    ownerId: OWNER,
    rights: { can_reply: true },
  });
  const person = await fake.createUser({ first_name: "Sam" });
  await fake.sayInBusinessChat(connection.id, person, "person", "hi");
  expect(
    (
      await api("sendMessage", {
        business_connection_id: connection.id,
        chat_id: person,
        text: "for the owner",
      })
    ).ok,
  ).toBe(true);
  await api("getMe", {}, "999:WRONG");
  const unreadable = await fetch(`${fake.origin}/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data" },
    body: "{broken",
  });
  await unreadable.text();

  const methods = (calls) => calls.map((call) => call.method);
  expect(methods((await page(CHAT)).calls)).toEqual([
    "sendMessage",
    "answerCallbackQuery",
  ]);
  expect(methods((await page(`${ann}:${BOT}`)).calls)).toEqual(["sendMessage"]);
  const log = await page(OTHER);
  expect(log.calls).toHaveLength(1);
  expect(log.calls[0].targets).toMatchObject({
    // The forwarded message is in the chat it came from.
    messages: [{ chat_id: CHAT, message_id: posted }],
    created_message_ids: [forwarded],
  });
  const other = await page("calls");
  expect(
    other.calls.map((call) => [call.method, call.journal, call.status]),
  ).toEqual([
    ["getUpdates", "calls", 200],
    ["setWebhook", "calls", 200],
    ["deleteWebhook", "calls", 200],
    ["sendMessage", "calls", 200],
    ["getMe", "rejected_requests", 401],
    ["sendMessage", "rejected_requests", 400],
  ]);
  expect(other.calls[1].params).toEqual({ url: "http://127.0.0.1:9/hook" });
  expect(JSON.stringify(other)).not.toContain("do-not-show");
  const state = await (await fetch(`${fake.viewerUrl}/api/state`)).json();
  expect(state.chats[0]).toMatchObject({
    key: "calls",
    call_count: 6,
    last_call: { method: "sendMessage", journal: "rejected_requests" },
  });
});

it("merges calls before the items they produced and pages them with the items, then by calls_before", async () => {
  const { fake, api, page, ann } = await setup();
  for (let i = 0; i < 4; i += 1) {
    await fake.post(CHAT, ann, `post ${i}`);
    await api("sendMessage", { chat_id: CHAT, text: `reply ${i}` });
  }
  const refused = await api("deleteMessage", { chat_id: CHAT, message_id: 1 });
  expect(refused.ok).toBe(false);
  await fake.post(CHAT, ann, "last");

  const latest = await page(CHAT);
  expect(labels(mergeStream(latest.items, latest.calls)).slice(-6)).toEqual([
    "message reply 2",
    "message post 3",
    "call sendMessage",
    "message reply 3",
    "call deleteMessage",
    "message last",
  ]);
  // A refusal carries Telegram's text as it was sent.
  expect(latest.calls.at(-1)).toMatchObject({
    method: "deleteMessage",
    outcome: "rejected",
    status: 400,
    description: refused.description,
    targets: { messages: [{ chat_id: CHAT, message_id: 1 }] },
  });

  // Paged by items, every call comes once, on the page of the items around it.
  const seen = [];
  let before = null;
  do {
    const part = await page(
      CHAT,
      `?limit=3${before === null ? "" : `&before=${before}`}`,
    );
    seen.unshift(...labels(mergeStream(part.items, part.calls)));
    before = part.has_older ? part.oldest_seq : null;
  } while (before !== null);
  expect(seen).toEqual(labels(mergeStream(latest.items, latest.calls)));

  // More calls than a page holds: the newest 1000, then the rest by calls_before.
  for (let i = 0; i < 1050; i += 1) await api("getChat", { chat_id: CHAT });
  const { calls: all } = await fake.getCalls();
  const numbers = all
    .filter((call) => call.params.chat_id === String(CHAT))
    .map((call) => Number(call.request_id.split(":").at(-1)));
  const newest = await page(CHAT);
  expect(newest.calls).toHaveLength(1000);
  expect(newest.calls_truncated).toBe(true);
  expect(newest.calls_oldest_request).toBe(newest.calls[0].request_number);
  const rest = await page(CHAT, `?calls_before=${newest.calls_oldest_request}`);
  expect(rest.items).toEqual([]);
  expect(rest.calls_truncated).toBe(false);
  expect(
    [...rest.calls, ...newest.calls].map((call) => call.request_number),
  ).toEqual(numbers);
});

it("escapes everything a call shows", async () => {
  const { fake, api, page } = await setup();
  const hostile = '<img src=x onerror="alert(1)">';
  const eve = await fake.createUser({ first_name: hostile });
  await fake.join(CHAT, eve);
  await fake.failNext({
    method: "restrictChatMember",
    errorCode: 400,
    description: `Bad Request: <script>alert("x")</script>`,
  });
  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: eve,
    permissions: { can_send_messages: false },
  });
  await api("sendMessage", { chat_id: CHAT, text: `${hostile} & more` });
  const current = await page(CHAT);
  const ctx = makeContext(current, { key: String(CHAT) });
  const html = [
    ...current.calls.map((call) => renderCall(call, ctx)),
    renderCallFilters(current.calls, { bots: null, methods: null }, ctx),
  ].join("");
  expect(html).not.toMatch(/<img|<script/i);
  expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});
