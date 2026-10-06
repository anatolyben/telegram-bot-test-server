import http from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST-TOKEN";
const BOT = 123456;
const SECOND_TOKEN = "654321:SECOND-TOKEN";
const GROUP = -1001000000001;
const OWNER = 5000000001;
const PHOTO = Buffer.from("fake-jpeg-bytes");

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A webhook endpoint that records every update and the secret header. */
async function startReceiver() {
  const updates = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      updates.push({
        secret: request.headers["x-telegram-bot-api-secret-token"] ?? null,
        update: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    updates,
    ofType: (type) => updates.map(({ update }) => update[type]).filter(Boolean),
  };
}

/**
 * A webhook endpoint that answers each update with the next scripted
 * [status, headers, body], or 200, and records what arrived.
 */
async function startScriptedReceiver(answers = []) {
  const requests = [];
  const waiting = new Set();
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        url: request.url,
        rawHeaders: request.rawHeaders,
        update,
      });
      for (const check of [...waiting]) check();
      const answer = answers.shift() ?? [200];
      const [status, headers = {}, body = ""] =
        typeof answer === "function" ? await answer(update) : answer;
      response.writeHead(status, headers).end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    requests,
    /** Resolves once `count` requests have arrived. */
    arrived: (count) =>
      new Promise((resolve) => {
        const check = () => {
          if (requests.length < count) return;
          waiting.delete(check);
          resolve();
        };
        waiting.add(check);
        check();
      }),
  };
}

