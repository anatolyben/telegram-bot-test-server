import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST-TOKEN";
const SECOND_TOKEN = "654321:SECOND-TOKEN";

const cleanups = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()();
});

/** A webhook endpoint that records every update, and its raw bytes. */
async function startReceiver() {
  const raw = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      raw.push(Buffer.concat(chunks).toString("utf8"));
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
    raw,
    ofType: (type) =>
      raw
        .map((body) => JSON.parse(body))
        .map((update) => update[type])
        .filter(Boolean),
  };
}

async function setup() {
  const fake = await startTestServer({ botToken: TOKEN });
  cleanups.push(() => fake.stop());
  async function api(method, params = {}, token = TOKEN) {
    const response = await fetch(`${fake.origin}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json()) };
  }
  async function control(method, path, body) {
    const response = await fetch(`${fake.origin}/_fake/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const hook = await startReceiver();
  await api("setWebhook", { url: hook.url });
  const owner = await fake.createUser({ first_name: "Owner" });
  return { fake, api, control, hook, owner };
}

/** A connected owner and a person who has written to them. */
async function connected(rights = { can_reply: true }) {
  const context = await setup();
  const { connection } = await context.fake.connectBusiness({
    ownerId: context.owner,
    rights,
  });
  const person = await context.fake.createUser({ first_name: "Sam" });
  return { ...context, connection, person };
}

describe("users and getMe", () => {
  it("shows is_bot and is_premium on a user wherever a User appears", async () => {
    const { fake, hook, owner } = await setup();
    const { connection } = await fake.connectBusiness({
      ownerId: owner,
      rights: { can_reply: true },
    });
    const premiumBot = await fake.createUser({
      first_name: "Spam Bot",
      is_bot: true,
      is_premium: true,
    });
    const plain = await fake.createUser({ first_name: "Plain" });
    await fake.sayInBusinessChat(connection.id, premiumBot, "person", "hi");
    await fake.sayInBusinessChat(connection.id, plain, "person", "hi");

    await expect.poll(() => hook.ofType("business_message").length).toBe(2);
    const [fromBot, fromPlain] = hook.ofType("business_message");
    expect(fromBot.from).toMatchObject({ is_bot: true, is_premium: true });
    expect(fromPlain.from.is_bot).toBe(false);
    expect(fromPlain.from.is_premium).toBeUndefined();
  });

  it("says the bot can be connected to a business account", async () => {
    const { api } = await setup();
    expect((await api("getMe")).result.can_connect_to_business).toBe(true);
  });
});

describe("business connections", () => {
  it("connects a bot, tells it through business_connection, and changes the connection", async () => {
    const { fake, api, hook, owner } = await setup();
    const created = await fake.connectBusiness({
      ownerId: owner,
      rights: { can_reply: true },
    });
    expect(created.update_id).toEqual(expect.any(Number));
    expect(created.connection).toMatchObject({
      user: { id: owner },
      user_chat_id: owner,
      rights: { can_reply: true },
      is_enabled: true,
    });

    await fake.connectBusiness({
      id: created.connection.id,
      ownerId: owner,
      rights: {},
      isEnabled: false,
    });

    await expect.poll(() => hook.ofType("business_connection").length).toBe(2);
    expect(hook.ofType("business_connection")[1]).toMatchObject({
      id: created.connection.id,
      rights: {},
      is_enabled: false,
    });
    expect(await fake.getBusinessConnection(created.connection.id)).toEqual(
      hook.ofType("business_connection")[1],
    );
    expect(
      (
        await api("getBusinessConnection", {
          business_connection_id: created.connection.id,
        })
      ).result,
    ).toEqual(hook.ofType("business_connection")[1]);
  });

  it("sends business_connection only to a bot that asked for it", async () => {
    const { fake, api, hook, owner } = await setup();
    await api("setWebhook", { url: hook.url, allowed_updates: ["message"] });
    const created = await fake.connectBusiness({
      ownerId: owner,
      rights: { can_reply: true },
    });
    expect(created.update_id).toBeNull();
    expect(hook.ofType("business_connection")).toEqual([]);
  });

  it("refuses getBusinessConnection for a connection it does not know", async () => {
    const { api } = await setup();
    expect(
      await api("getBusinessConnection", { business_connection_id: "nope" }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: BUSINESS_CONNECTION_INVALID",
    });
  });
});

describe("business chats", () => {
  it("sends the person's and the owner's messages as business_message, in one chat", async () => {
    const { fake, hook, owner, connection, person } = await connected();
    const said = await fake.sayInBusinessChat(
      connection.id,
      person,
      "person",
      "are you open?",
    );
    await fake.sayInBusinessChat(connection.id, person, "owner", "yes!");

    expect(said).toMatchObject({
      message_id: expect.any(Number),
      date: expect.any(Number),
      update_id: expect.any(Number),
    });
    await expect.poll(() => hook.ofType("business_message").length).toBe(2);
    const [fromPerson, fromOwner] = hook.ofType("business_message");
    expect(fromPerson).toMatchObject({
      business_connection_id: connection.id,
      from: { id: person },
      chat: { id: person, type: "private" },
      text: "are you open?",
    });
    expect(fromOwner).toMatchObject({
      business_connection_id: connection.id,
      from: { id: owner },
      chat: { id: person },
    });
    expect(
      (await fake.getBusinessChat(connection.id, person)).map(
        (entry) => entry.direction,
      ),
    ).toEqual(["owner", "inbound"]);
  });

  it("sends nothing while the connection is disabled", async () => {
    const { fake, hook, owner, connection, person } = await connected();
    await fake.connectBusiness({
      id: connection.id,
      ownerId: owner,
      rights: { can_reply: true },
      isEnabled: false,
    });
    const said = await fake.sayInBusinessChat(
      connection.id,
      person,
      "person",
      "hi",
    );
    expect(said.update_id).toBeNull();
    expect(hook.ofType("business_message")).toEqual([]);
  });
});

describe("answering in a business chat", () => {
  it("sends as the owner, marked with sender_business_bot", async () => {
    const { fake, api, owner, connection, person } = await connected();
    await fake.sayInBusinessChat(connection.id, person, "person", "hi");

    const sent = await api("sendMessage", {
      business_connection_id: connection.id,
      chat_id: person,
      text: "Hello! How can I help?",
    });

    expect(sent.result).toMatchObject({
      business_connection_id: connection.id,
      from: { id: owner },
      chat: { id: person },
      sender_business_bot: { id: 123456, is_bot: true },
    });
    const [latest] = await fake.getBusinessChat(connection.id, person);
    expect(latest).toMatchObject({
      direction: "bot",
      deleted: false,
      message: { message_id: sent.result.message_id },
    });
  });

  it("refuses an unknown connection, a disabled one, and one without can_reply", async () => {
    const { fake, api, owner, connection, person } = await connected();
    await fake.sayInBusinessChat(connection.id, person, "person", "hi");
    const send = (id = connection.id) =>
      api("sendMessage", {
        business_connection_id: id,
        chat_id: person,
        text: "x",
      });

    expect(await send("unknown")).toMatchObject({
      status: 400,
      description: "Bad Request: BUSINESS_CONNECTION_INVALID",
    });
    await fake.connectBusiness({
      id: connection.id,
      ownerId: owner,
      rights: {},
    });
    expect(await send()).toMatchObject({
      status: 403,
      description: "Forbidden: BOT_ACCESS_FORBIDDEN",
    });
    await fake.connectBusiness({
      id: connection.id,
      ownerId: owner,
      rights: { can_reply: true },
      isEnabled: false,
    });
    expect(await send()).toMatchObject({
      status: 400,
      description: "Bad Request: BUSINESS_CONNECTION_INVALID",
    });
  });

  it("refuses a chat whose person has not written in 24 hours", async () => {
    const { fake, api, connection, person } = await connected();
    const send = () =>
      api("sendMessage", {
        business_connection_id: connection.id,
        chat_id: person,
        text: "x",
      });
    expect(await send()).toMatchObject({
      status: 400,
      description: "Bad Request: BUSINESS_PEER_USAGE_MISSING",
    });

    await fake.sayInBusinessChat(connection.id, person, "person", "hi");
    expect((await send()).ok).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 25 * 3600_000 });
    expect(await send()).toMatchObject({
      description: "Bad Request: BUSINESS_PEER_USAGE_MISSING",
    });
  });

  it("applies requested failures to business sends", async () => {
    const { fake, api, connection, person } = await connected();
    await fake.sayInBusinessChat(connection.id, person, "person", "hi");
    await fake.failNext({
      method: "sendMessage",
      errorCode: 429,
      description: "Too Many Requests: retry after 3",
      retryAfter: 3,
    });
    const sent = await api("sendMessage", {
      business_connection_id: connection.id,
      chat_id: person,
      text: "x",
    });
    expect(sent).toMatchObject({
      status: 429,
      parameters: { retry_after: 3 },
    });
    expect(await fake.getBusinessChat(connection.id, person)).toHaveLength(1);
  });
});

