// The owner client: a test stand-in for the GramJS TelegramClient an app uses
// on a user's own account. Every test drives the exported client exactly as an
// app would, against state the test seeds through the server's controls.
import { afterEach, describe, expect, it } from "vitest";

import { createOwnerClient, ownerApi, startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST-TOKEN";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup() {
  const server = await startTestServer({ botToken: TOKEN });
  cleanups.push(() => server.stop());
  const owner = await server.createOwner({ firstName: "Ana", username: "ana" });
  const client = createOwnerClient({ origin: server.origin, userId: owner.id });
  await client.connect();
  cleanups.push(() => client.destroy());
  return { server, owner, client };
}

/** A dialog with one message at `date`, returning its peer id. */
async function dialogAt(server, ownerId, fields, date, messageId = 1) {
  const { id } = await server.addOwnerDialog(ownerId, fields);
  await server.addOwnerMessages(ownerId, id, [
    {
      id: messageId,
      date,
      text: `${fields.title ?? fields.firstName} ${date}`,
    },
  ]);
  return id;
}

describe("connecting", () => {
  it("answers as the owner, and refuses calls before connect and after disconnect", async () => {
    const server = await startTestServer({ botToken: TOKEN });
    cleanups.push(() => server.stop());
    const owner = await server.createOwner({
      firstName: "Ana",
      lastName: "Lee",
      username: "ana",
    });
    const client = createOwnerClient({
      origin: server.origin,
      userId: owner.id,
    });

    await expect(client.getMe()).rejects.toThrow(/disconnected/);
    await client.connect();
    expect(await client.isUserAuthorized()).toBe(true);
    expect(await client.getMe()).toMatchObject({
      className: "User",
      id: owner.id,
      self: true,
      firstName: "Ana",
      lastName: "Lee",
      username: "ana",
      bot: false,
    });
    await client.disconnect();
    await expect(client.getDialogs({})).rejects.toThrow(/disconnected/);
  });

  it("reports an owner whose authorization was revoked", async () => {
    const { server, owner, client } = await setup();
    await server.updateOwner(owner.id, { authorized: false });
    expect(await client.isUserAuthorized()).toBe(false);
    await expect(client.getMe()).rejects.toMatchObject({
      errorMessage: "AUTH_KEY_UNREGISTERED",
      code: 401,
    });
  });
});

describe("entities", () => {
  it("resolves users, bots, basic groups, supergroups and channels in GramJS shapes", async () => {
    const { server, owner, client } = await setup();
    const person = await dialogAt(
      server,
      owner.id,
      {
        kind: "private",
        id: 501,
        firstName: "Sam",
        lastName: "Roe",
        username: "sam",
      },
      100,
    );
    const bot = await dialogAt(
      server,
      owner.id,
      { kind: "bot", id: 502, firstName: "Helper", username: "helper_bot" },
      101,
    );
    const group = await dialogAt(
      server,
      owner.id,
      { kind: "group", id: 601, title: "Family", participantsCount: 4 },
      102,
    );
    const supergroup = await dialogAt(
      server,
      owner.id,
      {
        kind: "supergroup",
        id: 701,
        title: "Builders",
        username: "builders",
        participantsCount: 812,
      },
      103,
    );
    const channel = await dialogAt(
      server,
      owner.id,
      { kind: "channel", id: 702, title: "News", participantsCount: 9000 },
      104,
    );

    expect([person, bot, group, supergroup, channel]).toEqual([
      501, 502, -601, -1000000000701, -1000000000702,
    ]);
    expect(await client.getEntity(person)).toMatchObject({
      className: "User",
      id: 501,
      firstName: "Sam",
      lastName: "Roe",
      username: "sam",
      bot: false,
    });
    expect(await client.getEntity(bot)).toMatchObject({
      className: "User",
      id: 502,
      bot: true,
    });
    expect(await client.getEntity(group)).toMatchObject({
      className: "Chat",
      id: 601,
      title: "Family",
      participantsCount: 4,
    });
    expect(await client.getEntity(String(supergroup))).toMatchObject({
      className: "Channel",
      id: 701,
      title: "Builders",
      username: "builders",
      megagroup: true,
      broadcast: false,
      participantsCount: 812,
    });
    expect(await client.getEntity(channel)).toMatchObject({
      className: "Channel",
      id: 702,
      megagroup: false,
      broadcast: true,
    });
    expect(
      await client.getInputEntity(await client.getEntity(supergroup)),
    ).toMatchObject({
      className: "InputPeerChannel",
      channelId: 701,
    });
    expect(await client.getInputEntity(person)).toMatchObject({
      className: "InputPeerUser",
      userId: 501,
    });
    expect(await client.getInputEntity(group)).toMatchObject({
      className: "InputPeerChat",
      chatId: 601,
    });
    await expect(client.getEntity(999)).rejects.toThrow(
      /Could not find the input entity/,
    );
  });
});