async function setup(options = {}) {
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
    ...options,
  });
  cleanups.push(() => fake.stop());

  async function api(method, params = {}, token = TOKEN) {
    const response = await fetch(`${fake.origin}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json()) };
  }
  async function control(method, path, body) {
    const response = await fetch(`${fake.origin}/_fake/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  async function newUser(fields = {}) {
    return (await control("POST", "users", fields)).body.id;
  }
  return { fake, api, control, newUser };
}

describe("Bot API basics", () => {
  it("identifies the bot from its token and rejects any other token", async () => {
    const { api } = await setup({ botUsername: "my_bot" });

    const me = await api("getMe");
    expect(me.result).toMatchObject({
      id: 123456,
      is_bot: true,
      username: "my_bot",
    });
    expect(await api("getMe", {}, "999:WRONG")).toMatchObject({
      status: 401,
      ok: false,
      error_code: 401,
    });
  });

  it("rejects a method it does not implement with Telegram's answer, and records it", async () => {
    const { api, control } = await setup();

    for (const method of ["sendInvoice", "sendMesage"]) {
      expect(await api(method, { chat_id: GROUP })).toEqual({
        status: 404,
        ok: false,
        error_code: 404,
        description: "Not Found: method not found",
      });
    }
    expect((await control("GET", "calls")).body.unimplemented).toEqual([
      "sendInvoice",
      "sendMesage",
    ]);
  });

  it("answers true when asked to only for methods Telegram answers with True", async () => {
    const { api } = await setup({ unimplemented: "ok" });
    expect(
      await api("setMyDescription", { description: "Hello" }),
    ).toMatchObject({ ok: true, result: true });
    for (const method of ["sendInvoice", "getMyName", "sendMesage"]) {
      expect(await api(method, { chat_id: GROUP })).toMatchObject({
        status: 404,
        description: "Not Found: method not found",
      });
    }
  });

  it("resolves configured public chats by username and nothing else", async () => {
    const { api } = await setup({
      publicChats: [{ username: "news_channel", type: "channel" }],
    });

    expect(
      (await api("getChat", { chat_id: "@News_Channel" })).result,
    ).toMatchObject({ type: "channel", username: "news_channel" });
    expect(await api("getChat", { chat_id: "@someone" })).toMatchObject({
      status: 400,
      description: "Bad Request: chat not found",
    });
  });
});

describe("webhook delivery", () => {
  it("delivers member posts with the secret token and Telegram's entities", async () => {
    const { api, control, newUser } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url, secret_token: "s3cret" });
    const user = await newUser({ first_name: "Ann" });
    await control("POST", `chats/${GROUP}/join`, { user_id: user });

    await control("POST", `chats/${GROUP}/messages`, {
      user_id: user,
      text: "/start hi @someone see https://example.com",
    });

    const posted = hook.ofType("message").at(-1);
    expect(posted.text).toBe("/start hi @someone see https://example.com");
    expect(posted.entities.map((entity) => entity.type)).toEqual([
      "bot_command",
      "mention",
      "url",
    ]);
    expect(hook.updates.every(({ secret }) => secret === "s3cret")).toBe(true);
  });

  it("withholds chat_member updates unless the webhook asks for them", async () => {
    const { api, control, newUser } = await setup();
    const hook = await startReceiver();

    await api("setWebhook", { url: hook.url });
    const first = await newUser();
    await control("POST", `chats/${GROUP}/join`, { user_id: first });
    expect(hook.ofType("chat_member")).toHaveLength(0);
    expect(hook.ofType("message").at(-1).new_chat_members[0].id).toBe(first);

    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message", "chat_member"],
    });
    const second = await newUser();
    await control("POST", `chats/${GROUP}/join`, { user_id: second });
    const [change] = hook.ofType("chat_member");
    expect(change.new_chat_member).toMatchObject({
      status: "member",
      user: { id: second },
    });
  });

  it("runs the Bot API call a webhook answers with, but never a get method, setWebhook, deleteWebhook, close or logOut", async () => {
    const { fake, api, newUser } = await setup();
    const user = await newUser();
    const hook = await startScriptedReceiver([
      [
        200,
        { "Content-Type": "application/json" },
        JSON.stringify({ method: "sendMessage", chat_id: user, text: "json" }),
      ],
      // The content type is read in any case.
      [
        200,
        { "Content-Type": "Application/X-WWW-Form-Urlencoded" },
        `method=SendMessage&chat_id=${user}&text=form`,
      ],
      // Telegram asks for gzip and deflate, and reads either.
      [
        200,
        { "Content-Type": "application/json", "Content-Encoding": "gzip" },
        gzipSync(
          JSON.stringify({
            method: "sendMessage",
            chat_id: user,
            text: "gzip",
          }),
        ),
      ],
      ...["GETME", "SetWebhook", "deleteWebhook", "close", "logOut"].map(
        (method) => [
          200,
          { "Content-Type": "application/json" },
          JSON.stringify({ method, url: "http://127.0.0.1:1/" }),
        ],
      ),
    ]);
    await api("setWebhook", { url: hook.url });

    for (let i = 0; i < 8; i++) await fake.sendDirectMessage(user, `m${i}`);

    const replies = (await fake.getDirectMessages(user))
      .filter((message) => message.from.is_bot)
      .map((message) => message.text);
    expect(replies.sort()).toEqual(["form", "gzip", "json"]);
    expect((await fake.getCalls()).calls.map((call) => call.method)).toEqual([
      "setWebhook",
      "sendMessage",
      "SendMessage",
      "sendMessage",
    ]);
    expect((await api("getWebhookInfo")).result.url).toBe(hook.url);
  });

  it("keeps an update the webhook refuses and retries it on Telegram's backoff, honouring Retry-After", async () => {
    const start = 1_800_000_000_000;
    const { fake, api, newUser } = await setup({ clock: { now: start } });
    const hook = await startScriptedReceiver([
      [500],
      [503],
      [429, { "Retry-After": "30" }],
      [200],
    ]);
    await api("setWebhook", { url: hook.url });
    const user = await newUser();
    const outcomes = async () =>
      (await fake.getDeliveries()).map((attempt) => attempt.outcome);

    await fake.sendDirectMessage(user, "hello");
    await hook.arrived(2);
    // The first failure is retried at once, the next after 2 seconds.
    await expect.poll(outcomes).toEqual(["rejected", "rejected", "queued"]);
    expect((await api("getWebhookInfo")).result).toMatchObject({
      pending_update_count: 1,
      last_error_date: start / 1000,
      last_error_message:
        "Wrong response from the webhook: 503 Service Unavailable",
    });
    await fake.advanceTime(1999);
    expect((await fake.getDeliveries()).at(-1).started_at).toBeUndefined();
    await fake.advanceTime(1);
    await hook.arrived(3);
    await expect
      .poll(outcomes)
      .toEqual(["rejected", "rejected", "rejected", "queued"]);
    // Retry-After replaces the backoff.
    await fake.advanceTime(29_999);
    expect((await fake.getDeliveries()).at(-1).started_at).toBeUndefined();
    await fake.advanceTime(1);
    await hook.arrived(4);
    await fake.drainDeliveries();
    expect(
      new Set(hook.requests.map(({ update }) => update.update_id)).size,
    ).toBe(1);
    expect((await api("getWebhookInfo")).result).toMatchObject({
      pending_update_count: 0,
      last_error_date: start / 1000 + 2,
      last_error_message:
        "Wrong response from the webhook: 429 Too Many Requests",
    });
  });

  it("gives up on an update when its next retry would come after it expires", async () => {
    const { fake, api, newUser } = await setup({
      clock: { now: 1_800_000_000_000 },
    });
    const hook = await startScriptedReceiver(
      Array.from({ length: 10 }, () => [429, { "Retry-After": "200" }]),
    );
    await api("setWebhook", { url: hook.url });
    const user = await newUser();
    await fake.sendDirectMessage(user, "hello");
    const sent = await api("sendMessage", {
      chat_id: user,
      text: "Press",
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "ok" }]],
      },
    });
    const pressing = fake
      .pressDirectButton(user, sent.result.message_id, "ok")
      .catch(() => null);

    // A message lives for a day; a button press only 150 seconds.
    await hook.arrived(2);
    await expect
      .poll(
        async () => (await api("getWebhookInfo")).result.pending_update_count,
      )
      .toBe(1);
    await fake.advanceTime(200_000);
    await hook.arrived(3);
    expect(hook.requests.map(({ update }) => Object.keys(update)[1])).toEqual([
      "message",
      "callback_query",
      "message",
    ]);
    await fake.stop();
    await pressing;
  });

  it("delivers different chats at once, each chat in order, up to max_connections at a time", async () => {
    const { fake, api, control, newUser } = await setup();
    let release;
    let held;
    const hold = () => {
      held = new Promise((resolve) => {
        release = resolve;
      });
    };
    const hook = await startScriptedReceiver(
      Array.from({ length: 12 }, () => async (update) => {
        if (update.message?.text === "slow") await held;
        return [200];
      }),
    );
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message", "chat_member"],
    });
    const arrivals = () =>
      hook.requests.map(
        ({ update }) =>
          update.message?.text ??
          (update.message?.new_chat_members ? "joined" : null) ??
          (update.chat_member ? "chat_member" : null),
      );
    const ann = await newUser();
    await control("POST", `chats/${GROUP}/join`, { user_id: ann });
    hook.requests.length = 0;

    hold();
    const slow = fake.post(GROUP, ann, "slow");
    await hook.arrived(1);
    await fake.sendDirectMessage(ann, "private");
    const second = fake.post(GROUP, ann, "second");
    // A member change queues by user, so it does not wait for the chat.
    const bob = await newUser();
    const joining = fake.join(GROUP, bob);
    await hook.arrived(3);
    expect(arrivals()).toEqual(["slow", "private", "chat_member"]);
    release();
    await Promise.all([slow, second, joining]);
    expect(arrivals()).toEqual([
      "slow",
      "private",
      "chat_member",
      "second",
      "joined",
    ]);

    // With one connection, the private chat waits for the group.
    hook.requests.length = 0;
    await api("setWebhook", { url: hook.url, max_connections: 1 });
    hold();
    const slowAgain = fake.post(GROUP, ann, "slow");
    await hook.arrived(1);
    const privateAgain = fake.sendDirectMessage(ann, "private");
    await expect
      .poll(
        async () =>
          (await fake.getDeliveries()).filter(
            (attempt) => attempt.completed_at == null,
          ).length,
      )
      .toBe(2);
    expect(arrivals()).toEqual(["slow"]);
    release();
    await Promise.all([slowAgain, privateAgain]);
    expect(arrivals()).toEqual(["slow", "private"]);
  });

  it("sends exactly Telegram's webhook request headers", async () => {
    const { fake, api, newUser } = await setup();
    const hook = await startScriptedReceiver();
    await api("setWebhook", {
      url: `http://user:pa%20ss@127.0.0.1:${hook.port}/hook?x=1`,
      secret_token: "s3cret",
    });
    await fake.sendDirectMessage(await newUser(), "hello");

    const [{ url, rawHeaders, update }] = hook.requests;
    expect(url).toBe("/hook?x=1");
    expect(rawHeaders).toEqual([
      "Host",
      `127.0.0.1:${hook.port}`,
      "Authorization",
      `Basic ${Buffer.from("user:pa%20ss").toString("base64")}`,
      "X-Telegram-Bot-Api-Secret-Token",
      "s3cret",
      "Content-Type",
      "application/json",
      "Content-Length",
      String(Buffer.byteLength(JSON.stringify(update))),
      "Connection",
      "keep-alive",
      "Accept-Encoding",
      "gzip, deflate",
    ]);
  });
});

