import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST-TOKEN";
const GUARD_TOKEN = "777777:GUARD-TOKEN";
const GROUP = -1001000000001;
const OWNER = 5000000001;
const BYTES = Buffer.from("fake-media-bytes");

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A webhook endpoint that records every update. */
async function startReceiver() {
  const updates = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      updates.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
    ofType: (type) => updates.map((update) => update[type]).filter(Boolean),
  };
}

async function setup() {
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
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
  async function upload(method, fields) {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (Buffer.isBuffer(value)) body.append(key, new Blob([value]), key);
      else
        body.append(
          key,
          typeof value === "string" ? value : JSON.stringify(value),
        );
    }
    const response = await fetch(`${fake.origin}/bot${TOKEN}/${method}`, {
      method: "POST",
      body,
    });
    return { status: response.status, ...(await response.json()) };
  }
  const member = await fake.createUser({ first_name: "Member" });
  await fake.join(GROUP, member);
  const me = (await api("getMe")).result;
  return { fake, api, upload, member, me };
}

describe("what members post", () => {
  it("delivers videos, voice notes, stickers and documents with the fields bots read", async () => {
    const { fake, member } = await setup();
    const post = async (media, caption) => {
      const id = await fake.post(GROUP, member, { media, caption });
      return (await fake.getMessage(GROUP, id)).message;
    };

    expect(await post({ type: "video", bytes: BYTES }, "clip")).toMatchObject({
      video: { width: 1280, height: 720, mime_type: "video/mp4" },
      caption: "clip",
    });
    expect(await post({ type: "voice", bytes: BYTES })).toMatchObject({
      voice: { mime_type: "audio/ogg", duration: 1 },
    });
    const sticker = await post({ type: "sticker", bytes: BYTES }, "ignored");
    expect(sticker.sticker).toMatchObject({
      type: "regular",
      is_animated: false,
    });
    expect(sticker.caption).toBeUndefined();
    expect(
      await post({ type: "document", bytes: BYTES, fileName: "invoice.pdf" }),
    ).toMatchObject({ document: { file_name: "invoice.pdf" } });
    const animation = await post({ type: "animation", bytes: BYTES });
    expect(animation.animation).toBeDefined();
    expect(animation.document).toBeDefined();
  });

  it("refuses a voice note from a member who may not send one", async () => {
    const { fake, api, member } = await setup();
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: member,
      permissions: { can_send_messages: true, can_send_voice_notes: false },
    });
    await expect(
      fake.post(GROUP, member, { media: { type: "voice", bytes: BYTES } }),
    ).rejects.toThrow(/CHAT_WRITE_FORBIDDEN/);
  });

  it("trims a member's text and refuses text that is empty", async () => {
    const { fake, member } = await setup();
    const id = await fake.post(GROUP, member, "  hi /help \n");
    expect((await fake.getMessage(GROUP, id)).message).toMatchObject({
      text: "hi /help",
      entities: [{ type: "bot_command", offset: 3, length: 5 }],
    });
    const before = await fake.getMessages(GROUP);
    for (const text of ["", " \n "]) {
      await expect(fake.post(GROUP, member, text)).rejects.toThrow(
        /MESSAGE_EMPTY/,
      );
    }
    expect(await fake.getMessages(GROUP)).toEqual(before);
    await expect(fake.sendDirectMessage(member, "  ")).rejects.toThrow(
      /MESSAGE_EMPTY/,
    );
  });

  it("marks forwarded messages with where they came from", async () => {
    const { fake, api, member, me } = await setup();
    const source = await fake.createUser({ first_name: "Source" });
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const post = await api("sendMessage", { chat_id: channel, text: "news" });

    const read = async (forwardFrom) =>
      (
        await fake.getMessage(
          GROUP,
          await fake.post(GROUP, member, { text: "fwd", forwardFrom }),
        )
      ).message.forward_origin;

    expect(await read({ userId: source })).toMatchObject({
      type: "user",
      sender_user: { id: source },
    });
    expect(await read({ senderName: "Anonymous Seller" })).toMatchObject({
      type: "hidden_user",
      sender_user_name: "Anonymous Seller",
    });
    expect(
      await read({ chatId: channel, messageId: post.result.message_id }),
    ).toMatchObject({
      type: "channel",
      chat: { id: channel },
      message_id: post.result.message_id,
      date: post.result.date,
    });
  });

  it("sends an album as messages that share a media_group_id", async () => {
    const { fake, api, member } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });

    const album = await fake.postAlbum(GROUP, member, [
      { type: "photo", bytes: BYTES, caption: "set" },
      { type: "video", bytes: BYTES },
    ]);

    await expect
      .poll(() =>
        hook
          .ofType("message")
          .filter((message) => message.media_group_id === album.media_group_id)
          .map((message) => message.message_id),
      )
      .toEqual(album.message_ids);
    await expect(
      fake.postAlbum(GROUP, member, [{ type: "photo", bytes: BYTES }]),
    ).rejects.toThrow();
  });

  it("delivers a member's edit as edited_message, only by its author", async () => {
    const { fake, api, member } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const other = await fake.createUser();
    await fake.join(GROUP, other);
    const id = await fake.post(GROUP, member, "hello");

    await fake.editMessage(GROUP, id, member, {
      text: "buy followers at spam.example.com",
    });

    await expect.poll(() => hook.ofType("edited_message").length).toBe(1);
    expect(hook.ofType("edited_message")[0]).toMatchObject({
      message_id: id,
      text: "buy followers at spam.example.com",
      edit_date: expect.any(Number),
      entities: [{ type: "url" }],
    });
    await expect(
      fake.editMessage(GROUP, id, other, { text: "not mine" }),
    ).rejects.toThrow(/MESSAGE_AUTHOR_REQUIRED/);
    await expect(
      fake.editMessage(GROUP, id, member, {
        text: "buy followers at spam.example.com",
      }),
    ).rejects.toThrow(/MESSAGE_NOT_MODIFIED/);
  });

  it("tells administrator bots that asked for it when a member reacts", async () => {
    const { fake, api, member } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message", "message_reaction"],
    });
    const sent = await api("sendMessage", { chat_id: GROUP, text: "poll" });

    await fake.react(GROUP, sent.result.message_id, member, "👍");
    await fake.react(GROUP, sent.result.message_id, member, null);

    await expect.poll(() => hook.ofType("message_reaction").length).toBe(2);
    expect(
      hook
        .ofType("message_reaction")
        .map((update) => [update.old_reaction, update.new_reaction]),
    ).toEqual([
      [[], [{ type: "emoji", emoji: "👍" }]],
      [[{ type: "emoji", emoji: "👍" }], []],
    ]);
  });

  it("sends no reaction updates to a bot that did not ask for them", async () => {
    const { fake, api, member } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const sent = await api("sendMessage", { chat_id: GROUP, text: "x" });
    await fake.react(GROUP, sent.result.message_id, member, "🔥");
    const id = await fake.post(GROUP, member, "after");
    await expect
      .poll(() => hook.ofType("message").some((m) => m.message_id === id))
      .toBe(true);
    expect(hook.ofType("message_reaction")).toEqual([]);
  });
});

