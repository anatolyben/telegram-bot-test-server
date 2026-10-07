import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { startTestServer } from "../src/index.js";
const TOKEN = "123456:CONTROL-SECRET";
const BOT = 123456;
const CHAT = -1001000000001;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});
async function setup(options = {}) {
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: CHAT, title: "Controls", ownerId: 5000000001 }],
    ...options,
  });
  const stopCleanup = () => fake.stop();
  cleanups.push(stopCleanup);
  const api = async (method, params = {}, token = TOKEN) => {
    const r = await fetch(`${fake.origin}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: r.status, ...(await r.json()) };
  };
  const user = await fake.createUser();
  await fake.join(CHAT, user);
  return { fake, api, user, stopCleanup };
}
async function receiver(onUpdate) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const update = JSON.parse(Buffer.concat(chunks));
    await onUpdate(update, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
it("waits for exact message and deletion, returns detached state, and reports only matching redacted calls", async () => {
  const { fake, api, user } = await setup();
  const waiting = fake.waitFor({
    kind: "message",
    chatId: CHAT,
    userId: BOT,
    text: "😀 bold",
    deleted: false,
  });
  await fake.post(CHAT, user, "wrong author");
  const sent = await api("sendMessage", {
    chat_id: CHAT,
    text: "😀 <b>bold</b>",
    parse_mode: "HTML",
  });
  const message = await waiting;
  expect(message.message.message_id).toBe(sent.result.message_id);
  expect(message.message.entities).toEqual([
    { type: "bold", offset: 3, length: 4 },
  ]);
  message.message.text = "mutated result";
  expect(
    (await fake.getMessage(CHAT, sent.result.message_id)).message.text,
  ).toBe("😀 bold");
  const deleted = fake.waitFor({
    kind: "message",
    chatId: CHAT,
    messageId: sent.result.message_id,
    deleted: true,
  });
  await api("deleteMessage", {
    chat_id: CHAT,
    message_id: sent.result.message_id,
  });
  expect(await deleted).toMatchObject({ exists: true, deleted: true });
  await api("setWebhook", {
    url: "http://127.0.0.1:1",
    secret_token: "HIDDEN",
  });
  await expect(
    fake.waitFor(
      {
        kind: "call",
        botId: BOT,
        method: "setWebhook",
        params: { secret_token: "HIDDEN" },
        afterSeq: 100,
      },
      { timeoutMs: 15 },
    ),
  ).rejects.toThrow(/observed/);
  const error = await fake
    .waitFor(
      { kind: "call", botId: BOT, method: "setWebhook", afterSeq: 100 },
      { timeoutMs: 15 },
    )
    .then(
      () => null,
      (error) => error,
    );
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain("HIDDEN");
  expect(error.message).not.toContain(TOKEN);
});
it("wakes membership waits on fake time expiry without global time changes or another API read", async () => {
  const initial = 1800000000000;
  const { fake, api, user } = await setup({ clock: { now: initial } });
  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: user,
    permissions: { can_send_messages: false },
    until_date: initial / 1000 + 30,
  });
  expect(
    await fake.waitFor({
      kind: "member",
      chatId: CHAT,
      userId: user,
      status: "restricted",
      permissions: { can_send_messages: false },
    }),
  ).toMatchObject({ status: "restricted" });
  const unmuted = fake.waitFor({
    kind: "member",
    chatId: CHAT,
    userId: user,
    status: "member",
  });
  await fake.advanceTime(29999);
  expect((await fake.getMember(CHAT, user)).status).toBe("restricted");
  await fake.advanceTime(1);
  expect(await unmuted).toMatchObject({ status: "member" });
  expect(Date.now()).not.toBe(initial + 30000);
});
it("distinguishes join decisions from pending requests and does not invent admission on decline", async () => {
  const { fake, api } = await setup();
  const invite = (
    await api("createChatInviteLink", {
      chat_id: CHAT,
      creates_join_request: true,
    })
  ).result.invite_link;
  for (const state of ["approved", "declined"]) {
    const user = await fake.createUser();
    await fake.joinByLink(invite, user);
    expect(
      await fake.waitFor({
        kind: "joinRequest",
        chatId: CHAT,
        userId: user,
        state: "pending",
      }),
    ).toMatchObject({ state: "pending", member: { status: "left" } });
    const done = fake.waitFor({
      kind: "joinRequest",
      chatId: CHAT,
      userId: user,
      botId: BOT,
      state,
    });
    await api(
      state === "approved"
        ? "approveChatJoinRequest"
        : "declineChatJoinRequest",
      { chat_id: CHAT, user_id: user },
    );
    expect(await done).toMatchObject({
      state,
      member: { status: state === "approved" ? "member" : "left" },
    });
  }
});
it("records truthful stages for rejection, delayed success and response loss with original formatting and fault identity", async () => {
  const { fake, api, user } = await setup({ clock: { now: 1800000000000 } });
  await fake.failNext({
    method: "sendMessage",
    chatId: CHAT,
    botId: BOT,
    delayMs: 100,
  });
  const receipt = fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "sendMessage",
    chatId: CHAT,
    stage: "state_applied",
  });
  const pending = api("sendMessage", {
    chat_id: CHAT,
    text: "<b>x</b>",
    parse_mode: "HTML",
  });
  const applied = await receipt;
  expect(applied.applied).toBe(true);
  expect(applied.timeline.map((e) => e.stage)).toEqual([
    "received",
    "validated",
    "state_applied",
  ]);
  expect(applied.params).toMatchObject({
    text: "<b>x</b>",
    parse_mode: "HTML",
  });
  const snapshotBusy = fake.snapshot();
  await expect(snapshotBusy).rejects.toThrow(/busy/);
  await fake.advanceTime(100);
  expect(await pending).toMatchObject({ ok: true });
  const finished = await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "sendMessage",
    requestId: applied.request_id,
    stage: "response_sent",
  });
  expect(finished.fault_id).toBeTruthy();
  await fake.failNext({
    method: "banChatMember",
    chatId: CHAT,
    userId: user,
    dropAfterApply: true,
  });
  await expect(
    api("banChatMember", { chat_id: CHAT, user_id: user }),
  ).rejects.toThrow();
  const lost = await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "banChatMember",
    chatId: CHAT,
    userId: user,
    stage: "response_lost",
  });
  expect(lost).toMatchObject({ applied: true, dropped: true });
  await api("restrictChatMember", {
    chat_id: CHAT,
    user_id: 5000000001,
    permissions: {},
  });
  const rejected = await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "restrictChatMember",
    chatId: CHAT,
    userId: 5000000001,
    outcome: "rejected",
  });
  expect(rejected.timeline.map((e) => e.stage)).not.toContain("state_applied");
});
it("restores a detached complete fixture, counters, queued updates, faults and receipts repeatedly, and refuses another instance snapshot", async () => {
  const { fake, api, user } = await setup({ clock: { now: 1800000000000 } });
  const messageId = await fake.post(CHAT, user, "literal <b>😀</b>");
  await fake.failNext({
    method: "deleteMessage",
    chatId: CHAT,
    messageId,
    errorCode: 403,
  });
  const baseline = await fake.snapshot();
  for (let i = 0; i < 2; i++) {
    const nextUser = await fake.createUser();
    const nextMessage = await fake.post(CHAT, user, "temporary");
    expect(
      (await api("deleteMessage", { chat_id: CHAT, message_id: messageId }))
        .status,
    ).toBe(403);
    await api("banChatMember", { chat_id: CHAT, user_id: user });
    await fake.advanceTime(60000);
    await fake.restore(baseline);
    expect((await fake.getMember(CHAT, user)).status).toBe("member");
    expect(await fake.getMessage(CHAT, messageId)).toMatchObject({
      deleted: false,
      message: { text: "literal <b>😀</b>" },
    });
    expect(await fake.getMessage(CHAT, nextMessage)).toMatchObject({
      exists: false,
    });
    expect((await fake.getCalls()).calls).toHaveLength(0);
    expect((await fake.getClock()).now).toBe(1800000000000);
    expect(await fake.createUser()).toBe(nextUser);
    const queued = await api("getUpdates");
    expect(
      queued.result.filter((u) => u.message?.text === "literal <b>😀</b>"),
    ).toHaveLength(1);
    await fake.restore(baseline);
  }
  const other = await setup();
  await expect(other.fake.restore(baseline)).rejects.toThrow(/snapshot/);
  await fake.releaseSnapshot(baseline);
  await expect(fake.restore(baseline)).rejects.toThrow(/snapshot/);
});
it("restores the flood control history with the fixture's time", async () => {
  const { fake, api } = await setup({
    clock: { now: 1800000000000 },
    floodControl: true,
  });
  expect(await api("sendMessage", { chat_id: CHAT, text: "a" })).toMatchObject({
    ok: true,
  });
  const saved = await fake.snapshot();
  await fake.advanceTime(1000);
  expect(await api("sendMessage", { chat_id: CHAT, text: "b" })).toMatchObject({
    ok: true,
  });
  await fake.restore(saved);
  // "c" waits out the second after "a", then goes.
  const c = api("sendMessage", { chat_id: CHAT, text: "c" });
  await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "sendMessage",
    params: { text: "c" },
  });
  await fake.advanceTime(1000);
  expect(await c).toMatchObject({ ok: true, result: { date: 1800000001 } });
  await fake.releaseSnapshot(saved);
});
it("restores queued updates that still expire a day after they happened", async () => {
  const { fake, api, user } = await setup({ clock: { now: 1800000000000 } });
  await fake.post(CHAT, user, "before snapshot");
  const saved = await fake.snapshot();
  await fake.restore(saved);
  await fake.advanceTime(86_401_000);
  expect((await api("getUpdates")).result).toEqual([]);
  await fake.releaseSnapshot(saved);
});
it("restores media bytes, owner-account state and webhook replay bytes without cross-instance delivery", async () => {
  const { fake, api, user } = await setup();
  const updates = [];
  const url = await receiver(async (update, res) => {
    updates.push(update);
    res.end();
  });
  await api("setWebhook", { url, drop_pending_updates: true });
  const media = await fake.post(CHAT, user, {
    photo: Buffer.from("image bytes"),
    caption: "😀 literal <i>x</i>",
  });
  const before = await fake.getMessage(CHAT, media);
  const fileId = before.message.photo.at(-1).file_id;
  const file = (await api("getFile", { file_id: fileId })).result;
  const owner = await fake.createOwner();
  const dialog = await fake.addOwnerDialog(owner.id, {
    kind: "supergroup",
    title: "Owner chat",
  });
  await fake.addOwnerMessages(owner.id, dialog.id, [
    { id: 1, date: 1800000000, text: "saved" },
  ]);
  const snapshot = await fake.snapshot();
  await fake.deleteOwnerMessage(owner.id, dialog.id, 1);
  await api("deleteMessage", { chat_id: CHAT, message_id: media });
  await api("deleteWebhook");
  await fake.restore(snapshot);
  await fake.redeliverUpdate(updates.at(-1).update_id);
  expect(updates.at(-1)).toEqual(updates.at(-2));
  expect(
    await (
      await fetch(`${fake.origin}/file/bot${TOKEN}/${file.file_path}`)
    ).text(),
  ).toBe("image bytes");
  // Owner records include nested maps and message deletion state.
  expect(await fake.getOwner(owner.id)).toMatchObject({ id: owner.id });
  const restoredOwner = await fetch(
    `${fake.origin}/_owner/${owner.id}/getMessages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity: dialog.id, ids: [1] }),
    },
  );
  expect((await restoredOwner.json()).result.messages[0]).toMatchObject({
    id: 1,
    message: "saved",
  });
  expect(await fake.getMessage(CHAT, media)).toMatchObject({ deleted: false });
});
it("drains fake deliveries separately from consumer work and preserves duplicate update attempts", async () => {
  const { fake, api, user } = await setup();
  let release;
  let received;
  const arriving = new Promise((resolve) => {
    received = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const updates = [];
  const url = await receiver(async (update, res) => {
    updates.push(update);
    received();
    await hold;
    res.end();
  });
  await api("setWebhook", { url, drop_pending_updates: true });
  const posting = fake.post(CHAT, user, "held delivery");
  await arriving;
  expect(
    await fake.waitFor({
      kind: "message",
      chatId: CHAT,
      userId: user,
      text: "held delivery",
    }),
  ).toMatchObject({ deleted: false });
  await expect(fake.drainDeliveries({ timeoutMs: 15 })).rejects.toThrow(
    /outstanding/,
  );
  await expect(fake.snapshot()).rejects.toThrow(/busy/);
  release();
  await posting;
  await fake.drainDeliveries();
  await fake.redeliverUpdate(updates[0].update_id);
  expect(updates[1]).toEqual(updates[0]);
  const journal = await fake.getDeliveries();
  expect(journal.map((e) => [e.update_id, e.attempt, e.outcome])).toEqual([
    [updates[0].update_id, 1, "delivered"],
    [updates[0].update_id, 2, "delivered"],
  ]);
});
it("delivers one button press twice, with the same update_id and callback query id", async () => {
  const { fake, api, user } = await setup();
  const presses = [];
  const answers = [];
  const url = await receiver(async (update, res) => {
    if (update.callback_query) {
      presses.push(update);
      const answer = await api("answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
        text: `seen ${presses.length}`,
      });
      answers.push(answer.description ?? answer.ok);
    }
    res.end();
  });
  await api("setWebhook", { url });
  const keyboard = {
    inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
  };
  const sent = await api("sendMessage", {
    chat_id: CHAT,
    text: "Verify",
    reply_markup: keyboard,
  });

  expect(
    await fake.pressButton(CHAT, sent.result.message_id, user, "ok", {
      deliverTwice: true,
    }),
  ).toEqual({ answered: true, text: "seen 1", show_alert: false });
  expect(presses).toHaveLength(2);
  expect(presses[1]).toEqual(presses[0]);
  // The query was answered, so the duplicate's answer is refused.
  expect(answers).toEqual([
    true,
    "Bad Request: query is too old and response timeout expired or query ID is invalid",
  ]);
  const deliveries = (await fake.getDeliveries()).filter(
    (entry) => entry.update_id === presses[0].update_id,
  );
  expect(deliveries.map((entry) => entry.attempt)).toEqual([1, 2]);

  // Over HTTP, on an ephemeral message and in a private chat.
  const control = async (path, body) => {
    const response = await fetch(`${fake.origin}/_fake/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const ephemeral = await api("sendMessage", {
    chat_id: CHAT,
    text: "Just for you",
    reply_markup: keyboard,
    ephemeral_message_parameters: { receiver_user_id: user },
  });
  expect(
    await control(
      `chats/${CHAT}/ephemeral-messages/${ephemeral.result.ephemeral_message_id}/callback`,
      { user_id: user, data: "ok", deliver_twice: true },
    ),
  ).toEqual({
    status: 200,
    body: { answered: true, text: "seen 3", show_alert: false },
  });
  expect(presses).toHaveLength(4);
  expect(presses[3]).toEqual(presses[2]);
  await fake.sendDirectMessage(user, "/start");
  const direct = await api("sendMessage", {
    chat_id: user,
    text: "Verify",
    reply_markup: keyboard,
  });
  expect(
    (
      await control(`users/${user}/dm/${direct.result.message_id}/callback`, {
        data: "ok",
        deliver_twice: true,
      })
    ).body,
  ).toMatchObject({ answered: true, text: "seen 5" });
  expect(presses).toHaveLength(6);
  expect(presses[5]).toEqual(presses[4]);
  // A press goes once without the option.
  await fake.pressButton(CHAT, sent.result.message_id, user, "ok");
  expect(presses).toHaveLength(7);

  // Telegram sends an update again only to a webhook, so a polling bot's
  // press is refused before anything is sent.
  await api("deleteWebhook");
  const before = (await fake.getBotUpdates(BOT)).updates.length;
  await expect(
    fake.pressButton(CHAT, sent.result.message_id, user, "ok", {
      deliverTwice: true,
    }),
  ).rejects.toThrow(/webhook/);
  expect((await fake.getBotUpdates(BOT)).updates).toHaveLength(before);
});
it("cancels pending exact waits on restore and stop and exposes controls over HTTP", async () => {
  const { fake, user } = await setup();
  const snapshot = await fake.snapshot();
  const reset = fake.waitFor({
    kind: "member",
    chatId: CHAT,
    userId: user,
    status: "kicked",
  });
  const resetCheck = expect(reset).rejects.toThrow(/restored/);
  await fake.restore(snapshot);
  await resetCheck;
  const response = await fetch(`${fake.origin}/_fake/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      condition: {
        kind: "member",
        chatId: CHAT,
        userId: user,
        status: "member",
      },
      timeoutMs: 100,
    }),
  });
  expect(await response.json()).toMatchObject({ status: "member" });
  const stopped = fake.waitFor({
    kind: "member",
    chatId: CHAT,
    userId: user,
    status: "kicked",
  });
  const stopCheck = expect(stopped).rejects.toThrow(/stopped/);
  await fake.stop();
  await stopCheck;
});
it("answers failed HTTP waits, drains, clock advances and bad media as control errors, not internal errors", async () => {
  const lines = [];
  const { fake, user } = await setup({ log: (line) => lines.push(line) });
  const control = async (path, body) => {
    const response = await fetch(`${fake.origin}/_fake/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return [response.status, (await response.json()).error];
  };
  const kicked = {
    kind: "member",
    chatId: CHAT,
    userId: user,
    status: "kicked",
  };

  expect(await control("wait", { condition: { kind: "nope" } })).toEqual([
    400,
    "Unknown wait kind",
  ]);
  expect(
    await control("wait", { condition: { ...kicked, userId: 42 } }),
  ).toEqual([400, "Bad Request: user not found"]);
  expect(await control("wait", { condition: kicked, timeoutMs: 20 })).toEqual([
    408,
    expect.stringContaining("Wait deadline 20ms exceeded"),
  ]);
  expect(await control("deliveries", { timeoutMs: 0 })).toEqual([
    400,
    "timeoutMs must be 1-30000",
  ]);
  expect(await control("clock", { ms: 5 })).toEqual([
    409,
    "advanceTime requires a manual clock",
  ]);
  expect(
    await control(`chats/${CHAT}/messages`, { user_id: user, photo_base64: 5 }),
  ).toEqual([400, "photo_base64 must be a base64 string"]);
  expect(lines.filter((line) => line.startsWith("internal error"))).toEqual([]);
});
it("refuses callback answers from a different bot without consuming the legitimate query", async () => {
  const { fake, api, user } = await setup();
  const other = "987654:OTHER";
  await fake.addBot({ token: other, username: "other" });
  let arrived;
  const query = new Promise((resolve) => {
    arrived = resolve;
  });
  const url = await receiver(async (update, res) => {
    if (update.callback_query) arrived(update.callback_query.id);
    res.end();
  });
  await api("setWebhook", { url, drop_pending_updates: true });
  const sent = await api("sendMessage", {
    chat_id: CHAT,
    text: "Button",
    reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "ok" }]] },
  });
  const pressed = fake.pressButton(CHAT, sent.result.message_id, user, "ok");
  const queryId = await query;
  const wrong = await api(
    "answerCallbackQuery",
    { callback_query_id: queryId, text: "wrong" },
    other,
  );
  const right = await api("answerCallbackQuery", {
    callback_query_id: queryId,
    text: "right",
  });
  expect(await pressed).toMatchObject({ answered: true, text: "right" });
  expect(wrong).toMatchObject({ status: 400, ok: false });
  expect(right).toMatchObject({ ok: true });
});
it("keeps returned request journals detached so callers cannot rewrite replay evidence", async () => {
  const { fake, api } = await setup();
  await api("sendMessage", {
    chat_id: CHAT,
    text: "<b>original</b>",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "ok" }]] },
  });
  const journal = await fake.getCalls();
  journal.calls[0].params.reply_markup.inline_keyboard[0][0].text = "corrupted";
  journal.calls[0].timeline.length = 0;
  const original = (await fake.getCalls()).calls[0];
  expect(original.params.reply_markup.inline_keyboard[0][0].text).toBe("ok");
  expect(original.timeline.map((e) => e.stage)).toContain("response_sent");
});
it("returns copies of stored messages, so changing one changes nothing on the server", async () => {
  const { fake, api, user } = await setup();
  const posted = await fake.post(CHAT, user, "original");
  await fake.react(CHAT, posted, user, "👍");
  const ephemeral = await api("sendMessage", {
    chat_id: CHAT,
    text: "just for you",
    ephemeral_message_parameters: { receiver_user_id: user },
  });
  const eid = ephemeral.result.ephemeral_message_id;
  await fake.sendDirectMessage(user, "private");
  const before = JSON.stringify({
    one: await fake.getMessage(CHAT, posted),
    all: await fake.getMessages(CHAT),
    ephemeral: await fake.getEphemeralMessage(CHAT, eid),
    direct: await fake.getDirectMessages(user),
  });

  const one = await fake.getMessage(CHAT, posted);
  one.message.text = "changed";
  one.message.from.first_name = "changed";
  one.reactions[user].push("👎");
  for (const message of await fake.getMessages(CHAT)) message.text = "changed";
  (await fake.getEphemeralMessage(CHAT, eid)).message.text = "changed";
  for (const message of await fake.getDirectMessages(user)) {
    message.text = "changed";
  }

  expect(
    JSON.stringify({
      one: await fake.getMessage(CHAT, posted),
      all: await fake.getMessages(CHAT),
      ephemeral: await fake.getEphemeralMessage(CHAT, eid),
      direct: await fake.getDirectMessages(user),
    }),
  ).toBe(before);
  // The bot sees the stored message as it was, too.
  const forward = await api("forwardMessage", {
    chat_id: CHAT,
    from_chat_id: CHAT,
    message_id: posted,
  });
  expect(forward.result.text).toBe("original");
  await expect(
    fake.waitFor(
      { kind: "message", chatId: CHAT, userId: user, text: "changed" },
      { timeoutMs: 15 },
    ),
  ).rejects.toThrow(/observed/);
});
it("isolates concurrent bot and chat call waits and leaves unmatched faults for their exact attempt", async () => {
  const { fake, api, user } = await setup({ clock: { now: 1800000000000 } });
  const token = "987654:PARALLEL";
  await fake.addBot({ token, username: "parallel" });
  await fake.setBotMembership(CHAT, 987654, { status: "administrator" });
  const other = await fake.createChat({
    title: "Other",
    ownerId: 5000000001,
    type: "supergroup",
  });
  await fake.setBotMembership(other, BOT, { status: "administrator" });
  await fake.join(other, user);
  await fake.failNext({
    method: "banChatMember",
    botId: BOT,
    chatId: CHAT,
    userId: user,
    attempt: 2,
    errorCode: 403,
  });
  const exact = fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "banChatMember",
    chatId: CHAT,
    userId: user,
    outcome: "rejected",
  });
  await Promise.all([
    api("banChatMember", { chat_id: other, user_id: user }),
    api("getChatMember", { chat_id: CHAT, user_id: user }, token),
  ]);
  expect((await fake.getMember(CHAT, user)).status).toBe("member");
  expect(
    (await api("banChatMember", { chat_id: CHAT, user_id: user })).ok,
  ).toBe(true);
  expect((await fake.getCalls()).calls.at(-1)).toMatchObject({
    attempt: 1,
    fault_injected: false,
    fault_id: expect.any(String),
  });
  expect(
    (await api("banChatMember", { chat_id: CHAT, user_id: user })).status,
  ).toBe(403);
  expect(await exact).toMatchObject({
    bot_id: BOT,
    attempt: 2,
    applied: false,
  });
});
it("stops queued webhook work and manual response delays without leaking a scheduler or later delivery", async () => {
  const { fake, api, user } = await setup({ clock: { now: 1800000000000 } });
  let seen;
  const arrived = new Promise((resolve) => {
    seen = resolve;
  });
  const url = await receiver(async (_update, _res) => {
    seen();
  });
  await api("setWebhook", { url, drop_pending_updates: true });
  const first = fake.post(CHAT, user, "first");
  const second = fake.post(CHAT, user, "second");
  await arrived;
  await fake.failNext({ method: "getMe", botId: BOT, delayMs: 30000 });
  const delayed = api("getMe").then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "getMe",
    stage: "state_applied",
  });
  await fake.stop();
  await Promise.all([first, second]);
  expect(await delayed).toMatchObject({ error: expect.any(Error) });
  expect((await fake.getClock()).scheduled).toBe(0);
  expect((await fake.getDeliveries()).map((e) => e.outcome)).toEqual([
    "cancelled",
    "cancelled",
  ]);
  const lost = (await fake.getCalls()).calls.find((e) => e.method === "getMe");
  expect(lost).toMatchObject({
    outcome: "response_lost",
    applied: true,
    dropped: true,
  });
});
it("gives migrated-chat rejection the same request timeline and identity as other calls", async () => {
  const { fake, api } = await setup();
  const old = await fake.createChat({
    title: "Basic",
    ownerId: 5000000001,
    type: "group",
  });
  await fake.setBotMembership(old, BOT, { status: "administrator" });
  await fake.migrateToSupergroup(old, { by: 5000000001 });
  expect((await api("sendMessage", { chat_id: old, text: "hi" })).status).toBe(
    400,
  );
  const call = (await fake.getCalls()).calls.at(-1);
  expect(call).toMatchObject({
    request_id: expect.any(String),
    applied: false,
    outcome: "rejected",
  });
  expect(call.timeline.map((e) => e.stage)).toEqual([
    "received",
    "response_sent",
  ]);
});
it("records rejected malformed and unauthorized Bot API attempts without leaking URL tokens in diagnostics", async () => {
  const { fake } = await setup();
  const invalid = await fetch(`${fake.origin}/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data" },
    body: "{broken",
  });
  expect(invalid.status).toBe(400);
  await invalid.text();
  const unauthorized = await fetch(`${fake.origin}/bot999:BAD-SECRET/getMe`);
  expect(unauthorized.status).toBe(401);
  await unauthorized.json();
  const { calls, rejected_requests: journal } = await fake.getCalls();
  expect(calls).toEqual([]);
  expect(journal.map((e) => [e.method, e.failed, e.applied])).toEqual([
    ["sendMessage", 400, false],
    ["getMe", 401, false],
  ]);
  expect(JSON.stringify(journal)).not.toContain("BAD-SECRET");
  expect(
    journal.every(
      (e) =>
        e.timeline.map((t) => t.stage).join(",") === "received,response_sent",
    ),
  ).toBe(true);
});
it.each([
  "setMyDescription",
  "setMyShortDescription",
  "setChatMenuButton",
  "setMyDefaultAdministratorRights",
])("explicitly refuses %s while its state is not modelled", async (method) => {
  const { fake, api } = await setup();
  const result = await api(method, {
    description: "must not pretend this was stored",
  });
  expect(result).toMatchObject({ status: 404, ok: false });
  const journal = await fake.getCalls();
  expect(journal.calls.at(-1)).toMatchObject({
    method,
    applied: false,
    outcome: "rejected",
  });
  expect(journal.unimplemented).toContain(method);
});

