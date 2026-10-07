import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
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
  // The Activity feed comes first, then the calls no chat holds.
  expect(state.chats[0]).toMatchObject({ key: "all", title: "Activity" });
  expect(state.chats[1]).toMatchObject({
    key: "calls",
    call_count: 6,
    last_call: { method: "sendMessage", journal: "rejected_requests" },
  });
});

it("reads a call's permissions as Telegram does, those left out off", async () => {
  const { api, page, ann } = await setup();
  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: ann,
    permissions: { can_send_photos: false },
  });
  const { result: member } = await api("getChatMember", {
    chat_id: CHAT,
    user_id: ann,
  });
  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: ann,
    permissions: "not an object",
  });

  const [restricted, refused] = (await page(CHAT)).calls.filter(
    (call) => call.method === "restrictChatMember",
  );
  // Telegram turned off every permission, not only the one named.
  expect(Object.values(restricted.resolved_permissions)).not.toContain(true);
  expect(restricted.resolved_permissions).toEqual(
    Object.fromEntries(
      Object.keys(restricted.resolved_permissions).map((key) => [
        key,
        member[key],
      ]),
    ),
  );
  expect(refused).toMatchObject({ status: 400, resolved_permissions: null });
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

/** The first bytes of a PNG: enough for its type and size to be read. */
function png(width, height) {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A recorded page's messages by text, the context ones marked "before:". */
const recorded = (page) =>
  page.items
    .filter((item) => item.kind === "message")
    .map(
      (item) =>
        `${item.before_window ? "before: " : ""}${item.message.text ?? item.message.caption}`,
    );

/** A fresh directory for recordings, removed after the test. */
async function recordDir() {
  const dir = await mkdtemp(join(tmpdir(), "recordings-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

it("records only what happened between start and stop, with the older messages its calls and replies name", async () => {
  const { fake, api, ann } = await setup();
  const deleted = await fake.post(CHAT, ann, "before the start");
  const quoted = await fake.post(CHAT, ann, "quoted later");
  await fake.post(CHAT, ann, "named by nothing");
  await api("sendMessage", { chat_id: CHAT, text: "bot before" });
  await api("sendMessage", { chat_id: OTHER, text: "other chat before" });
  const started = await fake.startRecording("window");
  await fake.post(CHAT, ann, { text: "a reply", replyTo: quoted });
  await api("deleteMessage", { chat_id: CHAT, message_id: deleted });
  await api("sendMessage", { chat_id: CHAT, text: "bot inside" });
  await api("getMe");
  const { json } = await fake.stopRecording("window");

  expect(json).toMatchObject({
    format: "telegram-bot-test-server-recording",
    format_version: 1,
    name: "window",
    chats_filter: null,
    missing_chats: [],
    window: {
      epoch: 0,
      start_seq: started.start_seq,
      start_request: started.start_request,
      stop_request: started.start_request + 3,
      started_at: started.started_at,
    },
  });
  // Only the chats something happened in, and the calls no chat holds.
  expect(Object.keys(json.pages).sort()).toEqual([String(CHAT), "calls"]);
  expect(json.state.chats.map((row) => row.key)).toEqual([
    "calls",
    String(CHAT),
  ]);
  const page = json.pages[CHAT];
  expect(recorded(page)).toEqual([
    "before: before the start",
    "before: quoted later",
    "a reply",
    "bot inside",
  ]);
  expect(page.items[0]).toMatchObject({
    deleted: true,
    deleted_by: { method: "deleteMessage" },
  });
  expect(page.has_older).toBe(false);
  expect(page.calls.map((call) => call.method)).toEqual([
    "deleteMessage",
    "sendMessage",
  ]);
  expect(json.pages.calls.calls.map((call) => call.method)).toEqual(["getMe"]);
  expect(page.members.map((entry) => entry.user_id)).toContain(ann);
});

it("records each message's reactions as they are at the stop, an older message's included", async () => {
  const { fake, api, ann } = await setup();
  const quoted = await fake.post(CHAT, ann, "from before");
  await fake.startRecording("reactions");
  const reply = await fake.post(CHAT, ann, {
    text: "a reply",
    replyTo: quoted,
  });
  await fake.react(CHAT, quoted, ann, "🔥");
  await fake.react(CHAT, reply, ann, "👀");
  await api("setMessageReaction", {
    chat_id: CHAT,
    message_id: reply,
    reaction: [{ type: "emoji", emoji: "👍" }],
  });
  await fake.react(CHAT, reply, ann, null);
  const { json } = await fake.stopRecording("reactions");

  expect(
    json.pages[CHAT].items.map((item) => [
      recorded({ items: [item] })[0],
      item.reactions,
    ]),
  ).toEqual([
    [
      "before: from before",
      [{ type: "emoji", emoji: "🔥", total_count: 1, user_ids: [ann] }],
    ],
    [
      "a reply",
      [{ type: "emoji", emoji: "👍", total_count: 1, user_ids: [BOT] }],
    ],
  ]);
});

it("records only the chats it names, a private chat that starts after it included", async () => {
  const { fake, api, ann } = await setup();
  const sam = await fake.createUser({ first_name: "Sam" });
  const missing = -1009999999999;
  await expect(
    fake.startRecording("bad", { chats: [CHAT, "-12x"] }),
  ).rejects.toThrow("bad chat reference: -12x");
  await fake.startRecording("named", {
    chats: [OTHER, `${sam}:${BOT}`, missing],
  });
  await fake.post(CHAT, ann, "not recorded");
  await fake.sendDirectMessage(sam, "/start");
  await api("sendMessage", { chat_id: sam, text: "hello Sam" });
  await api("sendMessage", { chat_id: OTHER, text: "logged" });
  const { json } = await fake.stopRecording("named");

  expect(json.chats_filter).toEqual([
    String(OTHER),
    `${sam}:${BOT}`,
    String(missing),
  ]);
  expect(json.missing_chats).toEqual([String(missing)]);
  expect(Object.keys(json.pages).sort()).toEqual(
    [String(OTHER), `${sam}:${BOT}`].sort(),
  );
  expect(recorded(json.pages[`${sam}:${BOT}`])).toEqual([
    "/start",
    "hello Sam",
  ]);
  expect(recorded(json.pages[OTHER])).toEqual(["logged"]);
  expect(json.state.chats.map((row) => row.key).sort()).toEqual(
    [String(OTHER), `${sam}:${BOT}`].sort(),
  );
});

it("runs named recordings side by side, each with its own window, over HTTP", async () => {
  const { fake, ann } = await setup();
  const control = async (action, body) => {
    const response = await fetch(`${fake.origin}/_fake/record/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  expect(await control("start", { name: "../escape" })).toEqual({
    status: 400,
    body: {
      error: 'a recording needs a name of letters, digits, ".", "_" and "-"',
    },
  });
  expect((await control("start", { name: "first" })).status).toBe(200);
  await fake.post(CHAT, ann, "one");
  expect((await control("start", { name: "second" })).status).toBe(200);
  expect(await control("start", { name: "first" })).toEqual({
    status: 409,
    body: { error: "recording first is already running" },
  });
  await fake.post(CHAT, ann, "two");
  const first = await control("stop", { name: "first" });
  await fake.post(CHAT, ann, "three");
  const second = await control("stop", { name: "second" });

  expect(first.status).toBe(200);
  expect(first.body.html).toMatch(/^<!doctype html>/);
  expect(recorded(first.body.json.pages[CHAT])).toEqual(["one", "two"]);
  expect(recorded(second.body.json.pages[CHAT])).toEqual(["two", "three"]);
  expect(await control("stop", { name: "first" })).toEqual({
    status: 404,
    body: { error: "recording first is not running" },
  });
  // A stopped name can record again.
  expect((await control("start", { name: "first" })).status).toBe(200);
});

it("drops a recording that spans a restore, which neither holds up nor keeps recordings", async () => {
  const { fake, ann } = await setup();
  await fake.startRecording("spans");
  const saved = await fake.snapshot();
  await fake.post(CHAT, ann, "undone");
  await fake.restore(saved);
  await fake.startRecording("after");
  await fake.post(CHAT, ann, "kept");

  await expect(fake.stopRecording("spans")).rejects.toThrow(
    "recording spans started before a restore; start it after restoring",
  );
  await expect(fake.stopRecording("spans")).rejects.toThrow(
    "recording spans is not running",
  );
  const { json } = await fake.stopRecording("after");
  expect(json.window.epoch).toBe(1);
  expect(recorded(json.pages[CHAT])).toEqual(["kept"]);
});

it("writes the file and its twin into recordDir, with the viewer off", async () => {
  const dir = await recordDir();
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: CHAT, title: "Timeline", ownerId: OWNER }],
    recordDir: join(dir, "runs"),
  });
  cleanups.push(() => fake.stop());
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  await fake.startRecording("spam-is-removed");
  await fake.post(CHAT, ann, "inside");
  const recording = await fake.stopRecording("spam-is-removed");

  expect(recording.files).toEqual({
    html: join(dir, "runs", "spam-is-removed.html"),
    json: join(dir, "runs", "spam-is-removed.json"),
  });
  expect(await readFile(recording.files.html, "utf8")).toBe(recording.html);
  expect(JSON.parse(await readFile(recording.files.json, "utf8"))).toEqual(
    recording.json,
  );
  expect(recorded(recording.json.pages[CHAT])).toEqual(["inside"]);
  expect(fake.viewerUrl).toBeNull();
  expect((await fetch(`${fake.origin}/_fake/ui`)).status).toBe(404);
});

it("draws the recording in one file that loads nothing and holds user text only as escaped data", async () => {
  const { fake, api } = await setup();
  const hostile = '</script><img src=x onerror="alert(1)"><!--';
  const eve = await fake.createUser({ first_name: hostile });
  await fake.join(CHAT, eve);
  await fake.startRecording("self-contained");
  await fake.renameChat(CHAT, { by: OWNER, title: hostile });
  await fake.changeChatPhoto(CHAT, { by: OWNER, bytes: png(64, 64) });
  const image = png(96, 64);
  const photo = await fake.post(CHAT, eve, { photo: image, caption: hostile });
  await fake.post(CHAT, eve, { text: "the same photo", replyTo: photo });
  await api("sendMessage", {
    chat_id: CHAT,
    text: hostile,
    reply_markup: {
      inline_keyboard: [[{ text: hostile, callback_data: hostile }]],
    },
  });
  const { html, json } = await fake.stopRecording("self-contained");

  // The policy comes first, and allows exactly the inline style and script.
  const head = html.slice(html.indexOf("<head>") + "<head>".length);
  expect(head.trimStart()).toMatch(
    /^<meta http-equiv="Content-Security-Policy" content="[^"]+">/,
  );
  const policy = /content="([^"]+)"/.exec(head)[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  expect(scripts.map((match) => match[1])).toEqual([
    ' type="application/json" id="tv-data"',
    "",
  ]);
  const [data, script] = scripts.map((match) => match[2]);
  const sha = (text) => createHash("sha256").update(text).digest("base64");
  expect(policy).toBe(
    `default-src 'none'; img-src data:; style-src 'sha256-${sha(style)}'; script-src 'sha256-${sha(script)}'; base-uri 'none'; form-action 'none'`,
  );
  expect(() => new vm.Script(script)).not.toThrow();
  expect(JSON.parse(data)).toEqual(json);

  // Nothing outside the script and the data loads a file; the stylesheet's
  // images are data too.
  const markup = html.replace(script, "").replace(data, "");
  expect(markup).not.toMatch(/<link|@import/i);
  const urls = [
    ...markup.matchAll(/\b(?:src|href)\s*=\s*["']?([^"'\s>]*)/gi),
    ...markup.matchAll(/url\(\s*["']?([^"')\s]*)/gi),
  ].map((match) => match[1]);
  expect(urls.filter((url) => !url.startsWith("data:"))).toEqual([]);
  expect(html).not.toContain(fake.origin);
  expect(html).not.toContain("/_fake/ui/files/");

  // Each image once, as data, in the top-level table only.
  const page = json.pages[CHAT];
  const photoId = page.items
    .find((item) => item.message.photo && !item.message.new_chat_photo)
    .message.photo.at(-1).file_id;
  expect(json.files[photoId]).toEqual({
    url: `data:image/png;base64,${image.toString("base64")}`,
    mime_type: "image/png",
    width: 96,
    height: 64,
    size: image.length,
  });
  expect(json.files[page.chat.photo_file_id].url).toBe(
    `data:image/png;base64,${png(64, 64).toString("base64")}`,
  );
  expect(html.split(image.toString("base64"))).toHaveLength(2);
  expect(json.state.files).toEqual({});
  expect(page.files).toEqual({});

  // User text is data the page escapes when it draws it: none of it is markup here.
  expect(html).not.toContain("<img src=x");
  expect(html.match(/<\/script/gi)).toHaveLength(2);
  expect(html).not.toContain("<!--");
  expect(data).toContain("\\u003c/script>\\u003cimg src=x");
});
