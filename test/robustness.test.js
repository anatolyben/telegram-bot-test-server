import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST";
const GROUP = -1001000000001;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup(options = {}) {
  const server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
    ...options,
  });
  cleanups.push(() => server.stop());
  async function raw(path, body, contentType = "application/json") {
    const response = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    return { status: response.status, body: await response.json() };
  }
  const api = async (method, params = {}) =>
    (await raw(`/bot${TOKEN}/${method}`, JSON.stringify(params))).body;
  return { server, raw, api };
}

describe("update delivery", () => {
  it("hands every update the webhook has not confirmed to getUpdates when the webhook is removed", async () => {
    const { server, api } = await setup();
    const received = [];
    const slow = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        setTimeout(() => response.writeHead(200).end(), 300);
      });
    });
    await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          slow.close(resolve);
          slow.closeAllConnections();
        }),
    );
    await api("setWebhook", {
      url: `http://127.0.0.1:${slow.address().port}/`,
    });
    const ann = await server.createUser();
    await server.join(GROUP, ann);

    const posted = ["one", "two", "three"].map((text) =>
      server.post(GROUP, ann, text),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api("deleteWebhook");
    await Promise.all(posted);

    const polled = (await api("getUpdates")).result.map((u) => u.message.text);
    const delivered = received.map((u) => u.message.text).filter(Boolean);
    // The update in flight was never confirmed, so it is pending too.
    expect(delivered).toHaveLength(1);
    expect([...polled].sort()).toEqual(["one", "three", "two"]);
  });

  it("does not rewrite an update after it was sent", async () => {
    const { server, api } = await setup();
    const link = (await api("createChatInviteLink", { chat_id: GROUP })).result
      .invite_link;
    await api("getUpdates", { allowed_updates: ["chat_member"] });
    await server.joinByLink(link, await server.createUser());

    await api("revokeChatInviteLink", { chat_id: GROUP, invite_link: link });

    const [update] = (await api("getUpdates")).result;
    expect(update.chat_member.invite_link.is_revoked).toBe(false);
  });
});

describe("private chats", () => {
  it("does not let reading a user's private chat open it for the bot", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();

    expect(await server.getDirectMessages(ann)).toEqual([]);

    expect(
      await api("sendMessage", { chat_id: ann, text: "hi" }),
    ).toMatchObject({
      ok: false,
      error_code: 403,
    });
  });
});

describe("bad input", () => {
  it("answers 400, not 500, to request bodies it cannot read", async () => {
    const { raw } = await setup();

    for (const [body, type] of [
      ["{bad", "application/json"],
      ["null", "application/json"],
      ["hello", "text/plain"],
      ["x", "multipart/form-data"],
    ]) {
      expect((await raw(`/bot${TOKEN}/getMe`, body, type)).status).toBe(400);
    }
    expect((await raw("/_fake/users", "{bad")).status).toBe(400);
    expect((await raw("/_fake/users", "null")).status).toBe(400);
  });

  it("answers 400 to malformed permissions and message lists", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser();
    await server.join(GROUP, ann);

    expect(
      await api("restrictChatMember", {
        chat_id: GROUP,
        user_id: ann,
        permissions: null,
      }),
    ).toMatchObject({ ok: false, error_code: 400 });
    expect(
      await api("deleteMessages", { chat_id: GROUP, message_ids: 5 }),
    ).toMatchObject({ ok: false, error_code: 400 });
  });

  it("answers 400 to an invite hash that is not valid percent-encoding", async () => {
    const { raw } = await setup();
    expect(
      (
        await raw(
          "/_fake/invites/%E0%A4%A/join",
          JSON.stringify({ user_id: 1 }),
        )
      ).status,
    ).toBe(400);
  });

  it("ignores a limit that is not a number instead of returning nothing", async () => {
    const { server, api } = await setup();
    await server.sendDirectMessage(await server.createUser(), "hello");

    expect((await api("getUpdates", { limit: "abc" })).result).toHaveLength(1);
  });
});

describe("listening", () => {
  it("gives a usable origin when listening on IPv6 localhost", async () => {
    const { server } = await setup({ host: "::1" });
    const response = await fetch(`${server.origin}/bot${TOKEN}/getMe`);
    expect(response.status).toBe(200);
  });
});