describe("setWebhook and getWebhookInfo", () => {
  it("refuses a webhook URL, secret token, certificate or address Telegram refuses, dropping the previous webhook", async () => {
    const { fake, api } = await setup();
    const bad = (description) => ({ status: 400, ok: false, description });
    const url = "Bad Request: invalid webhook URL specified";

    expect(await api("setWebhook", { url: "not a url" })).toMatchObject(
      bad(url),
    );
    expect(await api("setWebhook", { url: "/relative/path" })).toMatchObject(
      bad(url),
    );
    expect(
      await api("setWebhook", { url: "ftp://127.0.0.1/hook" }),
    ).toMatchObject(bad(url));
    expect(
      await api("setWebhook", {
        url: "https://example.com/hook",
        secret_token: "a".repeat(257),
      }),
    ).toMatchObject(bad("Bad Request: secret token is too long"));
    expect(
      await api("setWebhook", {
        url: "https://example.com/hook",
        secret_token: "abc+def/ghi=",
      }),
    ).toMatchObject(
      bad("Bad Request: secret token contains illegal characters"),
    );
    const big = new FormData();
    big.set("url", "https://example.com/hook");
    big.set("certificate", new Blob([Buffer.alloc((3 << 20) + 1)]), "c.pem");
    expect(
      await (
        await fetch(`${fake.origin}/bot${TOKEN}/setWebhook`, {
          method: "POST",
          body: big,
        })
      ).json(),
    ).toMatchObject({
      ok: false,
      description: `Bad Request: certificate size is too big (${(3 << 20) + 1} bytes)`,
    });
    expect(
      await api("setWebhook", {
        url: "https://example.com/hook",
        ip_address: "not-an-ip",
      }),
    ).toMatchObject(
      bad("Bad Request: bad webhook: Invalid IP address specified"),
    );
    // Without a scheme, the URL is taken as https.
    expect(
      await api("setWebhook", { url: "127.0.0.1:3000/hook" }),
    ).toMatchObject({ ok: true, result: true });
    expect((await api("getWebhookInfo")).result.url).toBe(
      "127.0.0.1:3000/hook",
    );

    expect(await api("setWebhook", { url: "not a url" })).toMatchObject(
      bad(url),
    );
    expect((await api("getWebhookInfo")).result.url).toBe("");
  });

  it("describes what setWebhook and deleteWebhook changed", async () => {
    const { api } = await setup();
    const url = "https://example.com/hook";
    const said = async (method, params) =>
      (await api(method, params)).description;

    expect(await said("setWebhook", { url })).toBe("Webhook was set");
    expect(await said("setWebhook", { url })).toBe("Webhook is already set");
    expect(await said("deleteWebhook")).toBe("Webhook was deleted");
    expect(await said("deleteWebhook")).toBe("Webhook is already deleted");
    expect(await said("setWebhook", { url: "" })).toBe(
      "Webhook is already deleted",
    );
  });

  it("drops pending updates when asked even with an empty URL", async () => {
    const { fake, api, newUser } = await setup();
    await fake.sendDirectMessage(await newUser(), "queued");
    expect((await api("getWebhookInfo")).result.pending_update_count).toBe(1);

    expect(
      await api("setWebhook", { url: "", drop_pending_updates: true }),
    ).toMatchObject({ ok: true, description: "Webhook is already deleted" });
    expect((await api("getWebhookInfo")).result.pending_update_count).toBe(0);
    expect((await api("getUpdates")).result).toEqual([]);
  });

  it("reports the webhook's connections, address, subscription, certificate and last error", async () => {
    const { fake, api, newUser } = await setup();
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const url = `http://127.0.0.1:${port}/hook`;

    expect((await api("getWebhookInfo")).result).toEqual({
      url: "",
      has_custom_certificate: false,
      pending_update_count: 0,
    });
    await api("setWebhook", {
      url,
      max_connections: 1000,
      allowed_updates: [],
    });
    expect((await api("getWebhookInfo")).result).toEqual({
      url,
      has_custom_certificate: false,
      pending_update_count: 0,
      max_connections: 100,
      ip_address: "127.0.0.1",
    });

    await fake.sendDirectMessage(await newUser(), "hello");
    const info = (await api("getWebhookInfo")).result;
    expect(info).toMatchObject({
      pending_update_count: 1,
      last_error_message: "Connection refused",
    });
    expect(info.last_error_date).toBeGreaterThan(0);

    const form = new FormData();
    form.set("url", url);
    form.set("allowed_updates", JSON.stringify(["chat_member", "message"]));
    form.set("certificate", new Blob(["-----BEGIN CERTIFICATE-----"]), "c.pem");
    await fetch(`${fake.origin}/bot${TOKEN}/setWebhook`, {
      method: "POST",
      body: form,
    });
    expect((await api("getWebhookInfo")).result).toMatchObject({
      url,
      has_custom_certificate: true,
      pending_update_count: 1,
      max_connections: 40,
      ip_address: "127.0.0.1",
      allowed_updates: ["message", "chat_member"],
    });
  });

  it("sends to the ip_address given instead of resolving the host", async () => {
    const { fake, api, newUser } = await setup();
    const hook = await startScriptedReceiver();
    const url = `http://bot.invalid:${hook.port}/hook`;
    await api("setWebhook", { url, ip_address: "127.0.0.1" });
    await fake.sendDirectMessage(await newUser(), "hello");

    expect(hook.requests[0].rawHeaders.slice(0, 2)).toEqual([
      "Host",
      `bot.invalid:${hook.port}`,
    ]);
    expect((await api("getWebhookInfo")).result).toMatchObject({
      url,
      pending_update_count: 0,
      ip_address: "127.0.0.1",
    });
  });

  it("reads allowed_updates sent as a JSON string inside a JSON body", async () => {
    const { api, control, newUser } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: JSON.stringify(["message", "chat_member"]),
    });
    await control("POST", `chats/${GROUP}/join`, { user_id: await newUser() });

    expect(hook.ofType("chat_member")).toHaveLength(1);
    expect((await api("getWebhookInfo")).result.allowed_updates).toEqual([
      "message",
      "chat_member",
    ]);
  });

  it("matches allowed_updates names in any case and falls back to the default when none is known", async () => {
    const { fake, api, newUser } = await setup();
    const user = await newUser();

    await api("getUpdates", { allowed_updates: ["Message"] });
    await fake.sendDirectMessage(user, "one");
    expect((await api("getUpdates")).result).toHaveLength(1);
    expect((await api("getWebhookInfo")).result.allowed_updates).toEqual([
      "message",
    ]);

    await api("getUpdates", { allowed_updates: ["messages"] });
    expect((await api("getWebhookInfo")).result).not.toHaveProperty(
      "allowed_updates",
    );
    await fake.join(GROUP, user);
    expect(
      (await api("getUpdates")).result.map((update) => Object.keys(update)[1]),
    ).toEqual(["message", "message"]);
  });
});

