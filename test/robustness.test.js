import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST";
const GROUP = -1001000000001;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup(options = {}) {
  const server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
    ...options,
  });
  cleanups.push(() => server.stop());
  async function raw(path, body, contentType = "application/json") {
    const response = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    return { status: response.status, body: await response.json() };
  }
  const api = async (method, params = {}) =>
    (await raw(`/bot${TOKEN}/${method}`, JSON.stringify(params))).body;
  return { server, raw, api };
}

describe("update delivery", () => {
  it("hands every update the webhook has not confirmed to getUpdates when the webhook is removed", async () => {
    const { server, api } = await setup();
    const received = [];
    const slow = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        setTimeout(() => response.writeHead(200).end(), 300);
      });
    });
    await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          slow.close(resolve);
          slow.closeAllConnections();
        }),
    );
    await api("setWebhook", {
      url: `http://127.0.0.1:${slow.address().port}/`,
    });
    const ann = await server.createUser();
    await server.join(GROUP, ann);

    const posted = ["one", "two", "three"].map((text) =>
      server.post(GROUP, ann, text),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api("deleteWebhook");
    await Promise.all(posted);

    const polled = (await api("getUpdates")).result.map((u) => u.message.text);
    const delivered = received.map((u) => u.message.text).filter(Boolean);
    // The update in flight was never confirmed, so it is pending too.
    expect(delivered).toHaveLength(1);
    expect([...polled].sort()).toEqual(["one", "three", "two"]);
  });

  it("does not rewrite an update after it was sent", async () => {
    const { server, api } = await setup();
    const link = (await api("createChatInviteLink", { chat_id: GROUP })).result
      .invite_link;
    await api("getUpdates", { allowed_updates: ["chat_member"] });
    await server.joinByLink(link, await server.createUser());

    await api("revokeChatInviteLink", { chat_id: GROUP, invite_link: link });

    const [update] = (await api("getUpdates")).result;
    expect(update.chat_member.invite_link.is_revoked).toBe(false);
  });
});

describe("private chats", () => {
  it("does not let reading a user's private chat open it for the bot", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();

    expect(await server.getDirectMessages(ann)).toEqual([]);

    expect(
      await api("sendMessage", { chat_id: ann, text: "hi" }),
    ).toMatchObject({
      ok: false,
      error_code: 403,
    });
  });
});

