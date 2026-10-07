import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST-TOKEN";
const OTHER_TOKEN = "654321:OTHER-TOKEN";
const OWNER = 5000000001;
const PHOTO = Buffer.from("fake-chat-photo");

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A webhook endpoint that records every update in order. */
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
    updates,
    kinds: () =>
      updates.map((update) =>
        Object.keys(update).find((k) => k !== "update_id"),
      ),
    ofType: (type) => updates.map((update) => update[type]).filter(Boolean),
  };
}

async function setup() {
  const fake = await startTestServer({
    botToken: TOKEN,
    botUsername: "modbot",
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
  const hook = await startReceiver();
  await api("setWebhook", {
    url: hook.url,
    allowed_updates: ["message", "my_chat_member", "chat_member"],
  });
  const me = (await api("getMe")).result;
  return { fake, api, hook, me };
}

describe("adding the bot through a startgroup link", () => {
  it("sends my_chat_member, the service message, then /start with the parameter", async () => {
    const { fake, hook, me } = await setup();
    const group = await fake.createChat({ title: "Shop", ownerId: OWNER });

    await fake.addBotViaLink(group, me.id, {
      by: OWNER,
      startParameter: "ws_abc123",
    });

    await expect
      .poll(() => hook.kinds())
      .toEqual(["my_chat_member", "message", "message"]);
    const [change] = hook.ofType("my_chat_member");
    expect(change).toMatchObject({
      from: { id: OWNER },
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member", user: { id: me.id } },
    });
    const [service, start] = hook.ofType("message");
    expect(service.new_chat_members).toEqual([
      expect.objectContaining({ id: me.id }),
    ]);
    expect(start).toMatchObject({
      from: { id: OWNER },
      text: "/start@modbot ws_abc123",
      entities: [{ type: "bot_command", offset: 0, length: 13 }],
    });
  });

  it("tells the chat's other bots through chat_member", async () => {
    const { fake, api, me } = await setup();
    const other = await fake.addBot({ token: OTHER_TOKEN, username: "other" });
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, other.id, { status: "administrator" });
    const otherHook = await startReceiver();
    await api(
      "setWebhook",
      { url: otherHook.url, allowed_updates: ["chat_member"] },
      OTHER_TOKEN,
    );

    await fake.addBotViaLink(group, me.id, { by: OWNER, startParameter: "x" });

    await expect.poll(() => otherHook.ofType("chat_member").length).toBe(1);
    expect(otherHook.ofType("chat_member")[0].new_chat_member.user.id).toBe(
      me.id,
    );
  });

  it("lets only someone who can add members, or admins when rights are asked for", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    const member = await fake.createUser();
    await fake.join(group, member);
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    expect(
      await api("setChatPermissions", {
        chat_id: group,
        permissions: { can_send_messages: true, can_invite_users: false },
      }),
    ).toMatchObject({ status: 200, ok: true, result: true });
    await fake.setBotMembership(group, me.id, { status: "left" });

    await expect(
      fake.addBotViaLink(group, me.id, { by: member, startParameter: "a" }),
    ).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);
    await expect(
      fake.addBotViaLink(group, me.id, {
        by: member,
        rights: { can_delete_messages: true },
      }),
    ).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);

    await fake.addBotViaLink(group, me.id, {
      by: OWNER,
      rights: { can_delete_messages: true },
    });
    expect(await fake.getMember(group, me.id)).toMatchObject({
      status: "administrator",
      can_delete_messages: true,
    });
  });

  it("combines an administrator's rights with the requested ones, and still posts /start", async () => {
    const { fake, hook, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, {
      status: "administrator",
      rights: { can_pin_messages: false, can_manage_video_chats: true },
    });

    await fake.addBotViaLink(group, me.id, {
      by: OWNER,
      startParameter: "again",
      rights: { can_pin_messages: true },
    });

    expect(await fake.getMember(group, me.id)).toMatchObject({
      status: "administrator",
      can_pin_messages: true,
      can_manage_video_chats: true,
    });
    await expect
      .poll(() =>
        hook
          .ofType("message")
          .filter((message) => message.text)
          .map((message) => message.text),
      )
      .toEqual(["/start@modbot again"]);
  });
});