describe("dialogs", () => {
  it("returns dialogs newest first, with their entity, top message, unread, pin and mute state", async () => {
    const { server, owner, client } = await setup();
    const older = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "Sam" },
      1_000,
    );
    const newer = await dialogAt(
      server,
      owner.id,
      { kind: "supergroup", id: 701, title: "Builders", participantsCount: 5 },
      2_000,
    );
    await server.updateOwnerDialog(owner.id, older, {
      unreadCount: 3,
      muted: true,
    });

    const dialogs = await client.getDialogs({});

    expect(dialogs.total).toBe(2);
    expect(dialogs.map((dialog) => dialog.id)).toEqual([newer, older]);
    const [builders, sam] = dialogs;
    expect(builders).toMatchObject({
      id: newer,
      title: "Builders",
      name: "Builders",
      date: 2_000,
      unreadCount: 0,
      pinned: false,
      archived: false,
      isGroup: true,
      isChannel: true,
      isUser: false,
      entity: { className: "Channel", megagroup: true, participantsCount: 5 },
      message: {
        className: "Message",
        id: 1,
        date: 2_000,
        message: "Builders 2000",
        rawText: "Builders 2000",
      },
      dialog: {
        className: "Dialog",
        pinned: false,
        unreadCount: 0,
        notifySettings: { muteUntil: 0 },
      },
    });
    expect(sam).toMatchObject({
      title: "Sam",
      unreadCount: 3,
      isUser: true,
      dialog: { unreadCount: 3, notifySettings: { muteUntil: 2_147_483_647 } },
    });
  });

  it("keeps main and archive apart, and moves a dialog between them", async () => {
    const { server, owner, client } = await setup();
    const kept = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "Kept" },
      1_000,
    );
    const archived = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 502, firstName: "Old" },
      2_000,
    );
    await server.updateOwnerDialog(owner.id, archived, { folder: 1 });

    const ids = async (options) =>
      (await client.getDialogs(options)).map((d) => d.id);
    expect(await ids({ folder: 0 })).toEqual([kept]);
    expect(await ids({})).toEqual([kept]);
    expect(await ids({ folder: 1 })).toEqual([archived]);
    expect(await ids({ archived: true })).toEqual([archived]);
    const [inArchive] = await client.getDialogs({ folder: 1 });
    expect(inArchive).toMatchObject({
      archived: true,
      folderId: 1,
      dialog: { folderId: 1 },
    });

    await server.updateOwnerDialog(owner.id, archived, { folder: 0 });
    expect(await ids({ folder: 0 })).toEqual([archived, kept]);
    expect(await ids({ folder: 1 })).toEqual([]);
  });

  it("puts pinned dialogs first on the first page only, most recently pinned first", async () => {
    const { server, owner, client } = await setup();
    const ids = [];
    for (let index = 1; index <= 6; index += 1) {
      ids.push(
        await dialogAt(
          server,
          owner.id,
          { kind: "private", id: 500 + index, firstName: `P${index}` },
          1_000 * index,
        ),
      );
    }
    await server.updateOwnerDialog(owner.id, ids[0], { pinned: true });
    await server.updateOwnerDialog(owner.id, ids[1], { pinned: true });

    const first = await client.getDialogs({ limit: 3 });
    expect(first.map((d) => d.id)).toEqual([ids[1], ids[0], ids[5]]);
    expect(first.map((d) => d.pinned)).toEqual([true, true, false]);

    const last = first.at(-1);
    const next = await client.getDialogs({
      limit: 3,
      ignorePinned: true,
      offsetDate: last.date,
      offsetId: last.message.id,
      offsetPeer: await client.getInputEntity(last.id),
    });
    expect(next.map((d) => d.id)).toEqual([ids[4], ids[3], ids[2]]);
    // A cursor page leaves pinned dialogs out even without ignorePinned.
    const withoutFlag = await client.getDialogs({
      limit: 3,
      offsetDate: last.date,
      offsetId: last.message.id,
      offsetPeer: await client.getInputEntity(last.id),
    });
    expect(withoutFlag.map((d) => d.id)).toEqual([ids[4], ids[3], ids[2]]);
    expect(
      (await client.getDialogs({ ignorePinned: true })).map((d) => d.id),
    ).toEqual([ids[5], ids[4], ids[3], ids[2]]);
  });

  it("pages through dialogs with offsets, without gaps or duplicates, across equal dates", async () => {
    const { server, owner, client } = await setup();
    const expected = [];
    // Pairs share a timestamp, so only the message id and peer tell them apart.
    for (let index = 0; index < 11; index += 1) {
      const date = 10_000 - Math.floor(index / 2) * 10;
      expected.push(
        await dialogAt(
          server,
          owner.id,
          { kind: "private", id: 800 + index, firstName: `D${index}` },
          date,
          100 - index,
        ),
      );
    }

    const seen = [];
    let page = await client.getDialogs({ limit: 3 });
    let pages = 0;
    while (page.length) {
      pages += 1;
      seen.push(...page.map((d) => d.id));
      const last = page.at(-1);
      page = await client.getDialogs({
        limit: 3,
        ignorePinned: true,
        offsetDate: last.date,
        offsetId: last.message.id,
        offsetPeer: await client.getInputEntity(last.id),
      });
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(11);
  });

  it("returns an exact last page, then an empty one, and resumes after an offset whose dialog is gone", async () => {
    const { server, owner, client } = await setup();
    const a = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "A" },
      3_000,
    );
    const b = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 502, firstName: "B" },
      2_000,
    );
    const c = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 503, firstName: "C" },
      1_000,
    );

    const page = await client.getDialogs({ limit: 2 });
    expect(page.map((d) => d.id)).toEqual([a, b]);
    const rest = await client.getDialogs({
      limit: 2,
      ignorePinned: true,
      offsetDate: 2_000,
      offsetId: 1,
      offsetPeer: await client.getInputEntity(b),
    });
    expect(rest.map((d) => d.id)).toEqual([c]);
    const empty = await client.getDialogs({
      limit: 2,
      ignorePinned: true,
      offsetDate: 1_000,
      offsetId: 1,
      offsetPeer: await client.getInputEntity(c),
    });
    expect(empty).toHaveLength(0);
    expect((await client.getDialogs({ limit: 0 })).length).toBe(0);

    // b moves to the archive; the offset it left behind still resumes after its position.
    await server.updateOwnerDialog(owner.id, b, { folder: 1 });
    const stale = await client.getDialogs({
      limit: 2,
      ignorePinned: true,
      offsetDate: 2_000,
      offsetId: 1,
      offsetPeer: await client.getInputEntity(b),
    });
    expect(stale.map((d) => d.id)).toEqual([c]);
  });

  it("follows new messages, edits and deletions in the top message", async () => {
    const { server, owner, client } = await setup();
    const peer = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "Sam" },
      1_000,
    );
    const other = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 502, firstName: "Kim" },
      2_000,
    );

    await server.addOwnerMessages(owner.id, peer, [
      { id: 2, date: 3_000, text: "latest" },
    ]);
    let [top] = await client.getDialogs({});
    expect(top).toMatchObject({
      id: peer,
      date: 3_000,
      message: { id: 2, message: "latest" },
    });

    await server.editOwnerMessage(owner.id, peer, 2, {
      text: "latest, edited",
      editDate: 3_100,
    });
    [top] = await client.getDialogs({});
    expect(top.message).toMatchObject({
      message: "latest, edited",
      editDate: 3_100,
    });

    await server.deleteOwnerMessage(owner.id, peer, 2);
    const ids = (await client.getDialogs({})).map((d) => d.id);
    expect(ids).toEqual([other, peer]);
  });
});