describe("member administration", () => {
  it("restricts a member so they cannot post, and lifting every permission restores them", async () => {
    const { api, control, newUser } = await setup();
    const user = await newUser();
    await control("POST", `chats/${GROUP}/join`, { user_id: user });

    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: user,
      permissions: { can_send_messages: false },
    });
    expect(
      (await api("getChatMember", { chat_id: GROUP, user_id: user })).result,
    ).toMatchObject({ status: "restricted", can_send_messages: false });
    expect(
      await control("POST", `chats/${GROUP}/messages`, {
        user_id: user,
        text: "hello",
      }),
    ).toMatchObject({ status: 403 });

    const everything = Object.fromEntries(
      [
        "can_send_messages",
        "can_send_audios",
        "can_send_documents",
        "can_send_photos",
        "can_send_videos",
        "can_send_video_notes",
        "can_send_voice_notes",
        "can_send_polls",
        "can_send_other_messages",
        "can_add_web_page_previews",
        "can_change_info",
        "can_invite_users",
        "can_pin_messages",
        "can_manage_topics",
      ].map((key) => [key, true]),
    );
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: user,
      permissions: everything,
    });
    expect(
      (await api("getChatMember", { chat_id: GROUP, user_id: user })).result
        .status,
    ).toBe("member");
  });

  it("bans a member, blocks them from rejoining, and unbanning lets them back", async () => {
    const { api, control, newUser } = await setup();
    const user = await newUser();
    await control("POST", `chats/${GROUP}/join`, { user_id: user });

    await api("banChatMember", { chat_id: GROUP, user_id: user });
    expect(
      (await api("getChatMember", { chat_id: GROUP, user_id: user })).result
        .status,
    ).toBe("kicked");
    expect(
      await control("POST", `chats/${GROUP}/join`, { user_id: user }),
    ).toMatchObject({ status: 400, body: { error: "USER_BANNED_IN_CHANNEL" } });

    await api("unbanChatMember", { chat_id: GROUP, user_id: user });
    expect(
      await control("POST", `chats/${GROUP}/join`, { user_id: user }),
    ).toMatchObject({ status: 200, body: { status: "member" } });
  });

  it("counts members and lists the owner and bot as administrators", async () => {
    const { api, control, newUser } = await setup();
    await control("POST", `chats/${GROUP}/join`, { user_id: await newUser() });

    expect((await api("getChatMemberCount", { chat_id: GROUP })).result).toBe(
      3,
    );
    const admins = (await api("getChatAdministrators", { chat_id: GROUP }))
      .result;
    expect(admins.map((admin) => admin.status).sort()).toEqual([
      "administrator",
      "creator",
    ]);
  });
});

