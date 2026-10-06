import http from "node:http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { Telegraf } from "telegraf";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST";
const GROUP = -1001000000001;
const OWNER = 5000000001;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function startServer() {
  const server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
  });
  cleanups.push(() => server.stop());
  return server;
}

async function getUpdates(server, params = {}) {
  const response = await fetch(`${server.origin}/bot${TOKEN}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return { status: response.status, ...(await response.json()) };
}

describe("grammY", () => {
  it("runs a polling bot that removes links and bans the sender (the README quick start)", async () => {
    const server = await startServer();

    const bot = new Bot(TOKEN, { client: { apiRoot: server.origin } });
    bot.on("message:text", async (ctx) => {
      if (ctx.message.entities?.some((entity) => entity.type === "url")) {
        await ctx.deleteMessage();
        await ctx.banChatMember(ctx.from.id);
      }
    });
    void bot.start();
    cleanups.push(() => bot.stop());

    const ann = await server.createUser({ first_name: "Ann" });
    await server.join(GROUP, ann);
    const hello = await server.post(GROUP, ann, "hello everyone");
    const spam = await server.post(
      GROUP,
      ann,
      "cheap followers at example.com",
    );

    await expect
      .poll(async () => (await server.getMember(GROUP, ann)).status)
      .toBe("kicked");
    expect((await server.getMessage(GROUP, spam)).deleted).toBe(true);
    // A ban deletes nothing; the author's earlier message stays.
    expect((await server.getMessage(GROUP, hello)).deleted).toBe(false);
  });

  it("runs a webhook bot that asks new members to press a button", async () => {
    const server = await startServer();

    const bot = new Bot(TOKEN, { client: { apiRoot: server.origin } });
    bot.on("message:new_chat_members", (ctx) =>
      ctx.reply("Press the button to stay", {
        reply_markup: new InlineKeyboard().text("I am human", "human"),
      }),
    );
    bot.callbackQuery("human", (ctx) => ctx.answerCallbackQuery("Welcome!"));
    await bot.init();

    const receiver = http.createServer(webhookCallback(bot, "http"));
    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          receiver.close(resolve);
          receiver.closeAllConnections();
        }),
    );
    await bot.api.setWebhook(`http://127.0.0.1:${receiver.address().port}/`);

    const ann = await server.createUser({ first_name: "Ann" });
    await server.join(GROUP, ann);
    await expect
      .poll(async () => (await server.getMessages(GROUP))[0]?.text)
      .toBe("Press the button to stay");

    const [prompt] = await server.getMessages(GROUP);
    expect(
      await server.pressButton(GROUP, prompt.message_id, ann, "human"),
    ).toMatchObject({ answered: true, text: "Welcome!" });
  });
});

describe("Telegraf", () => {
  it("runs a polling bot that answers /start in a direct message", async () => {
    const server = await startServer();

    const bot = new Telegraf(TOKEN, { telegram: { apiRoot: server.origin } });
    bot.start((ctx) => ctx.reply(`Hi ${ctx.from.first_name}`));
    void bot.launch();
    cleanups.push(() => bot.stop());

    const ann = await server.createUser({ first_name: "Ann" });
    await server.sendDirectMessage(ann, "/start");

    await expect
      .poll(async () => (await server.getDirectMessages(ann))[0]?.text)
      .toBe("Hi Ann");
  });
});

describe("polling", () => {
  it("queues updates until the bot polls, and an offset confirms them", async () => {
    const server = await startServer();
    const ann = await server.createUser();
    await server.join(GROUP, ann);
    await server.post(GROUP, ann, "first");
    await server.post(GROUP, ann, "second");

    const { result } = await getUpdates(server);
    expect(result.map((update) => update.message.text ?? "join")).toEqual([
      "join",
      "first",
      "second",
    ]);

    const next = result.at(-1).update_id + 1;
    expect((await getUpdates(server, { offset: next })).result).toEqual([]);
  });

  it("holds a long poll open until an update arrives", async () => {
    const server = await startServer();
    const ann = await server.createUser();

    const started = Date.now();
    const polled = getUpdates(server, { timeout: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await server.sendDirectMessage(ann, "ping");

    const { result } = await polled;
    expect(result[0].message.text).toBe("ping");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses getUpdates while a webhook is set, as Telegram does", async () => {
    const server = await startServer();
    await fetch(`${server.origin}/bot${TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9/" }),
    });

    expect(await getUpdates(server)).toMatchObject({
      status: 409,
      ok: false,
      error_code: 409,
    });
  });

  it("filters queued updates by the allowed_updates the bot asked for", async () => {
    const server = await startServer();
    await getUpdates(server, { allowed_updates: ["chat_member"] });

    const ann = await server.createUser();
    await server.join(GROUP, ann);

    const { result } = await getUpdates(server);
    expect(result.map((update) => Object.keys(update)[1])).toEqual([
      "chat_member",
    ]);
  });
});
