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
    "Unknown fake wait kind",
  ]);
  expect(
    await control("wait", { condition: { ...kicked, userId: 42 } }),
  ).toEqual([400, "Bad Request: user not found"]);
  expect(await control("wait", { condition: kicked, timeoutMs: 20 })).toEqual([
    408,
    expect.stringContaining("Fake wait deadline 20ms exceeded"),
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
  expect((await api("getChat", { chat_id: old })).status).toBe(400);
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
  expect(call.params).toEqual({ chat_id: CHAT, message_id: messageId });
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

it("records membership application before a held webhook settles, with request-scoped evidence and later handler completion", async () => {
  const initial = 1800000000000;
  const { fake, api } = await setup({ clock: { now: initial } });
  let arrived;
  let release;
  const received = new Promise((resolve) => {
    arrived = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const url = await receiver(async (update, res) => {
    if (update.my_chat_member) {
      arrived();
      await held;
    }
    res.end();
  });
  await api("setWebhook", {
    url,
    allowed_updates: ["my_chat_member"],
    drop_pending_updates: true,
  });
  const leaving = api("leaveChat", { chat_id: CHAT });
  try {
    await received;
    expect((await fake.getMember(CHAT, BOT)).status).toBe("left");
    const applied = await fake.waitFor(
      {
        kind: "call",
        botId: BOT,
        method: "leaveChat",
        chatId: CHAT,
        stage: "state_applied",
      },
      { timeoutMs: 15 },
    );
    expect(applied).toMatchObject({ applied: true, outcome: "pending" });
    expect(applied.timeline).toContainEqual({
      stage: "state_applied",
      at: initial,
    });
    expect(
      applied.timeline.some((event) => event.stage === "handler_completed"),
    ).toBe(false);
    await api("getMe");
    expect(
      (await fake.getCalls()).calls.find((call) => call.method === "getMe"),
    ).toMatchObject({ method: "getMe", applied: true, outcome: "succeeded" });
    await fake.advanceTime(50);
  } finally {
    release();
    await leaving;
  }
  const finished = await fake.waitFor({
    kind: "call",
    botId: BOT,
    method: "leaveChat",
    stage: "response_sent",
  });
  expect(
    finished.timeline.filter((event) => event.stage === "state_applied"),
  ).toEqual([{ stage: "state_applied", at: initial }]);
  expect(finished.timeline).toContainEqual({
    stage: "handler_completed",
    at: initial + 50,
  });
});

it("preserves applied-state evidence if a handler fails after a membership change", async () => {
  let failures = 0;
  const { fake, api, stopCleanup } = await setup({
    log: (line) => {
      if (line.startsWith("webhook") && failures++ < 2)
        throw new Error("fixture logger unavailable");
    },
  });
  const url = await receiver(async (_update, res) => {
    res.writeHead(503);
    res.end();
  });
  await api("setWebhook", {
    url,
    allowed_updates: ["my_chat_member"],
    drop_pending_updates: true,
  });
  try {
    expect(await api("leaveChat", { chat_id: CHAT })).toMatchObject({
      ok: false,
      status: 500,
    });
    expect((await fake.getMember(CHAT, BOT)).status).toBe("left");
    const receipt = (await fake.getCalls()).calls.find(
      (call) => call.method === "leaveChat",
    );
    expect(receipt).toMatchObject({
      applied: true,
      failed: 500,
      outcome: "failed_after_apply",
    });
    expect(receipt.timeline.map((event) => event.stage)).toEqual([
      "received",
      "validated",
      "state_applied",
      "response_sent",
    ]);
  } finally {
    cleanups.splice(cleanups.indexOf(stopCleanup), 1);
    // This deliberately failing logger is the operation failure under test.
    // Shutdown still closes resources and reports that exact delivery error.
    await expect(stopCleanup()).rejects.toThrow("fixture logger unavailable");
  }
});