describe("invite links and join requests", () => {
  it("turns a join through a request link into a join request the bot can approve", async () => {
    const { api, control, newUser } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["chat_join_request", "chat_member"],
    });
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        creates_join_request: true,
      })
    ).result.invite_link;
    const hash = link.replace("https://t.me/+", "");
    const user = await newUser();

    expect(
      (await control("POST", `invites/${hash}/join`, { user_id: user })).body,
    ).toMatchObject({ chat_id: GROUP, status: "requested" });
    expect(hook.ofType("chat_join_request")[0].from.id).toBe(user);

    await api("approveChatJoinRequest", { chat_id: GROUP, user_id: user });
    // Like Telegram, the fake answers the call before the update arrives.
    await expect.poll(() => hook.ofType("chat_member").length).toBe(1);
    const approved = hook.ofType("chat_member").at(-1);
    expect(approved).toMatchObject({
      invite_link: { invite_link: link },
      new_chat_member: { status: "member", user: { id: user } },
    });
    // via_join_request is only for requests made without an invite link.
    expect(approved).not.toHaveProperty("via_join_request");
    expect(
      await api("declineChatJoinRequest", { chat_id: GROUP, user_id: user }),
    ).toMatchObject({ status: 400, ok: false });
  });

  it("refuses a revoked invite link", async () => {
    const { api, control, newUser } = await setup();
    const link = (await api("createChatInviteLink", { chat_id: GROUP })).result
      .invite_link;
    await api("revokeChatInviteLink", { chat_id: GROUP, invite_link: link });

    expect(
      await control(
        "POST",
        `invites/${link.replace("https://t.me/+", "")}/join`,
        {
          user_id: await newUser(),
        },
      ),
    ).toMatchObject({ status: 400, body: { error: "INVITE_HASH_EXPIRED" } });
  });

  it("needs can_invite_users to create, export, edit or revoke invite links", async () => {
    const { fake, api } = await setup();
    const link = (await api("createChatInviteLink", { chat_id: GROUP })).result
      .invite_link;
    const refused = {
      status: 400,
      description: "Bad Request: not enough rights to manage chat invite link",
    };

    await fake.setBotMembership(GROUP, BOT, {
      status: "administrator",
      rights: { can_invite_users: false },
    });
    expect(await api("createChatInviteLink", { chat_id: GROUP })).toMatchObject(
      refused,
    );
    expect(await api("exportChatInviteLink", { chat_id: GROUP })).toMatchObject(
      refused,
    );
    expect(
      await api("editChatInviteLink", {
        chat_id: GROUP,
        invite_link: link,
        name: "renamed",
      }),
    ).toMatchObject(refused);
    expect(
      await api("revokeChatInviteLink", { chat_id: GROUP, invite_link: link }),
    ).toMatchObject(refused);
    await fake.setBotMembership(GROUP, BOT, { status: "member" });
    expect(await api("createChatInviteLink", { chat_id: GROUP })).toMatchObject(
      refused,
    );
  });

  it("admits at most member_limit members through a link at a time", async () => {
    const { fake, api } = await setup();
    const invite = (
      await api("createChatInviteLink", { chat_id: GROUP, member_limit: 1 })
    ).result;
    expect(invite.member_limit).toBe(1);
    const ann = await fake.createUser();

    await fake.joinByLink(invite.invite_link, ann);
    await expect(
      fake.joinByLink(invite.invite_link, await fake.createUser()),
    ).rejects.toThrow("INVITE_HASH_EXPIRED");
    await fake.leave(GROUP, ann);
    expect(
      await fake.joinByLink(invite.invite_link, await fake.createUser()),
    ).toMatchObject({ status: "member" });
    expect(
      await api("createChatInviteLink", {
        chat_id: GROUP,
        member_limit: 5,
        creates_join_request: true,
      }),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: member limit can't be specified for links requiring administrator approval",
    });
  });

  it("refuses a join through a link once its expire_date has passed", async () => {
    const { fake, api } = await setup({ clock: { now: 1800000000000 } });
    const invite = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        expire_date: 1800000060,
      })
    ).result;
    expect(invite.expire_date).toBe(1800000060);

    await fake.advanceTime(59000);
    expect(
      await fake.joinByLink(invite.invite_link, await fake.createUser()),
    ).toMatchObject({ status: "member" });
    await fake.advanceTime(1000);
    await expect(
      fake.joinByLink(invite.invite_link, await fake.createUser()),
    ).rejects.toThrow("INVITE_HASH_EXPIRED");
  });

  it("revokes only an existing link the bot created", async () => {
    const { fake, api } = await setup();
    const second = await fake.addBot({
      token: SECOND_TOKEN,
      username: "second_bot",
    });
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const link = (await api("createChatInviteLink", { chat_id: GROUP })).result
      .invite_link;

    expect(
      await api("revokeChatInviteLink", {
        chat_id: GROUP,
        invite_link: "https://t.me/+NoSuchLink000000",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: INVITE_HASH_EXPIRED",
    });
    expect(
      await api(
        "revokeChatInviteLink",
        { chat_id: GROUP, invite_link: link },
        SECOND_TOKEN,
      ),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: CHAT_ADMIN_REQUIRED",
    });
    expect(await fake.joinByLink(link, await fake.createUser())).toMatchObject({
      status: "member",
    });
  });

  it("replaces a revoked primary link with a new one", async () => {
    const { fake, api } = await setup();
    const primary = (await api("exportChatInviteLink", { chat_id: GROUP }))
      .result;

    const revoked = await api("revokeChatInviteLink", {
      chat_id: GROUP,
      invite_link: primary,
    });
    expect(revoked.result).toMatchObject({
      invite_link: primary,
      creator: { id: BOT },
      creates_join_request: false,
      is_primary: true,
      is_revoked: true,
    });
    const next = (await api("getChat", { chat_id: GROUP })).result.invite_link;
    expect(next).toEqual(expect.any(String));
    expect(next).not.toBe(primary);
    expect(await fake.joinByLink(next, await fake.createUser())).toMatchObject({
      status: "member",
    });
  });

  it("keeps a primary link for each administrator", async () => {
    const { fake, api } = await setup();
    const second = await fake.addBot({
      token: SECOND_TOKEN,
      username: "second_bot",
    });
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const first = (await api("exportChatInviteLink", { chat_id: GROUP }))
      .result;

    await api("exportChatInviteLink", { chat_id: GROUP }, SECOND_TOKEN);
    expect(await fake.joinByLink(first, await fake.createUser())).toMatchObject(
      { status: "member" },
    );
  });

  it("gives getChat the bot's own primary link only while it may invite users", async () => {
    const { fake, api } = await setup();
    const chat = async () => (await api("getChat", { chat_id: GROUP })).result;

    const generated = (await chat()).invite_link;
    expect(generated).toMatch(/^https:\/\/t\.me\/\+/);
    expect((await chat()).invite_link).toBe(generated);
    const exported = (await api("exportChatInviteLink", { chat_id: GROUP }))
      .result;
    expect((await chat()).invite_link).toBe(exported);
    await expect(
      fake.joinByLink(generated, await fake.createUser()),
    ).rejects.toThrow("INVITE_HASH_EXPIRED");
    await fake.setBotMembership(GROUP, BOT, {
      status: "administrator",
      rights: { can_invite_users: false },
    });
    expect(await chat()).not.toHaveProperty("invite_link");
  });

  it("shows a link another administrator created with its second half hidden", async () => {
    const { fake, api } = await setup();
    const second = await fake.addBot({
      token: SECOND_TOKEN,
      username: "second_bot",
    });
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const own = await startReceiver();
    const other = await startReceiver();
    const allowed_updates = ["chat_join_request", "chat_member"];
    await api("setWebhook", { url: own.url, allowed_updates });
    await api("setWebhook", { url: other.url, allowed_updates }, SECOND_TOKEN);
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        creates_join_request: true,
      })
    ).result.invite_link;
    const hash = link.slice("https://t.me/+".length);
    const hidden = `https://t.me/+${hash.slice(0, hash.length / 2)}...`;
    const user = await fake.createUser();

    await fake.joinByLink(link, user);
    await api("approveChatJoinRequest", { chat_id: GROUP, user_id: user });
    await expect.poll(() => own.ofType("chat_member").length).toBe(1);
    await expect.poll(() => other.ofType("chat_member").length).toBe(1);
    const seen = (hook, type) => hook.ofType(type)[0].invite_link;
    expect(seen(own, "chat_join_request").invite_link).toBe(link);
    expect(seen(own, "chat_member").invite_link).toBe(link);
    expect(seen(other, "chat_join_request")).toMatchObject({
      invite_link: hidden,
      creator: { id: BOT },
    });
    expect(seen(other, "chat_member").invite_link).toBe(hidden);
  });

  it("gives each invite link an opaque random hash", async () => {
    const { api } = await setup();
    const links = [];
    for (let i = 0; i < 3; i += 1) {
      links.push(
        (await api("createChatInviteLink", { chat_id: GROUP })).result
          .invite_link,
      );
    }

    for (const link of links)
      expect(link).toMatch(/^https:\/\/t\.me\/\+[\w-]+$/);
    // No fixed marker opens the hash.
    expect(
      new Set(links.map((link) => link.slice(14, 18))).size,
    ).toBeGreaterThan(1);
  });
});