it("serializes concurrent clock advances so a due response cannot move fake time backwards", async () => {
  const initial = 1800000000000;
  const { fake, api } = await setup({ clock: { now: initial } });
  await fake.failNext({ method: "getMe", botId: BOT, delayMs: 50 });
  const applied = fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "getMe",
    stage: "state_applied",
  });
  const pending = api("getMe");
  await applied;
  await Promise.all([fake.advanceTime(50), fake.advanceTime(25)]);
  expect((await fake.getClock()).now).toBe(initial + 75);
  expect(await pending).toMatchObject({ ok: true });
});

/** The running clock's time, checked against the wall clock read around it. */
async function runningNow(fake, offset) {
  const before = Date.now();
  const state = await fake.getClock();
  const after = Date.now();
  expect(state).toMatchObject({ mode: "running", offset, scheduled: 0 });
  expect(state.now).toBeGreaterThanOrEqual(before + offset);
  expect(state.now).toBeLessThanOrEqual(after + offset);
  return state.now;
}

it("keeps a running clock on real time plus the offset advanceTime adds, and dates messages by it", async () => {
  const HOUR = 3_600_000;
  const { fake, user } = await setup({ clock: { offset: 0 } });
  const first = await runningNow(fake, 0);
  expect(await fake.advanceTime(2 * HOUR)).toMatchObject({
    mode: "running",
    offset: 2 * HOUR,
  });
  const jumped = await runningNow(fake, 2 * HOUR);
  expect(jumped - first).toBeGreaterThanOrEqual(2 * HOUR);
  // Between jumps the clock keeps moving.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await runningNow(fake, 2 * HOUR)).toBeGreaterThanOrEqual(jumped + 25);
  const before = Date.now();
  const id = await fake.post(CHAT, user, "two hours on");
  const after = Date.now();
  const { date } = (await fake.getMessage(CHAT, id)).message;
  expect(date).toBeGreaterThanOrEqual(Math.floor((before + 2 * HOUR) / 1000));
  expect(date).toBeLessThanOrEqual(Math.floor((after + 2 * HOUR) / 1000));

  await expect(
    startTestServer({ botToken: TOKEN, clock: { now: 0, offset: 0 } }),
  ).rejects.toThrow("clock takes now or offset, not both");
  await expect(
    startTestServer({ botToken: TOKEN, clock: { offset: -1 } }),
  ).rejects.toThrow("clock.offset must be non-negative milliseconds");
});

