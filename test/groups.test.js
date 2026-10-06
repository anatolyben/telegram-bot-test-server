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

  it("still reads the old id with getChat, and refuses leaveChat there as deactivated", async () => {
    const { fake, api, me } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "administrator" });
    const supergroup = await fake.migrateToSupergroup(group, { by: OWNER });

    expect((await api("getChat", { chat_id: group })).result).toMatchObject({
      id: group,
      type: "group",
    });
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
