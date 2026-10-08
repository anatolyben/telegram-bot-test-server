import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST-TOKEN";
const SECOND_TOKEN = "654321:SECOND-TOKEN";
const GROUP = -1001000000001;
const OWNER = 5000000001;
const PHOTO = Buffer.from("fake-jpeg-bytes");

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

/** A multipart Bot API call; each Buffer goes up as a file named after its field. */
async function upload(fake, method, fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Buffer.isBuffer(value)) body.append(key, new Blob([value]), key);
    else
      body.append(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
  }
  const response = await fetch(`${fake.origin}/bot${TOKEN}/${method}`, {
    method: "POST",
    body,
  });
  return { status: response.status, ...(await response.json()) };
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
  const second = await fake.addBot({
    token: SECOND_TOKEN,
    username: "second_bot",
  });
  return { fake, api, second };
}

describe("more than one bot", () => {
  it("tells a bot it was added through my_chat_member, and only then lets it post", async () => {
    const { fake, api, second } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url }, SECOND_TOKEN);

    const refused = await api(
      "sendMessage",
      { chat_id: GROUP, text: "too early" },
      SECOND_TOKEN,
    );
    expect(refused).toMatchObject({
      status: 400,
      description: "Bad Request: chat not found",
    });

    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    await expect.poll(() => hook.ofType("my_chat_member").length).toBe(1);
    expect(hook.ofType("my_chat_member")[0]).toMatchObject({
      chat: { id: GROUP },
      from: { id: OWNER },
      old_chat_member: { status: "left" },
      new_chat_member: { status: "administrator", user: { id: second.id } },
    });
    const sent = await api(
      "sendMessage",
      { chat_id: GROUP, text: "hello" },
      SECOND_TOKEN,
    );
    expect(sent.result.from.id).toBe(second.id);
  });

  it("delivers a group's messages to every bot in it, each to its own webhook", async () => {
    const { fake, api, second } = await setup();
    const first = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: first.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    await fake.setBotMembership(GROUP, second.id, { status: "member" });

    const member = await fake.createUser();
    await fake.join(GROUP, member);
    await fake.post(GROUP, member, "hi both");

    await expect
      .poll(() =>
        [first, other].map(
          (hook) =>
            hook
              .ofType("message")
              .filter((message) => message.text === "hi both").length,
        ),
      )
      .toEqual([1, 1]);
  });

  it("keeps a separate update queue for each polling bot", async () => {
    const { fake, api, second } = await setup();
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, second.id, {
      status: "administrator",
    });

    const secondUpdates = await api("getUpdates", {}, SECOND_TOKEN);
    const firstUpdates = await api("getUpdates");

    expect(
      secondUpdates.result.map((update) => Object.keys(update)[1]),
    ).toEqual(["my_chat_member"]);
    expect(firstUpdates.result).toEqual([]);
  });

  it("numbers each bot's updates in its own sequence, and replays one by bot", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const member = await fake.createUser();
    await fake.join(GROUP, member);
    for (const text of ["one", "two", "three"]) {
      await fake.post(GROUP, member, text);
    }

    const ids = async (token) =>
      (await api("getUpdates", {}, token)).result
        .filter((update) => update.message?.text)
        .map((update) => update.update_id);
    const first = await ids(TOKEN);
    const other = await ids(SECOND_TOKEN);
    expect(first.map((id) => id - first[0])).toEqual([0, 1, 2]);
    expect(other.map((id) => id - other[0])).toEqual([0, 1, 2]);
  });

  it("replays an update to the bot named when two bots got the same update_id", async () => {
    const { fake, api, second } = await setup({
      clock: { now: 1_800_000_000_000 },
    });
    const first = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: first.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    // Both bots start counting from the same moment: the first bot's
    // new_chat_members message and the second bot's my_chat_member share an id.
    const sent = (await fake.getDeliveries()).map((d) => [
      d.bot_id,
      d.update_id,
    ]);
    const shared = Math.min(...sent.map(([, id]) => id));
    expect(
      sent
        .filter(([, id]) => id === shared)
        .map(([botId]) => botId)
        .sort(),
    ).toEqual([123456, second.id]);

    await expect(fake.redeliverUpdate(shared)).rejects.toThrow(/bot/);
    await fake.redeliverUpdate(shared, { botId: second.id });
    await expect.poll(() => other.ofType("my_chat_member").length).toBe(2);
    expect(first.ofType("message")).toHaveLength(1);
  });

  it("lets a bot edit and stop only its own messages", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const mine = await api("sendMessage", { chat_id: GROUP, text: "first" });

    const edit = await api(
      "editMessageText",
      { chat_id: GROUP, message_id: mine.result.message_id, text: "changed" },
      SECOND_TOKEN,
    );
    expect(edit).toMatchObject({
      status: 400,
      description: "Bad Request: message can't be edited",
    });
  });

  it("reports a bot leaving to that bot and to the group", async () => {
    const { fake, api, second } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    await fake.setBotMembership(GROUP, second.id, { status: "member" });

    await api("leaveChat", { chat_id: GROUP }, SECOND_TOKEN);

    await expect
      .poll(() =>
        hook
          .ofType("message")
          .some((message) => message.left_chat_member?.id === second.id),
      )
      .toBe(true);
    expect(await fake.getMember(GROUP, second.id)).toMatchObject({
      status: "left",
    });
  });
});

describe("privacy mode", () => {
  it("says in getMe whether the bot reads every group message", async () => {
    const { fake, api } = await setup();
    await fake.addBot({
      token: "777777:PRIVATE",
      username: "private_bot",
      privacyMode: true,
    });
    expect((await api("getMe")).result.can_read_all_group_messages).toBe(true);
    expect(
      (await api("getMe", {}, "777777:PRIVATE")).result
        .can_read_all_group_messages,
    ).toBe(false);
  });

  it("gives a bot in privacy mode that is no administrator only commands for it, replies to it and service messages", async () => {
    const { fake, api } = await setup();
    const quiet = await fake.addBot({
      token: "777777:PRIVATE",
      username: "private_bot",
      privacyMode: true,
    });
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url }, "777777:PRIVATE");
    await fake.setBotMembership(GROUP, quiet.id, { status: "member" });
    const user = await fake.createUser({ first_name: "Ann" });
    await fake.join(GROUP, user);
    // The first bot spoke last, so a general command is not for this one.
    await api("sendMessage", { chat_id: GROUP, text: "welcome" });
    await fake.post(GROUP, user, "hello everyone");
    await fake.post(GROUP, user, "/help");
    await fake.post(GROUP, user, "/help@private_bot");
    await fake.post(GROUP, user, "/help@example_bot");
    const own = await api(
      "sendMessage",
      { chat_id: GROUP, text: "I am here" },
      "777777:PRIVATE",
    );
    await fake.post(GROUP, user, "/rules");
    await fake.post(GROUP, user, {
      text: "thanks",
      replyTo: own.result.message_id,
    });
    await fake.drainDeliveries();

    const got = hook
      .ofType("message")
      .map((message) => message.text ?? (message.new_chat_members ? "joined" : "?"));
    // Its own join, then Ann's.
    expect(got).toEqual([
      "joined",
      "joined",
      "/help@private_bot",
      "/rules",
      "thanks",
    ]);

    // As an administrator it gets every message.
    await fake.setBotMembership(GROUP, quiet.id, { status: "administrator" });
    await fake.post(GROUP, user, "hello again");
    await fake.drainDeliveries();
    expect(hook.ofType("message").at(-1).text).toBe("hello again");
  });

  it("gives a message to only one bot in privacy mode, a reply before a command", async () => {
    const { fake, api } = await setup();
    const one = await fake.addBot({
      token: "777771:ONE",
      username: "one_bot",
      privacyMode: true,
    });
    const two = await fake.addBot({
      token: "777772:TWO",
      username: "two_bot",
      privacyMode: true,
    });
    const hookOne = await startReceiver();
    const hookTwo = await startReceiver();
    await api("setWebhook", { url: hookOne.url }, "777771:ONE");
    await api("setWebhook", { url: hookTwo.url }, "777772:TWO");
    await fake.setBotMembership(GROUP, one.id, { status: "member" });
    await fake.setBotMembership(GROUP, two.id, { status: "member" });
    const user = await fake.createUser();
    await fake.join(GROUP, user);
    const fromOne = await api(
      "sendMessage",
      { chat_id: GROUP, text: "one speaks" },
      "777771:ONE",
    );
    await fake.post(GROUP, user, {
      text: "/ping@two_bot",
      replyTo: fromOne.result.message_id,
    });
    await fake.drainDeliveries();
    const texts = (hook) =>
      hook.ofType("message").map((message) => message.text).filter(Boolean);
    expect(texts(hookOne)).toEqual(["/ping@two_bot"]);
    expect(texts(hookTwo)).toEqual([]);
  });

  /** A bot in privacy mode, a member of GROUP, with Ann and Bob there. */
  async function privateBotInGroup() {
    const { fake, api } = await setup();
    const quiet = await fake.addBot({
      token: "777777:PRIVATE",
      username: "private_bot",
      privacyMode: true,
    });
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url }, "777777:PRIVATE");
    await fake.setBotMembership(GROUP, quiet.id, { status: "member" });
    const ann = await fake.createUser({ first_name: "Ann" });
    const bob = await fake.createUser({ first_name: "Bob" });
    await fake.join(GROUP, ann);
    await fake.join(GROUP, bob);
    const texts = async (type = "message") => {
      await fake.drainDeliveries();
      return hook
        .ofType(type)
        .map((message) => message.text ?? message.caption)
        .filter(Boolean);
    };
    return { fake, api, quiet, ann, bob, texts };
  }

  it("gives a bot in privacy mode replies to messages meant for it", async () => {
    const { fake, api, ann, bob, texts } = await privateBotInGroup();
    const command = await fake.post(GROUP, ann, "/help@private_bot");
    const reply = await fake.post(GROUP, bob, {
      text: "reply to the command",
      replyTo: command,
    });
    await fake.post(GROUP, ann, { text: "reply to the reply", replyTo: reply });
    const plain = await fake.post(GROUP, bob, "plain");
    await fake.post(GROUP, ann, { text: "reply to plain", replyTo: plain });
    await api("sendMessage", { chat_id: GROUP, text: "x" }, "777777:PRIVATE");
    const general = await fake.post(GROUP, ann, "/rules");
    await fake.post(GROUP, bob, { text: "reply to /rules", replyTo: general });

    expect(await texts()).toEqual([
      "/help@private_bot",
      "reply to the command",
      "reply to the reply",
      "/rules",
      "reply to /rules",
    ]);
  });

  it("counts only a command that starts a text message", async () => {
    const { fake, api, ann, texts } = await privateBotInGroup();
    await fake.post(GROUP, ann, "please run /help@private_bot now");
    await fake.post(GROUP, ann, {
      photo: PHOTO,
      caption: "/help@private_bot",
    });
    await fake.post(GROUP, ann, "/help@private_bot now");
    await api("sendMessage", { chat_id: GROUP, text: "x" }, "777777:PRIVATE");
    await fake.post(GROUP, ann, "and /rules");

    expect(await texts()).toEqual(["/help@private_bot now"]);
  });

  it("gives a bot in privacy mode edits of only the messages it received", async () => {
    const { fake, ann, texts } = await privateBotInGroup();
    const plain = await fake.post(GROUP, ann, "plain");
    await fake.editMessage(GROUP, plain, ann, { text: "/x@private_bot" });
    const command = await fake.post(GROUP, ann, "/y@private_bot");
    await fake.editMessage(GROUP, command, ann, { text: "no command now" });

    expect(await texts("edited_message")).toEqual(["no command now"]);
  });

  it("does not count a bot's service messages toward the last bot to send a message", async () => {
    const { fake, api, ann, texts } = await privateBotInGroup();
    const me = (await api("getMe")).result;
    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_pin_messages: true },
    });
    const plain = await fake.post(GROUP, ann, "plain");
    await api("sendMessage", { chat_id: GROUP, text: "x" }, "777777:PRIVATE");
    await api("pinChatMessage", { chat_id: GROUP, message_id: plain });
    await fake.post(GROUP, ann, "/rules");

    expect(await texts()).toEqual(["/rules"]);
  });

  it("does not count a message in a topic as a reply to the bot that created the topic", async () => {
    const { fake, quiet, ann, texts } = await privateBotInGroup();
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, quiet.id, { status: "member" });
    await fake.join(forum, ann);
    const topic = await fake.createTopic(forum, "Bots", { by: quiet.id });
    await fake.post(forum, ann, { text: "in the topic", threadId: topic });
    await fake.post(forum, ann, { text: "an explicit reply", replyTo: topic, threadId: topic });

    expect(await texts()).toEqual([]);
  });
});

