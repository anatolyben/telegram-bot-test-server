// Behaviour a group bot relies on that is easy to get subtly wrong. Each case
// follows the Bot API documentation or Telegram's observable behaviour.
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST";
const BOT = 123456;
const GROUP = -1001000000001;
const OWNER = 5000000001;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup() {
  const server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
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
  return { server, api, member };
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

  it("refuses to answer a callback query that was never sent", async () => {
    const { api } = await setup();
    expect(
      await api("answerCallbackQuery", { callback_query_id: "12345" }),
    ).toMatchObject({ status: 400, ok: false });
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

describe("Bot API details", () => {
  it("treats method names case-insensitively and remembers the bot's commands", async () => {
    const { api } = await setup();
    const commands = [{ command: "help", description: "Show help" }];

    await api("SETMYCOMMANDS", { commands });

    expect((await api("getmycommands")).result).toEqual(commands);
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
