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
      status: 403,
      description: "Forbidden: bot is not a member of the supergroup chat",
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
    ).toMatchObject(refused);
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
      options: [{ text: "Pizza" }, { text: "Salad" }],
      is_anonymous: false,
      allows_multiple_answers: true,
      description: "Vote by noon",
      is_closed: false,
    });

    const stop = () =>
      api("stopPoll", { chat_id: GROUP, message_id: poll.result.message_id });
    expect((await stop()).result.is_closed).toBe(true);
    expect(await stop()).toMatchObject({
      status: 400,
      description: "Bad Request: poll has already been closed",
    });
  });

  it("refuses a poll with fewer than two options", async () => {
    const { api } = await setup();
    const poll = await api("sendPoll", {
      chat_id: GROUP,
      question: "Only one?",
      options: ["Yes"],
    });
    expect(poll.status).toBe(400);
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
      description: "Bad Request: message to forward not found",
    });
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

  it("lets any bot download a file by its own token", async () => {
    const { fake, api } = await setup();
    const member = await fake.createUser();
    await fake.join(GROUP, member);
    const id = await fake.post(GROUP, member, {
      photo: PHOTO,
    });
    const { message } = await fake.getMessage(GROUP, id);
    const file = await api(
      "getFile",
      { file_id: message.photo.at(-1).file_id },
      SECOND_TOKEN,
    );
    const download = await fetch(
      `${fake.origin}/file/bot${SECOND_TOKEN}/${file.result.file_path}`,
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PHOTO);
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

  it("sends a button press only to the bot that sent the message", async () => {
    const { fake, api, second } = await setup();
    const first = await startReceiver();
    const other = await startReceiver();
    await api("setWebhook", { url: first.url });
    await api("setWebhook", { url: other.url }, SECOND_TOKEN);
    await fake.setBotMembership(GROUP, second.id, { status: "member" });
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

    const press = fake.pressButton(GROUP, sent.result.message_id, OWNER, "yes");
    await expect.poll(() => other.ofType("callback_query").length).toBe(1);
    await api(
      "answerCallbackQuery",
      { callback_query_id: other.ofType("callback_query")[0].id },
      SECOND_TOKEN,
    );
    await press;
    expect(first.ofType("callback_query")).toEqual([]);
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
      photo: "not-a-file-id",
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