describe("messages, buttons and files", () => {
  it("deletes a message once and refuses to delete it again", async () => {
    const { api, control } = await setup();
    const sent = (await api("sendMessage", { chat_id: GROUP, text: "hi" }))
      .result;

    expect(
      await api("deleteMessage", {
        chat_id: GROUP,
        message_id: sent.message_id,
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await control("GET", `chats/${GROUP}/messages/${sent.message_id}`)).body,
    ).toMatchObject({ exists: true, deleted: true });
    expect(
      await api("deleteMessage", {
        chat_id: GROUP,
        message_id: sent.message_id,
      }),
    ).toMatchObject({ status: 400, ok: false });
  });

  it("sends a callback query when a user presses a button and returns the bot's answer", async () => {
    const { api, control, newUser } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const user = await newUser();
    await control("POST", `chats/${GROUP}/join`, { user_id: user });
    const sent = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "Verify",
        reply_markup: {
          inline_keyboard: [[{ text: "OK", callback_data: "verify" }]],
        },
      })
    ).result;

    const pressed = control(
      "POST",
      `chats/${GROUP}/messages/${sent.message_id}/callback`,
      { user_id: user, data: "verify" },
    );
    await expect.poll(() => hook.ofType("callback_query").length).toBe(1);
    const query = hook.ofType("callback_query")[0];
    expect(query).toMatchObject({ from: { id: user }, data: "verify" });
    await api("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Verified",
    });

    expect((await pressed).body).toMatchObject({
      answered: true,
      text: "Verified",
    });
  });

  it("stores a photo uploaded as multipart and serves its bytes back", async () => {
    const { fake, api } = await setup();
    const form = new FormData();
    form.set("chat_id", String(GROUP));
    form.set("photo", new Blob([PHOTO]), "photo.jpg");
    const sent = await (
      await fetch(`${fake.origin}/bot${TOKEN}/sendPhoto`, {
        method: "POST",
        body: form,
      })
    ).json();

    const fileId = sent.result.photo[0].file_id;
    const file = (await api("getFile", { file_id: fileId })).result;
    const bytes = Buffer.from(
      await (
        await fetch(`${fake.origin}/file/bot${TOKEN}/${file.file_path}`)
      ).arrayBuffer(),
    );
    expect(bytes.equals(PHOTO)).toBe(true);
  });

  it("accepts profile photos only as image bytes, never as a file path", async () => {
    const { control, newUser } = await setup();
    const user = await newUser();

    expect(
      await control("POST", `users/${user}/photos`, { path: "/etc/hosts" }),
    ).toMatchObject({ status: 400 });
    expect(
      await control("POST", `users/${user}/photos`, {
        base64: PHOTO.toString("base64"),
      }),
    ).toMatchObject({ status: 200 });
  });

  it("delivers a user's direct message to the bot and stores the bot's reply", async () => {
    const { api, control, newUser } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const user = await newUser();

    await control("POST", `users/${user}/dm`, { text: "hello bot" });
    expect(hook.ofType("message").at(-1)).toMatchObject({
      chat: { id: user, type: "private" },
      text: "hello bot",
    });
    await api("sendMessage", { chat_id: user, text: "hello human" });
    expect(
      (await control("GET", `users/${user}/dm`)).body.map((m) => m.text),
    ).toEqual(["hello human", "hello bot"]);
  });
});