describe("the owner's private chat", () => {
  it("lets the connected bot message the owner, and shows it in their chat", async () => {
    const { fake, api, owner } = await setup();
    expect(
      await api("sendMessage", { chat_id: owner, text: "too early" }),
    ).toMatchObject({ status: 403 });
    await fake.connectBusiness({ ownerId: owner, rights: { can_reply: true } });

    await api("sendMessage", { chat_id: owner, text: "Connected" });

    const chat = await fake.getDirectMessages(owner);
    expect(chat.map((message) => message.text)).toEqual(["Connected"]);
  });

  it("opens it to a second bot when that bot is the one connected", async () => {
    const { fake, api, owner } = await setup();
    const second = await fake.addBot({ token: SECOND_TOKEN, username: "biz" });
    await fake.connectBusiness({
      ownerId: owner,
      rights: { can_reply: true },
      botId: second.id,
    });
    expect(
      (await api("sendMessage", { chat_id: owner, text: "hi" }, SECOND_TOKEN))
        .ok,
    ).toBe(true);
  });
});

describe("redelivery", () => {
  it("sends an update again, byte for byte, to the bot it went to", async () => {
    const { fake, hook, connection, person } = await connected();
    const said = await fake.sayInBusinessChat(
      connection.id,
      person,
      "person",
      "hi",
    );
    await expect.poll(() => hook.ofType("business_message").length).toBe(1);

    expect(await fake.redeliverUpdate(said.update_id)).toEqual({
      update_id: said.update_id,
    });
    await expect.poll(() => hook.ofType("business_message").length).toBe(2);
    expect(hook.raw.at(-1)).toBe(hook.raw.at(-2));
  });

  it("answers 404 for an unknown update and 409 when the bot has no webhook", async () => {
    const { fake, api, control, connection, person } = await connected();
    expect((await control("POST", "updates/1/redeliver")).status).toBe(404);
    const said = await fake.sayInBusinessChat(
      connection.id,
      person,
      "person",
      "hi",
    );
    await api("deleteWebhook");
    expect(
      (await control("POST", `updates/${said.update_id}/redeliver`)).status,
    ).toBe(409);
  });
});