describe("history", () => {
  async function withHistory(count) {
    const context = await setup();
    const { server, owner } = context;
    const { id: peer } = await server.addOwnerDialog(owner.id, {
      kind: "supergroup",
      id: 701,
      title: "Builders",
    });
    const { id: member } = await server.addOwnerUser(owner.id, {
      id: 900,
      firstName: "Mia",
      username: "mia",
    });
    const messages = [];
    for (let id = 1; id <= count; id += 1) {
      messages.push({
        id,
        date: 1_000 + id,
        fromId: id % 2 ? member : owner.id,
        out: id % 2 === 0,
        text: `m${id}`,
      });
    }
    await server.addOwnerMessages(owner.id, peer, messages);
    return { ...context, peer, member };
  }

  it("returns messages newest first with sender, chat, out and reply fields", async () => {
    const { server, owner, client, peer, member } = await withHistory(3);
    await server.addOwnerMessages(owner.id, peer, [
      { id: 4, date: 1_010, fromId: member, text: "answer", replyTo: 2 },
    ]);

    const entity = await client.getEntity(peer);
    const messages = await client.getMessages(entity, { limit: 10 });

    expect(messages.map((m) => m.id)).toEqual([4, 3, 2, 1]);
    expect(messages.total).toBe(4);
    expect(messages[0]).toMatchObject({
      className: "Message",
      id: 4,
      message: "answer",
      rawText: "answer",
      text: "answer",
      date: 1_010,
      out: false,
      fromId: { className: "PeerUser", userId: member },
      senderId: member,
      sender: { className: "User", id: member, firstName: "Mia" },
      peerId: { className: "PeerChannel", channelId: 701 },
      chatId: peer,
      chat: { className: "Channel", id: 701 },
      replyTo: { className: "MessageReplyHeader", replyToMsgId: 2 },
      replyToMsgId: 2,
      editDate: null,
    });
    expect(messages[1]).toMatchObject({ out: false, sender: { id: member } });
    expect(messages[2]).toMatchObject({
      out: true,
      senderId: owner.id,
      sender: { self: true },
    });
  });

  it("pages older messages with offsetId, strictly older each time", async () => {
    const { client, peer } = await withHistory(10);
    const entity = await client.getEntity(peer);
    const seen = [];
    let page = await client.getMessages(entity, { limit: 3 });
    let pages = 0;
    while (page.length) {
      pages += 1;
      seen.push(...page.map((m) => m.id));
      page = await client.getMessages(entity, {
        limit: 3,
        offsetId: page.at(-1).id,
      });
    }
    expect(pages).toBe(4);
    expect(seen).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("skips deleted messages and returns requested ids in the order asked, undefined when missing", async () => {
    const { server, owner, client, peer } = await withHistory(5);
    await server.deleteOwnerMessage(owner.id, peer, 4);
    const entity = await client.getEntity(peer);

    expect(
      (await client.getMessages(entity, { limit: 10 })).map((m) => m.id),
    ).toEqual([5, 3, 2, 1]);
    expect(
      (await client.getMessages(entity, { limit: 2, offsetId: 5 })).map(
        (m) => m.id,
      ),
    ).toEqual([3, 2]);
    const byId = await client.getMessages(entity, { ids: [2, 4, 99, 5] });
    expect(byId.map((m) => m?.id)).toEqual([2, undefined, undefined, 5]);
    expect(
      await client.getMessages(entity, { limit: 5, offsetId: 1 }),
    ).toHaveLength(0);
  });

  it("returns service messages and seeded media in GramJS shapes", async () => {
    const { server, owner, client } = await setup();
    const { id: peer } = await server.addOwnerDialog(owner.id, {
      kind: "group",
      id: 601,
      title: "Family",
    });
    const { id: member } = await server.addOwnerUser(owner.id, {
      id: 900,
      firstName: "Mia",
    });
    await server.addOwnerMessages(owner.id, peer, [
      {
        id: 1,
        date: 1_000,
        fromId: member,
        action: { className: "MessageActionChatAddUser", users: [member] },
      },
      {
        id: 2,
        date: 1_001,
        fromId: member,
        text: "look",
        media: { type: "photo", id: 55 },
      },
      {
        id: 3,
        date: 1_002,
        fromId: member,
        text: "",
        media: {
          type: "document",
          id: 56,
          fileName: "menu.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
      },
    ]);
    const [doc, photo, joined] = await client.getMessages(
      await client.getEntity(peer),
      { limit: 3 },
    );

    expect(joined).toMatchObject({
      className: "MessageService",
      id: 1,
      action: { className: "MessageActionChatAddUser", users: [member] },
      peerId: { className: "PeerChat", chatId: 601 },
    });
    expect(photo.media).toMatchObject({
      className: "MessageMediaPhoto",
      photo: { className: "Photo", id: 55 },
    });
    expect(doc.media).toMatchObject({
      className: "MessageMediaDocument",
      document: {
        className: "Document",
        id: 56,
        mimeType: "application/pdf",
        size: 2048,
        attributes: [
          { className: "DocumentAttributeFilename", fileName: "menu.pdf" },
        ],
      },
    });
  });
});

describe("dialog filters", () => {
  it("returns the default and custom filters in their order, and follows updates and deletions", async () => {
    const { server, owner, client } = await setup();
    const sam = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "Sam" },
      1_000,
    );
    const group = await dialogAt(
      server,
      owner.id,
      { kind: "supergroup", id: 701, title: "Builders" },
      2_000,
    );
    await server.setOwnerFilter(owner.id, {
      id: 2,
      title: "Work",
      emoticon: "💼",
      includePeers: [group],
      pinnedPeers: [group],
      groups: true,
    });
    await server.setOwnerFilter(owner.id, {
      id: 3,
      title: "People",
      includePeers: [sam],
      excludePeers: [group],
      contacts: true,
    });

    const load = async () =>
      (await client.invoke(new ownerApi.messages.GetDialogFilters({}))).filters;
    let filters = await load();
    expect(filters.map((f) => f.className)).toEqual([
      "DialogFilterDefault",
      "DialogFilter",
      "DialogFilter",
    ]);
    expect(filters[1]).toMatchObject({
      id: 2,
      title: { className: "TextWithEntities", text: "Work", entities: [] },
      emoticon: "💼",
      groups: true,
      includePeers: [{ className: "InputPeerChannel", channelId: 701 }],
      pinnedPeers: [{ className: "InputPeerChannel", channelId: 701 }],
      excludePeers: [],
    });
    expect(filters[2]).toMatchObject({
      id: 3,
      contacts: true,
      includePeers: [{ className: "InputPeerUser", userId: 501 }],
      excludePeers: [{ className: "InputPeerChannel", channelId: 701 }],
    });

    await server.orderOwnerFilters(owner.id, [3, 0, 2]);
    await server.setOwnerFilter(owner.id, {
      id: 2,
      title: "Jobs",
      includePeers: [group],
    });
    filters = await load();
    expect(filters.map((f) => f.id ?? "default")).toEqual([3, "default", 2]);
    expect(filters[2].title.text).toBe("Jobs");

    await server.deleteOwnerFilter(owner.id, 3);
    expect((await load()).map((f) => f.id ?? "default")).toEqual([
      "default",
      2,
    ]);
  });
});

describe("owners are isolated", () => {
  it("keeps the same peer and message ids apart for two owners", async () => {
    const { server, owner, client } = await setup();
    const other = await server.createOwner({ firstName: "Ben" });
    const otherClient = createOwnerClient({
      origin: server.origin,
      userId: other.id,
    });
    await otherClient.connect();
    cleanups.push(() => otherClient.destroy());

    for (const [who, text] of [
      [owner.id, "for Ana"],
      [other.id, "for Ben"],
    ]) {
      const { id } = await server.addOwnerDialog(who, {
        kind: "private",
        id: 501,
        firstName: "Sam",
      });
      await server.addOwnerMessages(who, id, [{ id: 7, date: 1_000, text }]);
    }
    await server.updateOwnerDialog(other.id, 501, {
      unreadCount: 4,
      folder: 1,
    });

    const [mine] = await client.getDialogs({});
    expect(mine).toMatchObject({
      id: 501,
      unreadCount: 0,
      message: { id: 7, message: "for Ana" },
    });
    expect(await otherClient.getDialogs({})).toHaveLength(0);
    const [theirs] = await otherClient.getDialogs({ folder: 1 });
    expect(theirs).toMatchObject({
      id: 501,
      unreadCount: 4,
      message: { message: "for Ben" },
    });

    await server.deleteOwnerMessage(owner.id, 501, 7);
    const [still] = await otherClient.getMessages(501, { ids: [7] });
    expect(still.message).toBe("for Ben");
    expect(
      (await server.getOwnerCalls(other.id)).every(
        (call) => call.owner_id === other.id,
      ),
    ).toBe(true);
  });

  it("refuses a client for an owner that does not exist", async () => {
    const server = await startTestServer({ botToken: TOKEN });
    cleanups.push(() => server.stop());
    const client = createOwnerClient({ origin: server.origin, userId: 424242 });
    await expect(client.connect()).rejects.toThrow(/No owner 424242/);
  });
});

describe("faults and latency", () => {
  it("answers each injected error with the fields GramJS callers read", async () => {
    const { server, owner, client } = await setup();
    const cases = [
      [
        { preset: "flood_wait", seconds: 17 },
        {
          name: "FloodWaitError",
          errorMessage: "FLOOD",
          code: 420,
          seconds: 17,
        },
      ],
      [
        { preset: "permission_denied" },
        { name: "RPCError", errorMessage: "CHAT_WRITE_FORBIDDEN", code: 403 },
      ],
      [
        { preset: "reconnect_required" },
        { name: "RPCError", errorMessage: "AUTH_KEY_UNREGISTERED", code: 401 },
      ],
      [
        { preset: "stale_entity" },
        { name: "RPCError", errorMessage: "PEER_ID_INVALID", code: 400 },
      ],
      [
        { errorMessage: "CHANNEL_PRIVATE", code: 400 },
        { errorMessage: "CHANNEL_PRIVATE", code: 400 },
      ],
    ];
    for (const [fault, expected] of cases) {
      await server.failOwnerCall(owner.id, { method: "getDialogs", ...fault });
      const error = await client.getDialogs({}).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject(expected);
    }
    expect(await client.getDialogs({})).toHaveLength(0);
  });

  it("fails a call a set number of times, then lets it through", async () => {
    const { server, owner, client } = await setup();
    await server.failOwnerCall(owner.id, {
      method: "getMe",
      preset: "flood_wait",
      seconds: 1,
      times: 2,
    });
    await expect(client.getMe()).rejects.toMatchObject({ code: 420 });
    await expect(client.getMe()).rejects.toMatchObject({ code: 420 });
    expect((await client.getMe()).id).toBe(owner.id);
  });

  it("returns a malformed page, and drops a response", async () => {
    const { server, owner, client } = await setup();
    await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "Sam" },
      1_000,
    );
    await server.failOwnerCall(owner.id, {
      method: "getDialogs",
      preset: "malformed_page",
    });
    const [broken] = await client.getDialogs({});
    expect(broken.entity).toBeUndefined();
    expect(broken.message).toBeUndefined();

    await server.failOwnerCall(owner.id, {
      method: "getDialogs",
      preset: "dropped",
    });
    await expect(client.getDialogs({})).rejects.toThrow(/TIMEOUT/);
    expect((await server.getOwnerCalls(owner.id)).at(-1)).toMatchObject({
      method: "getDialogs",
      outcome: "dropped",
    });
  });

  it("delays calls so they can complete out of order", async () => {
    const { server, owner, client } = await setup();
    await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "Sam" },
      1_000,
    );
    await server.failOwnerCall(owner.id, {
      method: "getDialogs",
      delayMs: 300,
    });
    const finished = [];
    await Promise.all([
      client.getDialogs({}).then(() => finished.push("slow dialogs")),
      client.getMe().then(() => finished.push("fast getMe")),
    ]);
    expect(finished).toEqual(["fast getMe", "slow dialogs"]);
  });
});

