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
  it("reads form-encoded booleans as Telegram does: true, yes or 1 in any case", async () => {
    const { server, member } = await setup();
    async function form(method, params) {
      const response = await fetch(`${server.origin}/bot${TOKEN}/${method}`, {
        method: "POST",
        body: new URLSearchParams(params),
      });
      return response.json();
    }
    const ann = await member();
    const gone = await server.post(GROUP, ann, "soon gone");
    await form("deleteMessage", { chat_id: GROUP, message_id: gone });

    const reply = await form("sendMessage", {
      chat_id: GROUP,
      text: "still sent",
      reply_to_message_id: gone,
      allow_sending_without_reply: "True",
    });
    expect(reply).toMatchObject({ ok: true, result: { text: "still sent" } });
    expect(reply.result.reply_to_message).toBeUndefined();
    for (const flag of ["True", "yes", " 1 "]) {
      await form("unbanChatMember", {
        chat_id: GROUP,
        user_id: ann,
        only_if_banned: flag,
      });
      expect((await server.getMember(GROUP, ann)).status).toBe("member");
    }
  });

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

  it("gives file ids, invite links, business connections and login keys opaque identifiers", async () => {
    const { server, api } = await setup();
    const owner = await server.createUser();
    const fileId = (await api("sendVideo", { chat_id: GROUP, video: "x" }))
      .result.video.file_id;
    const identifiers = [
      fileId,
      (await api("getFile", { file_id: fileId })).result.file_path,
      (await api("createChatInviteLink", { chat_id: GROUP })).result
        .invite_link,
      (await api("exportChatInviteLink", { chat_id: GROUP })).result,
      (await server.connectBusiness({ ownerId: owner, rights: {} })).connection
        .id,
      ...(
        await (await fetch(`${server.origin}/.well-known/jwks.json`)).json()
      ).keys.map((key) => key.kid),
    ];

    expect(identifiers).toHaveLength(6);
    for (const identifier of identifiers) {
      expect(identifier).not.toContain("fake");
    }
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