describe("adding the bot through a startchannel link", () => {
  it("needs admin rights, takes no start parameter and posts no /start", async () => {
    const { fake, api, hook, me } = await setup();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message", "channel_post", "my_chat_member"],
    });
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });

    await expect(
      fake.addBotViaLink(channel, me.id, { by: OWNER }),
    ).rejects.toThrow(/admin rights/);
    await expect(
      fake.addBotViaLink(channel, me.id, {
        by: OWNER,
        startParameter: "abc",
        rights: { can_post_messages: true },
      }),
    ).rejects.toThrow(/start parameter/);
    expect((await fake.getMember(channel, me.id)).status).toBe("left");

    await fake.addBotViaLink(channel, me.id, {
      by: OWNER,
      rights: { can_post_messages: true },
    });
    expect(await fake.getMember(channel, me.id)).toMatchObject({
      status: "administrator",
      can_post_messages: true,
    });
    expect(hook.kinds()).toEqual(["my_chat_member"]);
    expect(await fake.getMessages(channel)).toEqual([]);
  });
});

describe("who may add the bot as an administrator", () => {
  it("needs can_promote_members from an administrator", async () => {
    const { fake, api, me } = await setup();
    const other = await fake.addBot({ token: OTHER_TOKEN, username: "other" });
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, {
      status: "administrator",
      rights: { can_promote_members: true, can_delete_messages: true },
    });
    const [plainAdmin, promoter] = [
      await fake.createUser(),
      await fake.createUser(),
    ];
    for (const user of [plainAdmin, promoter]) await fake.join(group, user);
    await api("promoteChatMember", {
      chat_id: group,
      user_id: plainAdmin,
      can_delete_messages: true,
    });
    await api("promoteChatMember", {
      chat_id: group,
      user_id: promoter,
      can_promote_members: true,
    });
    const asAdmin = (by) =>
      fake.addBotViaLink(group, other.id, {
        by,
        rights: { can_delete_messages: true },
      });

    await expect(asAdmin(plainAdmin)).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);
    await asAdmin(promoter);
    expect((await fake.getMember(group, other.id)).status).toBe(
      "administrator",
    );
  });
});