describe("channels and rights", () => {
  it("lets a bot post in a channel only with the right to", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({
      title: "News",
      type: "channel",
      ownerId: OWNER,
    });
    await fake.setBotMembership(channel, me.id, {
      status: "administrator",
      rights: { can_post_messages: false },
    });

    const refused = await api("sendMessage", { chat_id: channel, text: "x" });
    expect(refused).toMatchObject({
      status: 400,
      description: "Bad Request: need administrator rights in the channel chat",
    });

    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const sent = await api("sendMessage", { chat_id: channel, text: "x" });
    expect(sent.result.chat).toMatchObject({ id: channel, type: "channel" });
  });

  it("sends a channel's messages as channel_post and edited_channel_post from the channel itself", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const channel = await fake.createChat({
      title: "News",
      type: "channel",
      ownerId: OWNER,
    });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const byChannel = { sender_chat: { id: channel, type: "channel" } };

    const sent = await api("sendMessage", { chat_id: channel, text: "bot" });
    const post = await fake.post(channel, OWNER, "owner");
    await fake.editMessage(channel, post, OWNER, { text: "owner, edited" });
    await fake.renameChat(channel, { by: OWNER, title: "News 2" });

    expect(sent.result).toMatchObject({ ...byChannel, text: "bot" });
    await expect.poll(() => hook.ofType("channel_post").length).toBe(2);
    const [posted, renamed] = hook.ofType("channel_post");
    const [edited] = hook.ofType("edited_channel_post");
    expect(posted).toMatchObject({ ...byChannel, text: "owner" });
    expect(edited).toMatchObject({ ...byChannel, text: "owner, edited" });
    expect(renamed).toMatchObject({ ...byChannel, new_chat_title: "News 2" });
    for (const message of [sent.result, posted, edited, renamed]) {
      expect(message.from).toBeUndefined();
    }
    expect(hook.ofType("message")).toEqual([]);
    expect(hook.ofType("edited_message")).toEqual([]);
  });

  it("lets only the creator and administrators with can_post_messages post in a channel", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    const [subscriber, editor, poster] = [
      await fake.createUser(),
      await fake.createUser(),
      await fake.createUser(),
    ];
    for (const user of [subscriber, editor, poster]) {
      await fake.join(channel, user);
    }
    await api("promoteChatMember", {
      chat_id: channel,
      user_id: editor,
      can_edit_messages: true,
    });
    await api("promoteChatMember", {
      chat_id: channel,
      user_id: poster,
      can_post_messages: true,
    });

    for (const user of [subscriber, editor]) {
      await expect(fake.post(channel, user, "hello")).rejects.toThrow(
        /CHAT_WRITE_FORBIDDEN/,
      );
    }
    for (const user of [OWNER, poster]) {
      await expect(fake.post(channel, user, "hello")).resolves.toBeTypeOf(
        "number",
      );
    }
  });

  it("refuses a channel's subscribers changing its title or photo", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const subscriber = await fake.createUser();
    await fake.join(channel, subscriber);

    await expect(
      fake.renameChat(channel, { by: subscriber, title: "Mine" }),
    ).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);
    await expect(
      fake.changeChatPhoto(channel, { by: subscriber, bytes: PHOTO }),
    ).rejects.toThrow(/CHAT_ADMIN_REQUIRED/);
  });

  it("lets a bot delete its own channel post with can_post_messages alone", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, {
      status: "administrator",
      rights: { can_post_messages: true, can_delete_messages: false },
    });
    const own = (await api("sendMessage", { chat_id: channel, text: "mine" }))
      .result.message_id;
    const owners = await fake.post(channel, OWNER, "the owner's");

    expect(
      await api("deleteMessage", { chat_id: channel, message_id: owners }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message can't be deleted",
    });
    expect(
      await api("deleteMessage", { chat_id: channel, message_id: own }),
    ).toMatchObject({ ok: true, result: true });
  });

  it("sends a press on a channel post to the bot that put the keyboard there", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    const first = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: first.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    await fake.setBotMembership(channel, second.id, {
      status: "administrator",
      rights: { can_post_messages: true, can_edit_messages: true },
    });
    const keyboard = {
      inline_keyboard: [[{ text: "Like", callback_data: "like" }]],
    };
    const sent = (
      await api(
        "sendMessage",
        { chat_id: channel, text: "the bot's", reply_markup: keyboard },
        SECOND_TOKEN,
      )
    ).result.message_id;
    const owners = await fake.post(channel, OWNER, "the owner's");
    await api(
      "editMessageReplyMarkup",
      { chat_id: channel, message_id: owners, reply_markup: keyboard },
      SECOND_TOKEN,
    );
    const subscriber = await fake.createUser();
    await fake.join(channel, subscriber);

    for (const [index, messageId] of [sent, owners].entries()) {
      const press = fake.pressButton(channel, messageId, subscriber, "like");
      await expect
        .poll(() => other.ofType("callback_query").length)
        .toBe(index + 1);
      await api(
        "answerCallbackQuery",
        { callback_query_id: other.ofType("callback_query")[index].id },
        SECOND_TOKEN,
      );
      await press;
    }
    expect(
      other.ofType("callback_query").map((query) => query.message.message_id),
    ).toEqual([sent, owners]);
    expect(first.ofType("callback_query")).toEqual([]);
  });

  it("tells the bot that sent a poll when another bot stops it", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    const first = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: first.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    await fake.setBotMembership(channel, second.id, {
      status: "administrator",
      rights: { can_edit_messages: true },
    });
    const poll = (
      await api("sendPoll", {
        chat_id: channel,
        question: "Which?",
        options: ["A", "B"],
      })
    ).result;

    expect(
      await api(
        "stopPoll",
        { chat_id: channel, message_id: poll.message_id },
        SECOND_TOKEN,
      ),
    ).toMatchObject({ ok: true, result: { is_closed: true } });
    for (const hook of [first, other]) {
      await expect
        .poll(() => hook.ofType("poll"))
        .toEqual([
          expect.objectContaining({ id: poll.poll.id, is_closed: true }),
        ]);
    }
  });

  it("edits and stops others' channel posts with can_edit_messages, and its own only while it may post", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    const rights = (can_post_messages, can_edit_messages) =>
      fake.setBotMembership(channel, me.id, {
        status: "administrator",
        rights: { can_post_messages, can_edit_messages },
      });
    const addButton = (messageId) =>
      api("editMessageReplyMarkup", {
        chat_id: channel,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[{ text: "Like", callback_data: "1" }]],
        },
      });
    const refused = {
      status: 400,
      description: "Bad Request: message can't be edited",
    };
    await rights(true, false);
    const own = (await api("sendMessage", { chat_id: channel, text: "mine" }))
      .result.message_id;
    const poll = (
      await api("sendPoll", {
        chat_id: channel,
        question: "Which?",
        options: ["A", "B"],
      })
    ).result.message_id;
    const owners = await fake.post(channel, OWNER, "the owner's");

    expect(await addButton(owners)).toMatchObject(refused);
    await rights(false, true);
    expect(await addButton(owners)).toMatchObject({
      ok: true,
      result: { message_id: owners, reply_markup: expect.any(Object) },
    });
    await rights(false, false);
    expect(await addButton(own)).toMatchObject(refused);
    expect(
      await api("stopPoll", { chat_id: channel, message_id: poll }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: poll can't be stopped",
    });
  });

  it("leaves default member permissions out of a channel's getChat", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });

    const chat = (await api("getChat", { chat_id: channel })).result;
    expect(chat.type).toBe("channel");
    expect(chat.permissions).toBeUndefined();
    expect(
      (await api("getChat", { chat_id: GROUP })).result.permissions,
    ).toBeDefined();
  });

  it("pins with the right to, and shows the pinned message on getChat", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const sent = await api("sendMessage", { chat_id: GROUP, text: "rules" });
    const pin = () =>
      api("pinChatMessage", {
        chat_id: GROUP,
        message_id: sent.result.message_id,
      });

    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_pin_messages: false },
    });
    expect(await pin()).toMatchObject({
      status: 400,
      description:
        "Bad Request: not enough rights to manage pinned messages in the chat",
    });

    await fake.setBotMembership(GROUP, me.id, { status: "administrator" });
    expect((await pin()).result).toBe(true);
    const chat = await api("getChat", { chat_id: GROUP });
    expect(chat.result.pinned_message.message_id).toBe(sent.result.message_id);

    await api("unpinChatMessage", {
      chat_id: GROUP,
      message_id: sent.result.message_id,
    });
    expect(
      (await api("getChat", { chat_id: GROUP })).result.pinned_message,
    ).toBeUndefined();
  });
});

describe("pins", () => {
  it("shows and unpins the most recent pin by sending date, without its reply, passing over a deleted one", async () => {
    const { api } = await setup();
    const older = await api("sendMessage", { chat_id: GROUP, text: "older" });
    const newer = await api("sendMessage", {
      chat_id: GROUP,
      text: "newer",
      reply_parameters: { message_id: older.result.message_id },
    });
    for (const sent of [newer, older]) {
      await api("pinChatMessage", {
        chat_id: GROUP,
        message_id: sent.result.message_id,
      });
    }

    const { reply_to_message: reply, ...shown } = newer.result;
    expect(reply).toBeDefined();
    expect(
      (await api("getChat", { chat_id: GROUP })).result.pinned_message,
    ).toEqual(shown);
    expect((await api("unpinChatMessage", { chat_id: GROUP })).result).toBe(
      true,
    );
    expect(
      (await api("getChat", { chat_id: GROUP })).result.pinned_message
        .message_id,
    ).toBe(older.result.message_id);

    await api("pinChatMessage", {
      chat_id: GROUP,
      message_id: newer.result.message_id,
    });
    await api("deleteMessage", {
      chat_id: GROUP,
      message_id: newer.result.message_id,
    });
    expect(
      (await api("getChat", { chat_id: GROUP })).result.pinned_message
        .message_id,
    ).toBe(older.result.message_id);
  });

  it("refuses to pin or unpin a message that is not there before checking rights", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const unpinNotFound = {
      status: 400,
      description: "Bad Request: message to unpin not found",
    };

    for (const status of ["administrator", "member"]) {
      await fake.setBotMembership(GROUP, me.id, { status });
      expect(await api("unpinChatMessage", { chat_id: GROUP })).toMatchObject(
        unpinNotFound,
      );
      expect(
        await api("unpinChatMessage", { chat_id: GROUP, message_id: 999_999 }),
      ).toMatchObject(unpinNotFound);
      expect(
        await api("pinChatMessage", { chat_id: GROUP, message_id: 999_999 }),
      ).toMatchObject({
        status: 400,
        description: "Bad Request: message to pin not found",
      });
    }
  });

  it("posts the pinned_message service message to every bot in the chat, the pinning bot too", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const question = await api("sendMessage", { chat_id: GROUP, text: "?" });
    const rules = await api("sendMessage", {
      chat_id: GROUP,
      text: "rules",
      reply_parameters: { message_id: question.result.message_id },
    });

    await api("pinChatMessage", {
      chat_id: GROUP,
      message_id: rules.result.message_id,
    });
    const after = await api("sendMessage", { chat_id: GROUP, text: "after" });

    const { reply_to_message: _reply, ...pinned } = rules.result;
    for (const token of [TOKEN, SECOND_TOKEN]) {
      const pins = (await api("getUpdates", {}, token)).result
        .map((update) => update.message)
        .filter((message) => message?.pinned_message);
      expect(pins).toEqual([
        {
          message_id: rules.result.message_id + 1,
          from: expect.objectContaining({ id: me.id }),
          chat: rules.result.chat,
          date: expect.any(Number),
          pinned_message: pinned,
        },
      ]);
    }
    expect(after.result.message_id).toBe(rules.result.message_id + 2);
  });

  it("pins in a private chat, telling the bot and showing it on that bot's getChat only", async () => {
    const { fake, api, second } = await setup();
    const user = await fake.createUser();
    await fake.join(GROUP, user);
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    await fake.sendDirectMessage(user, "/start");
    const menu = await api("sendMessage", { chat_id: user, text: "menu" });

    await api("pinChatMessage", {
      chat_id: user,
      message_id: menu.result.message_id,
    });

    expect(
      (await api("getChat", { chat_id: user })).result.pinned_message,
    ).toEqual(menu.result);
    // The other bot's private chat with the user is another chat.
    const seenByOther = await api("getChat", { chat_id: user }, SECOND_TOKEN);
    expect(seenByOther.ok).toBe(true);
    expect(seenByOther.result.pinned_message).toBeUndefined();
    const pins = (await api("getUpdates")).result
      .map((update) => update.message)
      .filter((message) => message?.pinned_message);
    expect(pins).toMatchObject([
      {
        chat: { id: user, type: "private" },
        pinned_message: { message_id: menu.result.message_id },
      },
    ]);
  });
});