describe("the calls ledger", () => {
  it("records every call with its outcome, without session material", async () => {
    const server = await startTestServer({ botToken: TOKEN });
    cleanups.push(() => server.stop());
    const owner = await server.createOwner({ firstName: "Ana" });
    const client = createOwnerClient({
      origin: server.origin,
      userId: owner.id,
      session: "1AgAOMTQ5LjE1NC4xNjcuNTEBu0SECRET",
    });
    await client.connect();
    await client.getMe();
    await server.failOwnerCall(owner.id, {
      method: "getDialogs",
      preset: "permission_denied",
    });
    await client.getDialogs({ limit: 5 }).catch(() => {});

    const calls = await server.getOwnerCalls(owner.id);
    expect(calls.map((call) => [call.method, call.outcome])).toEqual([
      ["connect", "ok"],
      ["getMe", "ok"],
      ["getDialogs", "error"],
    ]);
    expect(calls[2]).toMatchObject({
      args: { limit: 5 },
      error_message: "CHAT_WRITE_FORBIDDEN",
    });
    expect(JSON.stringify(calls)).not.toContain("SECRET");
    expect(calls[0].args.session).toBe("[redacted]");
  });
});

describe("what the owner client does not do", () => {
  it("fails loudly for unknown methods, unknown requests and unmodelled options", async () => {
    const { client } = await setup();
    await expect(async () => client.sendFile("me", {})).rejects.toThrow(
      /not modelled/,
    );
    await expect(
      client.invoke({ className: "messages.GetHistory" }),
    ).rejects.toThrow(/not modelled/);
    await expect(
      client.getMessages("me", { limit: 1, filter: {} }),
    ).rejects.toThrow(/not modelled/);
  });

  it("reserves markAsRead and sendMessage without pretending to implement them", async () => {
    const { client } = await setup();
    await expect(client.markAsRead(501, 1)).rejects.toMatchObject({
      code: "OWNER_CLIENT_NOT_MODELLED",
    });
    await expect(
      client.sendMessage(501, { message: "hi" }),
    ).rejects.toMatchObject({ code: "OWNER_CLIENT_NOT_MODELLED" });
  });
});

