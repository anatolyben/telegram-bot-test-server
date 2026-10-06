// Behaviour a group bot relies on that is easy to get subtly wrong. Each case
// follows the Bot API documentation or Telegram's observable behaviour.
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST";
const BOT = 123456;
const GROUP = -1001000000001;
const OWNER = 5000000001;

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()();
});

async function setup(options = {}) {
  const server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
    ...options,
  });
  cleanups.push(() => server.stop());
  async function api(method, params = {}) {
    const response = await fetch(`${server.origin}/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json()) };
  }
  async function member() {
    const id = await server.createUser();
    await server.join(GROUP, id);
    return id;
  }
  // The next callback query from getUpdates, confirming the updates before it.
  let offset = 0;
  async function nextCallbackQuery() {
    for (;;) {
      const { result } = await api("getUpdates", { offset, timeout: 5 });
      for (const update of result) {
        offset = update.update_id + 1;
        if (update.callback_query) return update.callback_query;
      }
    }
  }
  return { server, api, member, nextCallbackQuery };
}

describe("moderation", () => {
  it("refuses to restrict or ban the owner, an administrator or the bot itself", async () => {
    const { api } = await setup();
    const mute = { permissions: { can_send_messages: false } };

    expect(
      await api("restrictChatMember", {
        chat_id: GROUP,
        user_id: OWNER,
        ...mute,
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: can't remove chat owner",
    });
    expect(
      await api("banChatMember", { chat_id: GROUP, user_id: OWNER }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: can't remove chat owner",
    });
    expect(
      await api("restrictChatMember", {
        chat_id: GROUP,
        user_id: BOT,
        ...mute,
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: can't restrict self",
    });
    expect(
      await api("banChatMember", { chat_id: GROUP, user_id: BOT }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: user is an administrator of the chat",
    });
  });

  it("keeps a restriction when the user leaves and rejoins", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: ann,
      permissions: { can_send_messages: false },
    });

    await server.leave(GROUP, ann);
    expect(await server.getMember(GROUP, ann)).toMatchObject({
      status: "restricted",
      is_member: false,
    });
    await server.join(GROUP, ann);

    expect(await server.getMember(GROUP, ann)).toMatchObject({
      status: "restricted",
      is_member: true,
      can_send_messages: false,
    });
    await expect(server.post(GROUP, ann, "back again")).rejects.toThrow(
      "CHAT_WRITE_FORBIDDEN",
    );
  });

  it("removes a current member on unban unless only_if_banned is set", async () => {
    const { server, api, member } = await setup();
    const ann = await member();

    await api("unbanChatMember", {
      chat_id: GROUP,
      user_id: ann,
      only_if_banned: true,
    });
    expect((await server.getMember(GROUP, ann)).status).toBe("member");

    await api("unbanChatMember", { chat_id: GROUP, user_id: ann });
    expect((await server.getMember(GROUP, ann)).status).toBe("left");
  });

  it("applies the chat's default permissions to every member", async () => {
    const { server, api, member } = await setup();
    const ann = await member();

    await api("setChatPermissions", {
      chat_id: GROUP,
      permissions: { can_send_messages: false },
    });

    expect(
      (await api("getChat", { chat_id: GROUP })).result.permissions,
    ).toMatchObject({ can_send_messages: false, can_send_photos: false });
    await expect(server.post(GROUP, ann, "hello")).rejects.toThrow(
      "CHAT_WRITE_FORBIDDEN",
    );
  });

  it.each([
    { status: "member" },
    { status: "administrator", rights: { can_restrict_members: false } },
  ])(
    "refuses default-permission changes without restriction rights: %j",
    async (membership) => {
      const { server, api, member } = await setup();
      const ann = await member();
      const before = (await api("getChat", { chat_id: GROUP })).result
        .permissions;
      await server.setBotMembership(GROUP, BOT, membership);
      const denied = await api("setChatPermissions", {
        chat_id: GROUP,
        permissions: { can_send_messages: false },
      });
      expect(denied).toMatchObject({ status: 400, ok: false });
      expect(
        (await api("getChat", { chat_id: GROUP })).result.permissions,
      ).toEqual(before);
      expect((await server.getMember(GROUP, ann)).status).toBe("member");
      await expect(
        server.post(GROUP, ann, "still allowed"),
      ).resolves.toBeTypeOf("number");
      expect(
        (await server.getCalls()).calls.find(
          (call) => call.method === "setChatPermissions",
        ),
      ).toMatchObject({ applied: false, outcome: "rejected" });
    },
  );

  it("refuses group default permissions on a channel without changing channel state", async () => {
    const { server, api } = await setup();
    const channel = await server.createChat({
      ownerId: OWNER,
      type: "channel",
      title: "Channel",
    });
    await server.setBotMembership(channel, BOT, { status: "administrator" });
    const before = (await api("getChat", { chat_id: channel })).result;
    expect(
      await api("setChatPermissions", {
        chat_id: channel,
        permissions: { can_send_messages: false },
      }),
    ).toMatchObject({ status: 400, ok: false });
    expect((await api("getChat", { chat_id: channel })).result).toEqual(before);
  });

  it("lets broader permissions imply narrower ones unless they are independent", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const bob = await member();
    const permissions = { can_send_other_messages: true };

    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: ann,
      permissions,
    });
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: bob,
      permissions,
      use_independent_chat_permissions: true,
    });

    expect(await server.getMember(GROUP, ann)).toMatchObject({
      can_send_messages: true,
      can_send_photos: true,
    });
    expect(await server.getMember(GROUP, bob)).toMatchObject({
      can_send_messages: false,
      can_send_other_messages: true,
    });
  });

  it("checks the photo permission separately from the text permission", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: ann,
      permissions: { can_send_messages: true },
      use_independent_chat_permissions: true,
    });

    await expect(server.post(GROUP, ann, "text is fine")).resolves.toBeTypeOf(
      "number",
    );
    await expect(
      server.post(GROUP, ann, {
        photo: Buffer.from("jpg"),
        caption: "no photos",
      }),
    ).rejects.toThrow("CHAT_WRITE_FORBIDDEN");
  });

  it("announces a member admitted from a join request with a service message", async () => {
    const { server, api } = await setup();
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        creates_join_request: true,
      })
    ).result.invite_link;
    const ann = await server.createUser({ first_name: "Ann" });
    await server.joinByLink(link, ann);

    await api("approveChatJoinRequest", { chat_id: GROUP, user_id: ann });

    const [latest] = await server.getMessages(GROUP);
    expect(latest.new_chat_members).toEqual([
      expect.objectContaining({ id: ann }),
    ]);
  });

  it("revokes the previous primary link when a new one is exported", async () => {
    const { server, api } = await setup();
    const first = (await api("exportChatInviteLink", { chat_id: GROUP }))
      .result;
    await api("exportChatInviteLink", { chat_id: GROUP });

    await expect(
      server.joinByLink(first, await server.createUser()),
    ).rejects.toThrow("INVITE_HASH_EXPIRED");
  });
});

describe("messages and buttons", () => {
  it("removes the inline keyboard on an edit without reply_markup, so its buttons stop working", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const sent = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "Verify",
        reply_markup: {
          inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
        },
      })
    ).result;

    const edited = (
      await api("editMessageText", {
        chat_id: GROUP,
        message_id: sent.message_id,
        text: "Verified",
      })
    ).result;

    expect(edited).not.toHaveProperty("reply_markup");
    await expect(
      server.pressButton(GROUP, sent.message_id, ann, "ok"),
    ).rejects.toThrow("no button");
  });

  it("refuses an edit that changes nothing, and edits of other users' messages", async () => {
    const { server, api, member } = await setup();
    const sent = (await api("sendMessage", { chat_id: GROUP, text: "same" }))
      .result;
    const theirs = await server.post(GROUP, await member(), "mine");

    expect(
      await api("editMessageText", {
        chat_id: GROUP,
        message_id: sent.message_id,
        text: "same",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      (
        await api("editMessageText", {
          chat_id: GROUP,
          message_id: sent.message_id,
          text: "same",
        })
      ).description,
    ).toMatch(/^Bad Request: message is not modified/);
    expect(
      await api("editMessageText", {
        chat_id: GROUP,
        message_id: theirs,
        text: "x",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message can't be edited",
    });
  });

  it("refuses inline buttons without an action, and callback_data outside 1-64 bytes", async () => {
    const { api } = await setup();
    const send = (button) =>
      api("sendMessage", {
        chat_id: GROUP,
        text: "Choose",
        reply_markup: { inline_keyboard: [[{ text: "Go", ...button }]] },
      });
    const textButton = {
      status: 400,
      description:
        "Bad Request: can't parse InlineKeyboardButton: Text buttons are not allowed in the inline keyboard",
    };
    const badData = {
      status: 400,
      description: "Bad Request: BUTTON_DATA_INVALID",
    };

    expect(await send({})).toMatchObject(textButton);
    expect(await send({ callback_data: "" })).toMatchObject(textButton);
    expect(await send({ callback_data: "x".repeat(65) })).toMatchObject(
      badData,
    );
    // The limit is in UTF-8 bytes: 33 "é" are 66 bytes.
    expect(await send({ callback_data: "é".repeat(33) })).toMatchObject(
      badData,
    );
    const sent = await send({ callback_data: "é".repeat(32) });
    expect(sent).toMatchObject({ ok: true });
    expect(
      await api("editMessageReplyMarkup", {
        chat_id: GROUP,
        message_id: sent.result.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: "Go", callback_data: "x".repeat(65) }]],
        },
      }),
    ).toMatchObject(badData);
  });

  it("refuses to answer a callback query that was never sent", async () => {
    const { api } = await setup();
    expect(
      await api("answerCallbackQuery", { callback_query_id: "12345" }),
    ).toMatchObject({ status: 400, ok: false });
  });

  it("refuses a callback answer over 200 characters and keeps the query open", async () => {
    const { server, api, member, nextCallbackQuery } = await setup();
    const ann = await member();
    const sent = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "Verify",
        reply_markup: {
          inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
        },
      })
    ).result;
    const press = server.pressButton(GROUP, sent.message_id, ann, "ok");
    const query = await nextCallbackQuery();

    expect(
      await api("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "x".repeat(201),
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: MESSAGE_TOO_LONG",
    });
    expect(
      await api("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "x".repeat(200),
      }),
    ).toMatchObject({ ok: true });
    expect(await press).toMatchObject({
      answered: true,
      text: "x".repeat(200),
    });
  });

  it("gives callback queries an opaque chat_instance, the same for every press in a chat", async () => {
    const { server, api, member, nextCallbackQuery } = await setup();
    const ann = await member();
    await server.sendDirectMessage(ann, "/start");
    const send = async (chatId) =>
      (
        await api("sendMessage", {
          chat_id: chatId,
          text: "Verify",
          reply_markup: {
            inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
          },
        })
      ).result.message_id;
    const instance = async (press) => {
      const query = await nextCallbackQuery();
      await api("answerCallbackQuery", { callback_query_id: query.id });
      await press;
      return query.chat_instance;
    };

    const group = await instance(
      server.pressButton(GROUP, await send(GROUP), ann, "ok"),
    );
    const groupAgain = await instance(
      server.pressButton(GROUP, await send(GROUP), ann, "ok"),
    );
    const direct = await instance(
      server.pressDirectButton(ann, await send(ann), "ok"),
    );

    expect(group).toMatch(/^-?\d+$/);
    expect(group).not.toBe(String(GROUP));
    expect(groupAgain).toBe(group);
    expect(direct).not.toBe(String(ann));
    expect(direct).not.toBe(group);
  });

  it("lets the bot message a user privately only after the user has written to it", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();

    expect(
      await api("sendMessage", { chat_id: ann, text: "hi" }),
    ).toMatchObject({
      status: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    });
    await server.sendDirectMessage(ann, "/start");
    expect(
      await api("sendMessage", { chat_id: ann, text: "hi" }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("marks commands in private messages, emails and links without trailing punctuation", async () => {
    const { server, member } = await setup();
    const ann = await member();
    await server.sendDirectMessage(ann, "/help");
    await server.post(
      GROUP,
      ann,
      "write to ann@example.com or see example.org.",
    );

    const [dm] = await server.getDirectMessages(ann);
    expect(dm.entities).toEqual([
      { type: "bot_command", offset: 0, length: 5 },
    ]);
    const [post] = await server.getMessages(GROUP);
    expect(
      post.entities.map((entity) => [
        entity.type,
        post.text.slice(entity.offset, entity.offset + entity.length),
      ]),
    ).toEqual([
      ["email", "ann@example.com"],
      ["url", "example.org"],
    ]);
  });
});

describe("ephemeral messages", () => {
  const button = { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] };

  /** The first callback query waiting in the bot's getUpdates queue. */
  async function callbackQuery(api) {
    let query;
    await expect
      .poll(async () => {
        const updates = (await api("getUpdates")).result;
        query = updates.find((update) => update.callback_query)?.callback_query;
        return query;
      })
      .toBeTruthy();
    return query;
  }

  it("gives an ephemeral message message_id 0 and an ephemeral_message_id outside the chat's message ids", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const before = (await api("sendMessage", { chat_id: GROUP, text: "one" }))
      .result;

    const ephemeral = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "only you",
        ephemeral_message_parameters: { receiver_user_id: ann },
      })
    ).result;
    const after = (await api("sendMessage", { chat_id: GROUP, text: "two" }))
      .result;

    expect(ephemeral).toMatchObject({
      message_id: 0,
      receiver_user: { id: ann },
    });
    expect(ephemeral.ephemeral_message_id).toBeGreaterThan(0);
    expect(after.message_id).toBe(before.message_id + 1);
    expect((await server.getMessages(GROUP)).slice(0, 3)).toEqual([
      after,
      ephemeral,
      before,
    ]);
  });

  it("refuses the regular edit and delete methods for an ephemeral message", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const sent = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "only you",
        ephemeral_message_parameters: { receiver_user_id: ann },
      })
    ).result;

    expect(
      await api("editMessageText", {
        chat_id: GROUP,
        message_id: sent.message_id,
        text: "changed",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message to edit not found",
    });
    expect(
      await api("deleteMessage", {
        chat_id: GROUP,
        message_id: sent.message_id,
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message to delete not found",
    });
    expect(
      await server.getEphemeralMessage(GROUP, sent.ephemeral_message_id),
    ).toMatchObject({ deleted: false, message: { text: "only you" } });
  });

  it("edits the text and keyboard of an ephemeral message and deletes it through the ephemeral methods", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const bob = await member();
    const id = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "only you",
        reply_markup: button,
        ephemeral_message_parameters: { receiver_user_id: ann },
      })
    ).result.ephemeral_message_id;
    const target = {
      chat_id: GROUP,
      receiver_user_id: ann,
      ephemeral_message_id: id,
    };

    expect(
      await api("editEphemeralMessageText", {
        ...target,
        text: "<b>done</b>",
        parse_mode: "HTML",
        reply_markup: button,
      }),
    ).toMatchObject({ ok: true, result: true });
    expect((await server.getEphemeralMessage(GROUP, id)).message).toMatchObject(
      {
        message_id: 0,
        text: "done",
        entities: [{ type: "bold", offset: 0, length: 4 }],
        reply_markup: button,
        edit_date: expect.any(Number),
      },
    );
    expect(await api("editEphemeralMessageReplyMarkup", target)).toMatchObject({
      ok: true,
      result: true,
    });
    expect(
      (await server.getEphemeralMessage(GROUP, id)).message,
    ).not.toHaveProperty("reply_markup");
    expect(
      await api("editEphemeralMessageText", {
        ...target,
        receiver_user_id: bob,
        text: "not theirs",
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await api("deleteEphemeralMessage", {
        chat_id: GROUP,
        ephemeral_message_id: id,
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: invalid receiver_user_id specified",
    });

    expect(await api("deleteEphemeralMessage", target)).toMatchObject({
      ok: true,
      result: true,
    });
    expect(await server.getEphemeralMessage(GROUP, id)).toMatchObject({
      exists: true,
      deleted: true,
    });
    expect(await api("deleteEphemeralMessage", target)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("edits the caption and media of an ephemeral message", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const id = (
      await api("sendPhoto", {
        chat_id: GROUP,
        photo: "x",
        caption: "old",
        ephemeral_message_parameters: { receiver_user_id: ann },
      })
    ).result.ephemeral_message_id;
    const target = {
      chat_id: GROUP,
      receiver_user_id: ann,
      ephemeral_message_id: id,
    };
    const document = (
      await api("sendDocument", { chat_id: GROUP, document: "y" })
    ).result.document;

    expect(
      await api("editEphemeralMessageCaption", { ...target, caption: "new" }),
    ).toMatchObject({ ok: true, result: true });
    expect((await server.getEphemeralMessage(GROUP, id)).message).toMatchObject(
      { caption: "new", photo: expect.any(Array) },
    );
    expect(
      await api("editEphemeralMessageMedia", {
        ...target,
        media: { type: "document", media: document.file_id },
      }),
    ).toMatchObject({ ok: true, result: true });
    const { message } = await server.getEphemeralMessage(GROUP, id);
    expect(message).toMatchObject({
      document: { file_id: document.file_id },
    });
    expect(message).not.toHaveProperty("photo");
  });

  it("sends the receiver's button press with the ephemeral message, which no one else can press", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const bob = await member();
    const sent = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "Verify",
        reply_markup: button,
        ephemeral_message_parameters: { receiver_user_id: ann },
      })
    ).result;

    await expect(
      server.pressEphemeralButton(GROUP, sent.ephemeral_message_id, bob, "ok"),
    ).rejects.toThrow();
    const press = server.pressEphemeralButton(
      GROUP,
      sent.ephemeral_message_id,
      ann,
      "ok",
    );
    const query = await callbackQuery(api);
    await api("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "thanks",
    });

    expect(await press).toMatchObject({ answered: true, text: "thanks" });
    expect(query).toMatchObject({
      from: { id: ann },
      data: "ok",
      message: {
        message_id: 0,
        ephemeral_message_id: sent.ephemeral_message_id,
        receiver_user: { id: ann },
      },
    });
  });

  it("sends ephemeral messages only to non-bot members of a group or supergroup", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const stranger = await server.createUser();
    await server.addBot({ token: "222:SECOND", username: "second_bot" });
    await server.setBotMembership(GROUP, 222, { status: "member" });
    await server.sendDirectMessage(ann, "hi");
    const basic = await server.createChat({ type: "group", ownerId: OWNER });
    await server.setBotMembership(basic, BOT, { status: "administrator" });
    await server.join(basic, ann);
    const channel = await server.createChat({
      type: "channel",
      ownerId: OWNER,
    });
    await server.setBotMembership(channel, BOT, { status: "administrator" });
    const send = (chat, receiver) =>
      api("sendMessage", {
        chat_id: chat,
        text: "psst",
        ephemeral_message_parameters: { receiver_user_id: receiver },
      });

    expect(await send(basic, ann)).toMatchObject({ ok: true });
    for (const [chat, receiver] of [
      [ann, ann],
      [channel, OWNER],
      [GROUP, stranger],
      [GROUP, 222],
    ]) {
      expect(await send(chat, receiver)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });

  it("lets a bot that is not an administrator send one only within 15 seconds of the receiver's callback query", async () => {
    const { server, api, member } = await setup({
      clock: { now: 1_800_000_000_000 },
    });
    const ann = await member();
    const bob = await member();
    const prompt = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "Verify",
        reply_markup: button,
      })
    ).result;
    await server.setBotMembership(GROUP, BOT, { status: "member" });
    const send = (receiver, callbackQueryId) =>
      api("sendMessage", {
        chat_id: GROUP,
        text: "verified",
        ephemeral_message_parameters: {
          receiver_user_id: receiver,
          ...(callbackQueryId ? { callback_query_id: callbackQueryId } : {}),
        },
      });

    expect(await send(ann)).toMatchObject({ ok: false, status: 400 });
    const press = server.pressButton(GROUP, prompt.message_id, ann, "ok");
    const query = await callbackQuery(api);
    await api("answerCallbackQuery", { callback_query_id: query.id });
    await press;
    await server.advanceTime(15_000);

    expect(await send(bob, query.id)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await send(ann, query.id)).toMatchObject({
      ok: true,
      result: { receiver_user: { id: ann } },
    });
    await server.advanceTime(1);
    expect(await send(ann, query.id)).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("guest bots", () => {
  it("posts a guest bot's reply in the group from that bot, naming the user who called it", async () => {
    const { server, api, member } = await setup();
    const ann = await member();

    const replyId = await server.postGuestBotReply(
      GROUP,
      ann,
      "@helper_bot",
      "see example.org",
    );

    const { message } = await server.getMessage(GROUP, replyId);
    expect(message).toMatchObject({
      from: { is_bot: true, username: "helper_bot" },
      guest_bot_caller_user: { id: ann },
      entities: [{ type: "url" }],
    });
    // The group's own bot can moderate it like any other message.
    expect(
      await api("deleteMessage", { chat_id: GROUP, message_id: replyId }),
    ).toMatchObject({ ok: true });
  });
});

describe("Bot API details", () => {
  it("treats method names case-insensitively and remembers the bot's commands", async () => {
    const { api } = await setup();
    const commands = [{ command: "help", description: "Show help" }];

    await api("SETMYCOMMANDS", { commands });

    expect((await api("getmycommands")).result).toEqual(commands);
  });

  it("keeps one command list per scope and language, and deletes only the one addressed", async () => {
    const { api } = await setup();
    const members = [{ command: "rules", description: "Show the rules" }];
    const admins = [{ command: "ban", description: "Ban a member" }];
    const russian = [{ command: "pravila", description: "Правила" }];
    const chat = { type: "chat", chat_id: GROUP };
    const chatAdmins = { type: "chat_administrators", chat_id: GROUP };
    const commands = async (params) =>
      (await api("getMyCommands", params)).result;

    await api("setMyCommands", { commands: members, scope: chat });
    await api("setMyCommands", { commands: admins, scope: chatAdmins });
    await api("setMyCommands", {
      commands: russian,
      scope: chat,
      language_code: "ru",
    });

    expect(await commands({})).toEqual([]);
    expect(await commands({ scope: { type: "default" } })).toEqual([]);
    expect(await commands({ scope: chat })).toEqual(members);
    expect(
      await commands({ scope: { type: "chat", chat_id: String(GROUP) } }),
    ).toEqual(members);
    expect(await commands({ scope: chatAdmins })).toEqual(admins);
    expect(await commands({ scope: chat, language_code: "ru" })).toEqual(
      russian,
    );

    await api("deleteMyCommands", { scope: chatAdmins });

    expect(await commands({ scope: chatAdmins })).toEqual([]);
    expect(await commands({ scope: chat })).toEqual(members);
    expect(await commands({ scope: chat, language_code: "ru" })).toEqual(
      russian,
    );
  });

  it("returns media with the fields the Bot API requires, and files getFile can resolve", async () => {
    const { api } = await setup();
    const video = (await api("sendVideo", { chat_id: GROUP, video: "x" }))
      .result.video;

    expect(video).toMatchObject({
      file_id: expect.any(String),
      file_unique_id: expect.any(String),
      width: expect.any(Number),
      height: expect.any(Number),
      duration: expect.any(Number),
    });
    expect(await api("getFile", { file_id: video.file_id })).toMatchObject({
      ok: true,
    });
  });
});

// https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
describe("flood control", () => {
  const limited = { clock: { now: 1_800_000_000_000 }, floodControl: true };

  it("answers the Bot API server's 429 to a 21st message in a group within a minute", async () => {
    const { server } = await setup(limited);
    const send = (text) =>
      fetch(`${server.origin}/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: GROUP, text }),
      });
    for (let i = 1; i <= 20; i += 1) {
      expect((await send(`notice ${i}`)).status).toBe(200);
      await server.advanceTime(1000);
    }

    const refused = await send("notice 21");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("41");
    expect(await refused.json()).toEqual({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 41",
      parameters: { retry_after: 41 },
    });
    expect(
      (await server.getMessages(GROUP)).map((message) => message.text),
    ).not.toContain("notice 21");

    await server.advanceTime(41_000);
    expect((await send("notice 21")).status).toBe(200);
  });

  it("allows one message a second in a chat, counting an album as one", async () => {
    const { server, api } = await setup(limited);
    const video = (await api("sendVideo", { chat_id: GROUP, video: "x" }))
      .result.video.file_id;
    expect(
      await api("sendMessage", { chat_id: GROUP, text: "too soon" }),
    ).toMatchObject({ status: 429, parameters: { retry_after: 2 } });

    await server.advanceTime(1000);
    const album = await api("sendMediaGroup", {
      chat_id: GROUP,
      media: [
        { type: "video", media: video },
        { type: "video", media: video },
      ],
    });
    expect(album.result).toHaveLength(2);
    expect(
      await api("sendMessage", { chat_id: GROUP, text: "too soon" }),
    ).toMatchObject({ status: 429, parameters: { retry_after: 2 } });
  });

  it("allows a bot 30 messages a second across all its chats", async () => {
    const { server, api } = await setup(limited);
    const subscribers = [];
    for (let i = 0; i < 31; i += 1) {
      const id = await server.createUser();
      await server.sendDirectMessage(id, "subscribe");
      subscribers.push(id);
    }
    for (const id of subscribers.slice(0, 30)) {
      expect(
        await api("sendMessage", { chat_id: id, text: "news" }),
      ).toMatchObject({ ok: true });
    }

    const last = { chat_id: subscribers[30], text: "news" };
    expect(await api("sendMessage", last)).toMatchObject({
      status: 429,
      parameters: { retry_after: 2 },
    });
    await server.advanceTime(1000);
    expect(await api("sendMessage", last)).toMatchObject({ ok: true });
  });
});

