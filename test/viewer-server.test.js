import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { startTestServer } from "../src/index.js";

const TOKEN = "123456:VIEWER-SECRET";
const BOT = 123456;
const SECOND_TOKEN = "654321:SECOND-SECRET";
const CHAT = -1001000000001;
const OWNER = 5000000001;
const NOW = 1_800_000_000_000;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup(options = {}) {
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: CHAT, title: "Viewer", ownerId: OWNER }],
    ui: true,
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
  const get = async (path) => {
    const response = await fetch(`${fake.origin}/_fake/ui/${path}`);
    const type = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      headers: response.headers,
      body: type.startsWith("application/json")
        ? await response.json()
        : Buffer.from(await response.arrayBuffer()),
    };
  };
  const page = async (ref, query = "") => {
    const answer = await get(`api/chats/${encodeURIComponent(ref)}${query}`);
    expect(answer.status).toBe(200);
    return answer.body;
  };
  return { fake, api, get, page };
}

/** A request with headers fetch would not let a test set. */
function raw(fake, path, { method = "GET", headers = {} } = {}) {
  const { port } = new URL(fake.origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** The viewer's event stream, read event by event. */
function events(fake) {
  const received = [];
  const waiting = [];
  let ended;
  const closed = new Promise((resolve) => {
    ended = resolve;
  });
  let buffer = "";
  const deliver = () => {
    for (const waiter of [...waiting]) {
      const index = received.findIndex((event) => event.event === waiter.type);
      if (index >= 0) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve(received.splice(index, 1)[0]);
      }
    }
  };
  const request = http.get(`${fake.origin}/_fake/ui/events`, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(
          block
            .split("\n")
            .filter((line) => line && !line.startsWith(":"))
            .map((line) => [
              line.slice(0, line.indexOf(":")),
              line.slice(line.indexOf(":") + 1).trim(),
            ]),
        );
        if (fields.event) {
          received.push({
            event: fields.event,
            id: fields.id,
            data: JSON.parse(fields.data),
          });
          deliver();
        }
      }
    });
    response.on("end", ended);
    response.on("close", ended);
  });
  cleanups.push(() => request.destroy());
  return {
    next: (type) =>
      new Promise((resolve) => {
        waiting.push({ type, resolve });
        deliver();
      }),
    closed,
  };
}

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

const texts = (items) =>
  items
    .filter((item) => item.kind === "message")
    .map((item) => item.message.text);