describe("bad input", () => {
  it("reads request bodies as Telegram does, keeping what it could parse", async () => {
    const { server, raw } = await setup();
    const send = async (body, type = "application/json") =>
      (await raw(`/bot${TOKEN}/sendMessage`, body, type)).body;

    // Unreadable JSON, and bodies of other types, carry no parameters.
    for (const [body, type] of [
      ["{bad", "application/json"],
      ["null", "application/json"],
      ["hello", "text/plain"],
    ]) {
      expect((await raw(`/bot${TOKEN}/getMe`, body, type)).body.ok).toBe(true);
    }
    expect(await send(`chat_id=${GROUP}&text=hi`, "text/plain")).toMatchObject({
      error_code: 400,
      description: "Bad Request: message text is empty",
    });
    // Fields before a JSON error still count, and a trailing comma is fine.
    expect(
      await send(`{"chat_id": ${GROUP}, "text": "cut", "par`),
    ).toMatchObject({ ok: true, result: { text: "cut" } });
    expect(await send(`{"chat_id": ${GROUP}, "text": "comma",}`)).toMatchObject(
      { ok: true, result: { text: "comma" } },
    );
    // A JSON-serialized parameter may come as a JSON string.
    const keyboard = {
      inline_keyboard: [[{ text: "Go", callback_data: "go" }]],
    };
    expect(
      await send(
        JSON.stringify({
          chat_id: GROUP,
          text: "keys",
          reply_markup: JSON.stringify(keyboard),
        }),
      ),
    ).toMatchObject({ ok: true, result: { reply_markup: keyboard } });
    expect((await server.getMessages(GROUP)).map((m) => m.text)).toEqual([
      "keys",
      "comma",
      "cut",
    ]);

    // Form data it cannot read is refused with an empty 400.
    const unreadable = await fetch(`${server.origin}/bot${TOKEN}/getMe`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data" },
      body: "x",
    });
    expect([unreadable.status, await unreadable.text()]).toEqual([400, ""]);
    expect((await raw("/_fake/users", "{bad")).status).toBe(400);
    expect((await raw("/_fake/users", "null")).status).toBe(400);
  });

  it("reads a JSON body's values as the text they are written as", async () => {
    const { raw } = await setup();
    const send = async (body) =>
      (await raw(`/bot${TOKEN}/sendMessage`, body)).body;
    const sent = async (value) =>
      (await send(`{"chat_id": ${GROUP}, "text": ${value}}`)).result?.text;

    expect(await sent("null")).toBe("null");
    expect(await sent("1.50")).toBe("1.50");
    expect(await sent(`{"a": 1}`)).toBe(`{"a": 1}`);
    // A string keeps a raw control character, and an unknown escape gives
    // the character escaped.
    expect(await sent(`"it\\'s\\q"`)).toBe("it'sq");
    expect(await sent(`"a\tb"`)).toBe("a b");
    expect(
      await send(`{"chat_id": ${GROUP}, "text": "hi", "parse_mode": null}`),
    ).toMatchObject({
      error_code: 400,
      description: "Bad Request: unsupported parse_mode",
    });
  });

  it("reads an integer parameter by its leading digits, so a JSON null is 0", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();
    await server.join(GROUP, ann);
    const forum = await server.createChat({
      ownerId: 5000000001,
      isForum: true,
    });
    await server.setBotMembership(forum, 123456, { status: "administrator" });

    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "no reply",
        reply_to_message_id: null,
      }),
    ).toMatchObject({ ok: true, result: { text: "no reply" } });
    const general = await api("sendMessage", {
      chat_id: forum,
      text: "general",
      message_thread_id: null,
    });
    expect(general.ok).toBe(true);
    expect(general.result.message_thread_id).toBeUndefined();
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: ann,
      permissions: {},
      until_date: null,
    });
    expect(
      (await api("getChatMember", { chat_id: GROUP, user_id: ann })).result,
    ).toMatchObject({ status: "restricted", until_date: 0 });
  });

  it("takes the first of repeated parameters, the query string before the body", async () => {
    const { raw } = await setup();
    const text = async (path, body, type) =>
      (await raw(path, body, type)).body.result?.text;
    const path = `/bot${TOKEN}/sendMessage`;

    expect(
      await text(
        `${path}?text=query`,
        JSON.stringify({ chat_id: GROUP, text: "body" }),
      ),
    ).toBe("query");
    expect(
      await text(
        path,
        `{"chat_id": ${GROUP}, "text": "first", "text": "second"}`,
      ),
    ).toBe("first");
    expect(
      await text(
        path,
        `chat_id=${GROUP}&text=first&text=second`,
        "application/x-www-form-urlencoded",
      ),
    ).toBe("first");
  });

  it("reads coordinates by their leading number, and checks the map after the chat", async () => {
    const { api } = await setup();
    const location = async (latitude) =>
      (await api("sendLocation", { chat_id: GROUP, latitude, longitude: "1" }))
        .result?.location;

    expect(await location("12abc")).toEqual({ latitude: 12, longitude: 1 });
    expect(await location("abc")).toEqual({ latitude: 0, longitude: 1 });
    // An exponent without digits leaves no number.
    expect(await location("5e")).toEqual({ latitude: 0, longitude: 1 });
    for (const [method, extra] of [
      ["sendLocation", {}],
      ["sendVenue", { title: "Office", address: "1 Main St" }],
    ]) {
      expect(
        await api(method, {
          chat_id: 42,
          latitude: 100,
          longitude: 0,
          ...extra,
        }),
      ).toMatchObject({
        error_code: 400,
        description: "Bad Request: chat not found",
      });
    }
  });

  it("answers malformed permissions with Telegram's parse errors", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();
    await server.join(GROUP, ann);

    for (const [permissions, description] of [
      [null, "Bad Request: object expected as permissions"],
      ["{", "Bad Request: can't parse permissions JSON object"],
      // Given, even empty, permissions are read as JSON.
      ["", "Bad Request: can't parse permissions JSON object"],
      [
        { can_send_messages: true, can_send_polls: "true" },
        `Bad Request: can't parse chat permissions: Field "can_send_polls" must be of type Boolean`,
      ],
    ]) {
      expect(
        await api("restrictChatMember", {
          chat_id: GROUP,
          user_id: ann,
          permissions,
        }),
      ).toMatchObject({ error_code: 400, description });
    }
  });

  it("answers malformed message_ids with Telegram's texts, and an empty list with true", async () => {
    const { api } = await setup();
    const many = Array.from({ length: 101 }, (_, index) => index + 1);

    for (const [params, description] of [
      [{}, "Bad Request: message identifiers are not specified"],
      [
        { message_ids: "[" },
        "Bad Request: can't parse message_ids JSON object",
      ],
      [
        { message_ids: 5 },
        "Bad Request: expected an Array of message identifiers",
      ],
      [
        { message_ids: many },
        "Bad Request: too many message identifiers specified",
      ],
      [
        { message_ids: [null] },
        "Bad Request: message identifier must be a Number",
      ],
      [
        { message_ids: ["x"] },
        "Bad Request: can't parse message identifier as a Number",
      ],
      [
        { message_ids: [0] },
        "Bad Request: invalid message identifier specified",
      ],
    ]) {
      expect(
        await api("deleteMessages", { chat_id: GROUP, ...params }),
      ).toMatchObject({ error_code: 400, description });
    }
    expect(
      await api("deleteMessages", { chat_id: GROUP, message_ids: [] }),
    ).toMatchObject({ ok: true, result: true });
  });

  it("answers malformed reactions with Telegram's parse errors, not a crash", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();
    await server.join(GROUP, ann);
    const messageId = await server.post(GROUP, ann, "hi");

    for (const [reaction, description] of [
      ["[", "Bad Request: can't parse reaction types JSON object"],
      [{}, "Bad Request: expected an Array of ReactionType"],
      [[null], "Bad Request: can't parse ReactionType: expected an Object"],
      [[{}], `Bad Request: can't parse ReactionType: Can't find field "type"`],
      [
        [{ type: "emoji" }],
        `Bad Request: can't parse ReactionType: Can't find field "emoji"`,
      ],
      [
        [{ type: "custom_emoji" }],
        `Bad Request: can't parse ReactionType: Can't find field "custom_emoji_id"`,
      ],
      [
        [{ type: "custom_emoji", custom_emoji_id: {} }],
        `Bad Request: can't parse ReactionType: Field "custom_emoji_id" must be a Number`,
      ],
      [
        [{ type: "custom_emoji", custom_emoji_id: "5368abc" }],
        `Bad Request: can't parse ReactionType: Field "custom_emoji_id" must be a valid Number`,
      ],
    ]) {
      expect(
        await api("setMessageReaction", {
          chat_id: GROUP,
          message_id: messageId,
          reaction,
        }),
      ).toEqual({ ok: false, error_code: 400, description });
    }
  });

  it("answers malformed reply markup, reply parameters and link preview options with Telegram's parse errors", async () => {
    const { api } = await setup();

    for (const [params, description] of [
      [
        { reply_markup: "abc" },
        "Bad Request: can't parse reply keyboard markup JSON object",
      ],
      [{ reply_markup: null }, "Bad Request: object expected as reply markup"],
      [
        { reply_markup: { inline_keyboard: "abc" } },
        `Bad Request: field "inline_keyboard" must be of type Array`,
      ],
      [
        { reply_parameters: "abc" },
        "Bad Request: can't parse reply parameters JSON object",
      ],
      [
        { reply_parameters: 5 },
        "Bad Request: object expected as reply parameters",
      ],
      [
        { link_preview_options: "abc" },
        "Bad Request: can't parse link preview options JSON object",
      ],
      [
        { link_preview_options: [] },
        "Bad Request: object expected as link preview options",
      ],
      // A flag inside these objects must be a JSON true or false.
      [
        {
          reply_parameters: {
            message_id: 999,
            allow_sending_without_reply: "yes",
          },
        },
        `Bad Request: field "allow_sending_without_reply" must be of type Boolean`,
      ],
      [
        { link_preview_options: { is_disabled: "1" } },
        `Bad Request: field "is_disabled" must be of type Boolean`,
      ],
      [
        { reply_markup: { remove_keyboard: "yes" } },
        `Bad Request: field "remove_keyboard" must be of type Boolean`,
      ],
    ]) {
      expect(
        await api("sendMessage", { chat_id: GROUP, text: "hi", ...params }),
      ).toMatchObject({ error_code: 400, description });
    }
  });

  it("answers malformed bot commands with Telegram's parse errors", async () => {
    const { api } = await setup();

    for (const [commands, description] of [
      ["[", "Bad Request: can't parse commands JSON object"],
      [{}, "Bad Request: expected an Array of BotCommand"],
      [[null], "Bad Request: can't parse BotCommand: expected an Object"],
      [
        [{ command: "start" }],
        `Bad Request: can't parse BotCommand: Can't find field "description"`,
      ],
    ]) {
      expect(await api("setMyCommands", { commands })).toMatchObject({
        error_code: 400,
        description,
      });
    }
  });

  it("answers missing or invalid required parameters with Telegram's texts", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();
    await server.join(GROUP, ann);
    const venue = { title: "Office", address: "1 Main St" };

    for (const [method, params, description] of [
      ["sendMessage", { text: "hi" }, "Bad Request: chat_id is empty"],
      ["getChat", {}, "Bad Request: chat_id is empty"],
      [
        "restrictChatMember",
        { chat_id: GROUP, permissions: {} },
        "Bad Request: invalid user_id specified",
      ],
      [
        "banChatMember",
        { user_id: "abc" },
        "Bad Request: invalid user_id specified",
      ],
      [
        "getChatMember",
        { chat_id: GROUP, user_id: -5 },
        "Bad Request: invalid user_id specified",
      ],
      // An integer is an optional "-" and digits: no space or "+" first.
      ...[` ${ann}`, `+${ann}`].map((userId) => [
        "getChatMember",
        { chat_id: GROUP, user_id: userId },
        "Bad Request: invalid user_id specified",
      ]),
      [
        "sendContact",
        { chat_id: GROUP, first_name: "Ann" },
        'Bad Request: parameter "phone_number" is required',
      ],
      [
        "sendContact",
        { chat_id: GROUP, phone_number: "+15550100" },
        'Bad Request: parameter "first_name" is required',
      ],
      ["sendLocation", { chat_id: GROUP }, "Bad Request: latitude is empty"],
      [
        "sendLocation",
        { chat_id: GROUP, latitude: 1 },
        "Bad Request: longitude is empty",
      ],
      [
        "sendLocation",
        { chat_id: GROUP, latitude: 100, longitude: 0 },
        "Bad Request: invalid location specified",
      ],
      [
        "sendVenue",
        { chat_id: GROUP, ...venue },
        "Bad Request: latitude is empty",
      ],
      [
        "sendVenue",
        { chat_id: GROUP, latitude: 100, longitude: 0, ...venue },
        "Bad Request: wrong venue location specified",
      ],
      ...[
        ["sendPhoto", "photo"],
        ["sendAnimation", "animation"],
        ["sendAudio", "audio"],
        ["sendDocument", "document"],
        ["sendSticker", "sticker"],
        ["sendVideo", "video"],
        ["sendVideoNote", "video note"],
        ["sendVoice", "voice"],
      ].map(([method, name]) => [
        method,
        { chat_id: GROUP },
        `Bad Request: there is no ${name} in the request`,
      ]),
      [
        "sendPhoto",
        { chat_id: GROUP, photo: "attach://missing" },
        "Bad Request: there is no photo in the request",
      ],
    ]) {
      expect(await api(method, params)).toMatchObject({
        error_code: 400,
        description,
      });
    }
    // user_id is read as Telegram reads an integer: its leading digits.
    expect(
      await api("getChatMember", { chat_id: GROUP, user_id: `${ann}abc` }),
    ).toMatchObject({ ok: true, result: { user: { id: ann } } });
  });

  it("answers an unexpected failure with Telegram's bare 500 and logs the cause", async () => {
    const lines = [];
    const { api } = await setup({
      log: (line) => {
        if (line.startsWith("unimplemented")) throw new Error("log sink down");
        lines.push(line);
      },
    });

    expect(await api("sendInvoice")).toEqual({
      ok: false,
      error_code: 500,
      description: "Internal Server Error",
    });
    expect(lines.join("\n")).toContain("log sink down");
  });

  it("answers 400 to an invite hash that is not valid percent-encoding", async () => {
    const { raw } = await setup();
    expect(
      (
        await raw(
          "/_fake/invites/%E0%A4%A/join",
          JSON.stringify({ user_id: 1 }),
        )
      ).status,
    ).toBe(400);
  });

  it("ignores a limit that is not a number instead of returning nothing", async () => {
    const { server, api } = await setup();
    await server.sendDirectMessage(await server.createUser(), "hello");

    expect((await api("getUpdates", { limit: "abc" })).result).toHaveLength(1);
  });
});

describe("listening", () => {
  it("gives a usable origin when listening on IPv6 localhost", async () => {
    const { server } = await setup({ host: "::1" });
    const response = await fetch(`${server.origin}/bot${TOKEN}/getMe`);
    expect(response.status).toBe(200);
  });
});