describe("moderation physical state", () => {
  it.each([true, "true", false, undefined])(
    "revokes only the banned author's messages in a supergroup (revoke=%s)",
    async (revoke) => {
      const { server, api, member } = await setup();
      const ann = await member(),
        bob = await member();
      const other = await server.createChat({ ownerId: OWNER, title: "Other" });
      await server.join(other, ann);
      const a = await server.post(GROUP, ann, "ann"),
        b = await server.post(GROUP, bob, "bob");
      const elsewhere = await server.post(other, ann, "elsewhere");
      expect(
        await api("banChatMember", {
          chat_id: GROUP,
          user_id: ann,
          revoke_messages: revoke,
        }),
      ).toMatchObject({ ok: true });
      expect(await server.getMessage(GROUP, a)).toMatchObject({
        deleted: true,
      });
      expect(await server.getMessage(GROUP, b)).toMatchObject({
        deleted: false,
      });
      expect(await server.getMessage(other, elsewhere)).toMatchObject({
        deleted: false,
      });
      expect(
        (await api("getChatMember", { chat_id: GROUP, user_id: ann })).result
          .status,
      ).toBe("kicked");
    },
  );

  it.each(["restrictChatMember", "banChatMember", "unbanChatMember"])(
    "requires can_restrict_members for %s without changing physical state",
    async (method) => {
      const { server, api, member } = await setup();
      const ann = await member();
      const message = await server.post(GROUP, ann, "kept");
      if (method === "unbanChatMember")
        await api("banChatMember", { chat_id: GROUP, user_id: ann });
      const before = await server.getMember(GROUP, ann),
        beforeMessage = await server.getMessage(GROUP, message);
      await server.setBotMembership(GROUP, BOT, {
        status: "administrator",
        rights: { can_restrict_members: false },
      });
      expect(
        await api(method, {
          chat_id: GROUP,
          user_id: ann,
          permissions: { can_send_messages: false },
        }),
      ).toMatchObject({ ok: false, status: 400 });
      expect(await server.getMember(GROUP, ann)).toEqual(before);
      expect(await server.getMessage(GROUP, message)).toEqual(beforeMessage);
    },
  );

  it.each(["approveChatJoinRequest", "declineChatJoinRequest"])(
    "requires invite rights for %s and retains the pending request",
    async (method) => {
      const { server, api } = await setup();
      const link = (
        await api("createChatInviteLink", {
          chat_id: GROUP,
          creates_join_request: true,
        })
      ).result.invite_link;
      const ann = await server.createUser();
      await server.joinByLink(link, ann);
      expect((await server.getMember(GROUP, ann)).status).toBe("left");
      await server.setBotMembership(GROUP, BOT, {
        status: "administrator",
        rights: { can_invite_users: false },
      });
      expect(await api(method, { chat_id: GROUP, user_id: ann })).toMatchObject(
        { ok: false, status: 400 },
      );
      expect(await server.getJoinRequests(GROUP)).toEqual([ann]);
      expect((await server.getMember(GROUP, ann)).status).toBe("left");
    },
  );

  it("rejects bulk deletion before deleting any message when a target needs missing rights", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const mine = (await api("sendMessage", { chat_id: GROUP, text: "mine" }))
      .result.message_id;
    const theirs = await server.post(GROUP, ann, "theirs");
    await server.setBotMembership(GROUP, BOT, {
      status: "administrator",
      rights: { can_delete_messages: false },
    });
    expect(
      await api("deleteMessages", {
        chat_id: GROUP,
        message_ids: [mine, theirs],
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await server.getMessage(GROUP, mine)).toMatchObject({
      deleted: false,
    });
    expect(await server.getMessage(GROUP, theirs)).toMatchObject({
      deleted: false,
    });
    await server.setBotMembership(GROUP, BOT, { status: "administrator" });
    expect(
      await api("deleteMessages", {
        chat_id: GROUP,
        message_ids: [mine, theirs, 999],
      }),
    ).toMatchObject({ ok: true });
    expect(await server.getMessage(GROUP, theirs)).toMatchObject({
      deleted: true,
    });
  });

  it.each(["restrictChatMember", "banChatMember"])(
    "normalizes %s until_date boundaries and expires timed state",
    async (method) => {
      const { server, api, member } = await setup();
      const ann = await member();
      const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
      const now = 2_000_000_000;
      for (const [delta, expected] of [
        [29, 0],
        [30, now + 30],
        [366 * 86400, now + 366 * 86400],
        [366 * 86400 + 1, 0],
      ]) {
        expect(
          await api(method, {
            chat_id: GROUP,
            user_id: ann,
            permissions: { can_send_messages: false },
            until_date: now + delta,
          }),
        ).toMatchObject({ ok: true });
        expect((await server.getMember(GROUP, ann)).until_date).toBe(expected);
      }
      await api(method, {
        chat_id: GROUP,
        user_id: ann,
        permissions: { can_send_messages: false },
        until_date: now + 30,
      });
      clock.mockReturnValue((now + 30) * 1000);
      expect((await server.getMember(GROUP, ann)).status).toBe(
        method === "banChatMember" ? "left" : "member",
      );
    },
  );
});

describe("documented moderation boundaries", () => {
  it("honors form-encoded revocation in a basic group and ignores its ban deadline", async () => {
    const { server } = await setup();
    const group = await server.createChat({ type: "group", ownerId: OWNER });
    await server.setBotMembership(group, BOT, { status: "administrator" });
    const ann = await server.createUser();
    await server.join(group, ann);
    const message = await server.post(group, ann, "remove this");
    const response = await fetch(`${server.origin}/bot${TOKEN}/banChatMember`, {
      method: "POST",
      body: new URLSearchParams({
        chat_id: String(group),
        user_id: String(ann),
        revoke_messages: "true",
        until_date: String(Math.floor(Date.now() / 1000) + 60),
      }),
    });
    expect(await response.json()).toMatchObject({ ok: true });
    expect(await server.getMessage(group, message)).toMatchObject({
      deleted: true,
    });
    expect(await server.getMember(group, ann)).toMatchObject({
      status: "kicked",
      until_date: 0,
    });
  });

  it("rejects deletion at 48 hours while allowing it just before that boundary", async () => {
    const { server, api, member } = await setup();
    const ann = await member();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const recent = await server.post(GROUP, ann, "recent");
    const old = await server.post(GROUP, ann, "old");
    clock.mockReturnValue((2_000_000_000 + 48 * 3600 - 1) * 1000);
    expect(
      await api("deleteMessage", { chat_id: GROUP, message_id: recent }),
    ).toMatchObject({ ok: true });
    clock.mockReturnValue((2_000_000_000 + 48 * 3600) * 1000);
    expect(
      await api("deleteMessages", { chat_id: GROUP, message_ids: [old] }),
    ).toMatchObject({ ok: false });
    expect(await server.getMessage(GROUP, old)).toMatchObject({
      deleted: false,
    });
  });
});

it("deletes private dice only after 24 hours", async () => {
  const { server, api } = await setup();
  const ann = await server.createUser();
  await server.sendDirectMessage(ann, "start");
  const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
  const message = (await api("sendDice", { chat_id: ann })).result.message_id;
  clock.mockReturnValue((2_000_000_000 + 24 * 3600) * 1000);
  expect(
    await api("deleteMessage", { chat_id: ann, message_id: message }),
  ).toMatchObject({ ok: false });

  clock.mockReturnValue((2_000_000_000 + 24 * 3600 + 1) * 1000);
  expect(
    await api("deleteMessage", { chat_id: ann, message_id: message }),
  ).toMatchObject({ ok: true });
});

it("refuses to delete the creation service message of a forum topic", async () => {
  const { server, api } = await setup();
  const group = await server.createChat({ ownerId: OWNER, isForum: true });
  await server.setBotMembership(group, BOT, { status: "administrator" });
  const topic = await server.createTopic(group, "Garden");
  expect(
    await api("deleteMessage", {
      chat_id: group,
      message_id: topic,
    }),
  ).toMatchObject({ ok: false });
  expect(await server.getMessage(group, topic)).toMatchObject({
    deleted: false,
  });
});

it.each(["group", "channel"])(
  "rejects restrictChatMember outside a supergroup (%s)",
  async (type) => {
    const { server, api } = await setup();
    const chat = await server.createChat({ type, ownerId: OWNER });
    await server.setBotMembership(chat, BOT, { status: "administrator" });
    const ann = await server.createUser();
    await server.join(chat, ann);
    const before = await server.getMember(chat, ann);
    expect(
      await api("restrictChatMember", {
        chat_id: chat,
        user_id: ann,
        permissions: { can_send_messages: false },
      }),
    ).toMatchObject({ ok: false });
    expect(await server.getMember(chat, ann)).toEqual(before);
  },
);