describe("polls, forwards and media", () => {
  it("sends a poll with its settings and stops it once", async () => {
    const { api } = await setup();
    const poll = await api("sendPoll", {
      chat_id: GROUP,
      question: "Lunch?",
      options: [{ text: "Pizza" }, { text: "Salad" }],
      is_anonymous: false,
      allows_multiple_answers: true,
      description: "Vote by noon",
    });
    expect(poll.result.poll).toMatchObject({
      question: "Lunch?",
      options: [
        { persistent_id: expect.any(String), text: "Pizza", voter_count: 0 },
        { persistent_id: expect.any(String), text: "Salad", voter_count: 0 },
      ],
      is_anonymous: false,
      allows_multiple_answers: true,
      allows_revoting: true,
      members_only: false,
      description: "Vote by noon",
      is_closed: false,
    });
    const [pizza, salad] = poll.result.poll.options;
    expect(pizza.persistent_id).not.toBe(salad.persistent_id);

    const stop = () =>
      api("stopPoll", { chat_id: GROUP, message_id: poll.result.message_id });
    expect((await stop()).result.is_closed).toBe(true);
    expect(await stop()).toMatchObject({
      status: 400,
      description: "Bad Request: poll has already been closed",
    });
  });

  it("sends a poll with a single option, but not with none", async () => {
    const { api } = await setup();
    const poll = await api("sendPoll", {
      chat_id: GROUP,
      question: "Only one?",
      options: ["Yes"],
    });
    expect(poll.result.poll.options).toEqual([
      { persistent_id: expect.any(String), text: "Yes", voter_count: 0 },
    ]);
    expect(
      await api("sendPoll", { chat_id: GROUP, question: "None?", options: [] }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: poll must have at least one answer option",
    });
  });

  it("checks the question and each option as Telegram does", async () => {
    const { api } = await setup();
    const send = (fields) =>
      api("sendPoll", { chat_id: GROUP, question: "Which?", ...fields });
    const refusal = (description) => ({ status: 400, description });

    expect(await send({ options: undefined })).toMatchObject(
      refusal("Bad Request: can't parse options JSON object"),
    );
    // A JSON string is no list, even one whose text is a list.
    for (const options of [{}, JSON.stringify(JSON.stringify(["A", "B"]))]) {
      expect(await send({ options })).toMatchObject(
        refusal("Bad Request: expected an Array of InputPollOption"),
      );
    }
    expect(await send({ options: [null, null] })).toMatchObject(
      refusal(
        "Bad Request: can't parse InputPollOption: Expected InputPollOption to be an Object",
      ),
    );
    expect(await send({ options: [{}] })).toMatchObject(
      refusal(
        'Bad Request: can\'t parse InputPollOption: Can\'t find field "text"',
      ),
    );
    expect(await send({ options: ["A", ""] })).toMatchObject(
      refusal("Bad Request: text must be non-empty"),
    );
    expect(await send({ options: ["A", "x".repeat(101)] })).toMatchObject(
      refusal("Bad Request: poll options length must not exceed 100"),
    );
    expect(await send({ question: "", options: ["A"] })).toMatchObject(
      refusal("Bad Request: text must be non-empty"),
    );
    // A zero-width space shows nothing.
    expect(await send({ options: ["A", "\u200b"] })).toMatchObject(
      refusal("Bad Request: text must be non-empty"),
    );
    expect(
      await send({ question: "x".repeat(301), options: ["A"] }),
    ).toMatchObject(
      refusal("Bad Request: poll question length must not exceed 300"),
    );
    // The Bot API server refuses more than 32 KB before reading the options.
    expect(
      await send({ question: "x".repeat(32769), options: undefined }),
    ).toMatchObject(refusal("Bad Request: text is too long"));
    expect(await send({ options: ["A"], type: "survey" })).toMatchObject(
      refusal("Bad Request: unsupported poll type specified"),
    );
    // The limit counts characters, not UTF-16 code units.
    expect(await send({ options: ["🦄".repeat(100)] })).toMatchObject({
      ok: true,
    });
    // The question and options are kept trimmed, and the limits apply to
    // what is left.
    const trimmed = await send({
      question: `  ${"x".repeat(300)}  `,
      options: [" Yes ", { text: "No\n" }],
    });
    expect(trimmed.result.poll).toMatchObject({
      question: "x".repeat(300),
      options: [{ text: "Yes" }, { text: "No" }],
    });
  });

  it("requires a quiz's correct options and returns them and the explanation to the bot that sent it", async () => {
    const { api } = await setup();
    const quiz = (fields) =>
      api("sendPoll", {
        chat_id: GROUP,
        question: "Primes?",
        options: ["2", "4", "5"],
        type: "quiz",
        ...fields,
      });

    expect(await quiz({})).toMatchObject({
      status: 400,
      description: "Bad Request: correct quiz option list must be non-empty",
    });
    expect(await quiz({ correct_option_ids: [2, 0] })).toMatchObject({
      status: 400,
      description: "Bad Request: correct quiz option list must be increasing",
    });
    expect(await quiz({ correct_option_ids: [3] })).toMatchObject({
      status: 400,
      description: "Bad Request: wrong quiz correct_option_id",
    });
    for (const [ids, description] of [
      ["[0", "can't parse correct option identifiers JSON object"],
      [{}, "expected an Array of correct option identifiers"],
      [
        JSON.stringify("[0]"),
        "expected an Array of correct option identifiers",
      ],
      [["0"], "correct option identifier must be of type Number"],
      [[0.5], "invalid correct option identifier specified"],
    ]) {
      expect(await quiz({ correct_option_ids: ids })).toMatchObject({
        status: 400,
        description: `Bad Request: ${description}`,
      });
    }
    // An empty correct_option_id is no option at all, not option 0.
    expect(await quiz({ correct_option_id: "" })).toMatchObject({
      status: 400,
      description: "Bad Request: wrong quiz correct_option_id",
    });

    const sent = await quiz({
      correct_option_ids: [0, 2],
      allows_multiple_answers: true,
      explanation: "<b>4</b> is even",
      explanation_parse_mode: "HTML",
    });
    expect(sent.result.poll).toMatchObject({
      type: "quiz",
      allows_multiple_answers: true,
      allows_revoting: false,
      correct_option_ids: [0, 2],
      explanation: "4 is even",
      explanation_entities: [{ type: "bold", offset: 0, length: 1 }],
    });
    expect(sent.result.poll.correct_option_id).toBeUndefined();
    expect(
      (await quiz({ correct_option_id: 1 })).result.poll,
    ).toMatchObject({ correct_option_id: 1, correct_option_ids: [1] });
  });

  it("sends a poll already closed with is_closed", async () => {
    const { api } = await setup();
    const poll = await api("sendPoll", {
      chat_id: GROUP,
      question: "Preview?",
      options: ["A", "B"],
      is_closed: true,
    });
    expect(poll.result.poll.is_closed).toBe(true);
    expect(
      await api("stopPoll", {
        chat_id: GROUP,
        message_id: poll.result.message_id,
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: poll has already been closed",
    });
  });

  it("limits voting to long-time members only in channels", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const send = (chatId) =>
      api("sendPoll", {
        chat_id: chatId,
        question: "Members only?",
        options: ["A", "B"],
        members_only: true,
      });

    expect(await send(GROUP)).toMatchObject({
      status: 400,
      description:
        "Bad Request: poll voters can be restricted only in channel chats",
    });
    expect((await send(channel)).result.poll.members_only).toBe(true);
  });

  it("sends the closed poll as a poll update to the bot that stopped it", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url }, SECOND_TOKEN);
    const sent = await api(
      "sendPoll",
      {
        chat_id: GROUP,
        question: "Lunch?",
        options: ["Pizza", "Salad"],
        description: "Vote by noon",
      },
      SECOND_TOKEN,
    );
    await api(
      "stopPoll",
      { chat_id: GROUP, message_id: sent.result.message_id },
      SECOND_TOKEN,
    );

    await expect.poll(() => hook.ofType("poll").length).toBe(1);
    const { description: _description, ...poll } = sent.result.poll;
    expect(hook.ofType("poll")).toEqual([{ ...poll, is_closed: true }]);
    // Another administrator bot neither sent nor stopped the poll.
    const updates = (await api("getUpdates")).result;
    expect(updates.filter((update) => update.poll)).toEqual([]);
  });

  it("shows an open quiz's correct options and explanation only to the bot that sent it", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const quiz = await api("sendPoll", {
      chat_id: GROUP,
      question: "Primes?",
      options: ["2", "4"],
      type: "quiz",
      correct_option_ids: [0],
      explanation: "4 is even",
    });
    const {
      correct_option_id: _id,
      correct_option_ids: _ids,
      explanation: _explanation,
      explanation_entities: _entities,
      ...unanswered
    } = quiz.result.poll;
    expect(quiz.result.poll).toMatchObject({
      correct_option_id: 0,
      correct_option_ids: [0],
      explanation: "4 is even",
      explanation_entities: [],
    });

    const forward = await api(
      "forwardMessage",
      {
        chat_id: GROUP,
        from_chat_id: GROUP,
        message_id: quiz.result.message_id,
      },
      SECOND_TOKEN,
    );
    expect(forward.result.poll).toEqual(unanswered);
  });

  it("forwards with the message's origin and copies without it", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const other = await fake.createChat({ title: "Other", ownerId: OWNER });
    await fake.setBotMembership(other, me.id, { status: "administrator" });
    const original = await api("sendMessage", { chat_id: GROUP, text: "news" });

    const forward = await api("forwardMessage", {
      chat_id: other,
      from_chat_id: GROUP,
      message_id: original.result.message_id,
    });
    const copy = await api("copyMessage", {
      chat_id: other,
      from_chat_id: GROUP,
      message_id: original.result.message_id,
    });

    expect(forward.result).toMatchObject({
      text: "news",
      forward_origin: { type: "user", sender_user: { id: me.id } },
    });
    const copied = await fake.getMessage(other, copy.result.message_id);
    expect(copied.message.text).toBe("news");
    expect(copied.message.forward_origin).toBeUndefined();
  });

  it("refuses to forward from a chat the bot is not in", async () => {
    const { fake, api } = await setup();
    const hidden = await fake.createChat({ title: "Hidden", ownerId: OWNER });
    const member = await fake.createUser();
    await fake.join(hidden, member);
    const message = await fake.post(hidden, member, "secret");

    const forward = await api("forwardMessage", {
      chat_id: GROUP,
      from_chat_id: hidden,
      message_id: message,
    });
    expect(forward).toMatchObject({
      status: 400,
      description: "Bad Request: chat not found",
    });
  });

  it("protects a message, forward or album sent with protect_content, but lets the bot copy it", async () => {
    const { fake, api } = await setup();
    const sent = await api("sendMessage", {
      chat_id: GROUP,
      text: "members only",
      protect_content: true,
    });
    expect(sent.result.has_protected_content).toBe(true);
    const source = {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: sent.result.message_id,
    };

    expect(await api("forwardMessage", source)).toMatchObject({
      status: 400,
      description: "Bad Request: the message can't be forwarded",
    });
    const copy = await api("copyMessage", source);
    expect(copy.ok).toBe(true);
    const copied = await fake.getMessage(GROUP, copy.result.message_id);
    expect(copied.message.text).toBe("members only");
    expect(copied.message).not.toHaveProperty("has_protected_content");

    const forward = await api("forwardMessage", {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: copy.result.message_id,
      protect_content: true,
    });
    expect(forward.result.has_protected_content).toBe(true);
    const album = await api("sendMediaGroup", {
      chat_id: GROUP,
      media: [
        { type: "photo", media: "https://example.com/a.jpg" },
        { type: "photo", media: "https://example.com/b.jpg" },
      ],
      protect_content: true,
    });
    expect(
      album.result.map((message) => message.has_protected_content),
    ).toEqual([true, true]);
  });

  it("keeps the first origin when it forwards a forwarded message", async () => {
    const { fake, api } = await setup();
    const ann = await fake.createUser({ first_name: "Ann" });
    const bob = await fake.createUser({ first_name: "Bob" });
    await fake.join(GROUP, ann);
    const relayed = await fake.post(GROUP, ann, {
      text: "bob said hi",
      forwardFrom: { userId: bob },
    });
    const { message } = await fake.getMessage(GROUP, relayed);

    const forward = await api("forwardMessage", {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: relayed,
    });

    expect(forward.result.forward_origin).toEqual(message.forward_origin);
    expect(forward.result.forward_origin.sender_user.id).toBe(bob);
  });

  it("refuses to forward or copy a service message", async () => {
    const { fake, api } = await setup();
    await fake.join(GROUP, await fake.createUser());
    const service = (await fake.getMessages(GROUP)).find(
      (message) => message.new_chat_members,
    );
    const source = {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: service.message_id,
    };

    expect(await api("forwardMessage", source)).toMatchObject({
      status: 400,
      description: "Bad Request: the message can't be forwarded",
    });
    expect(await api("copyMessage", source)).toMatchObject({
      status: 400,
      description: "Bad Request: the message can't be copied",
    });
  });

  it("names a missing message as the one to forward or to copy", async () => {
    const { api } = await setup();
    const missing = { chat_id: GROUP, from_chat_id: GROUP, message_id: 999 };

    expect(await api("forwardMessage", missing)).toMatchObject({
      status: 400,
      description: "Bad Request: message to forward not found",
    });
    expect(await api("copyMessage", missing)).toMatchObject({
      status: 400,
      description: "Bad Request: message to copy not found",
    });
  });

  it("copies an open quiz only for the bot that sent it, and a closed one for any bot", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const quiz = await api("sendPoll", {
      chat_id: GROUP,
      question: "Primes?",
      options: ["2", "4"],
      type: "quiz",
      correct_option_ids: [0],
    });
    const source = {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: quiz.result.message_id,
    };

    // Another bot does not know an open quiz's correct options, which a copy
    // needs.
    expect(await api("copyMessage", source, SECOND_TOKEN)).toMatchObject({
      status: 400,
      description: "Bad Request: the message can't be copied",
    });
    expect((await api("copyMessage", source)).ok).toBe(true);
    await api("stopPoll", {
      chat_id: GROUP,
      message_id: quiz.result.message_id,
    });
    expect((await api("copyMessage", source, SECOND_TOKEN)).ok).toBe(true);
  });

  it("puts a copy's new caption only on media, formatted, and leaves out an empty one", async () => {
    const { fake, api } = await setup();
    const copy = async (messageId, fields) => {
      const copied = await api("copyMessage", {
        chat_id: GROUP,
        from_chat_id: GROUP,
        message_id: messageId,
        ...fields,
      });
      return (await fake.getMessage(GROUP, copied.result.message_id)).message;
    };
    const text = await api("sendMessage", { chat_id: GROUP, text: "plain" });
    const photo = await api("sendPhoto", {
      chat_id: GROUP,
      photo: "https://example.com/a.jpg",
      caption: "orig",
    });

    const textCopy = await copy(text.result.message_id, {
      caption: "<b>cap</b>",
      parse_mode: "HTML",
    });
    expect(textCopy.text).toBe("plain");
    expect(textCopy).not.toHaveProperty("caption");
    expect(
      await copy(photo.result.message_id, {
        caption: "<b>bold</b>",
        parse_mode: "HTML",
      }),
    ).toMatchObject({
      caption: "bold",
      caption_entities: [{ type: "bold", offset: 0, length: 4 }],
    });
    expect(
      await copy(photo.result.message_id, { caption: "" }),
    ).not.toHaveProperty("caption");

    // The 1024-character limit holds only where the caption is kept.
    const long = "a".repeat(1025);
    expect(
      await copy(text.result.message_id, { caption: long }),
    ).not.toHaveProperty("caption");
    expect(
      await api("copyMessage", {
        chat_id: GROUP,
        from_chat_id: GROUP,
        message_id: photo.result.message_id,
        caption: long,
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message caption is too long",
    });
  });

  it("forwards and copies one item of an album without its media_group_id", async () => {
    const { fake, api } = await setup();
    const ann = await fake.createUser();
    await fake.join(GROUP, ann);
    const album = await fake.postAlbum(GROUP, ann, [
      { type: "photo", bytes: PHOTO },
      { type: "photo", bytes: PHOTO },
    ]);
    const source = {
      chat_id: GROUP,
      from_chat_id: GROUP,
      message_id: album.message_ids[0],
    };

    const forward = await api("forwardMessage", source);
    const copy = await api("copyMessage", source);

    expect(forward.result.photo).toBeDefined();
    expect(forward.result).not.toHaveProperty("media_group_id");
    const copied = await fake.getMessage(GROUP, copy.result.message_id);
    expect(copied.message).not.toHaveProperty("media_group_id");
  });

  it("replaces a message's photo, and refuses a replacement that changes nothing", async () => {
    const { fake, api } = await setup();
    const form = (fields) => {
      const body = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        body.append(
          key,
          Buffer.isBuffer(value) ? new Blob([value]) : value,
          ...(Buffer.isBuffer(value) ? ["photo.jpg"] : []),
        );
      }
      return body;
    };
    const post = async (method, fields) =>
      (
        await fetch(`${fake.origin}/bot${TOKEN}/${method}`, {
          method: "POST",
          body: form(fields),
        })
      ).json();
    const sent = await post("sendPhoto", {
      chat_id: String(GROUP),
      photo: PHOTO,
      caption: "before",
    });
    const replaced = await post("editMessageMedia", {
      chat_id: String(GROUP),
      message_id: String(sent.result.message_id),
      media: JSON.stringify({
        type: "photo",
        media: "attach://next",
        caption: "after",
      }),
      next: Buffer.from("other-jpeg-bytes"),
    });
    expect(replaced.result.caption).toBe("after");
    expect(replaced.result.photo[0].file_id).not.toBe(
      sent.result.photo[0].file_id,
    );

    const unchanged = await api("editMessageMedia", {
      chat_id: GROUP,
      message_id: sent.result.message_id,
      media: {
        type: "photo",
        media: replaced.result.photo[0].file_id,
        caption: "after",
      },
    });
    expect(unchanged.status).toBe(400);
    expect(unchanged.description).toMatch(/message is not modified/);
  });

  it("edits media into a video, animation, audio or live photo with the fields a send gives", async () => {
    const { fake } = await setup();
    const sent = await upload(fake, "sendPhoto", {
      chat_id: GROUP,
      photo: PHOTO,
    });
    const edit = (media, files) =>
      upload(fake, "editMessageMedia", {
        chat_id: GROUP,
        message_id: sent.result.message_id,
        media,
        ...files,
      });

    const video = await edit(
      {
        type: "video",
        media: "attach://clip",
        width: 100,
        height: 200,
        duration: 7,
      },
      { clip: Buffer.from("video") },
    );
    expect(video.result.video).toMatchObject({
      width: 100,
      height: 200,
      duration: 7,
    });
    expect(video.result.photo).toBeUndefined();
    const animation = await edit(
      { type: "animation", media: "attach://gif" },
      { gif: Buffer.from("animation") },
    );
    expect(animation.result.document).toMatchObject({
      file_id: animation.result.animation.file_id,
      file_unique_id: animation.result.animation.file_unique_id,
    });
    expect(animation.result.video).toBeUndefined();
    const audio = await edit(
      {
        type: "audio",
        media: "attach://song",
        title: "Song",
        performer: "Band",
        duration: 120,
      },
      { song: Buffer.from("audio") },
    );
    expect(audio.result.audio).toMatchObject({
      title: "Song",
      performer: "Band",
      duration: 120,
    });
    expect(audio.result.animation).toBeUndefined();
    expect(audio.result.document).toBeUndefined();
    const live = await edit(
      { type: "live_photo", media: "attach://motion", photo: "attach://still" },
      { motion: Buffer.from("motion"), still: PHOTO },
    );
    expect(live.result.live_photo).toMatchObject({
      photo: live.result.photo,
      file_id: expect.any(String),
      width: expect.any(Number),
      height: expect.any(Number),
      duration: expect.any(Number),
    });
    expect(live.result.audio).toBeUndefined();
  });

  it("sends a live photo's video again on its own as a video", async () => {
    const { fake, api } = await setup();
    const message = async () =>
      (await api("sendMessage", { chat_id: GROUP, text: "media soon" })).result
        .message_id;
    const video = (
      await upload(fake, "editMessageMedia", {
        chat_id: GROUP,
        message_id: await message(),
        media: {
          type: "live_photo",
          media: "attach://motion",
          photo: "attach://still",
        },
        motion: Buffer.from("motion"),
        still: PHOTO,
      })
    ).result.live_photo;
    const same = { file_unique_id: video.file_unique_id };

    for (const [method, field] of [
      ["sendVideo", "video"],
      ["sendDocument", "document"],
    ]) {
      expect(
        (await api(method, { chat_id: GROUP, [field]: video.file_id })).result
          .video,
      ).toMatchObject(same);
    }
    const album = await api("sendMediaGroup", {
      chat_id: GROUP,
      media: [
        { type: "video", media: video.file_id },
        { type: "video", media: video.file_id },
      ],
    });
    expect(album.result.map((sent) => sent.video)).toMatchObject([same, same]);
    const edited = await api("editMessageMedia", {
      chat_id: GROUP,
      message_id: await message(),
      media: { type: "video", media: video.file_id },
    });
    expect(edited.result.video).toMatchObject(same);
  });

  it("gives each kind of file the file_path directory TDLib keeps it in", async () => {
    const { fake, api } = await setup();
    const url = "https://example.com/file.bin";
    const fileIds = [];
    for (const [method, field] of [
      ["sendPhoto", "photo"],
      ["sendVideo", "video"],
      ["sendAnimation", "animation"],
      ["sendDocument", "document"],
      ["sendSticker", "sticker"],
      ["sendVoice", "voice"],
      ["sendAudio", "audio"],
      ["sendVideoNote", "video_note"],
    ]) {
      const { result } = await api(method, { chat_id: GROUP, [field]: url });
      fileIds.push([result[field]].flat().at(-1).file_id);
    }
    const text = await api("sendMessage", { chat_id: GROUP, text: "live" });
    const live = await upload(fake, "editMessageMedia", {
      chat_id: GROUP,
      message_id: text.result.message_id,
      media: {
        type: "live_photo",
        media: "attach://motion",
        photo: "attach://still",
      },
      motion: Buffer.from("motion"),
      still: PHOTO,
    });
    fileIds.push(live.result.live_photo.file_id);

    const directories = [];
    for (const fileId of fileIds) {
      const { result } = await api("getFile", { file_id: fileId });
      directories.push(result.file_path.split("/")[0]);
    }
    expect(directories).toEqual([
      "photos",
      "videos",
      "animations",
      "documents",
      "stickers",
      "voice",
      "music",
      "video_notes",
      "photos",
    ]);
  });

  it("refuses media edits Telegram does not allow", async () => {
    const { fake, api } = await setup();
    const url = "https://example.com/a.jpg";
    const album = await api("sendMediaGroup", {
      chat_id: GROUP,
      media: [
        { type: "photo", media: url },
        { type: "photo", media: url },
      ],
    });
    const edit = (message, media) =>
      api("editMessageMedia", {
        chat_id: GROUP,
        message_id: message.message_id,
        media,
      });
    const unreadable = (reason) => ({
      status: 400,
      description: `Bad Request: can't parse InputMedia: ${reason}`,
    });
    const [first] = album.result;

    expect(await edit(first, undefined)).toMatchObject({
      status: 400,
      description: 'Bad Request: parameter "media" is required',
    });
    expect(await edit(first, "not json")).toMatchObject({
      status: 400,
      description: "Bad Request: can't parse input media JSON object",
    });
    // The caption's markup is read first, then the type, the file and
    // whether an edit takes the type.
    expect(
      await edit(first, {
        type: "sticker",
        caption: "<b>x",
        parse_mode: "HTML",
      }),
    ).toMatchObject(
      unreadable(
        "Can't parse entities: Can't find end tag corresponding to start tag \"b\"",
      ),
    );
    expect(await edit(first, { media: url })).toMatchObject(
      unreadable('Can\'t find field "type"'),
    );
    expect(await edit(first, { type: "sticker" })).toMatchObject(
      unreadable("media not found"),
    );
    expect(await edit(first, { type: "sticker", media: url })).toMatchObject(
      unreadable('type "sticker" is unsupported'),
    );
    expect(await edit(first, { type: "voice_note", media: url })).toMatchObject(
      unreadable('type "voice_note" is not allowed'),
    );
    expect(
      await edit(first, {
        type: "document",
        media: first.photo[0].file_id,
        disable_content_type_detection: true,
      }),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: can't use file of type Photo as DocumentAsFile",
    });
    expect(await edit(first, { type: "animation", media: url })).toMatchObject({
      status: 400,
      description:
        "Bad Request: message content type can't be used in an album",
    });
    expect(await edit(first, { type: "document", media: url })).toMatchObject({
      status: 400,
      description: "Bad Request: can't change media type in the album",
    });
    expect(
      (await edit(first, { type: "video", media: url })).result.video,
    ).toBeDefined();
    const sticker = await api("sendSticker", { chat_id: GROUP, sticker: url });
    const member = await fake.createUser();
    await fake.join(GROUP, member);
    const theirs = await fake.post(GROUP, member, { photo: PHOTO });
    for (const message of [sticker.result, { message_id: theirs }]) {
      expect(await edit(message, { type: "photo", media: url })).toMatchObject({
        status: 400,
        description: "Bad Request: message media can't be edited",
      });
    }
  });
});