it("is off by default: /_fake/ui answers as any unknown control", async () => {
  const fake = await startTestServer({ botToken: TOKEN });
  cleanups.push(() => fake.stop());
  expect(fake.viewerUrl).toBe(null);
  const response = await fetch(`${fake.origin}/_fake/ui`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Unknown control GET /ui" });
});

it("answers only this computer, only GET, and needs a host it can answer on", async () => {
  const { fake, get } = await setup();
  const { port } = new URL(fake.origin);
  expect(fake.viewerUrl).toBe(`http://127.0.0.1:${port}/_fake/ui`);
  const state = await get("api/state");
  expect(state.status).toBe(200);
  expect(state.headers.get("x-content-type-options")).toBe("nosniff");
  expect(state.headers.get("cache-control")).toBe("no-store");
  expect(
    (
      await raw(fake, "/_fake/ui/api/state", {
        headers: { Host: `localhost:${port}` },
      })
    ).status,
  ).toBe(200);
  const foreign = await raw(fake, "/_fake/ui/api/state", {
    headers: { Host: `viewer.example:${port}` },
  });
  expect(foreign.status).toBe(403);
  expect(
    (
      await raw(fake, "/_fake/ui/api/state", {
        headers: { Host: "localhost:1" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await raw(fake, "/_fake/ui/api/state", {
        headers: { "X-Forwarded-For": "203.0.113.9" },
      })
    ).status,
  ).toBe(403);
  const posted = await raw(fake, "/_fake/ui", { method: "POST" });
  expect(posted.status).toBe(405);
  expect(posted.headers.allow).toBe("GET");
  expect((await get("nothing-here")).status).toBe(404);
  await expect(
    startTestServer({ botToken: TOKEN, ui: true, host: "192.0.2.10" }),
  ).rejects.toThrow("ui needs a loopback or wildcard host");
});

it("lists every chat, each private chat once per bot, and opens a private chat without storing anything", async () => {
  const { fake, api, get, page } = await setup();
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
    firstName: "Second Bot",
  });
  await fake.setBotMembership(CHAT, second.id);
  const channel = await fake.createChat({
    type: "channel",
    title: "News",
    ownerId: OWNER,
  });
  const forum = await fake.createChat({
    title: "Help",
    ownerId: OWNER,
    isForum: true,
  });
  const basic = await fake.createChat({
    type: "group",
    title: "Basic",
    ownerId: OWNER,
  });
  const upgraded = await fake.migrateToSupergroup(basic);
  const ann = await fake.createUser({ first_name: "Ann", last_name: "Lee" });
  await fake.sendDirectMessage(ann, "/start");
  const invite = (
    await api("createChatInviteLink", {
      chat_id: CHAT,
      creates_join_request: true,
    })
  ).result.invite_link;
  const carol = await fake.createUser({ first_name: "Carol" });
  await fake.joinByLink(invite, carol);
  await api(
    "sendMessage",
    { chat_id: carol, text: "answer 2+2 to join" },
    SECOND_TOKEN,
  );
  const dave = await fake.createUser({ first_name: "Dave" });
  await fake.sendDirectMessage(dave, "/start");
  await api("unpinAllChatMessages", { chat_id: dave }, SECOND_TOKEN);
  const eve = await fake.createUser({ first_name: "Eve" });

  const { body: state } = await get("api/state");
  expect(state.bots).toEqual([
    {
      id: BOT,
      username: "example_bot",
      first_name: "Example Bot",
      first: true,
      index: 0,
    },
    {
      id: second.id,
      username: "second_bot",
      first_name: "Second Bot",
      first: false,
      index: 1,
    },
  ]);
  const rows = Object.fromEntries(state.chats.map((row) => [row.key, row]));
  expect(Object.keys(rows).sort()).toEqual(
    [
      String(CHAT),
      String(channel),
      String(forum),
      String(basic),
      String(upgraded),
      `${ann}:${BOT}`,
      `${carol}:${second.id}`,
      `${dave}:${BOT}`,
      `${dave}:${second.id}`,
    ].sort(),
  );
  expect(rows[basic]).toMatchObject({ type: "group", migrated_to: upgraded });
  expect(rows[upgraded]).toMatchObject({
    type: "supergroup",
    migrated_from: basic,
  });
  expect(rows[forum]).toMatchObject({ is_forum: true });
  expect(rows[channel]).toMatchObject({ type: "channel", title: "News" });
  expect(rows[`${ann}:${BOT}`]).toMatchObject({
    type: "private",
    title: "Ann Lee",
    user_id: ann,
    bot_id: BOT,
    last: { kind: "message", preview: "/start", author: ann },
  });
  expect(rows[`${carol}:${second.id}`]).toMatchObject({
    last: { kind: "message", preview: "answer 2+2 to join" },
    message_count: 1,
  });
  expect(rows[`${dave}:${second.id}`]).toMatchObject({
    message_count: 0,
    last: { kind: "event", media: "unpin" },
  });
  expect(rows[CHAT]).toMatchObject({ pending_join_requests: 1 });
  // The rows' people come with the list, whichever chats a page has open.
  expect(state.users[ann]).toMatchObject({
    first_name: "Ann",
    last_name: "Lee",
  });
  expect(state.users[carol]).toMatchObject({ first_name: "Carol" });

  const empty = await page(`${eve}:${BOT}`);
  expect(empty).toMatchObject({
    chat: { key: `${eve}:${BOT}`, type: "private", user_id: eve, bot_id: BOT },
    items: [],
    has_older: false,
  });
  expect((await page(String(eve))).chat.key).toBe(`${eve}:${BOT}`);
  // Opening it stored nothing: the bot still may not write first.
  expect((await api("sendMessage", { chat_id: eve, text: "hi" })).status).toBe(
    403,
  );
  const missing = await get("api/chats/-1009999999999");
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ error: "chat not found" });
  expect((await get(`api/chats/${eve}:${OWNER}`)).status).toBe(404);
});

