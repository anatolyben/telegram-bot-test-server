// An app's owner-account adapter, driven against the owner client exactly as it
// calls GramJS: the dialog list's first page and cursor pages, entity lookups,
// older-history pages and the dialog filters. The adapter's code is not here;
// its call sequence is.
import { afterEach, expect, it } from "vitest";

import { createOwnerClient, ownerApi, startTestServer } from "../src/index.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

it("serves an app's dialog pages, history pages and filters through the public client", async () => {
  const server = await startTestServer({ botToken: "123456:TEST-TOKEN" });
  cleanups.push(() => server.stop());
  const owner = await server.createOwner({ firstName: "Ana" });
  const { id: builders } = await server.addOwnerDialog(owner.id, {
    kind: "supergroup",
    id: 701,
    title: "Builders",
    participantsCount: 40,
  });
  const { id: sam } = await server.addOwnerDialog(owner.id, {
    kind: "private",
    id: 501,
    firstName: "Sam",
  });
  const { id: member } = await server.addOwnerUser(owner.id, {
    id: 900,
    firstName: "Mia",
  });
  await server.addOwnerMessages(
    owner.id,
    builders,
    Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      date: 5_000 + index,
      fromId: member,
      text: `update ${index + 1}`,
    })),
  );
  await server.addOwnerMessages(owner.id, sam, [
    { id: 1, date: 4_000, text: "hi" },
  ]);
  await server.updateOwnerDialog(owner.id, sam, { unreadCount: 1 });
  await server.setOwnerFilter(owner.id, {
    id: 2,
    title: "Work",
    includePeers: [builders],
  });

  // What the app's lifecycle does after constructing its client.
  const client = createOwnerClient({
    origin: server.origin,
    userId: owner.id,
    session: "owner-session",
  });
  await client.connect();
  cleanups.push(() => client.destroy());
  expect(await client.isUserAuthorized()).toBe(true);

  // First dialog page: one bounded head in the main folder, sliced by the app.
  const head = [...(await client.getDialogs({ folder: 0, limit: 100 }))];
  const firstPage = head.slice(0, 1);
  expect(firstPage.map((dialog) => String(dialog.id))).toEqual([
    String(builders),
  ]);

  // The next page resumes from the last dialog's offsets, resolved by id string.
  const last = firstPage.at(-1);
  const offsetPeer = await client.getInputEntity(String(last.id));
  const nextPage = [
    ...(await client.getDialogs({
      folder: 0,
      limit: 1,
      ignorePinned: true,
      offsetDate: Number(last.date ?? last.message?.date),
      offsetId: Number(last.message?.id),
      offsetPeer,
    })),
  ];
  expect(
    nextPage.map((dialog) => [String(dialog.id), dialog.unreadCount]),
  ).toEqual([[String(sam), 1]]);

  // History: the entity, then newest-first pages going older by offsetId.
  const entity = await client.getEntity(String(builders));
  const seen = [];
  let beforeMessageId = null;
  for (let page = 0; page < 3; page += 1) {
    const options = { limit: 3 };
    if (beforeMessageId != null) options.offsetId = Number(beforeMessageId);
    const messages = [...(await client.getMessages(entity, options))].filter(
      (message) => ["Message", "MessageService"].includes(message?.className),
    );
    seen.push(...messages.map((message) => message.id));
    beforeMessageId = messages.at(-1)?.id ?? null;
  }
  expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);

  // Dialog filters, as the app reads them.
  const response = await client.invoke(
    new ownerApi.messages.GetDialogFilters({}),
  );
  const filters = Array.isArray(response) ? response : response.filters;
  expect(
    filters.map((filter) => [filter.className, filter.title?.text ?? null]),
  ).toEqual([
    ["DialogFilterDefault", null],
    ["DialogFilter", "Work"],
  ]);

  const calls = await server.getOwnerCalls(owner.id);
  expect(calls.map((call) => call.method)).toEqual([
    "connect",
    "isUserAuthorized",
    "getDialogs",
    "getInputEntity",
    "getDialogs",
    "getEntity",
    "getMessages",
    "getMessages",
    "getMessages",
    "invoke",
  ]);
});