describe("failures a test asks for", () => {
  it("answers the next calls with the error asked for, then works again", async () => {
    const { fake, api } = await setup();
    await fake.failNext({
      method: "sendMessage",
      chatId: GROUP,
      errorCode: 429,
      description: "Too Many Requests: retry after 3",
      retryAfter: 3,
      times: 2,
    });

    const first = await api("sendMessage", { chat_id: GROUP, text: "a" });
    const second = await api("sendMessage", { chat_id: GROUP, text: "b" });
    const third = await api("sendMessage", { chat_id: GROUP, text: "c" });

    expect(first).toMatchObject({
      status: 429,
      parameters: { retry_after: 3 },
    });
    expect(second.status).toBe(429);
    expect(third.result.text).toBe("c");
    const texts = (await fake.getMessages(GROUP)).map((m) => m.text);
    expect(texts).toEqual(["c"]);
  });

  it("describes an injected error by its code, and sends Retry-After with a 429", async () => {
    const { fake } = await setup();
    async function getMe() {
      const response = await fetch(`${fake.origin}/bot${TOKEN}/getMe`);
      return {
        retryAfter: response.headers.get("retry-after"),
        ...(await response.json()),
      };
    }

    await fake.failNext({ method: "getMe", errorCode: 429, retryAfter: 5 });
    expect(await getMe()).toEqual({
      retryAfter: "5",
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 5",
      parameters: { retry_after: 5 },
    });
    for (const [errorCode, description] of [
      [400, "Bad Request"],
      [401, "Unauthorized"],
      [403, "Forbidden"],
      [409, "Conflict"],
      [500, "Internal Server Error"],
    ]) {
      await fake.failNext({ method: "getMe", errorCode });
      expect(await getMe()).toEqual({
        retryAfter: null,
        ok: false,
        error_code: errorCode,
        description,
      });
    }
    // Telegram's 429 always says how long to wait.
    await expect(
      fake.failNext({ method: "getMe", errorCode: 429 }),
    ).rejects.toThrow("retry_after");
    await expect(
      fake.failNext({ method: "getMe", errorCode: 429, retryAfter: 2.5 }),
    ).rejects.toThrow("retry_after");
  });

  it("applies a call whose answer it then drops, as a lost connection would", async () => {
    const { fake } = await setup();
    await fake.failNext({ method: "sendMessage", dropAfterApply: true });

    await expect(
      fetch(`${fake.origin}/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: GROUP, text: "landed" }),
      }),
    ).rejects.toThrow();

    const texts = (await fake.getMessages(GROUP)).map((m) => m.text);
    expect(texts).toEqual(["landed"]);
    const { calls } = await fake.getCalls();
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      dropped: true,
    });
  });

  it("fails only the named bot's calls", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    await fake.failNext({ method: "sendMessage", botId: second.id });

    const first = await api("sendMessage", { chat_id: GROUP, text: "ok" });
    const other = await api(
      "sendMessage",
      { chat_id: GROUP, text: "no" },
      SECOND_TOKEN,
    );

    expect(first.ok).toBe(true);
    expect(other.status).toBe(400);
  });
});

describe("forum topics", () => {
  it("announces a new topic and posts into it, refusing a topic that does not exist", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const forum = await fake.createChat({
      title: "Forum",
      ownerId: OWNER,
      isForum: true,
    });
    await fake.setBotMembership(forum, me.id, { status: "administrator" });

    const thread = await fake.createTopic(forum, "News");
    await expect
      .poll(() =>
        hook.ofType("message").find((message) => message.forum_topic_created),
      )
      .toMatchObject({
        message_thread_id: thread,
        forum_topic_created: { name: "News" },
        chat: { id: forum, is_forum: true },
      });

    const sent = await api("sendMessage", {
      chat_id: forum,
      message_thread_id: thread,
      text: "in the topic",
    });
    expect(sent.result).toMatchObject({
      message_thread_id: thread,
      is_topic_message: true,
    });
    const missing = await api("sendMessage", {
      chat_id: forum,
      message_thread_id: 999,
      text: "nowhere",
    });
    expect(missing).toMatchObject({
      status: 400,
      description: "Bad Request: message thread not found",
    });
  });

  it("closes, reopens and renames a topic with can_manage_topics, posting Telegram's service messages", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, me.id, {
      rights: { can_manage_topics: true },
    });
    const thread = await fake.createTopic(forum, "News");
    const user = await fake.createUser();
    await fake.join(forum, user);
    const call = (method, params = {}) =>
      api(method, { chat_id: forum, message_thread_id: thread, ...params });

    expect((await call("closeForumTopic")).ok).toBe(true);
    expect(await call("closeForumTopic")).toMatchObject({
      status: 400,
      description: "Bad Request: TOPIC_NOT_MODIFIED",
    });
    await expect(
      fake.post(forum, user, { text: "hello?", threadId: thread }),
    ).rejects.toThrow("TOPIC_CLOSED");
    // The bot manages topics, so it still writes there.
    expect((await call("sendMessage", { text: "closed for now" })).ok).toBe(
      true,
    );
    expect((await call("reopenForumTopic")).ok).toBe(true);
    await fake.post(forum, user, { text: "open again", threadId: thread });

    expect((await call("editForumTopic", { name: "  " })).status).toBe(400);
    expect((await call("editForumTopic", {})).ok).toBe(true);
    expect(await call("editForumTopic", { name: "News" })).toMatchObject({
      description: "Bad Request: TOPIC_NOT_MODIFIED",
    });
    expect((await call("editForumTopic", { name: "Updates" })).ok).toBe(true);
    expect(await call("closeForumTopic", { message_thread_id: 0 })).toMatchObject(
      { description: "Bad Request: invalid forum topic identifier specified" },
    );
    expect(
      await call("closeForumTopic", { message_thread_id: 999 }),
    ).toMatchObject({ description: "Bad Request: TOPIC_ID_INVALID" });
    expect(
      await api("closeForumTopic", { chat_id: GROUP, message_thread_id: 5 }),
    ).toMatchObject({ description: "Bad Request: the chat is not a forum" });

    await fake.drainDeliveries();
    const service = hook
      .ofType("message")
      .filter(
        (message) =>
          message.forum_topic_closed ||
          message.forum_topic_reopened ||
          message.forum_topic_edited,
      );
    expect(service).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ id: me.id }),
        message_thread_id: thread,
        is_topic_message: true,
        forum_topic_closed: {},
      }),
      expect.objectContaining({ forum_topic_reopened: {} }),
      expect.objectContaining({ forum_topic_edited: { name: "Updates" } }),
    ]);
  });

  it("has a topic's service messages answer the topic's creation message", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, me.id, {
      rights: { can_manage_topics: true },
    });
    const thread = await fake.createTopic(forum, "News");

    await api("closeForumTopic", { chat_id: forum, message_thread_id: thread });
    await fake.renameTopic(forum, thread, "Updates");

    await fake.drainDeliveries();
    const service = hook
      .ofType("message")
      .filter((message) => message.forum_topic_closed || message.forum_topic_edited);
    expect(service).toEqual([
      expect.objectContaining({
        forum_topic_closed: {},
        reply_to_message: expect.objectContaining({
          message_id: thread,
          forum_topic_created: { name: "News", icon_color: 7322096 },
        }),
      }),
      expect.objectContaining({
        forum_topic_edited: { name: "Updates" },
        reply_to_message: expect.objectContaining({ message_id: thread }),
      }),
    ]);
  });

  it("refuses a bot without can_manage_topics as TDLib does once it knows the topic, and reports the rest as unimplemented", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, me.id, {
      rights: { can_delete_messages: true },
    });
    const thread = await fake.createTopic(forum, "News");
    const close = () =>
      api("closeForumTopic", { chat_id: forum, message_thread_id: thread });
    const notFound = {
      status: 404,
      description: "Not Found: method not found",
    };
    // TDLib may know the topic from fetched messages, or pass the call to
    // Telegram, whose answer no source gives.
    expect(await close()).toMatchObject(notFound);
    expect(
      await api("closeGeneralForumTopic", { chat_id: forum }),
    ).toMatchObject(notFound);
    expect((await fake.getCalls()).unimplemented).toEqual([
      "closeForumTopic without can_manage_topics on a topic the bot has not sent to",
      "closeGeneralForumTopic without can_manage_topics",
    ]);
    await api("sendMessage", {
      chat_id: forum,
      message_thread_id: thread,
      text: "hi",
    });
    expect(await close()).toMatchObject({
      description: "Bad Request: not enough rights to close or open the topic",
    });
    expect(
      await api("hideGeneralForumTopic", { chat_id: forum }),
    ).toMatchObject({
      description: "Bad Request: not enough rights to close or open the topic",
    });
  });

  it("deletes a topic with all its messages and sends no update for it", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, me.id, {
      rights: { can_delete_messages: true },
    });
    const thread = await fake.createTopic(forum, "Old");
    const inside = await fake.post(forum, OWNER, { text: "a", threadId: thread });
    const outside = await fake.post(forum, OWNER, "b");
    await fake.drainDeliveries();
    const before = hook.ofType("message").length;

    expect(
      (
        await api("deleteForumTopic", {
          chat_id: forum,
          message_thread_id: thread,
        })
      ).ok,
    ).toBe(true);
    expect((await fake.getMessage(forum, thread)).deleted).toBe(true);
    expect((await fake.getMessage(forum, inside)).deleted).toBe(true);
    expect((await fake.getMessage(forum, outside)).deleted).toBe(false);
    expect(
      await api("sendMessage", {
        chat_id: forum,
        message_thread_id: thread,
        text: "x",
      }),
    ).toMatchObject({ description: "Bad Request: message thread not found" });
    // No source gives Telegram's answer for the General topic.
    expect(
      await api("deleteForumTopic", { chat_id: forum, message_thread_id: 1 }),
    ).toMatchObject({ status: 404, description: "Not Found: method not found" });
    expect((await fake.getCalls()).unimplemented).toEqual([
      "deleteForumTopic with the General topic",
    ]);
    await fake.drainDeliveries();
    expect(hook.ofType("message")).toHaveLength(before);
  });

  it("needs can_delete_messages to delete a topic, also the bot's own", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, me.id, {
      rights: { can_manage_topics: true, can_delete_messages: false },
    });
    const theirs = await fake.createTopic(forum, "Theirs");
    const own = await fake.createTopic(forum, "Own", { by: me.id });
    const remove = (thread) =>
      api("deleteForumTopic", { chat_id: forum, message_thread_id: thread });
    await api("sendMessage", {
      chat_id: forum,
      message_thread_id: theirs,
      text: "hi",
    });

    expect(await remove(theirs)).toMatchObject({
      status: 400,
      description: "Bad Request: not enough rights to delete the topic",
    });
    // TDLib passes the bot's own topic on to Telegram, whose answer no
    // source gives.
    expect(await remove(own)).toMatchObject({
      status: 404,
      description: "Not Found: method not found",
    });
    expect((await fake.getCalls()).unimplemented).toEqual([
      "deleteForumTopic without can_delete_messages on a topic the bot created",
    ]);
    expect((await fake.getMessage(forum, own)).deleted).toBe(false);
  });

  it("closes, hides and renames the General topic, and unpins a topic's messages", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, me.id, {
      rights: { can_manage_topics: true, can_pin_messages: true },
    });
    const user = await fake.createUser();
    await fake.join(forum, user);
    const call = (method, params = {}) =>
      api(method, { chat_id: forum, ...params });

    expect((await call("hideGeneralForumTopic")).ok).toBe(true);
    // Hiding closed it too.
    await expect(fake.post(forum, user, "in General")).rejects.toThrow(
      "TOPIC_CLOSED",
    );
    expect(await call("closeGeneralForumTopic")).toMatchObject({
      description: "Bad Request: TOPIC_NOT_MODIFIED",
    });
    expect((await call("reopenGeneralForumTopic")).ok).toBe(true);
    // Reopening unhid it too.
    expect(await call("unhideGeneralForumTopic")).toMatchObject({
      description: "Bad Request: TOPIC_NOT_MODIFIED",
    });
    await fake.post(forum, user, "in General");
    expect(
      await call("editForumTopic", {
        message_thread_id: 1,
        icon_custom_emoji_id: "",
      }),
    ).toMatchObject({
      description: "Bad Request: GENERAL_MODIFY_ICON_FORBIDDEN",
    });
    expect((await call("editGeneralForumTopic", { name: "Lobby" })).ok).toBe(
      true,
    );

    await fake.drainDeliveries();
    const service = hook
      .ofType("message")
      .filter((message) => message.from?.id === me.id);
    expect(service.map((message) => Object.keys(message).at(-1))).toEqual([
      "general_forum_topic_hidden",
      "forum_topic_reopened",
      "forum_topic_edited",
    ]);
    expect(service.every((message) => !("message_thread_id" in message))).toBe(
      true,
    );

    const thread = await fake.createTopic(forum, "Pins");
    const inTopic = (
      await call("sendMessage", { message_thread_id: thread, text: "t" })
    ).result.message_id;
    const inGeneral = (await call("sendMessage", { text: "g" })).result
      .message_id;
    await call("pinChatMessage", { message_id: inTopic });
    await call("pinChatMessage", { message_id: inGeneral });
    expect(
      await call("unpinAllForumTopicMessages", { message_thread_id: thread }),
    ).toMatchObject({ ok: true });
    expect((await fake.getChat(forum)).pinned).toEqual([inGeneral]);
    await call("unpinAllGeneralForumTopicMessages");
    expect((await fake.getChat(forum)).pinned).toEqual([]);
  });

  it("sends a member's message in a topic as a reply to the topic's creation", async () => {
    const { fake } = await setup();
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    const thread = await fake.createTopic(forum, "Introductions");
    await fake.renameTopic(forum, thread, "Say hello");

    const id = await fake.post(forum, OWNER, { text: "hi", threadId: thread });
    const { message } = await fake.getMessage(forum, id);

    expect(message).toMatchObject({
      message_thread_id: thread,
      is_topic_message: true,
      reply_to_message: {
        message_id: thread,
        forum_topic_created: { name: "Introductions" },
      },
    });
  });
});

describe("each bot is itself", () => {
  it("answers each token as its own bot and records which bot called", async () => {
    const { fake, api, second } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url }, SECOND_TOKEN);

    expect((await api("getMe", {}, SECOND_TOKEN)).result).toMatchObject({
      id: second.id,
      username: "second_bot",
    });
    expect(await api("getMe", {}, "999:UNKNOWN")).toMatchObject({
      status: 401,
    });
    const bots = await (await fetch(`${fake.origin}/_fake/bots`)).json();
    expect(bots.map((bot) => [bot.id, bot.webhook?.url ?? null])).toEqual([
      [123456, null],
      [second.id, hook.url],
    ]);
    const { calls } = await fake.getCalls();
    expect(
      calls
        .filter((call) => call.method === "getMe")
        .map((call) => call.bot_id),
    ).toEqual([second.id]);
  });

  it("gives each bot its own file_id for a file, which it downloads by its own token", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const member = await fake.createUser();
    await fake.join(GROUP, member);
    await fake.post(GROUP, member, { photo: PHOTO });
    const photoFor = async (token) =>
      (await api("getUpdates", {}, token)).result
        .map((update) => update.message?.photo)
        .find(Boolean)
        .at(-1);
    const first = await photoFor(TOKEN);
    const other = await photoFor(SECOND_TOKEN);

    expect(other.file_id).not.toBe(first.file_id);
    expect(other.file_unique_id).toBe(first.file_unique_id);
    const file = await api("getFile", { file_id: other.file_id }, SECOND_TOKEN);
    const download = await fetch(
      `${fake.origin}/file/bot${SECOND_TOKEN}/${file.result.file_path}`,
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PHOTO);
    const firstPath = (await api("getFile", { file_id: first.file_id })).result
      .file_path;
    const foreign = await fetch(
      `${fake.origin}/file/bot${SECOND_TOKEN}/${firstPath}`,
    );
    expect(foreign.status).toBe(404);
  });

  it("refuses a file_id that another bot was given", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const member = await fake.createUser();
    await fake.join(GROUP, member);
    const id = await fake.post(GROUP, member, { photo: PHOTO });
    const fileId = (await fake.getMessage(GROUP, id)).message.photo.at(
      -1,
    ).file_id;

    expect(
      await api("sendPhoto", { chat_id: GROUP, photo: fileId }, SECOND_TOKEN),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: wrong file identifier/HTTP URL specified",
    });
    // Only a send turns Telegram's MEDIA_EMPTY into that text; an edit gets
    // it as it is.
    const own = await api(
      "sendMessage",
      { chat_id: GROUP, text: "photo soon" },
      SECOND_TOKEN,
    );
    expect(
      await api(
        "editMessageMedia",
        {
          chat_id: GROUP,
          message_id: own.result.message_id,
          media: { type: "photo", media: fileId },
        },
        SECOND_TOKEN,
      ),
    ).toMatchObject({ status: 400, description: "Bad Request: MEDIA_EMPTY" });
    expect(
      await api("getFile", { file_id: fileId }, SECOND_TOKEN),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: wrong file_id or the file is temporarily unavailable",
    });
  });

  it("refuses a second bot's message to someone who wrote only to the first", async () => {
    const { fake, api } = await setup();
    const user = await fake.createUser();
    await fake.sendDirectMessage(user, "/start");

    expect((await api("sendMessage", { chat_id: user, text: "hi" })).ok).toBe(
      true,
    );
    expect(
      await api("sendMessage", { chat_id: user, text: "hi" }, SECOND_TOKEN),
    ).toMatchObject({
      status: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    });
  });

  it("finds a private chat it never had only with a user the bot knows", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id);
    // Known to the second bot through the group; never wrote to it.
    const known = await fake.createUser({ first_name: "Ann" });
    await fake.join(GROUP, known);
    // Wrote only to the first bot, and shares nothing with the second.
    const unknown = await fake.createUser({ first_name: "Bob" });
    await fake.sendDirectMessage(unknown, "/start");
    const notFound = { status: 400, description: "Bad Request: chat not found" };
    const calls = (user) => [
      ["getChat", { chat_id: user }],
      ["deleteMessage", { chat_id: user, message_id: 1 }],
      ["pinChatMessage", { chat_id: user, message_id: 1 }],
      ["unpinAllChatMessages", { chat_id: user }],
      ["editMessageText", { chat_id: user, message_id: 1, text: "x" }],
      ["setMessageReaction", { chat_id: user, message_id: 1 }],
      [
        "forwardMessage",
        { chat_id: GROUP, from_chat_id: user, message_id: 1 },
      ],
      ["sendChatAction", { chat_id: user, action: "typing" }],
    ];

    for (const [method, params] of calls(unknown)) {
      expect(await api(method, params, SECOND_TOKEN)).toMatchObject(notFound);
    }
    const answers = {};
    for (const [method, params] of calls(known)) {
      const { status, ok, description, result } = await api(
        method,
        params,
        SECOND_TOKEN,
      );
      answers[method] = ok ? result : { status, description };
    }
    expect(answers).toEqual({
      getChat: expect.objectContaining({
        id: known,
        type: "private",
        first_name: "Ann",
      }),
      deleteMessage: {
        status: 400,
        description: "Bad Request: message to delete not found",
      },
      pinChatMessage: {
        status: 400,
        description: "Bad Request: message to pin not found",
      },
      unpinAllChatMessages: true,
      editMessageText: {
        status: 400,
        description: "Bad Request: message to edit not found",
      },
      setMessageReaction: {
        status: 400,
        description: "Bad Request: MESSAGE_ID_INVALID",
      },
      forwardMessage: {
        status: 400,
        description: "Bad Request: message to forward not found",
      },
      sendChatAction: true,
    });
    // Sends still need the user to have written to the bot.
    expect(
      await api("sendMessage", { chat_id: known, text: "hi" }, SECOND_TOKEN),
    ).toMatchObject({
      status: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    });
    expect(await api("getChat", { chat_id: unknown })).toMatchObject({
      ok: true,
    });
  });

  it("keeps a user's private chat with each bot apart, with its own message ids", async () => {
    const { fake, api, second } = await setup();
    const first = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: first.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    const user = await fake.createUser({ first_name: "Ann" });

    const toFirst = await fake.sendDirectMessage(user, "hi first");
    const toSecond = await fake.sendDirectMessage(user, "hi second", {
      botId: second.id,
    });
    expect([toFirst, toSecond]).toEqual([1, 1]);
    expect(first.ofType("message").map((m) => m.text)).toEqual(["hi first"]);
    expect(other.ofType("message").map((m) => m.text)).toEqual(["hi second"]);

    // The second bot's message 1 is its own, not the first bot's.
    const pinned = await api(
      "pinChatMessage",
      { chat_id: user, message_id: 1 },
      SECOND_TOKEN,
    );
    expect(pinned.ok).toBe(true);
    expect((await api("getChat", { chat_id: user })).result).not.toHaveProperty(
      "pinned_message",
    );
    expect(
      (await api("getChat", { chat_id: user }, SECOND_TOKEN)).result
        .pinned_message,
    ).toMatchObject({ text: "hi second" });
    expect(
      (
        await api(
          "deleteMessage",
          { chat_id: user, message_id: 1 },
          SECOND_TOKEN,
        )
      ).ok,
    ).toBe(true);
    expect((await fake.getDirectMessages(user)).map((m) => m.text)).toEqual([
      "hi first",
    ]);
    // What is left of the second bot's chat: the pin's service message.
    expect(await fake.getDirectMessages(user, { botId: second.id })).toEqual([
      expect.objectContaining({ message_id: 2, pinned_message: expect.anything() }),
    ]);
    const { messages } = await fake.getMessageLog(user, {
      botId: second.id,
      includeDeleted: true,
    });
    expect(messages.map((entry) => entry.deleted)).toEqual([true, false]);
    await fake.waitFor({
      kind: "message",
      chatId: user,
      botId: second.id,
      userId: user,
      text: "hi second",
      deleted: true,
    });
  });

  it("names the bot of each private message in the log, and needs bot_id for a user with two bot chats", async () => {
    const { fake, second } = await setup();
    const me = Number(TOKEN.split(":")[0]);
    const ann = await fake.createUser();
    await fake.sendDirectMessage(ann, "to the first");

    expect(
      (await fake.getMessageLog(ann)).messages.map((entry) => entry.bot_id),
    ).toEqual([me]);
    await fake.sendDirectMessage(ann, "to the second", { botId: second.id });
    await expect(fake.getMessageLog(ann)).rejects.toThrow(/bot_id/);
    expect(
      (await fake.getMessageLog(ann, { botId: second.id })).messages.map(
        (entry) => [entry.bot_id, entry.message.text],
      ),
    ).toEqual([[second.id, "to the second"]]);
  });

  it("draws the message ids of all of a bot's private chats from one sequence", async () => {
    const { fake, api, second } = await setup();
    const ann = await fake.createUser({ first_name: "Ann" });
    const bob = await fake.createUser({ first_name: "Bob" });

    expect(await fake.sendDirectMessage(ann, "/start")).toBe(1);
    expect(await fake.sendDirectMessage(bob, "/start")).toBe(2);
    const toAnn = await api("sendMessage", { chat_id: ann, text: "hi Ann" });
    expect(toAnn.result.message_id).toBe(3);
    expect(
      await fake.sendDirectMessage(ann, "/start", { botId: second.id }),
    ).toBe(1);
    expect(await fake.sendDirectMessage(bob, "thanks")).toBe(4);
    // Each chat keeps only its own: Bob's chat has no message 3.
    expect(
      await api("deleteMessage", { chat_id: bob, message_id: 3 }),
    ).toMatchObject({ status: 400 });
  });

  it("lets a user start any bot by its link, and only that bot then writes to them", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id);
    const user = await fake.createUser();
    await fake.join(GROUP, user);
    const { message_id } = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "Start the other bot",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Go", url: "https://t.me/second_bot?start=hello" }],
          ],
        },
      })
    ).result;

    const opened = await fake.openUrlButton(GROUP, message_id, user, "Go");
    expect(opened).toMatchObject({
      link: "start",
      bot_id: second.id,
      chat_id: user,
      message_id: 1,
    });
    expect(
      (await fake.getDirectMessages(user, { botId: second.id }))[0].text,
    ).toBe("/start hello");
    expect(
      (await api("sendMessage", { chat_id: user, text: "hi" }, SECOND_TOKEN))
        .ok,
    ).toBe(true);
    expect(await api("sendMessage", { chat_id: user, text: "hi" })).toMatchObject(
      {
        status: 403,
        description: "Forbidden: bot can't initiate conversation with a user",
      },
    );
  });

  it("sends a button press only to the bot that sent the message, ephemeral or not", async () => {
    const { fake, api, second } = await setup();
    const first = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: first.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const vote = {
      chat_id: GROUP,
      text: "vote",
      reply_markup: {
        inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]],
      },
    };
    const sent = await api("sendMessage", vote, SECOND_TOKEN);
    const ephemeral = await api(
      "sendMessage",
      { ...vote, ephemeral_message_parameters: { receiver_user_id: OWNER } },
      SECOND_TOKEN,
    );
    const answer = (index) =>
      api(
        "answerCallbackQuery",
        { callback_query_id: other.ofType("callback_query")[index].id },
        SECOND_TOKEN,
      );

    const press = fake.pressButton(GROUP, sent.result.message_id, OWNER, "yes");
    await expect.poll(() => other.ofType("callback_query").length).toBe(1);
    await answer(0);
    await press;
    const ephemeralPress = fake.pressEphemeralButton(
      GROUP,
      ephemeral.result.ephemeral_message_id,
      OWNER,
      "yes",
    );
    await expect.poll(() => other.ofType("callback_query").length).toBe(2);
    await answer(1);
    await ephemeralPress;
    expect(first.ofType("callback_query")).toEqual([]);
  });

  it("lets only the bot that received a callback query answer it with an ephemeral message", async () => {
    const { fake, api, second } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const prompt = await api("sendMessage", {
      chat_id: GROUP,
      text: "Verify",
      reply_markup: {
        inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
      },
    });
    const press = fake.pressButton(
      GROUP,
      prompt.result.message_id,
      OWNER,
      "ok",
    );
    await expect.poll(() => hook.ofType("callback_query").length).toBe(1);
    const [query] = hook.ofType("callback_query");
    await api("answerCallbackQuery", { callback_query_id: query.id });
    await press;

    expect(
      await api(
        "sendMessage",
        {
          chat_id: GROUP,
          text: "verified",
          ephemeral_message_parameters: {
            receiver_user_id: OWNER,
            callback_query_id: query.id,
          },
        },
        SECOND_TOKEN,
      ),
    ).toMatchObject({ status: 400 });
  });

  it("lets only the bot that sent an ephemeral message edit or delete it", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const id = (
      await api("sendMessage", {
        chat_id: GROUP,
        text: "only you",
        ephemeral_message_parameters: { receiver_user_id: OWNER },
      })
    ).result.ephemeral_message_id;
    const target = {
      chat_id: GROUP,
      receiver_user_id: OWNER,
      ephemeral_message_id: id,
    };

    expect(
      await api(
        "editEphemeralMessageText",
        { ...target, text: "mine now" },
        SECOND_TOKEN,
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await api("deleteEphemeralMessage", target, SECOND_TOKEN),
    ).toMatchObject({ status: 400 });
    expect(await fake.getEphemeralMessage(GROUP, id)).toMatchObject({
      deleted: false,
      message: { text: "only you" },
    });
  });
});

describe("bot membership", () => {
  it("tells the chat's other bots and its members when a bot joins", async () => {
    const { fake, api, second } = await setup();
    const hook = await startReceiver();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message", "chat_member", "my_chat_member"],
    });

    await fake.setBotMembership(GROUP, second.id, { status: "member" });

    await expect.poll(() => hook.ofType("chat_member").length).toBe(1);
    expect(hook.ofType("chat_member")[0]).toMatchObject({
      new_chat_member: { status: "member", user: { id: second.id } },
    });
    await expect
      .poll(() =>
        hook
          .ofType("message")
          .some((message) =>
            message.new_chat_members?.some((user) => user.id === second.id),
          ),
      )
      .toBe(true);
    expect(hook.ofType("my_chat_member")).toEqual([]);
  });

  it("refuses a kicked bot's messages", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "kicked" });
    expect(
      await api("sendMessage", { chat_id: GROUP, text: "x" }, SECOND_TOKEN),
    ).toMatchObject({
      status: 403,
      description: "Forbidden: bot was kicked from the supergroup chat",
    });
  });

  it("deletes another user's message only with the right to", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const member = await fake.createUser();
    await fake.join(GROUP, member);
    const id = await fake.post(GROUP, member, "spam");

    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_delete_messages: false },
    });
    expect(
      await api("deleteMessage", { chat_id: GROUP, message_id: id }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message can't be deleted",
    });
    await fake.setBotMembership(GROUP, me.id, { status: "administrator" });
    expect(
      (await api("deleteMessage", { chat_id: GROUP, message_id: id })).result,
    ).toBe(true);
  });

  it("refuses to let a bot restrict itself, whichever bot it is", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    expect(
      await api(
        "restrictChatMember",
        {
          chat_id: GROUP,
          user_id: second.id,
          permissions: { can_send_messages: false },
        },
        SECOND_TOKEN,
      ),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: can't restrict self",
    });
  });

  it("sends chat_member only to the chat's administrator bots", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    const hook = await startReceiver();
    await api(
      "setWebhook",
      { url: hook.url, allowed_updates: ["message", "chat_member"] },
      SECOND_TOKEN,
    );

    const ann = await fake.createUser();
    await fake.join(GROUP, ann);
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const bob = await fake.createUser();
    await fake.join(GROUP, bob);

    const joined = hook
      .ofType("message")
      .flatMap((message) => message.new_chat_members ?? [])
      .map((user) => user.id);
    expect(joined).toEqual(expect.arrayContaining([ann, bob]));
    expect(
      hook
        .ofType("chat_member")
        .map((change) => change.new_chat_member.user.id),
    ).toEqual([bob]);
  });

  it("sends chat_join_request only to bots that can invite users", async () => {
    const { fake, api, second } = await setup();
    await fake.setBotMembership(GROUP, second.id, {
      status: "administrator",
      rights: { can_invite_users: false },
    });
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url }, SECOND_TOKEN);
    const link = (
      await api("createChatInviteLink", {
        chat_id: GROUP,
        creates_join_request: true,
      })
    ).result.invite_link;

    await fake.joinByLink(link, await fake.createUser());
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const bob = await fake.createUser();
    await fake.joinByLink(link, bob);

    expect(
      hook.ofType("chat_join_request").map((request) => request.from.id),
    ).toEqual([bob]);
  });

  it("tells a bot through my_chat_member when another bot promotes, demotes or bans it", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url }, SECOND_TOKEN);
    await fake.setBotMembership(GROUP, second.id, { status: "member" });

    const promote = (rights) =>
      api("promoteChatMember", {
        chat_id: GROUP,
        user_id: second.id,
        ...rights,
      });
    expect((await promote({ can_delete_messages: true })).ok).toBe(true);
    expect((await promote({})).ok).toBe(true);
    expect(
      (await api("banChatMember", { chat_id: GROUP, user_id: second.id })).ok,
    ).toBe(true);

    await expect
      .poll(() =>
        hook
          .ofType("my_chat_member")
          .map((change) => [change.from.id, change.new_chat_member.status]),
      )
      .toEqual([
        [OWNER, "member"],
        [me.id, "administrator"],
        [me.id, "member"],
        [me.id, "kicked"],
      ]);
  });

  it("lists other administrator bots only when return_bots is set", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const admins = async (params) =>
      (await api("getChatAdministrators", { chat_id: GROUP, ...params })).result
        .map((admin) => admin.user.id)
        .sort();

    expect(await admins({})).toEqual([OWNER, me.id].sort());
    expect(await admins({ return_bots: true })).toEqual(
      [OWNER, me.id, second.id].sort(),
    );
  });

  it("refuses a bot kicked from or no longer in a supergroup or channel, even for reads", async () => {
    const { fake, api, second } = await setup();
    const ann = await fake.createUser();
    await fake.join(GROUP, ann);
    const calls = [
      ["getChat", {}],
      ["getChatMember", { user_id: ann }],
      ["getChatMember", { user_id: second.id }],
      ["getChatAdministrators", {}],
      ["getChatMemberCount", {}],
      ["leaveChat", {}],
      ["banChatMember", { user_id: ann }],
    ];
    const answers = async (chat) =>
      Promise.all(
        calls.map(async ([method, params]) => {
          const answer = await api(
            method,
            { chat_id: chat, ...params },
            SECOND_TOKEN,
          );
          return [answer.status, answer.description];
        }),
      );

    await fake.setBotMembership(GROUP, second.id, { status: "kicked" });
    expect(new Set((await answers(GROUP)).map(JSON.stringify))).toEqual(
      new Set([
        JSON.stringify([
          403,
          "Forbidden: bot was kicked from the supergroup chat",
        ]),
      ]),
    );
    await fake.setBotMembership(GROUP, second.id, { status: "left" });
    expect(new Set((await answers(GROUP)).map(JSON.stringify))).toEqual(
      new Set([
        JSON.stringify([
          403,
          "Forbidden: bot is not a member of the supergroup chat",
        ]),
      ]),
    );
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, second.id, { status: "kicked" });
    expect(
      await api("getChat", { chat_id: channel }, SECOND_TOKEN),
    ).toMatchObject({
      status: 403,
      description: "Forbidden: bot was kicked from the channel chat",
    });
  });

  it("lets a bot removed from a basic group read the chat and its own status and delete its ephemeral messages, but nothing else", async () => {
    const { fake, api, second } = await setup();
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, second.id, { status: "administrator" });
    const call = (method, params = {}) =>
      api(method, { chat_id: group, ...params }, SECOND_TOKEN);
    const ephemeral = (
      await call("sendMessage", {
        text: "only you",
        ephemeral_message_parameters: { receiver_user_id: OWNER },
      })
    ).result;

    await fake.setBotMembership(group, second.id, { status: "left" });
    expect((await call("getChat")).result).toMatchObject({ type: "group" });
    expect(
      (await call("getChatMember", { user_id: second.id })).result.status,
    ).toBe("left");
    expect(
      await call("deleteEphemeralMessage", {
        receiver_user_id: OWNER,
        ephemeral_message_id: ephemeral.ephemeral_message_id,
      }),
    ).toMatchObject({ ok: true });
    for (const [method, params] of [
      ["getChatMemberCount", {}],
      ["getChatMember", { user_id: OWNER }],
      ["sendMessage", { text: "hi" }],
    ]) {
      expect(await call(method, params)).toMatchObject({
        status: 403,
        description: "Forbidden: bot is not a member of the group chat",
      });
    }
    await fake.setBotMembership(group, second.id, { status: "kicked" });
    expect(
      (await call("getChatMember", { user_id: second.id })).result.status,
    ).toBe("kicked");
    expect(await call("getChatAdministrators")).toMatchObject({
      status: 403,
      description: "Forbidden: bot was kicked from the group chat",
    });
  });

  it("answers chat not found for a chat the bot was never in", async () => {
    const { fake, api } = await setup();
    const hidden = await fake.createChat({ ownerId: OWNER });
    for (const method of ["getChat", "getChatMemberCount", "sendMessage"]) {
      expect(
        await api(method, { chat_id: hidden, text: "hi" }, SECOND_TOKEN),
      ).toMatchObject({
        status: 400,
        description: "Bad Request: chat not found",
      });
    }
  });

  it("reads a call's arguments, and a forward's source chat, before the chat it addresses", async () => {
    const { fake, api, second } = await setup();
    const hidden = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(GROUP, second.id, { status: "kicked" });
    const call = (method, params) =>
      api(method, { chat_id: GROUP, ...params }, SECOND_TOKEN);

    expect(await call("sendMessage", { text: "" })).toMatchObject({
      status: 400,
      description: "Bad Request: message text is empty",
    });
    for (const method of [
      "banChatMember",
      "getChatMember",
      "deleteMessageReaction",
    ]) {
      expect(
        await call(method, { user_id: "abc", message_id: 1 }),
      ).toMatchObject({
        status: 400,
        description: "Bad Request: invalid user_id specified",
      });
    }
    for (const method of ["restrictChatMember", "setChatPermissions"]) {
      expect(
        await call(method, { user_id: OWNER, permissions: "none" }),
      ).toMatchObject({
        status: 400,
        description: "Bad Request: can't parse permissions JSON object",
      });
    }
    expect(await call("sendChatAction", { action: "dancing" })).toMatchObject({
      status: 400,
      description: "Bad Request: wrong parameter action in request",
    });
    expect(
      await call("forwardMessage", { from_chat_id: hidden, message_id: 1 }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: chat not found",
    });
  });

  it("checks the bot's access to the chat of the message it replies to", async () => {
    const { fake, api, second } = await setup();
    const other = await fake.createChat({ ownerId: OWNER });
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
    await fake.setBotMembership(other, second.id, { status: "member" });
    const message = await fake.post(other, OWNER, "elsewhere");
    const reply = (chat) =>
      api(
        "sendMessage",
        {
          chat_id: GROUP,
          text: "re",
          reply_parameters: { chat_id: chat, message_id: message },
        },
        SECOND_TOKEN,
      );

    await fake.setBotMembership(other, second.id, { status: "kicked" });
    expect(await reply(other)).toMatchObject({
      status: 403,
      description: "Forbidden: bot was kicked from the supergroup chat",
    });
    await fake.setBotMembership(other, second.id, { status: "left" });
    expect(await reply(other)).toMatchObject({
      status: 403,
      description: "Forbidden: bot is not a member of the supergroup chat",
    });
  });

  it("says can_be_edited only to the bot that promoted the administrator", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    await fake.setBotMembership(GROUP, me.id, {
      status: "administrator",
      rights: { can_promote_members: true },
    });
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const hooks = [await startReceiver(), await startReceiver()];
    await api("setWebhook", {
      url: hooks[0].url,
      allowed_updates: ["chat_member"],
    });
    await api(
      "setWebhook",
      { url: hooks[1].url, allowed_updates: ["chat_member"] },
      SECOND_TOKEN,
    );
    const ann = await fake.createUser();
    await fake.join(GROUP, ann);

    await api("promoteChatMember", {
      chat_id: GROUP,
      user_id: ann,
      can_delete_messages: true,
    });

    const editable = async (token) =>
      (await api("getChatMember", { chat_id: GROUP, user_id: ann }, token))
        .result.can_be_edited;
    expect(await editable(TOKEN)).toBe(true);
    expect(await editable(SECOND_TOKEN)).toBe(false);
    await expect
      .poll(() =>
        hooks.map((hook) => hook.ofType("chat_member").at(-1)?.new_chat_member),
      )
      .toEqual([
        expect.objectContaining({ can_be_edited: true }),
        expect.objectContaining({ can_be_edited: false }),
      ]);
  });
});

describe("deleting a bot", () => {
  it("takes a deleted bot out of its chats, telling the other bots, and refuses its token", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    for (const chat of [GROUP, channel]) {
      await fake.setBotMembership(chat, second.id, { status: "administrator" });
    }
    const hook = await startReceiver();
    await api("setWebhook", {
      url: hook.url,
      allowed_updates: ["message", "chat_member", "callback_query"],
    });
    const sent = await api(
      "sendMessage",
      {
        chat_id: GROUP,
        text: "vote",
        reply_markup: {
          inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]],
        },
      },
      SECOND_TOKEN,
    );
    const pending = (await api("getUpdates", {}, SECOND_TOKEN)).result;
    // A long poll that only a wake-up ends within the test's time.
    const poll = api(
      "getUpdates",
      { offset: pending.at(-1).update_id + 1, timeout: 50 },
      SECOND_TOKEN,
    );
    await fake.waitFor({
      kind: "call",
      botId: second.id,
      method: "getUpdates",
      params: { timeout: "50" },
    });

    expect(await fake.deleteBot(second.id)).toEqual({ deleted: true });

    // Its waiting getUpdates answers at once; then its token is unknown.
    expect((await poll).result).toEqual([]);
    expect(await api("getMe", {}, SECOND_TOKEN)).toMatchObject({
      status: 401,
      description: "Unauthorized",
    });
    expect((await fake.getCalls()).rejected_requests.at(-1)).toMatchObject({
      method: "getMe",
      bot_id: second.id,
      status: 401,
    });
    await expect
      .poll(() =>
        hook
          .ofType("chat_member")
          .filter((change) => change.new_chat_member.status === "left")
          .map((change) => [
            change.chat.id,
            change.from.id,
            change.old_chat_member.status,
            change.new_chat_member.user.id,
          ]),
      )
      .toEqual([
        [GROUP, second.id, "administrator", second.id],
        [channel, second.id, "administrator", second.id],
      ]);
    await expect
      .poll(() =>
        hook
          .ofType("message")
          .filter((message) => message.left_chat_member)
          .map((message) => [message.from.id, message.left_chat_member.id]),
      )
      .toEqual([[second.id, second.id]]);
    expect(
      (await api("getChatMember", { chat_id: GROUP, user_id: second.id }))
        .result.status,
    ).toBe("left");
    // A press on its button reaches no bot.
    expect(
      await fake.pressButton(GROUP, sent.result.message_id, OWNER, "yes"),
    ).toEqual({ answered: false });
    expect(hook.ofType("callback_query")).toEqual([]);
    await expect(fake.deleteBot(me.id)).rejects.toThrow(
      "the first bot can't be deleted",
    );
  });
});

describe("chats created during a run", () => {
  it("keeps the pinned messages and members a test can read", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({
      title: "Announcements",
      type: "channel",
      ownerId: OWNER,
    });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const first = await api("sendMessage", { chat_id: channel, text: "one" });
    const second = await api("sendMessage", { chat_id: channel, text: "two" });
    for (const sent of [first, second]) {
      await api("pinChatMessage", {
        chat_id: channel,
        message_id: sent.result.message_id,
      });
    }

    expect(await fake.getChat(channel)).toMatchObject({
      id: channel,
      type: "channel",
      pinned: [second.result.message_id, first.result.message_id],
      members: expect.arrayContaining([
        { user_id: OWNER, status: "creator" },
        { user_id: me.id, status: "administrator" },
      ]),
    });
    await api("unpinAllChatMessages", { chat_id: channel });
    expect((await fake.getChat(channel)).pinned).toEqual([]);
  });

  it("forwards a channel post with the channel as its origin, and copies with a new caption", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const post = await api("sendPhoto", {
      chat_id: channel,
      photo: "https://example.com/photo.jpg",
      caption: "old",
    });

    const forward = await api("forwardMessage", {
      chat_id: GROUP,
      from_chat_id: channel,
      message_id: post.result.message_id,
    });
    expect(forward.result.forward_origin).toMatchObject({
      type: "channel",
      chat: { id: channel },
      message_id: post.result.message_id,
    });
    const copy = await api("copyMessage", {
      chat_id: GROUP,
      from_chat_id: channel,
      message_id: post.result.message_id,
      caption: "new",
    });
    expect(Object.keys(copy.result)).toEqual(["message_id"]);
    const copied = await fake.getMessage(GROUP, copy.result.message_id);
    expect(copied.message).toMatchObject({ caption: "new" });
    expect(copied.message.photo).toBeDefined();
  });
});

describe("polls and parsed options", () => {
  it("keeps a poll's attached photo and refuses more than twelve options", async () => {
    const { fake } = await setup();
    const body = new FormData();
    body.append("chat_id", String(GROUP));
    body.append("question", "Which?");
    body.append("options", JSON.stringify(["A", "B"]));
    body.append("type", "quiz");
    body.append("correct_option_ids", JSON.stringify([1]));
    body.append(
      "media",
      JSON.stringify({ type: "photo", media: "attach://pic" }),
    );
    body.append("pic", new Blob([PHOTO]), "pic.jpg");
    const poll = await (
      await fetch(`${fake.origin}/bot${TOKEN}/sendPoll`, {
        method: "POST",
        body,
      })
    ).json();
    expect(poll.result.poll).toMatchObject({
      type: "quiz",
      correct_option_ids: [1],
      media: { photo: expect.any(Array) },
    });

    const tooMany = await fetch(`${fake.origin}/bot${TOKEN}/sendPoll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: GROUP,
        question: "Many?",
        options: Array.from({ length: 13 }, (_, index) => String(index)),
      }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("reads entities sent as a JSON string", async () => {
    const { fake } = await setup();
    const body = new FormData();
    body.append("chat_id", String(GROUP));
    body.append("text", "bold");
    body.append(
      "entities",
      JSON.stringify([{ type: "bold", offset: 0, length: 4 }]),
    );
    await fetch(`${fake.origin}/bot${TOKEN}/sendMessage`, {
      method: "POST",
      body,
    });
    const { calls } = await fake.getCalls();
    expect(calls.at(-1).params.entities).toEqual([
      { type: "bold", offset: 0, length: 4 },
    ]);
  });
});

describe("failures and topics a test can inspect", () => {
  it("lists pending failures, marks the failed call, and clears them", async () => {
    const { fake, api } = await setup();
    await fake.failNext({ method: "sendMessage", errorCode: 500, times: 2 });
    await api("sendMessage", { chat_id: GROUP, text: "x" });

    const pending = await (await fetch(`${fake.origin}/_fake/failures`)).json();
    expect(pending).toMatchObject([{ method: "sendMessage", remaining: 1 }]);
    const { calls } = await fake.getCalls();
    expect(calls.at(-1)).toMatchObject({ method: "sendMessage", failed: 500 });

    await fake.clearFailures();
    expect((await api("sendMessage", { chat_id: GROUP, text: "y" })).ok).toBe(
      true,
    );
  });

  it("lists a forum's topics and announces a rename", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const hook = await startReceiver();
    await api("setWebhook", { url: hook.url });
    const forum = await fake.createChat({ ownerId: OWNER, isForum: true });
    await fake.setBotMembership(forum, me.id, { status: "administrator" });
    const thread = await fake.createTopic(forum, "Old");

    await fake.renameTopic(forum, thread, "New");

    const topics = await (
      await fetch(`${fake.origin}/_fake/chats/${forum}/topics`)
    ).json();
    expect(topics).toEqual([{ message_thread_id: thread, name: "New" }]);
    await expect
      .poll(() =>
        hook.ofType("message").find((message) => message.forum_topic_edited),
      )
      .toMatchObject({
        message_thread_id: thread,
        forum_topic_edited: { name: "New" },
      });
  });
});

describe("precise fault receipts", () => {
  it("targets the second matching user/message attempt and preserves unrelated operations", async () => {
    const { fake, api } = await setup();
    const ann = await fake.createUser(),
      bob = await fake.createUser();
    await fake.join(GROUP, ann);
    await fake.join(GROUP, bob);
    await fake.failNext({
      method: "restrictChatMember",
      chatId: GROUP,
      userId: ann,
      attempt: 2,
      errorCode: 403,
    });
    const params = {
      chat_id: GROUP,
      user_id: ann,
      permissions: { can_send_messages: false },
    };
    expect(
      await api("restrictChatMember", { ...params, user_id: bob }),
    ).toMatchObject({ ok: true });
    expect(await api("restrictChatMember", params)).toMatchObject({ ok: true });
    expect(await api("restrictChatMember", params)).toMatchObject({
      ok: false,
      status: 403,
    });
    const a = await fake.post(GROUP, OWNER, "a"),
      b = await fake.post(GROUP, OWNER, "b");
    await fake.failNext({
      method: "deleteMessage",
      chatId: GROUP,
      messageId: a,
      userId: OWNER,
      errorCode: 403,
    });
    expect(
      await api("deleteMessage", { chat_id: GROUP, message_id: b }),
    ).toMatchObject({ ok: true });
    expect(
      await api("deleteMessage", { chat_id: GROUP, message_id: a }),
    ).toMatchObject({ ok: false });
    expect(await fake.getMessage(GROUP, a)).toMatchObject({ deleted: false });
    await fake.failNext({
      method: "deleteMessages",
      chatId: GROUP,
      messageId: a,
      errorCode: 403,
    });
    expect(
      await api("deleteMessages", { chat_id: GROUP, message_ids: [b] }),
    ).toMatchObject({ ok: true });
    expect(
      await api("deleteMessages", { chat_id: GROUP, message_ids: [a] }),
    ).toMatchObject({ ok: false });
    expect(await fake.getMessage(GROUP, a)).toMatchObject({ deleted: false });
  });

  it("records physical execution separately from transport loss and real permission rejection", async () => {
    const { fake, api } = await setup();
    const ann = await fake.createUser();
    await fake.join(GROUP, ann);
    await fake.failNext({
      method: "banChatMember",
      chatId: GROUP,
      userId: ann,
      dropAfterApply: true,
    });
    await expect(
      api("banChatMember", { chat_id: GROUP, user_id: ann }),
    ).rejects.toThrow();
    expect((await fake.getMember(GROUP, ann)).status).toBe("kicked");
    expect((await fake.getCalls()).calls.at(-1)).toMatchObject({
      outcome: "response_lost",
      applied: true,
      dropped: true,
      status: 200,
    });
    await fake.setBotMembership(GROUP, 123456, {
      status: "administrator",
      rights: { can_restrict_members: false },
    });
    await fake.failNext({
      method: "unbanChatMember",
      chatId: GROUP,
      userId: ann,
      dropAfterApply: true,
    });
    expect(
      await api("unbanChatMember", { chat_id: GROUP, user_id: ann }),
    ).toMatchObject({ ok: false });
    expect((await fake.getCalls()).calls.at(-1)).toMatchObject({
      outcome: "rejected",
      applied: false,
      failed: 400,
    });
    expect((await fake.getMember(GROUP, ann)).status).toBe("kicked");
  });

  it("delays a successful response without rejecting or executing it twice", async () => {
    const { fake, api } = await setup();
    await fake.failNext({ method: "sendMessage", chatId: GROUP, delayMs: 50 });
    const start = Date.now();
    expect(
      await api("sendMessage", { chat_id: GROUP, text: "delayed" }),
    ).toMatchObject({ ok: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    expect(
      (await fake.getMessages(GROUP)).filter((m) => m.text === "delayed"),
    ).toHaveLength(1);
    expect((await fake.getCalls()).calls.at(-1)).toMatchObject({
      outcome: "delayed",
      applied: true,
      delay_ms: 50,
    });
  });
});

describe("poll votes", () => {
  async function pollSetup(fields) {
    const { fake, api, second } = await setup();
    const hook = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: hook.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    await fake.setBotMembership(GROUP, second.id, { status: "administrator" });
    const poll = (
      await api("sendPoll", {
        chat_id: GROUP,
        question: "Lunch?",
        options: ["Pizza", "Salad", "Soup"],
        ...fields,
      })
    ).result;
    const ann = await fake.createUser({ first_name: "Ann" });
    await fake.join(GROUP, ann);
    return { fake, api, hook, other, poll, ann };
  }

  it("tells the bot that sent a public poll who voted for what, and the new counts", async () => {
    const { fake, hook, other, poll, ann } = await pollSetup({
      is_anonymous: false,
      allows_multiple_answers: true,
    });
    const [pizza, , soup] = poll.poll.options;

    await fake.vote(GROUP, poll.message_id, ann, [2, 0]);
    expect(hook.ofType("poll_answer")).toEqual([
      {
        poll_id: poll.poll.id,
        user: expect.objectContaining({ id: ann, first_name: "Ann" }),
        option_ids: [0, 2],
        option_persistent_ids: [pizza.persistent_id, soup.persistent_id],
      },
    ]);
    expect(hook.ofType("poll")).toEqual([
      expect.objectContaining({
        id: poll.poll.id,
        total_voter_count: 1,
        options: [
          expect.objectContaining({ text: "Pizza", voter_count: 1 }),
          expect.objectContaining({ text: "Salad", voter_count: 0 }),
          expect.objectContaining({ text: "Soup", voter_count: 1 }),
        ],
      }),
    ]);
    expect(
      (await fake.getMessage(GROUP, poll.message_id)).message.poll,
    ).toMatchObject({ total_voter_count: 1 });

    // An empty choice retracts the vote.
    await fake.vote(GROUP, poll.message_id, ann, []);
    expect(hook.ofType("poll_answer").at(-1)).toMatchObject({
      option_ids: [],
      option_persistent_ids: [],
    });
    expect(hook.ofType("poll").at(-1)).toMatchObject({ total_voter_count: 0 });
    // Bots get votes only in the polls they sent.
    expect(other.ofType("poll_answer")).toEqual([]);
    expect(other.ofType("poll")).toEqual([]);
  });

  it("names the group, not the person, as the voter for an anonymous administrator or owner", async () => {
    const { fake, api, hook, poll, ann } = await pollSetup({
      is_anonymous: false,
    });
    await fake.promoteMember(GROUP, ann, { rights: { is_anonymous: true } });
    await fake.vote(GROUP, poll.message_id, ann, [1]);
    const olga = await fake.createUser({ first_name: "Olga" });
    const group = await fake.createChat({ ownerId: olga, ownerAnonymous: true });
    const me = (await api("getMe")).result;
    const named = await fake.createUser();
    await fake.join(group, named);
    await fake.promoteMember(group, named, {
      rights: { can_invite_users: true, can_promote_members: true },
    });
    await fake.setBotMembership(group, me.id, {
      status: "administrator",
      by: named,
    });
    const second = (
      await api("sendPoll", {
        chat_id: group,
        question: "Tea?",
        options: ["Yes", "No"],
        is_anonymous: false,
      })
    ).result;
    await fake.vote(group, second.message_id, olga, [0]);

    const channelBot = {
      id: 136817688,
      is_bot: true,
      first_name: "Channel",
      username: "Channel_Bot",
    };
    expect(hook.ofType("poll_answer")).toEqual([
      {
        poll_id: poll.poll.id,
        user: channelBot,
        voter_chat: expect.objectContaining({ id: GROUP, type: "supergroup" }),
        option_ids: [1],
        option_persistent_ids: [poll.poll.options[1].persistent_id],
      },
      expect.objectContaining({
        user: channelBot,
        voter_chat: expect.objectContaining({ id: group }),
      }),
    ]);
  });

  it("sends only the new counts for an anonymous poll", async () => {
    const { fake, hook, poll, ann } = await pollSetup({});
    await fake.vote(GROUP, poll.message_id, ann, [1]);
    expect(hook.ofType("poll")).toEqual([
      expect.objectContaining({ id: poll.poll.id, total_voter_count: 1 }),
    ]);
    expect(hook.ofType("poll_answer")).toEqual([]);
  });

  it("refuses the votes Telegram's app refuses", async () => {
    const { fake, api, poll, ann } = await pollSetup({});
    const vote = (options, user = ann, messageId = poll.message_id) =>
      fake.vote(GROUP, messageId, user, options);

    await expect(vote([0, 1])).rejects.toThrow(
      "Can't choose more than 1 option in the poll",
    );
    await expect(vote([3])).rejects.toThrow(
      "Invalid option identifier specified",
    );
    const outsider = await fake.createUser({ first_name: "Out" });
    await expect(vote([0], outsider)).rejects.toThrow("Can't access the chat");
    const text = await fake.post(GROUP, ann, "not a poll");
    await expect(vote([0], ann, text)).rejects.toThrow("Message is not a poll");
    await expect(vote([0], ann, 999_999)).rejects.toThrow("Message not found");

    const quiz = (
      await api("sendPoll", {
        chat_id: GROUP,
        question: "2+2?",
        options: ["4", "5"],
        type: "quiz",
        correct_option_id: 0,
      })
    ).result;
    await vote([1], ann, quiz.message_id);
    await expect(vote([0], ann, quiz.message_id)).rejects.toThrow(
      "Can't revote in a quiz",
    );
    await expect(vote([], ann, quiz.message_id)).rejects.toThrow(
      "Can't retract vote in the poll",
    );

    await api("stopPoll", { chat_id: GROUP, message_id: poll.message_id });
    await expect(vote([0])).rejects.toThrow("Can't answer closed poll");
  });

  it("delivers a member's poll as a message, and none of its votes", async () => {
    const { fake, api, hook, ann } = await pollSetup({});
    const id = await fake.post(GROUP, ann, {
      poll: { question: "Movie?", options: ["Yes", "No"], is_anonymous: false },
    });
    expect(hook.ofType("message").at(-1)).toMatchObject({
      message_id: id,
      from: { id: ann },
      poll: {
        question: "Movie?",
        options: [
          expect.objectContaining({ text: "Yes", voter_count: 0 }),
          expect.objectContaining({ text: "No", voter_count: 0 }),
        ],
        is_anonymous: false,
        type: "regular",
      },
    });
    const bob = await fake.createUser({ first_name: "Bob" });
    await fake.join(GROUP, bob);
    await fake.vote(GROUP, id, bob, [0]);
    expect(
      (await fake.getMessage(GROUP, id)).message.poll.options[0].voter_count,
    ).toBe(1);
    expect(hook.ofType("poll_answer")).toEqual([]);
    expect(hook.ofType("poll")).toEqual([]);

    await api("restrictChatMember", {
      chat_id: GROUP,
      user_id: bob,
      permissions: { can_send_messages: true, can_send_polls: false },
    });
    await expect(
      fake.post(GROUP, bob, { poll: { question: "Q?", options: ["A"] } }),
    ).rejects.toThrow(/CHAT_WRITE_FORBIDDEN/);
  });

  it("takes a vote in a poll the bot sent to a private chat", async () => {
    const { fake, api, hook, ann } = await pollSetup({});
    await fake.sendDirectMessage(ann, "/start");
    const poll = (
      await api("sendPoll", {
        chat_id: ann,
        question: "Rate us?",
        options: ["Good", "Bad"],
        is_anonymous: false,
      })
    ).result;
    await fake.voteDirect(ann, poll.message_id, [0]);
    expect(hook.ofType("poll_answer")).toEqual([
      expect.objectContaining({ poll_id: poll.poll.id, option_ids: [0] }),
    ]);
  });
});

describe("polls in channels", () => {
  it("takes only anonymous polls in a channel", async () => {
    const { fake, api } = await setup();
    const me = (await api("getMe")).result;
    const channel = await fake.createChat({ type: "channel", ownerId: OWNER });
    await fake.setBotMembership(channel, me.id, { status: "administrator" });
    const send = (is_anonymous) =>
      api("sendPoll", {
        chat_id: channel,
        question: "Which?",
        options: ["A", "B"],
        is_anonymous,
      });
    expect(await send(false)).toMatchObject({
      status: 400,
      description:
        "Bad Request: non-anonymous polls can't be sent to channel chats",
    });
    expect((await send(true)).ok).toBe(true);
  });
});

describe("basic group message ids", () => {
  /** The message ids a bot was sent in a chat, in order. */
  async function seenIds(fake, botId, chatId) {
    const { updates } = await fake.getBotUpdates(botId, {
      chatId,
      type: "message",
    });
    return updates.map((entry) => entry.update.message.message_id);
  }

  /** A basic group with both bots in it as administrators. */
  async function basicGroup() {
    const context = await setup();
    const { fake, api, second } = context;
    const me = (await api("getMe")).result;
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id); // first bot: 1
    await fake.setBotMembership(group, second.id); // first: 2, second: 1
    return { ...context, me, group };
  }

  it("numbers a basic group's messages for each bot from that bot's own sequence, shared with its private chats", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    const ann = await fake.createUser({ first_name: "Ann" });
    // The first bot's private chat with Ann takes its ids 1 and 2.
    await fake.sendDirectMessage(ann, "/start");
    await api("sendMessage", { chat_id: ann, text: "hi" });
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id, { status: "member" });
    await fake.setBotMembership(group, second.id, { status: "member" });
    const hello = await fake.post(group, OWNER, "hello");

    expect(await seenIds(fake, me.id, group)).toEqual([3, 4, 5]);
    expect(await seenIds(fake, second.id, group)).toEqual([1, 2]);
    // The first bot's next private message continues the same sequence.
    expect(await fake.sendDirectMessage(ann, "thanks")).toBe(6);
    // Tests name the message by the chat's own id, and the log gives each
    // bot's.
    const entry = (await fake.getMessageLog(group)).messages.at(-1);
    expect(entry.message).toMatchObject({ message_id: hello, text: "hello" });
    expect(entry.bot_message_ids).toEqual({ [me.id]: 5, [second.id]: 2 });
  });

  it("takes and shows each bot's own ids in its calls about a basic group's messages", async () => {
    const { fake, api, second, me, group } = await basicGroup();
    const hello = await fake.post(group, OWNER, "hello"); // first: 3, second: 2

    // The second bot replies to its message 2, which the first bot knows
    // as 3.
    const reply = await api(
      "sendMessage",
      { chat_id: group, text: "re", reply_parameters: { message_id: 2 } },
      SECOND_TOKEN,
    );
    expect(reply.result).toMatchObject({
      message_id: 3,
      reply_to_message: { message_id: 2, text: "hello" },
    });
    // A person's reply reaches each bot under its own ids.
    await fake.post(group, OWNER, { text: "me too", replyTo: hello });
    const last = async (botId) =>
      (
        await fake.getBotUpdates(botId, { chatId: group, type: "message" })
      ).updates.at(-1).update.message;
    expect(await last(me.id)).toMatchObject({
      message_id: 5,
      reply_to_message: { message_id: 3, text: "hello" },
    });
    expect(await last(second.id)).toMatchObject({
      message_id: 4,
      reply_to_message: { message_id: 2, text: "hello" },
    });

    // The first bot pins hello by its id 3; each bot reads the pin by its own.
    expect(
      (await api("pinChatMessage", { chat_id: group, message_id: 3 })).ok,
    ).toBe(true);
    expect(
      (await api("getChat", { chat_id: group }, SECOND_TOKEN)).result
        .pinned_message,
    ).toMatchObject({ message_id: 2, text: "hello" });
    expect(await last(second.id)).toMatchObject({
      message_id: 5,
      pinned_message: { message_id: 2 },
    });

    // A copy answers with the copying bot's id of the new message.
    expect(
      (
        await api(
          "copyMessage",
          { chat_id: group, from_chat_id: group, message_id: 2 },
          SECOND_TOKEN,
        )
      ).result,
    ).toEqual({ message_id: 6 });

    // The second bot deletes hello by its id 2; the first bot's id 3 for it
    // then names a deleted message.
    expect(
      (
        await api(
          "deleteMessage",
          { chat_id: group, message_id: 2 },
          SECOND_TOKEN,
        )
      ).ok,
    ).toBe(true);
    await fake.waitFor({
      kind: "message",
      chatId: group,
      messageId: hello,
      deleted: true,
    });
    expect(
      await api("deleteMessage", { chat_id: group, message_id: 3 }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message to delete not found",
    });
  });

  it("shows a button press and a reaction to each bot with its own id", async () => {
    const { fake, api, second, me, group } = await basicGroup();
    await api("getUpdates", {
      allowed_updates: ["message", "message_reaction", "callback_query"],
    });
    const sent = await api(
      "sendMessage",
      {
        chat_id: group,
        text: "Pick",
        reply_markup: {
          inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]],
        },
      },
      SECOND_TOKEN,
    ); // first: 3, second: 2
    expect(sent.result.message_id).toBe(2);
    const [entry] = (await fake.getMessageLog(group)).messages.slice(-1);
    const pick = entry.message.message_id;

    const pressing = fake.pressButton(group, pick, OWNER, "yes");
    const press = await fake.waitFor({
      kind: "update",
      botId: second.id,
      type: "callback_query",
    });
    expect(press.update.callback_query.message.message_id).toBe(2);
    await api(
      "answerCallbackQuery",
      { callback_query_id: press.update.callback_query.id },
      SECOND_TOKEN,
    );
    await pressing;

    await fake.react(group, pick, OWNER, "👍");
    const reactions = await fake.getBotUpdates(me.id, {
      type: "message_reaction",
    });
    expect(reactions.updates[0].update.message_reaction).toMatchObject({
      chat: { id: group },
      message_id: 3,
    });
  });

  it("names a basic group's messages in waits and failure rules by the chat's own ids", async () => {
    const { fake, api, second, group } = await basicGroup();
    // A message the second bot knows as 2 and the first as 3.
    const hello = await fake.post(group, OWNER, "hello");
    await fake.failNext({
      method: "deleteMessage",
      botId: second.id,
      messageId: hello,
      errorCode: 400,
    });

    expect(
      (
        await api(
          "deleteMessage",
          { chat_id: group, message_id: 2 },
          SECOND_TOKEN,
        )
      ).ok,
    ).toBe(false);
    const call = await fake.waitFor({
      kind: "call",
      botId: second.id,
      method: "deleteMessage",
      messageId: hello,
    });
    expect(call).toMatchObject({ fault_injected: true });
    expect(
      (
        await api(
          "deleteMessage",
          { chat_id: group, message_id: 2 },
          SECOND_TOKEN,
        )
      ).ok,
    ).toBe(true);
    expect((await fake.getMessage(group, hello)).deleted).toBe(true);
  });

  it("gives a bot no id for what was posted before it joined, so a reply to it shows none", async () => {
    const { fake, api, second } = await setup();
    const me = (await api("getMe")).result;
    const group = await fake.createChat({ type: "group", ownerId: OWNER });
    await fake.setBotMembership(group, me.id); // first: 1
    const early = await fake.post(group, OWNER, "early"); // first: 2
    await fake.setBotMembership(group, second.id); // first: 3, second: 1

    await fake.post(group, OWNER, { text: "about that", replyTo: early });
    const { updates } = await fake.getBotUpdates(second.id, {
      chatId: group,
      type: "message",
    });
    expect(updates.at(-1).update.message.text).toBe("about that");
    expect(updates.at(-1).update.message).not.toHaveProperty(
      "reply_to_message",
    );
    expect(
      (await fake.getMessageLog(group)).messages.find(
        (entry) => entry.message.message_id === early,
      ).bot_message_ids,
    ).toEqual({ [me.id]: 2 });
  });
});