it("ends a restriction on a running clock when advanceTime jumps past it, or when real time reaches it", async () => {
  const { fake, api, user } = await setup({ clock: { offset: 0 } });
  const other = await fake.createUser();
  await fake.join(CHAT, other);
  const restrict = async (userId, seconds) => {
    const now = Math.floor((await fake.getClock()).now / 1000);
    expect(
      await api("restrictChatMember", {
        chat_id: CHAT,
        user_id: userId,
        permissions: { can_send_messages: false },
        until_date: now + seconds,
      }),
    ).toMatchObject({ ok: true });
  };
  const unmuted = (userId) =>
    fake.waitFor(
      { kind: "member", chatId: CHAT, userId, status: "member" },
      { timeoutMs: 3000 },
    );

  await restrict(user, 3600);
  const userUnmuted = unmuted(user);
  // The advance itself runs the restriction's end, before any timer could:
  // nothing is left scheduled.
  expect((await fake.getClock()).scheduled).toBe(1);
  await fake.advanceTime(3_601_000);
  expect((await fake.getClock()).scheduled).toBe(0);
  expect(await userUnmuted).toMatchObject({ status: "member" });

  // 32 seconds: a jump of 30 leaves one to two, which pass on their own.
  await restrict(other, 32);
  const otherUnmuted = unmuted(other);
  await fake.advanceTime(30_000);
  expect((await fake.getMember(CHAT, other)).status).toBe("restricted");
  expect(await otherUnmuted).toMatchObject({ status: "member" });
});