it("pages a chat's messages and events in order and logs member changes, join requests and unpins", async () => {
  const { fake, api, get, page } = await setup({ clock: { now: NOW } });
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  for (let i = 0; i < 12; i += 1) await fake.post(CHAT, ann, `post ${i}`);
  const latest = await page(CHAT, "?limit=5");
  expect(texts(latest.items)).toEqual(
    [7, 8, 9, 10, 11].map((i) => `post ${i}`),
  );
  expect(latest.has_older).toBe(true);
  expect(latest.oldest_seq).toBe(latest.items[0].seq);
  expect(latest.latest_seq).toBe(latest.items[4].seq);
  const older = await page(CHAT, `?limit=5&before=${latest.oldest_seq}`);
  expect(texts(older.items)).toEqual([2, 3, 4, 5, 6].map((i) => `post ${i}`));
  expect(older.latest_seq).toBe(older.items[4].seq);
  expect(older.chat_latest_seq).toBe(latest.latest_seq);
  const both = [...older.items, ...latest.items];
  const range = await page(CHAT, `?from=${both[1].seq}&to=${both[6].seq}`);
  expect(range.items.map((item) => item.seq)).toEqual(
    both.slice(1, 7).map((item) => item.seq),
  );
  for (const query of ["?limit=0", "?limit=x", "?before=1&from=1", "?as=-5"]) {
    expect((await get(`api/chats/${CHAT}${query}`)).status).toBe(400);
  }

  const link = (
    await api("createChatInviteLink", {
      chat_id: CHAT,
      name: "Ads <b>",
      creates_join_request: true,
    })
  ).result.invite_link;
  const carol = await fake.createUser({ first_name: "Carol" });
  const dan = await fake.createUser({ first_name: "Dan" });
  const bob = await fake.createUser({ first_name: "Bob" });
  await fake.joinByLink(link, carol);
  await api("approveChatJoinRequest", { chat_id: CHAT, user_id: carol });
  await fake.joinByLink(link, dan);
  await api("declineChatJoinRequest", { chat_id: CHAT, user_id: dan });
  await fake.join(CHAT, bob);
  const restricted = await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: ann,
    permissions: { can_send_messages: false },
    until_date: NOW / 1000 + 60,
  });
  expect(restricted.ok).toBe(true);
  await api("banChatMember", { chat_id: CHAT, user_id: bob });
  const pinned = await fake.post(CHAT, carol, "rules");
  await api("pinChatMessage", { chat_id: CHAT, message_id: pinned });
  await api("unpinChatMessage", { chat_id: CHAT, message_id: pinned });
  await fake.advanceTime(61_000);
  const { calls } = await fake.getCalls();
  const callId = (method) =>
    calls.find((call) => call.method === method).request_id;

  const { items } = await page(CHAT, "?limit=1000");
  const seqs = items.map((item) => item.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  const events = items.filter((item) => item.kind === "event");
  const find = (fields) =>
    items.findIndex((item) =>
      Object.entries(fields).every(
        ([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value),
      ),
    );
  const requested = find({
    type: "join_request",
    user_id: carol,
    state: "pending",
  });
  const approved = find({
    type: "join_request",
    user_id: carol,
    state: "approved",
  });
  const admitted = find({ type: "member", user_id: carol });
  const welcome = items.findIndex(
    (item) => item.message?.new_chat_members?.[0].id === carol,
  );
  expect(requested).toBeLessThan(approved);
  expect(approved).toBeLessThan(admitted);
  expect(admitted).toBeLessThan(welcome);
  expect(items[requested]).toMatchObject({
    bot_id: null,
    invite_link: expect.stringMatching(/^https:\/\/t\.me\/\+/),
    invite_link_name: "Ads <b>",
    request_id: null,
  });
  expect(items[approved]).toMatchObject({
    bot_id: BOT,
    invite_link_name: "Ads <b>",
    request_id: callId("approveChatJoinRequest"),
  });
  expect(items[admitted]).toMatchObject({
    actor_id: BOT,
    reason: "change",
    old: { status: "left" },
    new: { status: "member" },
    invite_link_name: "Ads <b>",
    service_seq: items[welcome].seq,
  });
  expect(events.find((event) => event.state === "declined")).toMatchObject({
    user_id: dan,
    bot_id: BOT,
    request_id: callId("declineChatJoinRequest"),
  });
  const bobJoin = items.findIndex(
    (item) => item.message?.new_chat_members?.[0].id === bob,
  );
  expect(
    events.find(
      (event) => event.user_id === bob && event.new.status === "member",
    ),
  ).toMatchObject({ actor_id: bob, service_seq: items[bobJoin].seq });
  expect(
    events.find(
      (event) => event.user_id === bob && event.new.status === "kicked",
    ),
  ).toMatchObject({ actor_id: BOT, request_id: callId("banChatMember") });
  const annEvents = events.filter((event) => event.user_id === ann);
  expect(annEvents.at(-2)).toMatchObject({
    reason: "change",
    actor_id: BOT,
    request_id: callId("restrictChatMember"),
    new: {
      status: "restricted",
      can_send_messages: false,
      until_date: NOW / 1000 + 60,
    },
  });
  expect(annEvents.at(-1)).toMatchObject({
    reason: "expired",
    actor_id: null,
    request_id: null,
    at: NOW + 60_000,
    old: { status: "restricted" },
    new: { status: "member" },
  });
  expect(events.find((event) => event.type === "unpin")).toMatchObject({
    message_id: pinned,
    all: false,
    bot_id: BOT,
    request_id: callId("unpinChatMessage"),
  });
});