describe("more send methods", () => {
  it("sends voice, audio, video notes, places, contacts and dice", async () => {
    const { api, upload } = await setup();
    expect(
      (await upload("sendVoice", { chat_id: String(GROUP), voice: BYTES }))
        .result.voice,
    ).toMatchObject({ mime_type: "audio/ogg" });
    expect(
      (await upload("sendAudio", { chat_id: String(GROUP), audio: BYTES }))
        .result.audio,
    ).toMatchObject({ mime_type: "audio/mpeg" });
    expect(
      (
        await upload("sendVideoNote", {
          chat_id: String(GROUP),
          video_note: BYTES,
        })
      ).result.video_note,
    ).toMatchObject({ length: 240 });
    expect(
      (
        await api("sendLocation", {
          chat_id: GROUP,
          latitude: 40.7,
          longitude: -74,
        })
      ).result.location,
    ).toEqual({ latitude: 40.7, longitude: -74 });
    expect(
      (
        await api("sendVenue", {
          chat_id: GROUP,
          latitude: 40.7,
          longitude: -74,
          title: "Office",
          address: "1 Main St",
        })
      ).result.venue,
    ).toMatchObject({ title: "Office", address: "1 Main St" });
    expect(
      (
        await api("sendContact", {
          chat_id: GROUP,
          phone_number: "+15550100",
          first_name: "Ann",
        })
      ).result.contact,
    ).toEqual({ phone_number: "+15550100", first_name: "Ann" });
    const dice = (await api("sendDice", { chat_id: GROUP, emoji: "🏀" })).result
      .dice;
    expect(dice.emoji).toBe("🏀");
    expect(dice.value).toBeGreaterThanOrEqual(1);
    expect(dice.value).toBeLessThanOrEqual(5);
    expect(
      await api("sendLocation", {
        chat_id: GROUP,
        latitude: 100,
        longitude: 0,
      }),
    ).toMatchObject({ status: 400 });
  });

  it("accepts known chat actions only", async () => {
    const { api } = await setup();
    expect(
      (await api("sendChatAction", { chat_id: GROUP, action: "typing" }))
        .result,
    ).toBe(true);
    expect(
      await api("sendChatAction", { chat_id: GROUP, action: "dancing" }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: wrong parameter action in request",
    });
  });

  it("sends an album of up to 10 items, and never documents or audio mixed with others", async () => {
    const { upload } = await setup();
    const sent = await upload("sendMediaGroup", {
      chat_id: String(GROUP),
      media: [
        { type: "photo", media: "attach://one", caption: "first" },
        { type: "video", media: "attach://two" },
      ],
      one: BYTES,
      two: BYTES,
    });
    expect(sent.result).toHaveLength(2);
    expect(new Set(sent.result.map((m) => m.media_group_id)).size).toBe(1);
    expect(sent.result[0]).toMatchObject({
      caption: "first",
      photo: expect.any(Array),
    });

    const photo = { type: "photo", media: "attach://one" };
    for (const [media, description] of [
      [undefined, 'Bad Request: parameter "media" is required'],
      [[], "Bad Request: there are no messages to send"],
      [
        Array.from({ length: 11 }, () => photo),
        "Bad Request: too many messages to send as an album",
      ],
      [
        [photo, { type: "document", media: "attach://one" }],
        "Bad Request: document can't be mixed with other media types",
      ],
      [
        [{ type: "audio", media: "attach://one" }, photo],
        "Bad Request: audio can't be mixed with other media types",
      ],
    ]) {
      expect(
        await upload("sendMediaGroup", {
          chat_id: String(GROUP),
          ...(media ? { media } : {}),
          one: BYTES,
        }),
      ).toMatchObject({ status: 400, description });
    }
    // One item is sent as an ordinary message, outside any album.
    const single = await upload("sendMediaGroup", {
      chat_id: String(GROUP),
      media: [photo],
      one: BYTES,
    });
    expect(single.result).toHaveLength(1);
    expect(single.result[0].photo).toEqual(expect.any(Array));
    expect(single.result[0].media_group_id).toBeUndefined();
  });

  it("sends an album as a reply", async () => {
    const { fake, upload, member } = await setup();
    const asked = await fake.post(GROUP, member, "send the photos");

    const sent = await upload("sendMediaGroup", {
      chat_id: String(GROUP),
      media: [
        { type: "photo", media: "attach://one" },
        { type: "photo", media: "attach://two" },
      ],
      one: BYTES,
      two: BYTES,
      reply_parameters: { message_id: asked },
    });

    expect(
      sent.result.map((message) => message.reply_to_message?.message_id),
    ).toEqual([asked, asked]);
  });
});