it("restores a running clock's offset, and not the real time under it", async () => {
  const { fake } = await setup({ clock: { offset: 0 } });
  await fake.advanceTime(60_000);
  const saved = await fake.snapshot();
  await fake.advanceTime(3_600_000);
  await fake.restore(saved);
  await runningNow(fake, 60_000);
  await fake.releaseSnapshot(saved);
});

it("does not let an unauthenticated request with the same numeric prefix satisfy a bot call wait", async () => {
  const { fake, api } = await setup();
  const actualBot = fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "getMe",
    stage: "response_sent",
  });
  expect((await api("getMe", {}, "123456:WRONG")).status).toBe(401);
  expect((await api("getMe")).ok).toBe(true);
  expect(await actualBot).toMatchObject({
    applied: true,
    outcome: "succeeded",
  });
  expect(
    await fake.waitFor({
      kind: "call",
      botId: BOT,
      method: "getMe",
      includeRejectedRequests: true,
      outcome: "rejected",
    }),
  ).toMatchObject({ failed: 401, applied: false });
});

it("keeps the deleted message author as a stable call selector without rewriting original parameters", async () => {
  const { fake, api, user } = await setup();
  const messageId = await fake.post(CHAT, user, "remove only this author");
  await api("deleteMessage", { chat_id: CHAT, message_id: messageId });
  const call = await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "deleteMessage",
    chatId: CHAT,
    userId: user,
    messageId,
    stage: "response_sent",
  });
  expect(call.target_user_id).toBe(user);
  // Parameters are recorded as Telegram's server reads them: as text.
  expect(call.params).toEqual({
    chat_id: String(CHAT),
    message_id: String(messageId),
  });
});