it("shows members as getChatMember does, most notable first, live and without writing anything", async () => {
  const { fake, api, page } = await setup();
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
  });
  await fake.setBotMembership(CHAT, second.id, {
    rights: { can_restrict_members: false },
  });
  const people = [];
  for (const name of ["Ann", "Bob", "Carl", "Dina", "Ed"]) {
    const id = await fake.createUser({ first_name: name });
    await fake.join(CHAT, id);
    people.push(id);
  }
  const [ann, bob, carl] = people;
  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: bob,
    permissions: { can_send_messages: false },
  });
  await api("banChatMember", { chat_id: CHAT, user_id: carl });
  const strip = ({ user: _user, can_be_edited: _edited, ...member }) => member;
  const read = await page(CHAT);
  const members = Object.fromEntries(
    read.members.map(({ user_id, member }) => [user_id, member]),
  );
  expect(members[bob]).toEqual(
    strip((await api("getChatMember", { chat_id: CHAT, user_id: bob })).result),
  );
  expect(members[second.id]).toEqual(
    strip(
      (await api("getChatMember", { chat_id: CHAT, user_id: second.id }))
        .result,
    ),
  );
  expect(members[second.id].can_restrict_members).toBe(false);
  expect(read.members.map((entry) => entry.user_id)).toEqual([
    OWNER,
    BOT,
    second.id,
    bob,
    carl,
    ...people.filter((id) => id !== bob && id !== carl).sort((a, b) => a - b),
  ]);
  expect(read.members_total).toBe(people.length + 3);
  // Carl is banned: every record but his is in the chat.
  expect(read.members_in_chat).toBe(people.length + 2);

  const capped = await page(CHAT, "?members_limit=5&limit=1");
  expect(capped.members.map((entry) => entry.user_id)).toEqual([
    OWNER,
    BOT,
    second.id,
    bob,
    carl,
  ]);
  expect(capped.members_total).toBe(people.length + 3);
  expect((await page(CHAT, "?members_limit=0")).members).toEqual([]);

  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: ann,
    permissions: { can_send_messages: false },
  });
  const changed = await page(CHAT);
  expect(
    changed.members.find((entry) => entry.user_id === ann).member,
  ).toMatchObject({ status: "restricted", can_send_messages: false });

  // Reading moved nothing: no message, event or deletion was added.
  const before = await fake.getMessageLog(CHAT);
  await page(CHAT);
  await page(`${ann}:${BOT}`);
  expect((await fake.getMessageLog(CHAT)).cursor).toBe(before.cursor);
});

it("streams a change event after every change, never blocks a snapshot, and says when the server stops", async () => {
  const { fake } = await setup();
  const stream = events(fake);
  const hello = await stream.next("hello");
  expect(hello.data).toMatchObject({
    instance: expect.stringMatching(/^[0-9a-f]{24}$/),
    epoch: 0,
  });
  expect(Number(hello.id)).toBe(hello.data.version);
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  await fake.post(CHAT, ann, "hello");
  const change = await stream.next("change");
  expect(change.data.instance).toBe(hello.data.instance);
  expect(change.data.version).toBeGreaterThan(hello.data.version);
  expect(await fake.snapshot()).toEqual(expect.any(String));
  await fake.stop();
  expect(await stream.next("stopped")).toMatchObject({ data: {} });
  await stream.closed;
});