describe("administrators and chat settings", () => {
  it("promotes only with can_promote_members, grants only rights the bot has, and demotes", async () => {
    const { fake, api, member, me } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["chat_member"],
    });
    const promote = (rights) =>
      api("promoteChatMember", { chat_id: GROUP, user_id: member, ...rights });

    expect(await promote({ can_delete_messages: true })).toMatchObject({
      status: 400,
      description: "Bad Request: not enough rights",
    });
    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    expect(await promote({ can_manage_video_chats: true })).toMatchObject({
      status: 400,
      description: "Bad Request: RIGHT_FORBIDDEN",
    });
    expect((await promote({ can_delete_messages: true })).result).toBe(true);
    expect(await fake.getMember(GROUP, member)).toMatchObject({
      status: "administrator",
      can_be_edited: true,
      can_delete_messages: true,
      can_manage_chat: true,
      can_pin_messages: false,
    });

    expect(
      (
        await api("setChatAdministratorCustomTitle", {
          chat_id: GROUP,
          user_id: member,
          custom_title: "Helper",
        })
      ).result,
    ).toBe(true);
    expect((await fake.getMember(GROUP, member)).custom_title).toBe("Helper");
    expect(
      await api("setChatAdministratorCustomTitle", {
        chat_id: GROUP,
        user_id: member,
        custom_title: "⭐ Star",
      }),
    ).toMatchObject({ status: 400 });

    await promote({});
    expect((await fake.getMember(GROUP, member)).status).toBe("member");
    await expect
      .poll(() => hook.ofType("chat_member").length)
      .toBeGreaterThanOrEqual(2);
  });

  it("promotes with any one right, including welcome messages and tags", async () => {
    const { fake, api, member, me } = await setup();
    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: {
        can_promote_members: true,
        can_send_welcome_messages: true,
        can_manage_tags: true,
      },
    });
    for (const right of ["can_send_welcome_messages", "can_manage_tags"]) {
      expect(
        (
          await api("promoteChatMember", {
            chat_id: GROUP,
            user_id: member,
            [right]: true,
          })
        ).result,
      ).toBe(true);
      expect(await fake.getMember(GROUP, member)).toMatchObject({
        status: "administrator",
        [right]: true,
      });
    }
  });

  it("gives each kind of chat its own administrator rights, and channel admins can_restrict_members by default", async () => {
    const { fake, api, me } = await setup();
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    const reader = await fake.createUser();
    await fake.join(channel, reader);
    await api("promoteChatMember", {
      chat_id: channel,
      user_id: reader,
      can_post_messages: true,
    });
    const shared = [
      "user",
      "status",
      "can_be_edited",
      "can_manage_chat",
      "can_change_info",
      "can_delete_messages",
      "can_invite_users",
      "can_restrict_members",
      "can_promote_members",
      "can_manage_video_chats",
      "can_post_stories",
      "can_edit_stories",
      "can_delete_stories",
      "can_send_welcome_messages",
      "is_anonymous",
    ];
    const channelAdmin = await fake.getMember(channel, reader);
    expect(channelAdmin).toMatchObject({
      can_post_messages: true,
      can_restrict_members: true,
    });
    expect(Object.keys(channelAdmin).sort()).toEqual(
      [
        ...shared,
        "can_post_messages",
        "can_edit_messages",
        "can_manage_direct_messages",
      ].sort(),
    );
    expect(Object.keys(await fake.getMember(GROUP, me.id)).sort()).toEqual(
      [
        ...shared,
        "can_pin_messages",
        "can_manage_topics",
        "can_manage_tags",
      ].sort(),
    );
  });

  it("cuts a long title or description instead of refusing it, and refuses an empty title", async () => {
    const { api } = await setup();

    for (const title of ["", "   "]) {
      expect(
        await api("setChatTitle", { chat_id: GROUP, title }),
      ).toMatchObject({
        status: 400,
        description: "Bad Request: title must be non-empty",
      });
    }
    expect(
      (
        await api("setChatTitle", {
          chat_id: GROUP,
          title: "  a  b " + "t".repeat(200),
        })
      ).result,
    ).toBe(true);
    expect(
      (
        await api("setChatDescription", {
          chat_id: GROUP,
          description: "d".repeat(300),
        })
      ).result,
    ).toBe(true);
    const chat = (await api("getChat", { chat_id: GROUP })).result;
    expect(chat.title).toBe("a b " + "t".repeat(123));
    expect(chat.description).toBe("d".repeat(255));
    expect(
      await api("setChatDescription", {
        chat_id: GROUP,
        description: "d".repeat(256),
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: chat description is not modified",
    });
  });

  it("changes a chat's title, description and photo with can_change_info", async () => {
    const { fake, api, upload, me } = await setup();
    const hook = await startReceiver();
    const other = await fake.addBot({
      token: "888:OTHER",
      username: "other_bot",
    });
    await fake.setBotMembership(GROUP, other.id, { status: "member" });
    await api("setWebhook", { url: hook.url }, "888:OTHER");

    expect(
      (await api("setChatTitle", { chat_id: GROUP, title: "New Name" })).result,
    ).toBe(true);
    // The same title again succeeds without a second service message.
    expect(
      (await api("setChatTitle", { chat_id: GROUP, title: "New Name" })).result,
    ).toBe(true);
    await api("setChatDescription", { chat_id: GROUP, description: "Rules" });
    await upload("setChatPhoto", { chat_id: String(GROUP), photo: BYTES });

    const chat = (await api("getChat", { chat_id: GROUP })).result;
    expect(chat).toMatchObject({
      title: "New Name",
      description: "Rules",
      photo: { small_file_id: expect.any(String) },
    });
    await expect
      .poll(() =>
        hook
          .ofType("message")
          .map((message) =>
            message.new_chat_title
              ? "title"
              : message.new_chat_photo
                ? "photo"
                : null,
          )
          .filter(Boolean),
      )
      .toEqual(["title", "photo"]);
    expect((await api("deleteChatPhoto", { chat_id: GROUP })).result).toBe(
      true,
    );
    expect(await api("deleteChatPhoto", { chat_id: GROUP })).toMatchObject({
      status: 400,
    });

    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_change_info: false },
    });
    expect(
      await api("setChatTitle", { chat_id: GROUP, title: "Other" }),
    ).toMatchObject({
      description: "Bad Request: not enough rights to change chat title",
    });
    expect(
      await api("setChatDescription", { chat_id: GROUP, description: "x" }),
    ).toMatchObject({
      description: "Bad Request: not enough rights to set chat description",
    });
  });

  it("answers setChatAdministratorCustomTitle with Telegram's errors", async () => {
    const { fake, api, member, me } = await setup();
    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    const title = (userId, custom_title, chat_id = GROUP) =>
      api("setChatAdministratorCustomTitle", {
        chat_id,
        user_id: userId,
        custom_title,
      });

    expect(await title(OWNER, "Boss")).toMatchObject({
      status: 400,
      description: "Bad Request: only the owner can edit their custom title",
    });
    expect(await title(member, "Helper")).toMatchObject({
      status: 400,
      description: "Bad Request: user is not an administrator",
    });
    await api("promoteChatMember", {
      chat_id: GROUP,
      user_id: member,
      can_delete_messages: true,
    });
    expect(await title(member, "⭐ Star")).toMatchObject({
      status: 400,
      description: "Bad Request: CUSTOM_TITLE_EMOJI_NOT_ALLOWED",
    });
    expect(await title(member, "x".repeat(17))).toMatchObject({
      status: 400,
      description: "Bad Request: CUSTOM_TITLE_INVALID",
    });
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    expect(await title(member, "Helper", channel)).toMatchObject({
      status: 400,
      description:
        "Bad Request: method is available only in groups and supergroups",
    });
  });

  it("delivers the service messages of the bot's own chat changes to that bot too", async () => {
    const { api, upload, me } = await setup();

    await api("setChatTitle", { chat_id: GROUP, title: "Renamed" });
    await upload("setChatPhoto", { chat_id: String(GROUP), photo: BYTES });
    await api("deleteChatPhoto", { chat_id: GROUP });

    const kinds = ["new_chat_title", "new_chat_photo", "delete_chat_photo"];
    expect(
      (await api("getUpdates")).result
        .map((update) => update.message)
        .filter((message) => kinds.some((kind) => message?.[kind]))
        .map((message) => [
          message.from.id,
          kinds.find((kind) => message[kind]),
        ]),
    ).toEqual(kinds.map((kind) => [me.id, kind]));
  });

  it("edits the bot's own invite links, except its primary link", async () => {
    const { api } = await setup();
    const primary = (await api("exportChatInviteLink", { chat_id: GROUP }))
      .result;
    expect(
      await api("editChatInviteLink", {
        chat_id: GROUP,
        invite_link: primary,
        name: "Primary",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: CHAT_INVITE_PERMANENT",
    });
    const link = (await api("createChatInviteLink", { chat_id: GROUP })).result
      .invite_link;
    const edited = await api("editChatInviteLink", {
      chat_id: GROUP,
      invite_link: link,
      name: "Spring promo",
      member_limit: 50,
    });
    expect(edited.result).toMatchObject({
      name: "Spring promo",
      member_limit: 50,
    });
    expect(
      await api("editChatInviteLink", {
        chat_id: GROUP,
        invite_link: link,
        creates_join_request: true,
      }),
    ).toMatchObject({ status: 400 });
  });
});