describe("opening a URL button", () => {
  /** The bot sends a message with one button per row; returns it. */
  async function sendButtons(api, chatId, buttons) {
    const sent = await api("sendMessage", {
      chat_id: chatId,
      text: "Pick one",
      reply_markup: { inline_keyboard: buttons.map((button) => [button]) },
    });
    expect(sent.ok).toBe(true);
    return sent.result;
  }
  const privateMessages = (hook) =>
    hook.ofType("message").filter((message) => message.chat.type === "private");

  /** A group with the bot as an administrator, and Ann in it. */
  async function groupWithAnn(fake, me) {
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const ann = await fake.createUser({ first_name: "Ann", username: "ann" });
    await fake.join(group, ann);
    return { group, ann };
  }

  it("sends /start with the parameter in the person's private chat, on first contact and later", async () => {
    const { fake, api, hook, me } = await setup();
    const { group, ann } = await groupWithAnn(fake, me);
    const url = "https://t.me/modbot?start=verify_123";
    const { message_id } = await sendButtons(api, group, [
      { text: "I'm human", url },
      { text: "Start", url: "tg://resolve?domain=ModBot&start=" },
    ]);
    // Ann never wrote to the bot, so it cannot write to her yet.
    expect(
      (await api("sendMessage", { chat_id: ann, text: "Hi" })).status,
    ).toBe(403);

    const opened = await fake.openUrlButton(
      group,
      message_id,
      ann,
      "I'm human",
    );

    expect(opened).toEqual({
      url,
      link: "start",
      bot_id: me.id,
      chat_id: ann,
      message_id: expect.any(Number),
    });
    await expect.poll(() => privateMessages(hook)).toHaveLength(1);
    expect(privateMessages(hook)[0]).toMatchObject({
      message_id: opened.message_id,
      from: { id: ann },
      chat: { id: ann, type: "private" },
      text: "/start verify_123",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    });
    expect(
      (await api("sendMessage", { chat_id: ann, text: "Welcome" })).ok,
    ).toBe(true);

    // The chat has messages now, and the link sends /start again. The second
    // button, by its index, is a tg:// link with an empty parameter.
    await fake.openUrlButton(group, message_id, ann, 0);
    await fake.openUrlButton(group, message_id, ann, 1);
    await expect
      .poll(() => privateMessages(hook).map((message) => message.text))
      .toEqual(["/start verify_123", "/start verify_123", "/start"]);
  });

  it("adds the bot to the group the person picks for a startgroup link, with the rights it asks for", async () => {
    const { fake, api, hook, me } = await setup();
    const { group } = await groupWithAnn(fake, me);
    const shop = await fake.createChat({ title: "Shop", ownerId: OWNER });
    const url =
      "https://t.me/modbot?startgroup=ws_1&admin=delete_messages+restrict_members+post_messages";
    const { message_id } = await sendButtons(api, group, [
      { text: "Add me", url },
    ]);
    const before = hook.updates.length;

    expect(
      await fake.openUrlButton(group, message_id, OWNER, "Add me", {
        addToChatId: shop,
      }),
    ).toEqual({ url, link: "startgroup", bot_id: me.id, chat_id: shop });

    const member = await fake.getMember(shop, me.id);
    expect(member).toMatchObject({
      status: "administrator",
      can_manage_chat: true,
      can_delete_messages: true,
      can_restrict_members: true,
      can_pin_messages: false,
    });
    // post_messages is a channel right, so a group link leaves it out.
    expect(member.can_post_messages).toBeUndefined();
    await expect.poll(() => hook.updates.length - before).toBe(3);
    const added = hook.updates.slice(before);
    expect(added.find((update) => update.my_chat_member)).toMatchObject({
      my_chat_member: {
        chat: { id: shop },
        from: { id: OWNER },
        new_chat_member: { status: "administrator" },
      },
    });
    expect(added.find((update) => update.message?.text)?.message).toMatchObject(
      {
        chat: { id: shop },
        from: { id: OWNER },
        text: "/start@modbot ws_1",
      },
    );
  });

  it("adds the bot to a channel for a startchannel link with rights", async () => {
    const { fake, api, hook, me } = await setup();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message", "channel_post", "my_chat_member"],
    });
    const { group } = await groupWithAnn(fake, me);
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    const url =
      "tg://resolve?domain=modbot&startchannel&admin=post_messages+pin_messages";
    const bare = "https://t.me/modbot?startchannel";
    const { message_id } = await sendButtons(api, group, [
      { text: "Add to channel", url },
      { text: "Without rights", url: bare },
    ]);

    // Without admin rights it is not a startchannel link.
    expect(
      await fake.openUrlButton(group, message_id, OWNER, "Without rights", {
        addToChatId: channel,
      }),
    ).toEqual({ url: bare });
    expect((await fake.getMember(channel, me.id)).status).toBe("left");

    expect(
      await fake.openUrlButton(group, message_id, OWNER, "Add to channel", {
        addToChatId: channel,
      }),
    ).toEqual({ url, link: "startchannel", bot_id: me.id, chat_id: channel });
    const member = await fake.getMember(channel, me.id);
    expect(member).toMatchObject({
      status: "administrator",
      can_post_messages: true,
    });
    // pin_messages is a group right.
    expect(member.can_pin_messages).toBeUndefined();
    expect(await fake.getMessages(channel)).toEqual([]);
  });

  it("returns any other URL and does nothing", async () => {
    const { fake, api, me } = await setup();
    const { group, ann } = await groupWithAnn(fake, me);
    const urls = [
      "https://example.com/rules",
      "https://t.me/unknown_bot?start=x",
      "https://t.me/ann?start=x",
      "https://t.me/modbot",
      "https://t.me/modbot?start=not.valid",
      "https://t.me/+AbCdEf",
    ];
    const { message_id } = await sendButtons(
      api,
      group,
      urls.map((url, index) => ({ text: `Link ${index}`, url })),
    );
    const before = (await fake.getBotUpdates(me.id)).updates.length;

    for (const [index, url] of urls.entries()) {
      expect(await fake.openUrlButton(group, message_id, ann, index)).toEqual({
        url,
      });
    }

    expect((await fake.getBotUpdates(me.id)).updates).toHaveLength(before);
    expect(await fake.getDirectMessages(ann)).toEqual([]);
  });

  it("refuses a button that is not a URL button, and a person who cannot see the message", async () => {
    const { fake, api, me } = await setup();
    await fake.addBot({ token: OTHER_TOKEN, username: "otherbot" });
    const { group, ann } = await groupWithAnn(fake, me);
    const outsider = await fake.createUser();
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    const { message_id } = await sendButtons(api, group, [
      { text: "Vote", callback_data: "vote" },
      { text: "Add me", url: "https://t.me/modbot?startgroup=x" },
      { text: "Other", url: "https://t.me/otherbot?start=x" },
    ]);
    const open = (userId, button, options) =>
      fake.openUrlButton(group, message_id, userId, button, options);

    await expect(open(ann, "Vote")).rejects.toThrow(/not a URL button/);
    await expect(open(ann, "Nope")).rejects.toThrow(/no button/);
    await expect(open(ann, 3)).rejects.toThrow(/no button/);
    await expect(open(outsider, 1)).rejects.toThrow(/Can't access the chat/);
    // A startgroup link needs the group the person picks.
    await expect(open(OWNER, "Add me")).rejects.toThrow(/add_to_chat_id/);
    await expect(
      open(OWNER, "Add me", { addToChatId: channel }),
    ).rejects.toThrow(/group/);
    expect((await fake.getMember(channel, me.id)).status).toBe("left");
    // Only the first bot has private chats here.
    await expect(open(ann, "Other")).rejects.toThrow(/first bot/);

    await api("deleteMessage", { chat_id: group, message_id });
    await expect(open(ann, 1)).rejects.toThrow(/MESSAGE_ID_INVALID/);
  });

  it("opens URL buttons over HTTP, on ephemeral messages and in private chats", async () => {
    const { fake, api, hook, me } = await setup();
    const { group, ann } = await groupWithAnn(fake, me);
    const bob = await fake.createUser({ first_name: "Bob" });
    await fake.join(group, bob);
    const control = async (path, body) => {
      const response = await fetch(`${fake.origin}/_fake/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const url = "https://t.me/modbot?start=team_7";
    const plain = await sendButtons(api, group, [{ text: "Join", url }]);

    expect(
      await control(`chats/${group}/messages/${plain.message_id}/open-url`, {
        user_id: ann,
        button: "Join",
      }),
    ).toEqual({
      status: 200,
      body: {
        url,
        link: "start",
        bot_id: me.id,
        chat_id: ann,
        message_id: expect.any(Number),
      },
    });

    const ephemeral = await api("sendMessage", {
      chat_id: group,
      text: "Just for you",
      reply_markup: { inline_keyboard: [[{ text: "Join", url }]] },
      ephemeral_message_parameters: { receiver_user_id: bob },
    });
    const eid = ephemeral.result.ephemeral_message_id;
    expect(
      await control(`chats/${group}/ephemeral-messages/${eid}/open-url`, {
        user_id: ann,
        button: 0,
      }),
    ).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    expect(
      (
        await control(`chats/${group}/ephemeral-messages/${eid}/open-url`, {
          user_id: bob,
          button: 0,
        })
      ).body,
    ).toMatchObject({ link: "start", chat_id: bob });
    expect(
      await fake.openEphemeralUrlButton(group, eid, bob, "Join"),
    ).toMatchObject({ link: "start", chat_id: bob });

    const rules = "https://example.com/rules";
    const direct = await api("sendMessage", {
      chat_id: ann,
      text: "Welcome",
      reply_markup: { inline_keyboard: [[{ text: "Rules", url: rules }]] },
    });
    expect(
      await control(`users/${ann}/dm/${direct.result.message_id}/open-url`, {
        button: "Rules",
      }),
    ).toEqual({ status: 200, body: { url: rules } });
    expect(
      await fake.openDirectUrlButton(ann, direct.result.message_id, 0),
    ).toEqual({ url: rules });

    await expect
      .poll(() =>
        privateMessages(hook).map((message) => [message.chat.id, message.text]),
      )
      .toEqual([
        [ann, "/start team_7"],
        [bob, "/start team_7"],
        [bob, "/start team_7"],
      ]);
  });
});

describe("basic groups and the upgrade to a supergroup", () => {
  it("gives a basic group an id without the -100 prefix", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    expect(group).toBeLessThan(0);
    expect(String(group).startsWith("-100")).toBe(false);
    await fake.setBotMembership(group, me.id, { status: "member" });
    expect((await api("getChat", { chat_id: group })).result.type).toBe(
      "group",
    );
  });

  it("moves members and bots, posts both migrate messages, and refuses the old id", async () => {
    const { fake, api, hook, me } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    const member = await fake.createUser();
    await fake.join(group, member);
    await fake.setBotMembership(group, me.id, { status: "administrator" });

    await expect(
      fake.migrateToSupergroup(group, { by: member }),
    ).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);
    const supergroup = await fake.migrateToSupergroup(group, { by: OWNER });

    expect(String(supergroup).startsWith("-100")).toBe(true);
    expect((await fake.getMember(supergroup, member)).status).toBe("member");
    expect((await fake.getMember(supergroup, me.id)).status).toBe(
      "administrator",
    );
    await expect
      .poll(() =>
        hook
          .ofType("message")
          .filter(
            (message) =>
              message.migrate_to_chat_id || message.migrate_from_chat_id,
          ),
      )
      .toEqual([
        expect.objectContaining({
          chat: expect.objectContaining({ id: group }),
          migrate_to_chat_id: supergroup,
        }),
        expect.objectContaining({
          chat: expect.objectContaining({ id: supergroup, type: "supergroup" }),
          migrate_from_chat_id: group,
        }),
      ]);
    expect(await api("sendMessage", { chat_id: group, text: "hi" })).toEqual({
      status: 400,
      ok: false,
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: supergroup },
    });
    expect((await fake.getCalls()).calls.at(-1)).toMatchObject({
      outcome: "rejected",
      applied: false,
      status: 400,
      failed: 400,
      seq: expect.any(Number),
    });
    expect(
      (await api("sendMessage", { chat_id: supergroup, text: "hi" })).ok,
    ).toBe(true);
    expect(hook.ofType("my_chat_member")).toHaveLength(1);
  });

  it("posts left_chat_member from the bot that bans a member of a basic group", async () => {
    const { fake, api, hook, me } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const member = await fake.createUser();
    await fake.join(group, member);

    await api("banChatMember", { chat_id: group, user_id: member });

    await expect
      .poll(() =>
        hook
          .ofType("message")
          .filter((message) => message.left_chat_member)
          .map((message) => [message.from.id, message.left_chat_member.id]),
      )
      .toEqual([[me.id, member]]);
  });

  it("still reads the old id with getChat, without an invite link, and refuses leaveChat there as deactivated", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const supergroup = await fake.migrateToSupergroup(group, { by: OWNER });

    const old = (await api("getChat", { chat_id: group })).result;
    expect(old).toMatchObject({ id: group, type: "group" });
    expect(old).not.toHaveProperty("invite_link");
    expect(await api("leaveChat", { chat_id: group })).toMatchObject({
      status: 400,
      description: "Bad Request: chat is deactivated",
    });
    expect(
      await api("getChatMember", { chat_id: group, user_id: OWNER }),
    ).toMatchObject({
      status: 400,
      parameters: { migrate_to_chat_id: supergroup },
    });
  });

  it("forwards, copies and replies from the old id without the upgrade error", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const message = await fake.post(group, OWNER, "old history");
    const supergroup = await fake.migrateToSupergroup(group, { by: OWNER });
    const from = { from_chat_id: group, message_id: message };

    for (const [method, params] of [
      ["forwardMessage", from],
      ["copyMessage", from],
      [
        "sendMessage",
        {
          text: "re",
          reply_parameters: { chat_id: group, message_id: message },
        },
      ],
    ]) {
      expect((await api(method, { chat_id: supergroup, ...params })).ok).toBe(
        true,
      );
    }
  });
});

describe("people changing the chat", () => {
  it("renames the chat and changes its photo, with the service messages bots get", async () => {
    const { fake, api, hook, me } = await setup();
    const group = await fake.createChat({ title: "Old", ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "member" });

    await fake.renameChat(group, { by: OWNER, title: "New" });
    await fake.changeChatPhoto(group, { by: OWNER, bytes: PHOTO });

    await expect
      .poll(() =>
        hook
          .ofType("message")
          .filter((m) => m.new_chat_title || m.new_chat_photo)
          .map((m) => [m.from.id, m.new_chat_title ?? "photo"]),
      )
      .toEqual([
        [OWNER, "New"],
        [OWNER, "photo"],
      ]);
    const chat = (await api("getChat", { chat_id: group })).result;
    expect(chat.title).toBe("New");
    expect(chat.photo).toEqual({
      small_file_id: expect.any(String),
      small_file_unique_id: expect.any(String),
      big_file_id: expect.any(String),
      big_file_unique_id: expect.any(String),
    });
    const file = await api("getFile", { file_id: chat.photo.big_file_id });
    const download = await fetch(
      `${fake.origin}/file/bot${TOKEN}/${file.result.file_path}`,
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PHOTO);
  });

  it("gives getChat's photo a ChatPhoto file of its own, which no send takes", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "member" });
    await fake.changeChatPhoto(group, { by: OWNER, bytes: PHOTO });
    await fake.addProfilePhoto(OWNER, PHOTO);
    const chatPhoto = (await api("getChat", { chat_id: group })).result.photo;
    const ownerPhoto = (await api("getChat", { chat_id: OWNER })).result.photo;

    for (const photo of [chatPhoto.big_file_id, ownerPhoto.small_file_id]) {
      expect(await api("sendPhoto", { chat_id: group, photo })).toMatchObject({
        status: 400,
        description: "Bad Request: can't use file of type ChatPhoto as Photo",
      });
    }
    expect(
      await api("sendDocument", {
        chat_id: group,
        document: chatPhoto.big_file_id,
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: can't use file of type ChatPhoto as Document",
    });
    const file = await api("getFile", { file_id: chatPhoto.big_file_id });
    expect(file.result.file_path).toMatch(/^profile_photos\//);
  });

  it("refuses someone without can_change_info", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const member = await fake.createUser();
    await fake.join(group, member);
    await api("setChatPermissions", {
      chat_id: group,
      permissions: { can_send_messages: true, can_change_info: false },
    });
    await expect(
      fake.renameChat(group, { by: member, title: "Mine" }),
    ).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);
    await expect(
      fake.changeChatPhoto(group, { by: member, bytes: PHOTO }),
    ).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);
  });

  it("pins a message, with the pinned_message service message bots get", async () => {
    const { fake, api, hook, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "member" });
    const rules = await fake.post(group, OWNER, "rules");

    const pin = await fake.pinMessage(group, rules, OWNER);

    await expect
      .poll(() => hook.ofType("message").filter((m) => m.pinned_message))
      .toEqual([
        {
          message_id: pin.message_id,
          from: expect.objectContaining({ id: OWNER }),
          chat: expect.objectContaining({ id: group }),
          date: expect.any(Number),
          pinned_message: expect.objectContaining({
            message_id: rules,
            text: "rules",
          }),
        },
      ]);
    expect(
      (await api("getChat", { chat_id: group })).result.pinned_message
        .message_id,
    ).toBe(rules);
  });

  it("refuses to pin for someone without can_pin_messages, or a message that is not there", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const member = await fake.createUser();
    await fake.join(group, member);
    await api("setChatPermissions", {
      chat_id: group,
      permissions: { can_send_messages: true, can_pin_messages: false },
    });
    const rules = await fake.post(group, member, "rules");

    await expect(fake.pinMessage(group, rules, member)).rejects.toThrow(
      /CHAT_ADMIN_REQUIRED/,
    );
    await expect(fake.pinMessage(group, 999_999, OWNER)).rejects.toThrow(
      /MESSAGE_ID_INVALID/,
    );
  });
});

describe("people promoting and demoting members", () => {
  it("promotes a member with the rights chosen and demotes them, telling administrator bots", async () => {
    const { fake, api, hook, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const ann = await fake.createUser({ first_name: "Ann" });
    await fake.join(group, ann);

    const promoted = await fake.promoteMember(group, ann, {
      rights: { can_delete_messages: true, can_restrict_members: true },
    });

    const admin = {
      user: { id: ann },
      status: "administrator",
      can_be_edited: false,
      can_manage_chat: true,
      can_change_info: false,
      can_delete_messages: true,
      can_invite_users: false,
      can_restrict_members: true,
      can_promote_members: false,
      is_anonymous: false,
    };
    expect(promoted).toMatchObject(admin);
    expect(
      (await api("getChatMember", { chat_id: group, user_id: ann })).result,
    ).toMatchObject(admin);
    const admins = async () =>
      (await api("getChatAdministrators", { chat_id: group })).result.map(
        (entry) => entry.user.id,
      );
    expect(await admins()).toContain(ann);

    expect(await fake.demoteMember(group, ann)).toEqual({
      user: expect.objectContaining({ id: ann }),
      status: "member",
    });
    expect(await admins()).not.toContain(ann);
    await expect
      .poll(() =>
        hook
          .ofType("chat_member")
          .filter((change) => change.new_chat_member.user.id === ann)
          .map((change) => [
            change.from.id,
            change.old_chat_member.status,
            change.new_chat_member.status,
          ]),
      )
      .toEqual([
        [ann, "left", "member"],
        [OWNER, "member", "administrator"],
        [OWNER, "administrator", "member"],
      ]);
    expect(hook.ofType("chat_member").at(-2).new_chat_member).toMatchObject(
      admin,
    );
    // Demoting someone who is no administrator changes nothing, silently.
    expect((await fake.demoteMember(group, ann)).status).toBe("member");
    expect(
      hook
        .ofType("chat_member")
        .filter((change) => change.new_chat_member.user.id === ann),
    ).toHaveLength(3);

    // An edit of an administrator's rights keeps their custom title.
    await fake.setBotMembership(group, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    await api("promoteChatMember", {
      chat_id: group,
      user_id: ann,
      can_delete_messages: true,
    });
    await api("setChatAdministratorCustomTitle", {
      chat_id: group,
      user_id: ann,
      custom_title: "Boss",
    });
    expect(
      await fake.promoteMember(group, ann, {
        rights: { can_pin_messages: true },
      }),
    ).toMatchObject({
      can_pin_messages: true,
      can_delete_messages: false,
      custom_title: "Boss",
    });

    // Rights the kind of chat lacks are dropped first: a supergroup has no
    // post rights, and a channel no anonymous administrators.
    expect(
      (
        await fake.promoteMember(group, ann, {
          rights: { can_post_messages: true },
        })
      ).status,
    ).toBe("member");
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    const reader = await fake.createUser();
    await fake.join(channel, reader);
    expect(
      await fake.promoteMember(channel, reader, {
        rights: { can_post_messages: true, is_anonymous: true },
      }),
    ).toMatchObject({
      status: "administrator",
      can_post_messages: true,
      is_anonymous: false,
    });
    expect(
      (
        await fake.promoteMember(channel, reader, {
          rights: { is_anonymous: true },
        })
      ).status,
    ).toBe("member");
  });

  it("lets an administrator with can_promote_members promote, and refuses what Telegram refuses", async () => {
    const { fake, hook, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const [ann, bob, carl, dave] = [
      await fake.createUser(),
      await fake.createUser(),
      await fake.createUser(),
      await fake.createUser(),
    ];
    for (const user of [ann, bob, carl]) await fake.join(group, user);
    await fake.promoteMember(group, ann, {
      rights: { can_promote_members: true, can_delete_messages: true },
    });
    await fake.promoteMember(group, carl, {
      rights: { can_delete_messages: true },
    });

    await fake.promoteMember(group, bob, {
      by: ann,
      rights: { can_delete_messages: true },
    });
    await expect
      .poll(() => hook.ofType("chat_member").at(-1))
      .toMatchObject({
        from: { id: ann },
        new_chat_member: { status: "administrator", user: { id: bob } },
      });
    // Rights the promoter lacks, an administrator someone else promoted, the
    // owner, themselves and someone outside the chat are refused, as is
    // anyone without can_promote_members.
    await expect(
      fake.promoteMember(group, bob, {
        by: ann,
        rights: { can_change_info: true },
      }),
    ).rejects.toThrow("RIGHT_FORBIDDEN");
    await expect(fake.demoteMember(group, carl, { by: ann })).rejects.toThrow(
      "CHAT_ADMIN_REQUIRED",
    );
    await expect(fake.demoteMember(group, OWNER, { by: ann })).rejects.toThrow(
      "Can't remove chat owner",
    );
    await expect(
      fake.promoteMember(group, ann, {
        by: ann,
        rights: { can_delete_messages: true },
      }),
    ).rejects.toThrow("Can't promote self");
    await expect(
      fake.promoteMember(group, dave, {
        by: ann,
        rights: { can_delete_messages: true },
      }),
    ).rejects.toThrow("USER_NOT_PARTICIPANT");
    await expect(
      fake.promoteMember(group, carl, {
        by: bob,
        rights: { can_pin_messages: true },
      }),
    ).rejects.toThrow("Not enough rights");
    await expect(
      fake.promoteMember(group, bob, { rights: { can_delete_message: true } }),
    ).rejects.toThrow('unknown administrator right "can_delete_message"');
    await expect(
      fake.promoteMember(group, bob, { rights: { can_pin_messages: "true" } }),
    ).rejects.toThrow(/^rights\.can_pin_messages must be true or false$/);
    // An administrator may step down.
    expect(
      (await fake.demoteMember(group, carl, { by: carl })).status,
    ).toBe("member");
    // The owner edits any administrator; no right at all makes a member.
    expect((await fake.promoteMember(group, bob, { rights: {} })).status).toBe(
      "member",
    );
    // Making a member a member changes nothing, so it needs no right.
    expect((await fake.demoteMember(group, bob, { by: carl })).status).toBe(
      "member",
    );
  });

  it("keeps who promoted an administrator when the owner edits their rights", async () => {
    const { fake, api, hook, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    const [ann, bob, carl] = [
      await fake.createUser(),
      await fake.createUser(),
      await fake.createUser(),
    ];
    for (const user of [ann, bob, carl]) await fake.join(group, user);
    const promoted = await api("promoteChatMember", {
      chat_id: group,
      user_id: ann,
      can_delete_messages: true,
    });
    expect(promoted.ok).toBe(true);
    await fake.promoteMember(group, bob, {
      rights: { can_promote_members: true, can_delete_messages: true },
    });
    await fake.promoteMember(group, carl, {
      by: bob,
      rights: { can_delete_messages: true },
    });

    // The owner edits both; the bot and Bob still promoted them.
    await fake.promoteMember(group, ann, {
      rights: { can_delete_messages: true, can_pin_messages: true },
    });
    await fake.promoteMember(group, carl, {
      rights: { can_delete_messages: true, can_invite_users: true },
    });

    expect(
      (await api("getChatMember", { chat_id: group, user_id: ann })).result,
    ).toMatchObject({ can_be_edited: true, can_pin_messages: true });
    await expect
      .poll(
        () =>
          hook
            .ofType("chat_member")
            .filter((change) => change.new_chat_member.user.id === ann)
            .at(-1),
      )
      .toMatchObject({
        from: { id: OWNER },
        new_chat_member: { can_be_edited: true, can_pin_messages: true },
      });
    const edited = await api("promoteChatMember", {
      chat_id: group,
      user_id: ann,
      can_delete_messages: true,
    });
    expect(edited.ok).toBe(true);
    const titled = await api("setChatAdministratorCustomTitle", {
      chat_id: group,
      user_id: ann,
      custom_title: "Helper",
    });
    expect(titled.ok).toBe(true);
    expect(
      await fake.promoteMember(group, carl, {
        by: bob,
        rights: { can_delete_messages: true },
      }),
    ).toMatchObject({ status: "administrator", can_invite_users: false });
    // Nobody else became able to edit them.
    expect(
      (await api("getChatMember", { chat_id: group, user_id: carl })).result
        .can_be_edited,
    ).toBe(false);
  });

  it("lets only a basic group's creator promote, with the group's fixed rights", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const [ann, bob] = [await fake.createUser(), await fake.createUser()];
    for (const user of [ann, bob]) await fake.join(group, user);

    await fake.promoteMember(group, ann, {
      rights: { can_promote_members: true },
    });

    expect(
      (await api("getChatMember", { chat_id: group, user_id: ann })).result,
    ).toEqual({
      user: expect.objectContaining({ id: ann }),
      status: "administrator",
      can_be_edited: false,
      can_manage_chat: true,
      can_change_info: true,
      can_delete_messages: true,
      can_invite_users: true,
      can_restrict_members: true,
      can_pin_messages: true,
      can_promote_members: false,
      can_manage_video_chats: true,
      can_post_stories: false,
      can_edit_stories: false,
      can_delete_stories: false,
      can_manage_tags: true,
      can_send_welcome_messages: true,
      is_anonymous: false,
    });
    await expect(
      fake.promoteMember(group, bob, {
        by: ann,
        rights: { can_delete_messages: true },
      }),
    ).rejects.toThrow("Need owner rights in the group chat");
    await expect(
      fake.promoteMember(group, OWNER, {
        rights: { can_delete_messages: true },
      }),
    ).rejects.toThrow("Can't promote or demote self");
    // TDLib checks the creator before anything else changes, even for a
    // member who is no administrator.
    await expect(fake.demoteMember(group, bob, { by: ann })).rejects.toThrow(
      "Need owner rights in the group chat",
    );
    // Telegram's apps add someone outside the group first; this server
    // does not.
    const carl = await fake.createUser();
    await expect(
      fake.promoteMember(group, carl, {
        rights: { can_delete_messages: true },
      }),
    ).rejects.toThrow(/^the user is not in the chat; add them first$/);
    expect((await fake.demoteMember(group, ann)).status).toBe("member");
    // The basic group is gone once upgraded.
    await fake.migrateToSupergroup(group);
    await expect(
      fake.promoteMember(group, bob, { rights: { can_delete_messages: true } }),
    ).rejects.toThrow(/^Chat is deactivated$/);
  });
});

describe("member count and leaving", () => {
  it("counts members as they join and leave", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "member" });
    const count = async () =>
      (await api("getChatMemberCount", { chat_id: group })).result;
    expect(await count()).toBe(2);
    const member = await fake.createUser();
    await fake.join(group, member);
    expect(await count()).toBe(3);
    await fake.leave(group, member);
    expect(await count()).toBe(2);
  });

  it("tells the bot it left through my_chat_member", async () => {
    const { fake, api, hook, me } = await setup();
    const group = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "member" });

    await api("leaveChat", { chat_id: group });

    await expect
      .poll(() => hook.ofType("my_chat_member").at(-1)?.new_chat_member.status)
      .toBe("left");
    expect(hook.ofType("my_chat_member").at(-1).from.id).toBe(me.id);
  });
});