it("serves stored image bytes and nothing else", async () => {
  const { fake, get, page } = await setup();
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  const image = png(96, 64);
  await fake.post(CHAT, ann, { photo: image, caption: "receipt" });
  await fake.post(CHAT, ann, {
    media: {
      type: "document",
      bytes: Buffer.from("plain text"),
      fileName: "notes.txt",
    },
  });
  const { items, files } = await page(CHAT);
  const photo = items.find((item) => item.message?.photo).message.photo.at(-1);
  const document = items.find((item) => item.message?.document).message
    .document;
  expect(files[photo.file_id]).toEqual({
    url: `/_fake/ui/files/${photo.file_id}`,
    mime_type: "image/png",
    width: 96,
    height: 64,
    size: image.length,
  });
  expect(files[document.file_id]).toBeUndefined();
  const served = await get(`files/${photo.file_id}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("cache-control")).toBe(
    "private, max-age=31536000, immutable",
  );
  expect(Buffer.compare(served.body, image)).toBe(0);
  expect((await get(`files/${document.file_id}`)).status).toBe(404);
  expect((await get("files/unknown")).status).toBe(404);
});

it("serves the page under its policy with every file it loads, and no other file", async () => {
  const { fake, get } = await setup();
  const response = await fetch(fake.viewerUrl);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  const html = await response.text();
  const loads = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith("data:"));
  const boot = loads.find((url) => url.endsWith(".js"));
  const bootSource = (await get(boot.slice("/_fake/ui/".length))).body;
  // boot.js imports the other modules next to it.
  const modules = [
    ...String(bootSource).matchAll(/from "\.\/([a-z]+\.js)"/g),
  ].map((match) => `/_fake/ui/assets/${match[1]}`);
  expect(modules.length).toBeGreaterThan(0);
  for (const url of [...loads, ...modules]) {
    const asset = await get(url.slice("/_fake/ui/".length));
    expect(asset.status, url).toBe(200);
    expect(asset.headers.get("content-type"), url).toBe(
      url.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
    );
  }
  // The server's own modules are not the page's.
  for (const name of [
    "server.js",
    "state.js",
    "..%2Findex.js",
    "viewer.html",
  ]) {
    expect((await get(`assets/${name}`)).status, name).toBe(404);
  }
});

it("keeps everything the viewer reads out of the updates bots receive", async () => {
  const { fake, api } = await setup();
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  const first = await fake.post(CHAT, ann, "first");
  await fake.post(CHAT, ann, { text: "a reply", replyTo: first });
  await api("pinChatMessage", { chat_id: CHAT, message_id: first });
  await api("deleteMessage", { chat_id: CHAT, message_id: first });
  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: ann,
    permissions: { can_send_messages: false },
  });
  const response = await fetch(`${fake.origin}/bot${TOKEN}/getUpdates`);
  const keys = new Set();
  JSON.parse(await response.text(), (key, value) => {
    keys.add(key);
    return value;
  });
  for (const key of [
    "seq",
    "at",
    "after_request",
    "afterRequest",
    "request_id",
    "requestId",
    "deleted_by",
    "deletion",
    "service_seq",
    "serviceSeq",
  ]) {
    expect(keys.has(key)).toBe(false);
  }
});

it("shows a supergroup as one member sees it, filtered before the page is cut", async () => {
  const { fake, api, get, page } = await setup();
  const ann = await fake.createUser({ first_name: "Ann" });
  const bob = await fake.createUser({ first_name: "Bob" });
  const carol = await fake.createUser({ first_name: "Carol" });
  for (const id of [ann, bob, carol]) await fake.join(CHAT, id);
  await api("banChatMember", { chat_id: CHAT, user_id: bob });
  const gone = await fake.post(CHAT, ann, "to be deleted");
  await fake.post(CHAT, ann, { text: "a reply", replyTo: gone });
  await api("deleteMessage", { chat_id: CHAT, message_id: gone });
  for (const [receiver, text] of [
    [carol, "for Carol"],
    [ann, "for Ann"],
  ]) {
    await api("sendMessage", {
      chat_id: CHAT,
      text,
      ephemeral_message_parameters: { receiver_user_id: receiver },
    });
  }
  const other = await fake.createChat({ title: "Elsewhere", ownerId: OWNER });
  await fake.sendDirectMessage(ann, "/start");
  await fake.sendDirectMessage(carol, "/start");

  const testView = await page(CHAT);
  expect(
    testView.items.find((item) => item.message?.text === "a reply"),
  ).toMatchObject({ reply_deleted: true });
  const asAnn = await page(CHAT, `?as=${ann}`);
  expect(asAnn.as).toEqual({
    user_id: ann,
    status: "member",
    in_chat: true,
    access: "all",
    history_may_be_hidden: true,
  });
  expect(asAnn.items.every((item) => item.kind === "message")).toBe(true);
  expect(asAnn.items.some((item) => item.deleted)).toBe(false);
  expect(texts(asAnn.items)).toContain("for Ann");
  expect(texts(asAnn.items)).not.toContain("for Carol");
  expect(
    asAnn.items.find((item) => item.message.text === "a reply"),
  ).toMatchObject({ reply_deleted: true });
  expect(asAnn).toMatchObject({ members: [], join_requests: [] });

  const asBob = await page(CHAT, `?as=${bob}`);
  expect(asBob.items).toEqual([]);
  expect(asBob.as).toMatchObject({
    status: "kicked",
    in_chat: false,
    access: "none",
  });
  expect(asBob.users[bob]).toMatchObject({ first_name: "Bob" });
  const { body: bobList } = await get(`api/state?as=${bob}`);
  expect(bobList.chats).toEqual([
    expect.objectContaining({ key: String(CHAT), last: null, access: "none" }),
  ]);

  const { body: list } = await get(`api/state?as=${ann}`);
  expect(list.chats.map((row) => row.key).sort()).toEqual(
    [String(CHAT), `${ann}:${BOT}`].sort(),
  );
  expect(list.chats.map((row) => row.key)).not.toContain(String(other));

  const bulk = [];
  for (let i = 0; i < 260; i += 1)
    bulk.push(await fake.post(CHAT, ann, `bulk ${i}`));
  const newest = bulk.slice(10);
  for (let i = 0; i < newest.length; i += 100) {
    await api("deleteMessages", {
      chat_id: CHAT,
      message_ids: newest.slice(i, i + 100),
    });
  }
  const cut = await page(CHAT, `?as=${ann}&limit=5`);
  expect(texts(cut.items)).toEqual([5, 6, 7, 8, 9].map((i) => `bulk ${i}`));
  expect(cut.has_older).toBe(true);
  expect(
    (await page(CHAT, "?limit=5")).items.every((item) => item.deleted),
  ).toBe(true);
});

it("shows a basic group only while the member was in it, and nothing after a ban that revoked it", async () => {
  const { fake, api, page } = await setup();
  const basic = await fake.createChat({
    type: "group",
    title: "Basic",
    ownerId: OWNER,
  });
  await fake.setBotMembership(basic, BOT);
  await fake.post(basic, OWNER, "before Ann");
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(basic, ann);
  await fake.post(basic, ann, "Ann is here");
  const asAnn = await page(basic, `?as=${ann}`);
  expect(asAnn.as).toMatchObject({ access: "while_member", in_chat: true });
  expect(texts(asAnn.items)).not.toContain("before Ann");
  expect(asAnn.items[0].message.new_chat_members[0].id).toBe(ann);
  expect(texts(asAnn.items)).toContain("Ann is here");

  const carl = await fake.createUser({ first_name: "Carl" });
  await fake.join(basic, carl);
  await fake.post(basic, carl, "Carl was here");
  await fake.leave(basic, carl);
  await fake.post(basic, ann, "after Carl");
  const asCarl = await page(basic, `?as=${carl}`);
  expect(asCarl.as).toMatchObject({ access: "while_member", in_chat: false });
  expect(texts(asCarl.items)).toContain("Carl was here");
  expect(texts(asCarl.items)).not.toContain("after Carl");
  expect(texts(asCarl.items)).not.toContain("Ann is here");

  const bob = await fake.createUser({ first_name: "Bob" });
  await fake.join(basic, bob);
  await fake.post(basic, bob, "Bob was here");
  await api("banChatMember", {
    chat_id: basic,
    user_id: bob,
    revoke_messages: true,
  });
  const asBob = await page(basic, `?as=${bob}`);
  expect(asBob.items).toEqual([]);
  expect(asBob.as).toMatchObject({ access: "none", in_chat: false });
});

it("filters a forum by topic, its calls too", async () => {
  const { fake, api, page } = await setup();
  const forum = await fake.createChat({
    title: "Help",
    ownerId: OWNER,
    isForum: true,
  });
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(forum, ann);
  const topic = await fake.createTopic(forum, "Questions");
  await fake.post(forum, ann, { text: "in the topic", threadId: topic });
  await fake.post(forum, ann, "in General");
  const inTopic = await page(forum, `?topic=${topic}`);
  expect(inTopic.chat.topics).toEqual([
    { message_thread_id: topic, name: "Questions" },
  ]);
  expect(inTopic.items.map((item) => item.message.message_thread_id)).toEqual([
    topic,
    topic,
  ]);
  expect(texts(inTopic.items)).toEqual([undefined, "in the topic"]);
  const general = await page(forum, "?topic=general");
  expect(texts(general.items)).toContain("in General");
  expect(texts(general.items)).not.toContain("in the topic");

  // A call is in the topic of the message it stored, else of its
  // message_thread_id; one with neither is in General.
  await fake.setBotMembership(forum, BOT);
  await api("sendMessage", {
    chat_id: forum,
    message_thread_id: topic,
    text: "answer",
  });
  await api("sendMessage", {
    chat_id: forum,
    message_thread_id: topic,
    text: "",
  });
  await api("sendMessage", { chat_id: forum, text: "for everyone" });
  const calls = async (query) =>
    (await page(forum, query)).calls.map((call) => [
      call.params.text,
      call.status,
    ]);
  expect(await calls(`?topic=${topic}`)).toEqual([
    ["answer", 200],
    ["", 400],
  ]);
  expect(await calls("?topic=general")).toEqual([["for everyone", 200]]);
  expect(await calls("")).toHaveLength(3);
});

it("marks a bot's edit of only the keyboard, which Telegram's apps do not show as an edit", async () => {
  const { api, page } = await setup();
  const keyboard = (data) => ({
    inline_keyboard: [[{ text: "Next", callback_data: data }]],
  });
  const { message_id } = (
    await api("sendMessage", {
      chat_id: CHAT,
      text: "page 1",
      reply_markup: keyboard("2"),
    })
  ).result;
  const item = async () =>
    (await page(CHAT)).items.find(
      (each) => each.message?.message_id === message_id,
    );
  await api("editMessageReplyMarkup", {
    chat_id: CHAT,
    message_id,
    reply_markup: keyboard("3"),
  });
  // The bot still gets edit_date.
  expect(await item()).toMatchObject({
    edit_hidden: true,
    message: { edit_date: expect.any(Number) },
  });
  await api("editMessageText", {
    chat_id: CHAT,
    message_id,
    text: "page 2",
    reply_markup: keyboard("3"),
  });
  expect((await item()).edit_hidden).toBeUndefined();
});

it("names who posted on behalf of a chat, in the message log and the viewer", async () => {
  const { fake, get, page } = await setup();
  const ann = await fake.createUser({ first_name: "Ann" });
  const bob = await fake.createUser({ first_name: "Bob", is_premium: true });
  for (const id of [ann, bob]) await fake.join(CHAT, id);
  await fake.promoteMember(CHAT, ann, {
    rights: { is_anonymous: true, can_delete_messages: true },
  });
  const news = await fake.createChat({
    type: "channel",
    title: "News",
    ownerId: bob,
  });
  const mark = (await fake.getMessageLog(CHAT)).cursor;
  await fake.post(CHAT, ann, "Read the rules");
  await fake.post(CHAT, bob, { text: "Follow us", sendAs: news });

  // The messages name only a chat; the log and the viewer keep who posted.
  const sent = (entry) => [
    entry.author,
    entry.message.from.id,
    entry.message.sender_chat.id,
    entry.message.text,
  ];
  const posts = [
    [ann, 1087968824, CHAT, "Read the rules"],
    [bob, 136817688, news, "Follow us"],
  ];
  expect(
    (await fake.getMessageLog(CHAT, { since: mark })).messages.map(sent),
  ).toEqual(posts);
  const read = await page(CHAT);
  expect(read.items.filter((item) => item.seq > mark).map(sent)).toEqual(posts);
  expect(read.users[ann]).toMatchObject({ first_name: "Ann" });
  expect(read.users[bob]).toMatchObject({ first_name: "Bob" });
  const { body: state } = await get("api/state");
  const row = state.chats.find((each) => each.key === String(CHAT));
  expect(row.last).toMatchObject({
    author: bob,
    sender_chat: { id: news, title: "News" },
    preview: "Follow us",
  });
  expect(state.users[bob]).toMatchObject({ first_name: "Bob" });
});

it("logs a person's promotion and demotion of a member, with that person as the actor", async () => {
  const { fake, page } = await setup();
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  const member = async () =>
    (await page(CHAT)).members.find((entry) => entry.user_id === ann).member;

  await fake.promoteMember(CHAT, ann, {
    rights: { can_delete_messages: true },
  });
  expect(await member()).toMatchObject({
    status: "administrator",
    can_manage_chat: true,
    can_delete_messages: true,
    can_restrict_members: false,
  });
  await fake.demoteMember(CHAT, ann);
  expect((await member()).status).toBe("member");
  // Test actions: no call stored them.
  expect(
    (await page(CHAT)).items
      .filter((item) => item.kind === "event" && item.actor_id === OWNER)
      .map((event) => [
        event.user_id,
        event.request_id,
        event.old.status,
        event.new.status,
        event.new.can_delete_messages ?? null,
      ]),
  ).toEqual([
    [ann, null, "member", "administrator", true],
    [ann, null, "administrator", "member", null],
  ]);
});

it("keeps a deleted bot's private chats, calls and membership, marked deleted until a restore brings it back", async () => {
  const { fake, api, get, page } = await setup();
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
    firstName: "Second Bot",
  });
  await fake.setBotMembership(CHAT, second.id);
  const invite = (
    await api("createChatInviteLink", {
      chat_id: CHAT,
      creates_join_request: true,
    })
  ).result.invite_link;
  const carol = await fake.createUser({ first_name: "Carol" });
  await fake.joinByLink(invite, carol);
  await api(
    "sendMessage",
    { chat_id: carol, text: "answer 2+2 to join" },
    SECOND_TOKEN,
  );
  const before = await fake.snapshot();
  await fake.deleteBot(second.id);
  expect((await api("getMe", {}, SECOND_TOKEN)).status).toBe(401);

  const { body: state } = await get("api/state");
  expect(state.bots.map((bot) => [bot.id, bot.deleted === true])).toEqual([
    [BOT, false],
    [second.id, true],
  ]);
  // Its message to Carol stays in her chat with it, not with the first bot.
  const keys = state.chats.map((row) => row.key);
  expect(keys).toContain(`${carol}:${second.id}`);
  expect(keys).not.toContain(`${carol}:${BOT}`);
  const chat = await page(`${carol}:${second.id}`);
  expect(texts(chat.items)).toEqual(["answer 2+2 to join"]);
  expect(chat.calls.map((call) => call.method)).toEqual(["sendMessage"]);
  expect(
    (await fake.getMessageLog(carol, { botId: second.id })).messages.map(
      (entry) => entry.message.text,
    ),
  ).toEqual(["answer 2+2 to join"]);

  // It left the group as with leaveChat.
  const group = await page(CHAT);
  expect(
    group.members.find((entry) => entry.user_id === second.id).member.status,
  ).toBe("left");
  const left = group.items.find(
    (item) =>
      item.kind === "event" &&
      item.user_id === second.id &&
      item.new.status === "left",
  );
  expect(left).toMatchObject({
    actor_id: second.id,
    old: { status: "administrator" },
  });
  expect(
    group.items.find((item) => item.seq === left.service_seq).message
      .left_chat_member.id,
  ).toBe(second.id);

  // The call its revoked token made is named after it.
  const calls = await page("calls");
  expect(calls.calls.at(-1)).toMatchObject({
    method: "getMe",
    bot_id: second.id,
    status: 401,
  });
  expect(calls.users[second.id]).toMatchObject({ username: "second_bot" });

  // A restore from before the deletion has the bot back, listed once.
  await fake.restore(before);
  expect(
    (await get("api/state")).body.bots.map((bot) => [
      bot.id,
      bot.deleted === true,
    ]),
  ).toEqual([
    [BOT, false],
    [second.id, false],
  ]);
});

it("lists each message's reactions, most chosen first, names who chose them, and follows their changes", async () => {
  const { fake, api, page } = await setup();
  const stream = events(fake);
  await stream.next("hello");
  const people = [];
  for (const name of ["Ann", "Sam", "Zoe"]) {
    const user = await fake.createUser({ first_name: name });
    await fake.join(CHAT, user);
    people.push(user);
  }
  const [author, first, second] = people;
  const id = await fake.post(CHAT, author, "react to me");
  await fake.react(CHAT, id, author, "🔥");
  await fake.react(CHAT, id, first, "👍");
  await fake.react(CHAT, id, second, "👍");
  await api("setMessageReaction", {
    chat_id: CHAT,
    message_id: id,
    reaction: [
      { type: "custom_emoji", custom_emoji_id: "5368324170671202286" },
    ],
  });
  const reactionsOf = async (query = "") =>
    (await page(CHAT, query)).items.find(
      (item) => item.message?.message_id === id,
    ).reactions;
  expect(await reactionsOf()).toEqual([
    { type: "emoji", emoji: "👍", total_count: 2, user_ids: [first, second] },
    { type: "emoji", emoji: "🔥", total_count: 1, user_ids: [author] },
    {
      type: "custom_emoji",
      custom_emoji_id: "5368324170671202286",
      total_count: 1,
      user_ids: [BOT],
    },
  ]);
  // A page without the members panel still names everyone who reacted.
  const named = await page(CHAT, "?members_limit=0");
  expect(named.members).toEqual([]);
  for (const user of people) {
    expect(named.users[user]).toMatchObject({ id: user });
  }
  // A member sees the same reactions.
  expect(await reactionsOf(`?as=${first}`)).toEqual(await reactionsOf());

  // Taking a reaction back moves the version, and the stream tells of it.
  await fake.react(CHAT, id, first, null);
  const { version } = await page(CHAT);
  let change;
  do change = await stream.next("change");
  while (change.data.version < version);
  expect((await reactionsOf()).map((each) => each.total_count)).toEqual([
    1, 1, 1,
  ]);
});