describe("reactions and join request queries", () => {
  it("lets a bot set one reaction, and remove a member's with can_delete_messages", async () => {
    const { fake, api, member } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message_reaction"],
    });
    const id = await fake.post(GROUP, member, "spam");
    await fake.react(GROUP, id, member, "🔥");

    expect(
      await api("setMessageReaction", {
        chat_id: GROUP,
        message_id: id,
        reaction: [
          { type: "emoji", emoji: "👍" },
          { type: "emoji", emoji: "👎" },
        ],
      }),
    ).toMatchObject({ status: 400 });
    await api("setMessageReaction", {
      chat_id: GROUP,
      message_id: id,
      reaction: [{ type: "emoji", emoji: "👀" }],
    });
    await api("deleteMessageReaction", {
      chat_id: GROUP,
      message_id: id,
      user_id: member,
    });

    const state = await fake.getMessage(GROUP, id);
    expect(Object.keys(state.reactions)).toEqual([String(123456)]);
    await expect
      .poll(() => hook.ofType("message_reaction").at(-1)?.new_reaction)
      .toEqual([]);
  });

  it("refuses paid reactions and emoji outside Telegram's reaction list", async () => {
    const { fake, api, member } = await setup();
    const id = await fake.post(GROUP, member, "react to me");
    const react = (reaction) =>
      api("setMessageReaction", { chat_id: GROUP, message_id: id, reaction });

    expect(await react([{ type: "paid" }])).toMatchObject({
      status: 400,
      description:
        "Bad Request: can't parse ReactionType: invalid reaction type specified",
    });
    expect(await react([{ type: "emoji", emoji: "" }])).toMatchObject({
      status: 400,
      description: "Bad Request: invalid reaction type specified",
    });
    expect(await react([{ type: "emoji", emoji: "🦄🦄" }])).toMatchObject({
      status: 400,
      description: "Bad Request: REACTION_INVALID",
    });
    expect((await fake.getMessage(GROUP, id)).reactions).toEqual({});

    expect(await react([{ type: "emoji", emoji: "❤" }])).toMatchObject({
      ok: true,
    });
    expect((await fake.getMessage(GROUP, id)).reactions).toEqual({
      123456: ["❤"],
    });
  });

  it("sets a reaction on an album's first remaining message", async () => {
    const { fake, api, member } = await setup();
    const album = await fake.postAlbum(GROUP, member, [
      { type: "photo", bytes: BYTES },
      { type: "photo", bytes: BYTES },
      { type: "photo", bytes: BYTES },
    ]);
    const [first, second, third] = album.message_ids;
    const reactionsOf = async (id) =>
      (await fake.getMessage(GROUP, id)).reactions;

    await api("setMessageReaction", {
      chat_id: GROUP,
      message_id: third,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    expect(await reactionsOf(first)).toEqual({ 123456: ["👍"] });
    expect(await reactionsOf(third)).toEqual({});

    await api("deleteMessage", { chat_id: GROUP, message_id: first });
    await api("setMessageReaction", {
      chat_id: GROUP,
      message_id: third,
      reaction: [{ type: "emoji", emoji: "🔥" }],
    });
    expect(await reactionsOf(second)).toEqual({ 123456: ["🔥"] });
  });

  it("removes a chat's reaction by actor_chat_id instead of user_id", async () => {
    const { fake, api, member } = await setup();
    const id = await fake.post(GROUP, member, "anonymous admins react too");
    const remove = (params) =>
      api("deleteMessageReaction", { chat_id: GROUP, message_id: id, ...params });

    expect(await remove({ actor_chat_id: GROUP })).toMatchObject({
      ok: true,
      result: true,
    });
    expect(await remove({})).toMatchObject({
      status: 400,
      description: "Bad Request: sender_chat_id is empty",
    });
    expect(await remove({ actor_chat_id: "@channel" })).toMatchObject({
      status: 400,
      description: "Bad Request: sender_chat_id is not a valid Integer",
    });
  });

  it("gives a guard bot join requests as queries it answers", async () => {
    const { fake, api } = await setup();
    const guard = await fake.addBot({
      token: GUARD_TOKEN,
      username: "guard_bot",
      supportsJoinRequestQueries: true,
    });
    await fake.setBotMembership(GROUP, guard.id, { status: "administrator" });
    const guardHook = await startReceiver();
    const plainHook = await startReceiver();
    await api("setWebhook", { url: guardHook.url }, GUARD_TOKEN);
    await api("setWebhook", { url: plainHook.url });
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        creates_join_request: true,
      })
    ).result.invite_link;
    const applicant = await fake.createUser();

    await fake.joinByLink(link, applicant);
    await expect
      .poll(() => guardHook.ofType("chat_join_request").length)
      .toBe(1);
    const [request] = guardHook.ofType("chat_join_request");
    expect(request.query_id).toEqual(expect.any(String));
    await expect
      .poll(() => plainHook.ofType("chat_join_request").length)
      .toBe(1);
    expect(plainHook.ofType("chat_join_request")[0].query_id).toBeUndefined();
    expect((await api("getMe", {}, GUARD_TOKEN)).result).toMatchObject({
      supports_join_request_queries: true,
    });

    expect(
      await api(
        "answerChatJoinRequestQuery",
        { query_id: request.query_id, result: "approve" },
        GUARD_TOKEN,
      ),
    ).toMatchObject({ status: 400 });
    expect(
      (
        await api(
          "answerChatJoinRequestQuery",
          { chat_join_request_query_id: request.query_id, result: "approve" },
          GUARD_TOKEN,
        )
      ).result,
    ).toBe(true);
    expect((await fake.getMember(GROUP, applicant)).status).toBe("member");
  });

  it("lets a bot message a join requester for five minutes, until the request is processed", async () => {
    const fake = await startTestServer({
      botToken: TOKEN,
      chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
      clock: { now: 1_800_000_000_000 },
    });
    cleanups.push(() => fake.stop());
    const api = async (method, params) => {
      const response = await fetch(`${fake.origin}/bot${TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      return { status: response.status, ...(await response.json()) };
    };
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        creates_join_request: true,
      })
    ).result.invite_link;
    const write = (userId) =>
      api("sendMessage", { chat_id: userId, text: "Why do you want to join?" });
    const refused = {
      status: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    };

    const ann = await fake.createUser();
    await fake.joinByLink(link, ann);
    expect((await write(ann)).ok).toBe(true);
    await api("approveChatJoinRequest", { chat_id: GROUP, user_id: ann });
    expect(await write(ann)).toMatchObject(refused);

    const bob = await fake.createUser();
    await fake.joinByLink(link, bob);
    await fake.advanceTime(299_000);
    expect((await write(bob)).ok).toBe(true);
    await fake.advanceTime(1_000);
    expect(await write(bob)).toMatchObject(refused);
    expect(await fake.getDirectMessages(bob)).toHaveLength(1);
  });

  it("reads a join request query's result trimmed and in any case, and checks it first", async () => {
    const { fake, api } = await setup();
    const guard = await fake.addBot({
      token: GUARD_TOKEN,
      username: "guard_bot",
      supportsJoinRequestQueries: true,
    });
    await fake.setBotMembership(GROUP, guard.id, { status: "administrator" });
    const answer = (id, result) =>
      api(
        "answerChatJoinRequestQuery",
        { chat_join_request_query_id: id, result },
        GUARD_TOKEN,
      );
    expect(await answer("1", "maybe")).toMatchObject({
      status: 400,
      description: "Bad Request: invalid query result specified",
    });
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        creates_join_request: true,
      })
    ).result.invite_link;
    const applicant = await fake.createUser();
    await fake.joinByLink(link, applicant);
    const updates = (await api("getUpdates", {}, GUARD_TOKEN)).result;
    const queryId = updates.find((update) => update.chat_join_request)
      .chat_join_request.query_id;

    expect((await answer(queryId, " Approve ")).result).toBe(true);
    expect((await fake.getMember(GROUP, applicant)).status).toBe("member");
  });
});