it("allocates valid stored message IDs for configured and created chats when manual time starts at zero", async () => {
  const { fake, user } = await setup({ clock: { now: 0 } });
  const created = await fake.createChat({ ownerId: user, title: "Epoch zero" });
  for (const chatId of [CHAT, created]) {
    const firstId = await fake.post(chatId, user, "first");
    const secondId = await fake.post(chatId, user, "second");
    expect(firstId).toBeGreaterThan(0);
    expect(secondId).toBe(firstId + 1);
    expect((await fake.getMessage(chatId, firstId)).message.date).toBe(0);
  }
});

it("uses fake time for owner receipts and cancels an owner fault delay without claiming execution at shutdown", async () => {
  const initial = 1800000000000;
  const { fake } = await setup({ clock: { now: initial } });
  const owner = await fake.createOwner({ firstName: "Cancelled owner" });
  await fake.failOwnerCall(owner.id, { method: "getMe", delayMs: 30000 });
  const pending = fetch(`${fake.origin}/_owner/${owner.id}/getMe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then(
    () => "response",
    (error) => ({ error }),
  );
  await vi.waitFor(
    async () => {
      expect((await fake.getClock()).scheduled).toBe(1);
    },
    { timeout: 500, interval: 5 },
  );
  const before = (await fake.getOwnerCalls(owner.id))[0];
  await fake.stop();
  const after = (await fake.getOwnerCalls(owner.id))[0];
  expect(await pending).toMatchObject({ error: expect.any(Error) });
  expect.soft(before.at).toBe(new Date(initial).toISOString());
  expect.soft(before.outcome).toBe("pending");
  expect.soft(after).toMatchObject({ outcome: "cancelled", duration_ms: 0 });
});

it("uses only restored request receipts across repeated restore epochs, retaining both authenticated and rejected evidence", async () => {
  const { fake, api } = await setup();
  await api("getMe");
  await api("getMe", {}, "123456:WRONG");
  const saved = await fake.snapshot();
  const original = (await fake.getCalls()).calls[0];
  const denied = (await fake.getCalls()).rejected_requests[0];
  for (let i = 0; i < 2; i++) {
    await api("getMe");
    const removed = (await fake.getCalls()).calls.at(-1);
    await fake.restore(saved);
    expect(
      await fake.waitFor({
        kind: "call",
        botId: BOT,
        method: "GETME",
        requestId: original.request_id,
        stage: "response_sent",
      }),
    ).toEqual(original);
    expect(
      await fake.waitFor({
        kind: "call",
        botId: BOT,
        method: "getMe",
        requestId: denied.request_id,
        outcome: "rejected",
        includeRejectedRequests: true,
      }),
    ).toEqual(denied);
    await expect(
      fake.waitFor(
        {
          kind: "call",
          botId: BOT,
          method: "getMe",
          requestId: removed.request_id,
          stage: "response_sent",
        },
        { timeoutMs: 15 },
      ),
    ).rejects.toThrow(/deadline/);
    await expect(
      fake.waitFor(
        { kind: "call", botId: BOT, method: "getMe", afterSeq: original.seq },
        { timeoutMs: 15 },
      ),
    ).rejects.toThrow(/deadline/);
  }
  await fake.releaseSnapshot(saved);
});

it("answers Bot API calls at once while the updates they cause wait for a held webhook", async () => {
  const { fake, api, user } = await setup();
  const OTHER = "987654:HELD";
  await fake.addBot({ token: OTHER, username: "held" });
  await fake.setBotMembership(CHAT, 987654, { status: "member" });
  await fake.setBotMembership(CHAT, BOT, {
    status: "administrator",
    rights: { can_promote_members: true },
  });
  let holding = false;
  let arrived;
  const both = new Promise((resolve) => {
    let count = 0;
    arrived = () => ++count === 2 && resolve();
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const url = await receiver(async (_update, res) => {
    if (holding) {
      arrived();
      await held;
    }
    res.end();
  });
  // One connection each, so every later update to either bot waits.
  const hook = {
    url,
    max_connections: 1,
    allowed_updates: [
      "message",
      "chat_member",
      "my_chat_member",
      "message_reaction",
      "poll",
    ],
    drop_pending_updates: true,
  };
  await api("setWebhook", hook);
  await api("setWebhook", hook, OTHER);
  const poll = await api("sendPoll", {
    chat_id: CHAT,
    question: "Lunch?",
    options: [{ text: "Yes" }, { text: "No" }],
  });
  const reacted = await fake.post(CHAT, user, "react here");
  await fake.react(CHAT, reacted, user, "👍");
  holding = true;
  const posting = fake.post(CHAT, user, "hold");
  await both;

  try {
    const photo = new FormData();
    photo.set("chat_id", String(CHAT));
    photo.set("photo", new Blob([Buffer.from("photo bytes")]), "p.jpg");
    const calls = [
      () =>
        api("promoteChatMember", {
          chat_id: CHAT,
          user_id: user,
          can_invite_users: true,
        }),
      () =>
        api("setChatAdministratorCustomTitle", {
          chat_id: CHAT,
          user_id: user,
          custom_title: "Boss",
        }),
      () => api("setChatTitle", { chat_id: CHAT, title: "Renamed" }),
      async () =>
        (
          await fetch(`${fake.origin}/bot${TOKEN}/setChatPhoto`, {
            method: "POST",
            body: photo,
          })
        ).json(),
      () => api("deleteChatPhoto", { chat_id: CHAT }),
      () => api("pinChatMessage", { chat_id: CHAT, message_id: reacted }),
      () =>
        api("deleteMessageReaction", {
          chat_id: CHAT,
          message_id: reacted,
          user_id: user,
        }),
      () =>
        api("stopPoll", {
          chat_id: CHAT,
          message_id: poll.result.message_id,
        }),
      () => api("leaveChat", { chat_id: CHAT }),
    ];
    for (const call of calls) expect(await call()).toMatchObject({ ok: true });
    const left = (await fake.getCalls()).calls.find(
      (call) => call.method === "leaveChat",
    );
    expect(left.timeline.map((event) => event.stage)).toEqual([
      "received",
      "validated",
      "state_applied",
      "handler_completed",
      "response_sent",
    ]);
    expect((await fake.getMember(CHAT, BOT)).status).toBe("left");
  } finally {
    release();
    await posting;
  }
});

it("reports a webhook delivery error raised by the log option when the server stops", async () => {
  let failures = 0;
  const { fake, api, user, stopCleanup } = await setup({
    log: (line) => {
      if (line.startsWith("webhook") && failures++ < 2)
        throw new Error("fixture logger unavailable");
    },
  });
  const url = await receiver(async (_update, res) => {
    res.writeHead(503);
    res.end();
  });
  await api("setWebhook", { url, drop_pending_updates: true });
  try {
    await fake.post(CHAT, user, "refused");
    expect((await api("getWebhookInfo")).result.pending_update_count).toBe(1);
  } finally {
    cleanups.splice(cleanups.indexOf(stopCleanup), 1);
    // This deliberately failing logger is the operation failure under test.
    // Shutdown still closes resources and reports that exact delivery error.
    await expect(stopCleanup()).rejects.toThrow("fixture logger unavailable");
  }
});

it("forgets a long poll whose client hung up, so a snapshot need not wait for its timeout", async () => {
  const { fake, api } = await setup();
  const queued = (await api("getUpdates")).result;
  const abort = new AbortController();
  const polling = fetch(`${fake.origin}/bot${TOKEN}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offset: queued.at(-1).update_id + 1,
      timeout: 30,
    }),
    signal: abort.signal,
  }).catch(() => null);
  await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "getUpdates",
    afterSeq: 1,
  });
  abort.abort();
  await polling;

  await expect
    .poll(() =>
      fake.snapshot().then(
        () => "taken",
        (error) => error.message,
      ),
    )
    .toBe("taken");
});
