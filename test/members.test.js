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
    for (const text of ["", " \n ", "\u200b\u00a0"]) {
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

  it("trims a member's edit, refuses one that empties the text and drops an empty caption", async () => {
    const { fake, member } = await setup();
    const id = await fake.post(GROUP, member, "hello");
    await fake.editMessage(GROUP, id, member, { text: "  hi /help \n" });
    expect((await fake.getMessage(GROUP, id)).message).toMatchObject({
      text: "hi /help",
      entities: [{ type: "bot_command", offset: 3, length: 5 }],
    });
    for (const text of ["", " \n ", "\u200b"]) {
      await expect(
        fake.editMessage(GROUP, id, member, { text }),
      ).rejects.toThrow(/MESSAGE_EMPTY/);
    }
    await expect(
      fake.editMessage(GROUP, id, member, { text: "hi /help " }),
    ).rejects.toThrow(/MESSAGE_NOT_MODIFIED/);
    expect((await fake.getMessage(GROUP, id)).message.text).toBe("hi /help");

    const photo = await fake.post(GROUP, member, {
      photo: BYTES,
      caption: "cap",
    });
    await fake.editMessage(GROUP, photo, member, { caption: " new \n" });
    expect((await fake.getMessage(GROUP, photo)).message.caption).toBe("new");
    await fake.editMessage(GROUP, photo, member, { caption: " \u200b " });
    expect((await fake.getMessage(GROUP, photo)).message).not.toHaveProperty(
      "caption",
    );
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

  it("sends an animation that is also a document", async () => {
    const { upload } = await setup();
    const { animation, document } = (
      await upload("sendAnimation", {
        chat_id: String(GROUP),
        animation: BYTES,
      })
    ).result;

    expect(document).toEqual({
      file_id: animation.file_id,
      file_unique_id: animation.file_unique_id,
      file_size: animation.file_size,
      file_name: animation.file_name,
      mime_type: animation.mime_type,
    });
  });

  it("keeps what the sender says about its media, a contact and a live location", async () => {
    const { api, upload } = await setup();
    const send = async (method, fields) =>
      (await upload(method, { chat_id: String(GROUP), ...fields })).result;

    const { video } = await send("sendVideo", {
      video: BYTES,
      width: "100",
      height: "20000",
      duration: "7",
    });
    expect(video).toMatchObject({ width: 100, height: 10000, duration: 7 });
    expect(
      (await send("sendVideo", { video: video.file_id, width: "1" })).video,
    ).toMatchObject({ width: 100, height: 10000, duration: 7 });
    expect(
      (
        await send("sendAnimation", {
          animation: BYTES,
          width: "100",
          height: "50",
          duration: "9",
        })
      ).animation,
    ).toMatchObject({ width: 100, height: 50, duration: 9 });
    const { video_note: videoNote } = await send("sendVideoNote", {
      video_note: BYTES,
      length: "360",
      duration: "5",
    });
    expect(videoNote).toMatchObject({ length: 360, duration: 5 });
    // TDLib takes a video note at most 640 wide, also one sent again.
    for (const video_note of [BYTES, videoNote.file_id]) {
      expect(
        await upload("sendVideoNote", {
          chat_id: String(GROUP),
          video_note,
          length: "641",
        }),
      ).toMatchObject({
        status: 400,
        description: "Bad Request: wrong video note length",
      });
    }
    expect(
      (
        await send("sendAudio", {
          audio: BYTES,
          performer: "Band",
          title: "Song",
          duration: "120",
        })
      ).audio,
    ).toMatchObject({ performer: "Band", title: "Song", duration: 120 });
    expect(
      (await send("sendSticker", { sticker: BYTES, emoji: "😀" })).sticker,
    ).toMatchObject({ emoji: "😀" });
    const vcard = "BEGIN:VCARD\nVERSION:3.0\nEND:VCARD";
    expect(
      (
        await api("sendContact", {
          chat_id: GROUP,
          phone_number: "+15550100",
          first_name: "Ann",
          vcard,
        })
      ).result.contact,
    ).toEqual({ phone_number: "+15550100", first_name: "Ann", vcard });
    expect(
      (
        await api("sendLocation", {
          chat_id: GROUP,
          latitude: 40.7,
          longitude: -74,
          live_period: 600,
          heading: 90,
          proximity_alert_radius: 100,
        })
      ).result.location,
    ).toEqual({
      latitude: 40.7,
      longitude: -74,
      live_period: 600,
      heading: 90,
      proximity_alert_radius: 100,
    });
  });

  it("refuses a live location off the map, or its period, heading or alert radius out of range", async () => {
    const { api } = await setup();
    const live = (fields) =>
      api("sendLocation", {
        chat_id: GROUP,
        latitude: 40.7,
        longitude: -74,
        live_period: 600,
        ...fields,
      });

    expect(await live({ latitude: 100 })).toMatchObject({
      status: 400,
      description: "Bad Request: invalid live location specified",
    });
    expect(await live({ live_period: 30 })).toMatchObject({
      status: 400,
      description: "Bad Request: wrong live location period specified",
    });
    expect(await live({ heading: 361 })).toMatchObject({
      status: 400,
      description: "Bad Request: wrong live location heading specified",
    });
    expect(await live({ proximity_alert_radius: 100001 })).toMatchObject({
      status: 400,
      description:
        "Bad Request: wrong live location proximity alert radius specified",
    });
  });

  it("gives a photo its image's size, at most Telegram's 2560x2560", async () => {
    const { fake, upload, member } = await setup();
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000002000000030806000000",
      "hex",
    );
    const jpeg = Buffer.from(
      "ffd8ffe000104a46494600010100000100010000ffc00011080bb80fa003012200021101031101ffd9",
      "hex",
    );
    const gif = Buffer.from("4749463839610a0014000000", "hex");
    const sizeOf = (photo) => ({
      width: photo.at(-1).width,
      height: photo.at(-1).height,
    });
    const posted = async (photo) =>
      (await fake.getMessage(GROUP, await fake.post(GROUP, member, { photo })))
        .message.photo;

    expect(
      sizeOf(
        (await upload("sendPhoto", { chat_id: String(GROUP), photo: png }))
          .result.photo,
      ),
    ).toEqual({ width: 2, height: 3 });
    expect(sizeOf(await posted(jpeg))).toEqual({ width: 2560, height: 1920 });
    expect(sizeOf(await posted(gif))).toEqual({ width: 10, height: 20 });
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
      [
        [photo, { type: "photo", media: "attach://missing" }],
        "Bad Request: can't parse InputMedia: media not found",
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

  it("refuses album items with the Bot API's InputMedia errors before it looks at the chat", async () => {
    const { upload } = await setup();
    const unreadable = (reason) => ({
      status: 400,
      description: `Bad Request: can't parse InputMedia: ${reason}`,
    });
    const photo = { type: "photo", media: "attach://one" };
    const album = (chatId, item) =>
      upload("sendMediaGroup", {
        chat_id: String(chatId),
        media: [photo, item],
        one: BYTES,
      });

    for (const [item, reason] of [
      [
        { type: "sticker", media: "attach://one" },
        'type "sticker" is unsupported',
      ],
      [
        { type: "animation", media: "attach://one" },
        `type "animation" can't be used in sendMediaGroup`,
      ],
      [
        { type: "voice_note", media: "attach://one" },
        'type "voice_note" is not allowed',
      ],
      [{ type: "live_photo", media: "attach://one" }, "Photo not found"],
      [{ type: "sticker", media: "attach://missing" }, "media not found"],
    ]) {
      expect(await album(GROUP, item)).toMatchObject(unreadable(reason));
      expect(await album(42, item)).toMatchObject(unreadable(reason));
    }
  });

  it("sends a live photo in an album", async () => {
    const { upload } = await setup();
    const sent = await upload("sendMediaGroup", {
      chat_id: String(GROUP),
      media: [
        {
          type: "live_photo",
          media: "attach://motion",
          photo: "attach://still",
        },
        { type: "photo", media: "attach://still" },
      ],
      motion: BYTES,
      still: BYTES,
    });

    expect(sent.result).toHaveLength(2);
    const [live, photo] = sent.result;
    expect(live.media_group_id).toBe(photo.media_group_id);
    expect(live.live_photo).toMatchObject({
      photo: live.photo,
      file_id: expect.any(String),
    });
    expect(photo.photo).toEqual(expect.any(Array));
  });

  it("sends an album as a reply, read before its media and checked before its files", async () => {
    const { fake, api, upload, member } = await setup();
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

    expect(
      await api("sendMediaGroup", {
        chat_id: GROUP,
        media: "not json",
        reply_parameters: "{bad",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: can't parse reply parameters JSON object",
    });
    const unknown = { type: "photo", media: "not-a-file-id" };
    expect(
      await api("sendMediaGroup", {
        chat_id: GROUP,
        media: [unknown, unknown],
        reply_parameters: { message_id: 999999 },
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message to be replied not found",
    });
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

  it("drops rights the kind of chat does not have before checking and granting them", async () => {
    const { fake, api, member, me } = await setup();
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    for (const chat of [GROUP, channel]) {
      await fake.setBotMembership(chat, me.id, {
        status: "administrator",
        rights: { can_promote_members: true },
      });
    }
    const reader = await fake.createUser();
    await fake.join(channel, reader);

    expect(
      await api("promoteChatMember", {
        chat_id: GROUP,
        user_id: member,
        can_manage_direct_messages: true,
      }),
    ).toMatchObject({ ok: true });
    expect((await fake.getMember(GROUP, member)).status).toBe("member");
    // The channel default can_restrict_members still follows the request.
    expect(
      await api("promoteChatMember", {
        chat_id: channel,
        user_id: reader,
        can_manage_tags: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await fake.getMember(channel, reader)).toMatchObject({
      status: "administrator",
      can_restrict_members: true,
    });
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

  it("cleans a title and description as TDLib does, and refuses a title of blank characters", async () => {
    const { api } = await setup();
    const chat = async () => (await api("getChat", { chat_id: GROUP })).result;

    expect(
      await api("setChatTitle", { chat_id: GROUP, title: "\u2800\u3000" }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: title must be non-empty",
    });
    // A blank such as U+2800 becomes a space; U+2028 is dropped.
    await api("setChatTitle", { chat_id: GROUP, title: "a\u2800b\u2028c" });
    expect((await chat()).title).toBe("a bc");
    // Only ASCII spaces are trimmed from a description.
    await api("setChatDescription", {
      chat_id: GROUP,
      description: " a\u2003b\u00a0",
    });
    expect((await chat()).description).toBe("a b\u00a0");
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
    expect(
      await api("editChatInviteLink", { chat_id: GROUP, name: "No link" }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: invite link must be non-empty",
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
        member_limit: 50,
        creates_join_request: true,
      }),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: member limit can't be specified for links requiring administrator approval",
    });
  });

  it("sets every field of an edited link, and the ones left out to their defaults", async () => {
    const { api } = await setup();
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        name: "One-shot",
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 3600,
      })
    ).result.invite_link;
    const edit = async (fields) =>
      (
        await api("editChatInviteLink", {
          chat_id: GROUP,
          invite_link: link,
          ...fields,
        })
      ).result;
    const plain = {
      invite_link: link,
      creator: expect.any(Object),
      creates_join_request: false,
      is_primary: false,
      is_revoked: false,
    };

    expect(await edit({ name: "Renamed" })).toEqual({
      ...plain,
      name: "Renamed",
    });
    expect(await edit({ creates_join_request: true })).toEqual({
      ...plain,
      creates_join_request: true,
    });
    expect(
      await edit({ member_limit: 100001, creates_join_request: false }),
    ).toEqual({ ...plain, member_limit: 100000 });
    expect(await edit({ member_limit: 0, expire_date: 0 })).toEqual(plain);
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
    // TDLib reads "$" as the paid reaction and "#…" as a custom emoji.
    for (const emoji of ["", "$", "#1"]) {
      expect(await react([{ type: "emoji", emoji }])).toMatchObject({
        status: 400,
        description: "Bad Request: invalid reaction type specified",
      });
    }
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
    const { fake, api, member, me } = await setup();
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
    // The id must read back exactly as a 64-bit integer.
    for (const actor of ["@channel", "007", "-0", "99999999999999999999"]) {
      expect(await remove({ actor_chat_id: actor })).toMatchObject({
        status: 400,
        description: "Bad Request: sender_chat_id is not a valid Integer",
      });
    }
    expect(await remove({ actor_chat_id: 0 })).toMatchObject({
      status: 400,
      description: "Bad Request: invalid chat identifier specified",
    });
    expect(await remove({ actor_chat_id: -1009999999999 })).toMatchObject({
      status: 400,
      description: "Bad Request: reaction sender not found",
    });
    // A user's id names the user, whose reaction goes.
    await fake.react(GROUP, id, member, "👍");
    expect(await remove({ actor_chat_id: member })).toMatchObject({
      ok: true,
    });
    expect((await fake.getMessage(GROUP, id)).reactions).toEqual({});

    // The ids are read before Telegram checks the bot's rights.
    await fake.setBotMembership(GROUP, me.id, { status: "member" });
    expect(await remove({})).toMatchObject({
      status: 400,
      description: "Bad Request: sender_chat_id is empty",
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

    const carol = await fake.createUser();
    await fake.joinByLink(link, carol);
    expect(
      (
        await api("sendPoll", {
          chat_id: carol,
          question: "Why do you want to join?",
          options: [{ text: "To learn" }, { text: "To help" }],
        })
      ).ok,
    ).toBe(true);
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

describe("direct messages", () => {
  it("delivers a member's photo, file, reply and forward to the bot privately", async () => {
    const { fake, api, member } = await setup();
    await fake.sendDirectMessage(member, "/start");
    const prompt = (
      await api("sendMessage", { chat_id: member, text: "Send a receipt" })
    ).result;

    const photo = await fake.sendDirectMessage(member, {
      photo: BYTES,
      caption: "receipt",
      replyTo: prompt.message_id,
    });
    const file = await fake.sendDirectMessage(member, {
      media: { type: "document", bytes: BYTES, fileName: "receipt.pdf" },
    });
    const source = await fake.createUser({ first_name: "Source" });
    const forward = await fake.sendDirectMessage(member, {
      text: "look",
      forwardFrom: { userId: source },
    });
    const messages = await fake.getDirectMessages(member);
    const byId = (id) => messages.find((message) => message.message_id === id);

    expect(byId(photo)).toMatchObject({
      chat: { id: member, type: "private" },
      photo: expect.arrayContaining([
        expect.objectContaining({ file_id: expect.any(String) }),
      ]),
      caption: "receipt",
      reply_to_message: {
        message_id: prompt.message_id,
        text: "Send a receipt",
      },
    });
    expect(byId(file)).toMatchObject({
      document: { file_name: "receipt.pdf" },
    });
    expect(byId(forward)).toMatchObject({
      text: "look",
      forward_origin: { type: "user", sender_user: { id: source } },
    });
    const updates = (await api("getUpdates")).result.map((u) => u.message);
    expect(updates.map((message) => message?.message_id)).toEqual(
      expect.arrayContaining([photo, file, forward]),
    );
  });
});

describe("posts on behalf of a chat", () => {
  // The users the Bot API names as `from` of a message sent on behalf of a
  // chat in a group (TDLib UserManager.cpp).
  const GROUP_ANONYMOUS_BOT = {
    id: 1087968824,
    is_bot: true,
    first_name: "Group",
    username: "GroupAnonymousBot",
  };
  const CHANNEL_BOT = {
    id: 136817688,
    is_bot: true,
    first_name: "Channel",
    username: "Channel_Bot",
  };

  it("posts an anonymous administrator's message as the group, which bots get, forward and delete", async () => {
    const { fake, api, member, me } = await setup();
    await fake.setBotMembership(GROUP, me.id, {
      rights: { can_promote_members: true },
    });
    // An administrator without is_anonymous still posts as themselves.
    await api("promoteChatMember", {
      chat_id: GROUP,
      user_id: member,
      can_pin_messages: true,
    });
    const own = await fake.post(GROUP, member, "Mine");
    const signed = (await fake.getMessage(GROUP, own)).message;
    expect(signed.from.id).toBe(member);
    expect(signed).not.toHaveProperty("sender_chat");
    expect(signed).not.toHaveProperty("author_signature");
    await api("promoteChatMember", {
      chat_id: GROUP,
      user_id: member,
      is_anonymous: true,
      can_pin_messages: true,
    });
    await api("setChatAdministratorCustomTitle", {
      chat_id: GROUP,
      user_id: member,
      custom_title: "Mod",
    });

    const id = await fake.post(GROUP, member, "Read the rules");
    const { message } = await fake.getMessage(GROUP, id);
    expect(Object.keys(message).slice(0, 6)).toEqual([
      "message_id",
      "from",
      "author_signature",
      "sender_chat",
      "chat",
      "date",
    ]);
    expect(message).toMatchObject({
      from: GROUP_ANONYMOUS_BOT,
      author_signature: "Mod",
      sender_chat: { id: GROUP, title: "Test Group", type: "supergroup" },
      text: "Read the rules",
    });
    expect(message.from).toEqual(GROUP_ANONYMOUS_BOT);
    const delivered = (await api("getUpdates")).result
      .map((update) => update.message)
      .find((sent) => sent?.message_id === id);
    expect(delivered).toEqual(message);
    // A wait still finds it by the person who posted it.
    await fake.waitFor({
      kind: "message",
      chatId: GROUP,
      userId: member,
      text: "Read the rules",
    });
    // Naming the group itself is the same as posting anonymously.
    const named = await fake.post(GROUP, member, {
      text: "again",
      sendAs: GROUP,
    });
    expect((await fake.getMessage(GROUP, named)).message).toMatchObject({
      from: GROUP_ANONYMOUS_BOT,
      sender_chat: { id: GROUP },
    });
    // TDLib offers an anonymous administrator the group, not themselves.
    await expect(
      fake.post(GROUP, member, { text: "as me", sendAs: member }),
    ).rejects.toThrow(/^SEND_AS_PEER_INVALID$/);

    const forward = await api("forwardMessage", {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: id,
    });
    expect(forward.result.forward_origin).toEqual({
      type: "chat",
      sender_chat: { id: GROUP, title: "Test Group", type: "supergroup" },
      author_signature: "Mod",
      date: message.date,
    });
    // The bot's forward and copy are its own messages: the signature stays
    // in forward_origin only.
    expect(forward.result).not.toHaveProperty("author_signature");
    const copy = await api("copyMessage", {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: id,
    });
    expect(
      (await fake.getMessage(GROUP, copy.result.message_id)).message,
    ).not.toHaveProperty("author_signature");
    expect(
      (await api("deleteMessage", { chat_id: GROUP, message_id: id })).result,
    ).toBe(true);
    expect((await fake.getMessage(GROUP, id)).deleted).toBe(true);
  });

  it("posts as a channel a Premium member created, and refuses any other chat to send as", async () => {
    const { fake, api, member } = await setup();
    const star = await fake.createUser({ first_name: "Star", is_premium: true });
    await fake.join(GROUP, star);
    const channel = await fake.createChat({
      type: "channel",
      title: "Member News",
      ownerId: star,
    });

    const id = await fake.post(GROUP, star, {
      text: "Follow us",
      sendAs: channel,
    });
    const { message } = await fake.getMessage(GROUP, id);
    expect(message.from).toEqual(CHANNEL_BOT);
    expect(message.sender_chat).toEqual({
      id: channel,
      title: "Member News",
      type: "channel",
    });
    expect(message).not.toHaveProperty("author_signature");
    const forward = await api("forwardMessage", {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: id,
    });
    expect(forward.result.forward_origin).toEqual({
      type: "chat",
      sender_chat: { id: channel, title: "Member News", type: "channel" },
      date: message.date,
    });
    expect(
      (await api("deleteMessage", { chat_id: GROUP, message_id: id })).result,
    ).toBe(true);

    const others = await fake.createChat({ type: "channel", ownerId: OWNER });
    const basic = await fake.createChat({ type: "group", ownerId: star });
    const before = await fake.getMessages(GROUP);
    for (const [chatId, sendAs] of [
      [GROUP, others],
      [GROUP, GROUP],
      [GROUP, member],
      [basic, channel],
    ]) {
      await expect(
        fake.post(chatId, star, { text: "as someone", sendAs }),
      ).rejects.toThrow(/^SEND_AS_PEER_INVALID$/);
    }
    await expect(
      fake.sendDirectMessage(star, { text: "hi", sendAs: channel }),
    ).rejects.toThrow(/^SEND_AS_PEER_INVALID$/);
    // Without Premium, a group's member can't post as their own channel.
    const own = await fake.createChat({ type: "channel", ownerId: member });
    await expect(
      fake.post(GROUP, member, { text: "as mine", sendAs: own }),
    ).rejects.toThrow(/^PREMIUM_ACCOUNT_REQUIRED$/);
    expect(await fake.getMessages(GROUP)).toEqual(before);
    // Naming themselves, a member posts as themselves.
    const self = await fake.post(GROUP, member, { text: "me", sendAs: member });
    const plain = (await fake.getMessage(GROUP, self)).message;
    expect(plain.from.id).toBe(member);
    expect(plain).not.toHaveProperty("sender_chat");
  });

  it("forwards a post made on behalf of a supergroup, and a signed channel post", async () => {
    const { fake, member } = await setup();
    const other = await fake.createChat({
      title: "Other Group",
      ownerId: OWNER,
    });
    const basic = await fake.createChat({
      type: "group",
      title: "Small Group",
      ownerId: OWNER,
    });
    const channel = await fake.createChat({
      type: "channel",
      title: "News",
      ownerId: OWNER,
    });
    const read = async (forwardFrom) =>
      (
        await fake.getMessage(
          GROUP,
          await fake.post(GROUP, member, { text: "fwd", forwardFrom }),
        )
      ).message.forward_origin;

    expect(await read({ chatId: other, authorSignature: "Admin" })).toEqual({
      type: "chat",
      sender_chat: { id: other, title: "Other Group", type: "supergroup" },
      author_signature: "Admin",
      date: expect.any(Number),
    });
    expect(
      await read({ chatId: channel, messageId: 7, authorSignature: "Editor" }),
    ).toEqual({
      type: "channel",
      chat: { id: channel, title: "News", type: "channel" },
      message_id: 7,
      author_signature: "Editor",
      date: expect.any(Number),
    });
    // Only a supergroup's administrators post on its behalf; TDLib refuses
    // any other chat but a channel in a forward header.
    await expect(
      fake.post(GROUP, member, { text: "fwd", forwardFrom: { chatId: basic } }),
    ).rejects.toThrow(/^forward_from\.chat_id must be a channel or supergroup$/);
    await expect(
      fake.post(GROUP, member, {
        text: "fwd",
        forwardFrom: { chatId: other, messageId: 1 },
      }),
    ).rejects.toThrow(/message_id/);
    await expect(
      fake.post(GROUP, member, {
        text: "fwd",
        forwardFrom: { userId: member, authorSignature: "Admin" },
      }),
    ).rejects.toThrow(/author_signature/);
  });
});

describe("contacts and locations", () => {
  it("delivers a member's contact and location, in a group and privately", async () => {
    const { fake, api, member } = await setup();
    const contact = await fake.post(GROUP, member, {
      contact: {
        phoneNumber: "+15550100",
        firstName: "Ann",
        lastName: "Lee",
        vcard: "BEGIN:VCARD\nEND:VCARD",
        userId: member,
      },
    });
    const place = await fake.post(GROUP, member, {
      location: { latitude: 51.5, longitude: -0.12, horizontalAccuracy: 20.5 },
    });
    const live = await fake.post(GROUP, member, {
      location: {
        latitude: 1.5,
        longitude: 2.5,
        livePeriod: 900,
        heading: 90,
        proximityAlertRadius: 100,
        horizontalAccuracy: 3000,
      },
      replyTo: place,
    });
    const read = async (id) => (await fake.getMessage(GROUP, id)).message;

    const shared = await read(contact);
    expect(shared.contact).toEqual({
      phone_number: "+15550100",
      first_name: "Ann",
      last_name: "Lee",
      vcard: "BEGIN:VCARD\nEND:VCARD",
      user_id: member,
    });
    expect(Object.keys(shared.contact)).toEqual([
      "phone_number",
      "first_name",
      "last_name",
      "vcard",
      "user_id",
    ]);
    // Telegram keeps the accuracy in whole meters, rounded up.
    expect((await read(place)).location).toEqual({
      latitude: 51.5,
      longitude: -0.12,
      horizontal_accuracy: 21,
    });
    const moving = await read(live);
    expect(moving.location).toEqual({
      latitude: 1.5,
      longitude: 2.5,
      live_period: 900,
      heading: 90,
      proximity_alert_radius: 100,
      horizontal_accuracy: 1500,
    });
    expect(moving.reply_to_message.message_id).toBe(place);

    const direct = await fake.sendDirectMessage(member, {
      contact: { phoneNumber: "+15550101", firstName: "Bo" },
    });
    expect(
      (await fake.getDirectMessages(member)).find(
        (message) => message.message_id === direct,
      ).contact,
    ).toEqual({ phone_number: "+15550101", first_name: "Bo" });
    const updates = (await api("getUpdates")).result.map(
      (update) => update.message,
    );
    expect(
      updates
        .filter((message) => message.contact || message.location)
        .map((message) => message.message_id),
    ).toEqual([contact, place, live, direct]);
  });

  it("refuses contacts and locations as Telegram's app does", async () => {
    const { fake, api, member } = await setup();
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: member,
      use_independent_chat_permissions: true,
      permissions: { can_send_messages: false, can_send_photos: true },
    });
    const contact = { phoneNumber: "+15550100", firstName: "Ann" };
    for (const message of [
      { contact },
      { location: { latitude: 1, longitude: 2 } },
    ]) {
      await expect(fake.post(GROUP, member, message)).rejects.toThrow(
        /^CHAT_WRITE_FORBIDDEN$/,
      );
    }
    await fake.post(GROUP, member, { photo: BYTES });

    const other = await fake.createUser();
    await fake.join(GROUP, other);
    const refusals = [
      [
        { location: { latitude: 91, longitude: 0 } },
        "Invalid location specified",
      ],
      [
        { location: { latitude: 0, longitude: 181, livePeriod: 60 } },
        "Invalid live location specified",
      ],
      [
        { location: { latitude: 0, longitude: 0, livePeriod: 30 } },
        "Wrong live location period specified",
      ],
      [
        {
          location: { latitude: 0, longitude: 0, livePeriod: 60, heading: 361 },
        },
        "Wrong live location heading specified",
      ],
      [
        {
          location: {
            latitude: 0,
            longitude: 0,
            livePeriod: 60,
            proximityAlertRadius: 100001,
          },
        },
        "Wrong live location proximity alert radius specified",
      ],
      [{ contact: { ...contact, userId: 999999999 } }, "User not found"],
      [
        { contact: { phoneNumber: "+15550100" } },
        "a contact needs phone_number and first_name",
      ],
      [
        { location: { longitude: 0 } },
        "a location needs latitude and longitude",
      ],
      [
        { location: { latitude: "1", longitude: 2 } },
        "location.latitude must be a number",
      ],
    ];
    for (const [message, error] of refusals) {
      await expect(fake.post(GROUP, other, message)).rejects.toThrow(
        new RegExp(`^${error}$`),
      );
    }
    await expect(
      fake.post(GROUP, other, { text: "and", contact }),
    ).rejects.toThrow(/one kind of content/);
    // A permanent live location.
    const forever = await fake.post(GROUP, other, {
      location: { latitude: 0, longitude: 0, livePeriod: 0x7fffffff },
    });
    expect(
      (await fake.getMessage(GROUP, forever)).message.location.live_period,
    ).toBe(0x7fffffff);
    // They need can_send_messages, not can_send_other_messages.
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: other,
      use_independent_chat_permissions: true,
      permissions: { can_send_messages: true, can_send_other_messages: false },
    });
    await fake.post(GROUP, other, { contact });
  });
});

describe("entities members give", () => {
  it("keeps the entities a member's app sends and the phone numbers the test marks", async () => {
    const { fake, member, me } = await setup();
    const text =
      "Call +1 212 555 0123, read this or see example.com, ask @xavier";
    const id = await fake.post(GROUP, member, {
      text,
      entities: [
        { type: "phone_number", offset: 5, length: 15 },
        { type: "text_link", offset: 27, length: 4, url: "Promo.EXAMPLE/x y" },
        { type: "bold", offset: 0, length: 4 },
        // Telegram finds these by itself, so a given one is ignored.
        { type: "url", offset: 0, length: 4 },
        { type: "mention", offset: 5, length: 3 },
      ],
    });
    const { message } = await fake.getMessage(GROUP, id);
    expect(message.text).toBe(text);
    expect(message.entities).toEqual([
      { type: "bold", offset: 0, length: 4 },
      { type: "phone_number", offset: 5, length: 15 },
      {
        type: "text_link",
        offset: 27,
        length: 4,
        url: "http://promo.example/x%20y",
      },
      { type: "url", offset: 39, length: 11 },
      { type: "mention", offset: 56, length: 7 },
    ]);

    const mention = await fake.post(GROUP, member, {
      text: "hi friend",
      entities: [
        {
          type: "text_link",
          offset: 3,
          length: 6,
          url: `tg://user?id=${me.id}`,
        },
        {
          type: "text_link",
          offset: 0,
          length: 2,
          url: "tg://resolve?domain=x",
        },
      ],
    });
    expect((await fake.getMessage(GROUP, mention)).message.entities).toEqual([
      { type: "text_link", offset: 0, length: 2, url: "tg://resolve?domain=x" },
      {
        type: "text_mention",
        offset: 3,
        length: 6,
        user: {
          id: me.id,
          is_bot: true,
          first_name: me.first_name,
          username: me.username,
        },
      },
    ]);

    const photo = await fake.post(GROUP, member, {
      photo: BYTES,
      caption: "  call +44 20 7946 0958",
      captionEntities: [{ type: "phone_number", offset: 7, length: 16 }],
    });
    expect((await fake.getMessage(GROUP, photo)).message).toMatchObject({
      caption: "call +44 20 7946 0958",
      caption_entities: [{ type: "phone_number", offset: 5, length: 16 }],
    });
    const direct = await fake.sendDirectMessage(member, {
      text: "my number +1 555 0100",
      entities: [{ type: "phone_number", offset: 10, length: 11 }],
    });
    expect(
      (await fake.getDirectMessages(member)).find(
        (sent) => sent.message_id === direct,
      ).entities,
    ).toEqual([{ type: "phone_number", offset: 10, length: 11 }]);
    // Bank card numbers are kept as phone numbers are, a pre keeps its
    // language, and each entity only its own fields.
    const card = await fake.post(GROUP, member, {
      text: "card 4111 1111 1111 1111 and code",
      entities: [
        { type: "bank_card_number", offset: 5, length: 19 },
        { type: "pre", offset: 29, length: 4, language: "js" },
        { type: "italic", offset: 0, length: 4, url: "http://a.com" },
      ],
    });
    expect((await fake.getMessage(GROUP, card)).message.entities).toEqual([
      { type: "italic", offset: 0, length: 4 },
      { type: "bank_card_number", offset: 5, length: 19 },
      { type: "pre", offset: 29, length: 4, language: "js" },
    ]);
  });

  it("refuses entities Telegram refuses", async () => {
    const { fake, member } = await setup();
    const refusals = [
      [
        [{ type: "text_link", offset: 0, length: 2, url: "nodot" }],
        "Entity URL 'nodot' is invalid: Wrong HTTP URL",
      ],
      [
        [{ type: "text_link", offset: 0, length: 2, url: "ftp://a.com" }],
        "Entity URL 'ftp://a.com' is invalid: Unsupported URL protocol",
      ],
      [
        [{ type: "text_link", offset: 0, length: 2, url: "tg:http://a.com" }],
        "Entity URL 'tg:http://a.com' is invalid: Wrong tg URL",
      ],
      [
        [{ type: "text_link", offset: 0, length: 2 }],
        `can't parse MessageEntity: Can't find field "url"`,
      ],
      [
        [
          {
            type: "text_mention",
            offset: 0,
            length: 2,
            user: { id: 999999999 },
          },
        ],
        "User not found",
      ],
      [
        [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "0" }],
        "Invalid custom emoji identifier specified",
      ],
      [
        [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "x" }],
        `can't parse MessageEntity: Field "custom_emoji_id" must be a valid Number`,
      ],
      [
        [{ type: "phone_number", offset: 3, length: 5 }],
        "Entity beginning at UTF-16 offset 3 ends after the end of the text at UTF-16 offset 8",
      ],
      [
        [{ type: "sparkle", offset: 0, length: 2 }],
        "can't parse MessageEntity: Unsupported type specified",
      ],
    ];
    for (const [entities, error] of refusals) {
      await expect(
        fake.post(GROUP, member, { text: "hello", entities }),
      ).rejects.toHaveProperty("message", error);
    }
    await expect(
      fake.post(GROUP, member, { text: "hello", entities: "bold" }),
    ).rejects.toHaveProperty(
      "message",
      "entities must be a list of MessageEntity objects",
    );
  });
});

describe("files members post again", () => {
  it("posts an earlier file again with its file_unique_id, while a new upload is a new file", async () => {
    const { fake, api, upload, member } = await setup();
    const other = await fake.createUser();
    await fake.join(GROUP, other);
    const first = await fake.post(GROUP, member, { photo: BYTES });
    const [photo] = (await fake.getMessage(GROUP, first)).message.photo;

    const again = await fake.post(GROUP, other, {
      fileId: photo.file_id,
      caption: "seen this?",
    });
    expect((await fake.getMessage(GROUP, again)).message).toMatchObject({
      photo: [photo],
      caption: "seen this?",
    });
    const fresh = await fake.post(GROUP, member, { photo: BYTES });
    expect(
      (await fake.getMessage(GROUP, fresh)).message.photo[0].file_unique_id,
    ).not.toBe(photo.file_unique_id);

    // A file the bot sent keeps its name and kind when a member posts it.
    const sent = await upload("sendDocument", {
      chat_id: String(GROUP),
      document: Buffer.from("%PDF"),
    });
    const document = sent.result.document;
    const reposted = await fake.post(GROUP, other, {
      fileId: document.file_id,
    });
    expect((await fake.getMessage(GROUP, reposted)).message.document).toEqual(
      document,
    );
    const direct = await fake.sendDirectMessage(member, {
      fileId: document.file_id,
    });
    expect(
      (await fake.getDirectMessages(member)).find(
        (message) => message.message_id === direct,
      ).document.file_unique_id,
    ).toBe(document.file_unique_id);
    const file = await api("getFile", { file_id: document.file_id });
    expect(file.result.file_unique_id).toBe(document.file_unique_id);

    // A live photo's video goes again as a video.
    const [live] = (
      await upload("sendMediaGroup", {
        chat_id: String(GROUP),
        media: [
          {
            type: "live_photo",
            media: "attach://motion",
            photo: "attach://still",
          },
        ],
        motion: Buffer.from("motion"),
        still: BYTES,
      })
    ).result;
    const moving = await fake.post(GROUP, other, {
      fileId: live.live_photo.file_id,
    });
    const video = (await fake.getMessage(GROUP, moving)).message;
    expect(video.video.file_unique_id).toBe(live.live_photo.file_unique_id);
    expect(video).not.toHaveProperty("live_photo");
  });

  it("refuses an unknown file, and needs the permission for the file's kind", async () => {
    const { fake, api, upload, member } = await setup();
    const other = await fake.createUser();
    await fake.join(GROUP, other);
    const first = await fake.post(GROUP, other, { photo: BYTES });
    const [photo] = (await fake.getMessage(GROUP, first)).message.photo;
    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: member,
      use_independent_chat_permissions: true,
      permissions: { can_send_messages: true, can_send_photos: false },
    });

    await expect(
      fake.post(GROUP, member, { fileId: photo.file_id }),
    ).rejects.toThrow(/^CHAT_WRITE_FORBIDDEN$/);
    await expect(
      fake.post(GROUP, other, { fileId: "no-such-file" }),
    ).rejects.toThrow(/file_id/);
    await expect(
      fake.post(GROUP, other, { fileId: photo.file_id, text: "and text" }),
    ).rejects.toThrow(/one kind of content/);
    // A chat photo is no message's file.
    await upload("setChatPhoto", { chat_id: String(GROUP), photo: BYTES });
    const chat = (await api("getChat", { chat_id: GROUP })).result;
    await expect(
      fake.post(GROUP, other, { fileId: chat.photo.small_file_id }),
    ).rejects.toThrow(/^file_id names a chat photo, which no message carries$/);
  });
});

describe("control routes for what members post", () => {
  it("takes the new message fields in snake_case over HTTP", async () => {
    const { fake, member } = await setup();
    const control = async (path, body) => {
      const response = await fetch(`${fake.origin}/_fake/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, ...(await response.json()) };
    };
    const star = await fake.createUser({ is_premium: true });
    await fake.join(GROUP, star);
    const channel = await fake.createChat({ type: "channel", ownerId: star });
    const other = await fake.createChat({ ownerId: OWNER, title: "Other" });
    const photo = await fake.post(GROUP, member, { photo: BYTES });
    const [{ file_id }] = (await fake.getMessage(GROUP, photo)).message.photo;

    const posts = [
      { user_id: star, text: "as channel", send_as: channel },
      {
        text: "fwd",
        forward_from: { chat_id: other, author_signature: "Admin" },
      },
      {
        contact: {
          phone_number: "+15550100",
          first_name: "Ann",
          user_id: member,
        },
      },
      {
        location: {
          latitude: 1,
          longitude: 2,
          live_period: 60,
          heading: 5,
          proximity_alert_radius: 10,
          horizontal_accuracy: 1,
        },
      },
      {
        text: "call +1 555 0100",
        entities: [{ type: "phone_number", offset: 5, length: 11 }],
      },
      {
        file_id,
        caption: "+1 555 0100",
        caption_entities: [{ type: "phone_number", offset: 0, length: 11 }],
      },
    ];
    const ids = [];
    for (const body of posts) {
      const answer = await control(`chats/${GROUP}/messages`, {
        user_id: member,
        ...body,
      });
      expect(answer.status).toBe(200);
      ids.push(answer.message_id);
    }
    const messages = await Promise.all(
      ids.map(async (id) => (await fake.getMessage(GROUP, id)).message),
    );
    expect(messages[0].sender_chat.id).toBe(channel);
    expect(messages[1].forward_origin).toMatchObject({
      type: "chat",
      author_signature: "Admin",
    });
    expect(messages[2].contact.user_id).toBe(member);
    expect(messages[3].location).toEqual({
      latitude: 1,
      longitude: 2,
      live_period: 60,
      heading: 5,
      proximity_alert_radius: 10,
      horizontal_accuracy: 1,
    });
    expect(messages[4].entities).toEqual([
      { type: "phone_number", offset: 5, length: 11 },
    ]);
    expect(messages[5]).toMatchObject({
      photo: [{ file_id }],
      caption_entities: [{ type: "phone_number", offset: 0, length: 11 }],
    });
    const direct = await control(`users/${member}/dm`, {
      location: { latitude: 3, longitude: 4 },
    });
    expect(direct.status).toBe(200);
    expect(
      (await fake.getDirectMessages(member)).find(
        (message) => message.message_id === direct.message_id,
      ).location,
    ).toEqual({ latitude: 3, longitude: 4 });
    const own = await fake.createChat({ type: "channel", ownerId: member });
    expect(
      await control(`chats/${GROUP}/messages`, {
        user_id: member,
        text: "as mine",
        send_as: own,
      }),
    ).toEqual({ status: 403, error: "PREMIUM_ACCOUNT_REQUIRED" });
  });
});