describe("resetting", () => {
  it("clears every owner without restarting the server", async () => {
    const { server, owner } = await setup();
    await server.resetOwners();
    const client = createOwnerClient({
      origin: server.origin,
      userId: owner.id,
    });
    await expect(client.connect()).rejects.toThrow(/No owner/);
  });
});

describe("faults on every operation", () => {
  it("injects a fault into each supported call, and only for the named peer when one is given", async () => {
    const { server, owner, client } = await setup();
    const peer = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 501, firstName: "Sam" },
      1_000,
    );
    const other = await dialogAt(
      server,
      owner.id,
      { kind: "private", id: 502, firstName: "Kim" },
      2_000,
    );
    const calls = {
      isUserAuthorized: () => client.isUserAuthorized(),
      getMe: () => client.getMe(),
      getEntity: () => client.getEntity(peer),
      getInputEntity: () => client.getInputEntity(peer),
      getDialogs: () => client.getDialogs({}),
      getMessages: () => client.getMessages(peer, { limit: 1 }),
      invoke: () => client.invoke(new ownerApi.messages.GetDialogFilters({})),
    };
    for (const [method, run] of Object.entries(calls)) {
      await server.failOwnerCall(owner.id, {
        method,
        preset: "permission_denied",
      });
      await expect(run(), method).rejects.toMatchObject({ code: 403 });
      await expect(run(), method).resolves.toBeDefined();
    }

    await server.failOwnerCall(owner.id, {
      method: "getMessages",
      peerId: other,
      preset: "stale_entity",
    });
    await expect(client.getMessages(peer, { limit: 1 })).resolves.toHaveLength(
      1,
    );
    await expect(client.getMessages(other, { limit: 1 })).rejects.toMatchObject(
      {
        errorMessage: "PEER_ID_INVALID",
      },
    );
  });
});

describe("GramJS's own objects", () => {
  it("resolves peers whose ids are big integers, as GramJS's are", async () => {
    const { server, owner, client } = await setup();
    await dialogAt(
      server,
      owner.id,
      { kind: "supergroup", id: 701, title: "Builders" },
      1_000,
    );
    // GramJS's big-integer ids print their decimal value; native BigInt works too.
    const bigInteger = (value) => ({ toString: () => String(value) });
    expect(
      await client.getEntity({
        className: "InputPeerChannel",
        channelId: bigInteger(701),
        accessHash: bigInteger(1),
      }),
    ).toMatchObject({ className: "Channel", id: 701 });
    expect(
      await client.getEntity({ className: "PeerChannel", channelId: 701n }),
    ).toMatchObject({ id: 701 });
    expect(await client.getEntity(-1000000000701n)).toMatchObject({ id: 701 });
  });
});
