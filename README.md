# telegram-bot-test-server

**A local Telegram Bot API server for end-to-end tests.**\
Develop and test your bot offline: no Telegram account, no phone number, no real groups.

[![Bot API 10.3](https://img.shields.io/badge/Bot%20API-10.3-2aabee?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Tests](https://github.com/anatolyben/telegram-bot-test-server/actions/workflows/test.yml/badge.svg)](https://github.com/anatolyben/telegram-bot-test-server/actions/workflows/test.yml)
[![Coverage](https://codecov.io/gh/anatolyben/telegram-bot-test-server/graph/badge.svg)](https://codecov.io/gh/anatolyben/telegram-bot-test-server)
[![npm](https://img.shields.io/npm/v/telegram-bot-test-server)](https://www.npmjs.com/package/telegram-bot-test-server)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/anatolyben/telegram-bot-test-server/blob/main/package.json)
[![License: MIT](https://img.shields.io/npm/l/telegram-bot-test-server)](https://github.com/anatolyben/telegram-bot-test-server/blob/main/LICENSE)
[![Node >= 20](https://img.shields.io/node/v/telegram-bot-test-server)](https://github.com/anatolyben/telegram-bot-test-server/blob/main/package.json)

<img src="https://raw.githubusercontent.com/anatolyben/telegram-bot-test-server/v0.13.1/docs/images/viewer-desktop.jpg"
  alt="The chat viewer: every chat in one feed, with the bot's calls and member changes beside the
  messages" width="880">

[Install](#install) · [Quick start](#quick-start) · [Guide](#write-a-test) ·
[Viewer](#watch-the-chats-in-a-browser) · [Reference](#reference)

---

## What you can test

- **Moderation**: deleting messages, bans, mutes with an end time, and admin rights, with
  Telegram's own refusals and error texts.
- **Members**: joins, leaves, join requests, invite links, and people posting text, media,
  contacts, locations and polls.
- **Buttons**: inline keyboards, button presses, URL buttons and `/start` links.
- **Delivery**: webhooks and `getUpdates` polling, several bots in one group, and what each bot was
  sent.
- **Time**: a clock your test controls, which your app can follow too.
- **Watching**: a live viewer of every chat, and recordings you can open later.

It never talks to Telegram and runs as often as you like in CI.

<details>
<summary><b>All sections</b></summary>

**Start:** [Install](#install) · [Quick start](#quick-start) · [How it works](#how-it-works)

**Recipes:** [Delete a spam link and ban](#delete-a-spam-link-and-ban) ·
[Approve a join request after a button press](#approve-a-join-request-after-a-button-press) ·
[Check that a mute ends](#check-that-a-mute-ends) ·
[Prove a bot did not receive something](#prove-a-bot-did-not-receive-something) ·
[Report a scenario to the viewer](#report-a-scenario-to-the-viewer)

**Guide:** [Write a test](#write-a-test) · [Make users act](#make-users-act) ·
[Check what the bot did](#check-what-the-bot-did) ·
[Message log and delivered updates](#message-log-and-delivered-updates) ·
[Webhooks and polling](#webhooks-and-polling) · [More than one bot](#more-than-one-bot) ·
[Channels, basic groups and forums](#channels-basic-groups-and-forums) ·
[Failures, flood control and time](#failures-flood-control-and-time) ·
[Testing time-based app logic](#testing-time-based-app-logic) · [Snapshots](#snapshots) ·
[Watch the chats in a browser](#watch-the-chats-in-a-browser) ·
[Record a scenario](#record-a-scenario) · [Report scenarios](#report-scenarios) ·
[Telegram Login](#telegram-login) · [Owner accounts (GramJS)](#owner-accounts-gramjs) ·
[Other languages](#other-languages-command-line-and-http)

**[Reference](#reference)** ([docs/reference.md][ref]): [Options][ref-options] ·
[Test actions][ref-actions] · [Wait conditions][ref-waits] · [Control API][ref-control] ·
[Supported Bot API methods][ref-methods] · [Call receipts][ref-receipts] · [Viewer][ref-viewer]

**More:** [Development](#development) · [License](#license)

</details>

---

## Install

```sh
npm install --save-dev --save-exact telegram-bot-test-server
```

Requires Node.js 20 or newer. No runtime dependencies. Everything lives in memory and is gone when
the server stops. The control API answers anyone who can reach its port, so keep it on localhost.

---

## Quick start

A grammY bot that deletes links and bans whoever posted them, tested end to end:

```js
import { Bot } from "grammy";
import { startTestServer } from "telegram-bot-test-server";

const GROUP = -1001000000001;
const server = await startTestServer({
  botToken: "123456:TEST",
  chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
});

// Your bot, unchanged except for where it sends Bot API calls.
const bot = new Bot("123456:TEST", { client: { apiRoot: server.origin } });
bot.on("message:text", async (ctx) => {
  if (ctx.message.entities?.some((entity) => entity.type === "url")) {
    await ctx.deleteMessage();
    await ctx.banChatMember(ctx.from.id);
  }
});
// Resolve once the bot is polling.
await new Promise((resolve) => bot.start({ onStart: resolve }));

// Telegram's side, played by the test.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
const spam = await server.post(GROUP, ann, "cheap followers at example.com");

// Then wait for what the bot did: it runs asynchronously.
await server.waitFor({
  kind: "message",
  chatId: GROUP,
  messageId: spam,
  deleted: true,
});
await server.waitFor({
  kind: "member",
  chatId: GROUP,
  userId: ann,
  status: "kicked",
});

await bot.stop();
await server.stop();
```

With `grammy` installed, save it as `quickstart.mjs` and run `node quickstart.mjs`. It exits 0
once the bot has deleted the message and banned Ann. Like every example here, it is an ES module:
use `.mjs`, or `"type": "module"` in your `package.json`.

The same works with other libraries; only the base URL option differs:

| Library       | Point it at the server                                                  |
| ------------- | ----------------------------------------------------------------------- |
| grammY        | `new Bot(token, { client: { apiRoot: server.origin } })`                |
| Telegraf      | `new Telegraf(token, { telegram: { apiRoot: server.origin } })`         |
| Anything else | Replace `https://api.telegram.org` with `server.origin` in its settings |

Both grammY and Telegraf are tested against the server, with polling and with a webhook. A bot
written in another language, such as Python, points at the server the same way; its tests drive
the server over HTTP ([Other languages](#other-languages-command-line-and-http)).

---

## How it works

Your bot sends its Bot API calls to `server.origin` instead of `https://api.telegram.org`, and the
server answers the way Telegram does, keeping the state a group bot depends on: members and their
status, restrictions and bans, messages and deletions, invite links, join requests and profile
photos.

Your test plays the other side through **test actions**, methods such as `server.join`,
`server.post` and `server.pressButton`: users join, leave, post, ask to join, press buttons and
message the bot, and the server sends your bot the same updates Telegram would, by webhook or
through `getUpdates` polling.

Your bot handles those updates in its own time, so the test then waits for what it expects with
`server.waitFor`, or reads the state with `server.getMessages`, `server.getMember` and
`server.getCalls`.

---

## Recipes

Short [Vitest](https://vitest.dev) tests for common jobs, with a grammY bot. Each one runs as it
is. Put this setup at the top of the test file, then paste any recipe under it.

```js
// recipes.test.js
import { Bot, InlineKeyboard } from "grammy";
import { afterEach, expect, test } from "vitest";
import { startTestServer } from "telegram-bot-test-server";

const TOKEN = "123456:TEST";
const BOT_ID = 123456; // the number before the colon in the token
const GROUP = -1001000000001;
let server;
let bot;

// A server with GROUP in it, and a bot pointed at it. Add handlers, then start().
async function setup(options = {}) {
  server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
    ...options,
  });
  bot = new Bot(TOKEN, { client: { apiRoot: server.origin } });
}

// Resolves once the bot is polling.
function start(options = {}) {
  return new Promise((resolve) => bot.start({ ...options, onStart: resolve }));
}

afterEach(async () => {
  if (bot?.isRunning()) await bot.stop();
  await server?.stop();
});
```

### Delete a spam link and ban

```js
test("deletes a link and bans whoever posted it", async () => {
  await setup();
  bot.on("message:entities:url", async (ctx) => {
    await ctx.deleteMessage();
    await ctx.banChatMember(ctx.from.id);
  });
  await start();

  const ann = await server.createUser({ first_name: "Ann" });
  await server.join(GROUP, ann);
  const spam = await server.post(GROUP, ann, "cheap followers at example.com");

  await server.waitFor({ kind: "message", chatId: GROUP, messageId: spam, deleted: true });
  await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "kicked" });
});
```

### Approve a join request after a button press

The bot asks each requester to press a button in a private chat, then approves them.

```js
test("approves a join request once the button is pressed", async () => {
  await setup();
  bot.on("chat_join_request", (ctx) =>
    ctx.api.sendMessage(ctx.from.id, "Press the button to join.", {
      reply_markup: new InlineKeyboard().text("I'm human", `approve:${ctx.chat.id}`),
    }),
  );
  bot.callbackQuery(/^approve:(-\d+)$/, async (ctx) => {
    await ctx.api.approveChatJoinRequest(Number(ctx.match[1]), ctx.from.id);
    await ctx.answerCallbackQuery("Welcome!");
  });
  await start();

  const link = await bot.api.createChatInviteLink(GROUP, { creates_join_request: true });
  const bob = await server.createUser({ first_name: "Bob" });
  await server.joinByLink(link.invite_link, bob);

  // The bot's private message to Bob, found by its button.
  const { message } = await server.waitFor({
    kind: "message",
    chatId: bob,
    buttonData: `approve:${GROUP}`,
  });
  const answer = await server.pressDirectButton(bob, message.message_id, `approve:${GROUP}`);
  expect(answer.text).toBe("Welcome!");
  await server.waitFor({ kind: "joinRequest", chatId: GROUP, userId: bob, state: "approved" });
});
```

### Check that a mute ends

The bot mutes newcomers for an hour. A manual clock lets the test skip the hour.

```js
test("a newcomer's mute ends after an hour", async () => {
  await setup({ clock: { now: Date.now() } });
  bot.on("message:new_chat_members", async (ctx) => {
    for (const member of ctx.message.new_chat_members) {
      await ctx.restrictChatMember(
        member.id,
        { can_send_messages: false },
        { until_date: ctx.message.date + 60 * 60 }, // the message date follows the server clock
      );
    }
  });
  await start();

  const ann = await server.createUser({ first_name: "Ann" });
  await server.join(GROUP, ann);
  await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "restricted" });

  await server.advanceTime(2 * 60 * 60 * 1000); // two hours later
  await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "member" });
});
```

### Prove a bot did not receive something

`getBotUpdates` lists every update the server sent a bot. Here the bot asks only for
`my_chat_member` updates, so the group's messages never reach it.

```js
test("a bot that asks only for my_chat_member gets no messages", async () => {
  await setup();
  await start({ allowed_updates: ["my_chat_member"] });
  // allowed_updates applies from the bot's first getUpdates, so wait for that call.
  await server.waitFor({ kind: "call", botId: BOT_ID, method: "getUpdates" });

  const ann = await server.createUser({ first_name: "Ann" });
  await server.join(GROUP, ann);
  await server.post(GROUP, ann, "hello");
  await server.setBotMembership(GROUP, BOT_ID, { status: "member" }); // demoted

  const { updates } = await server.getBotUpdates(BOT_ID, { chatId: GROUP });
  expect(updates.map((update) => update.type)).toEqual(["my_chat_member"]);
});
```

### Report a scenario to the viewer

A test can tell the server where a scenario starts and how it ends. The viewer and recordings then
show it among the chats, and a failure points at the messages involved.

```js
// Reports a scenario's start and result. A failure names the messages it stored.
async function reported(scenarioId, body) {
  const run = { runId: "local", scenarioId };
  await server.startScenario({ ...run, chats: [GROUP] });
  const mark = await server.getMessageLog(GROUP);
  try {
    await body();
  } catch (error) {
    const log = await server.getMessageLog(GROUP, { since: mark.cursor, includeDeleted: true });
    const evidence = log.messages.map((entry) => ({ kind: "message", seq: entry.seq }));
    const failure = { message: error.message.slice(0, 200), evidence };
    await server.finishScenario({ ...run, result: "failed", failure });
    throw error;
  }
  await server.finishScenario({ ...run, result: "passed" });
}

test("says hello, reported to the viewer", async () => {
  await setup({ recordDir: "test-results/recordings" });
  bot.on("message:text", (ctx) => ctx.reply("Hi!"));
  await start();

  await server.startRecording("says-hello");
  await reported("says hello", async () => {
    const ann = await server.createUser({ first_name: "Ann" });
    await server.join(GROUP, ann);
    await server.post(GROUP, ann, "hello");
    await server.waitFor({ kind: "message", chatId: GROUP, botId: BOT_ID, text: "Hi!" });
  });
  const { files } = await server.stopRecording("says-hello");
  console.log(files.html); // open it in a browser: the scenario's cards sit among the messages

  const { scenarios } = await server.getScenarios({ runId: "local" });
  expect(scenarios.map((each) => each.result)).toEqual(["passed"]);
});
```

---

## Guide

### Write a test

A test starts a server, points the bot at it, plays the users, waits for the outcome and stops
both. This one uses [Vitest](https://vitest.dev) and a grammY bot that greets new members; any test
runner works the same way.

```js
// greeting.test.js
import { Bot } from "grammy";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startTestServer } from "telegram-bot-test-server";

const TOKEN = "123456:TEST";
const BOT_ID = 123456; // the number before the colon in the token
const GROUP = -1001000000001;
let server;
let bot;

beforeEach(async () => {
  server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
  });
  bot = new Bot(TOKEN, { client: { apiRoot: server.origin } });
  bot.on("message:new_chat_members", (ctx) =>
    ctx.reply(`Welcome, ${ctx.message.new_chat_members[0].first_name}!`),
  );
  // Resolve once the bot is polling, so afterEach never stops it mid-start.
  await new Promise((resolve) => bot.start({ onStart: resolve }));
});

afterEach(async () => {
  await bot.stop();
  await server.stop();
});

test("greets a new member", async () => {
  const ann = await server.createUser({ first_name: "Ann" });
  await server.join(GROUP, ann);

  const greeting = await server.waitFor({
    kind: "message",
    chatId: GROUP,
    botId: BOT_ID,
    text: "Welcome, Ann!",
  });
  expect(greeting.message.from.username).toBe("example_bot");
});
```

What each part does:

- `startTestServer` listens on `127.0.0.1` at a free port and returns the server; `server.origin`
  is its base URL. `chats` creates supergroups in which the bot is an administrator. Pick any ids;
  a supergroup's id starts with `-100`. `ownerId` is the chat creator's user id.
- The bot's user id is the number before the colon in its token. Waits, failure rules and call
  receipts name a bot by it (`botId`).
- `createUser` returns a new user's id; `join` makes them a member.
- `waitFor` resolves as soon as the condition holds and fails after a second by default, so a test
  never sleeps. [Check what the bot did](#check-what-the-bot-did) also shows how to check that the
  bot did nothing.
- A fresh server per test keeps tests apart. To share one, restore a [snapshot](#snapshots) between
  tests instead.

The rest of this guide shows parts of tests like this one, with `server`, `bot`, `BOT_ID` and
`GROUP` from it.

### Make users act

Test actions play people on Telegram. Each one resolves once the update it causes has been handed to
the bot: its first webhook attempt has finished (with any call the webhook answered with), it waits
behind an update the webhook refused, or it is queued for `getUpdates`.

A webhook gets a minute to answer, so one that never answers holds the action for a minute.

What the bot does in response happens after that, so wait for the outcome rather than checking it
immediately. An action fails where Telegram would refuse the person: `post` fails if the user is not
allowed to post, for example.

```js
const ann = await server.createUser({ first_name: "Ann", username: "ann" });
await server.join(GROUP, ann);
const hello = await server.post(GROUP, ann, "Hello!");
await server.post(GROUP, ann, { text: "Is anyone here?", replyTo: hello });
await server.sendDirectMessage(ann, "/start"); // a private message to the bot
const photo = Buffer.from("...image bytes..."); // e.g. await readFile("receipt.jpg")
await server.sendDirectMessage(ann, { photo, caption: "my receipt" });
await server.leave(GROUP, ann);
```

Members vote in polls. The bot that sent the poll gets a `poll` update with the new counts, and a
`poll_answer` saying who chose what unless the poll is anonymous; other bots get neither, as on
Telegram:

```js
// Your bot sent a poll with sendPoll; pollMessageId is its message_id.
await server.vote(GROUP, pollMessageId, ann, [0]); // Ann picks the first option
await server.vote(GROUP, pollMessageId, ann, []); // and takes her vote back
```

A press on an inline button resolves with the bot's `answerCallbackQuery` answer:

```js
// Your bot answers /menu with a message that has an inline keyboard.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
await server.post(GROUP, ann, "/menu");
const { message } = await server.waitFor({
  kind: "message",
  chatId: GROUP,
  botId: BOT_ID,
  text: "Pick one",
});
const answer = await server.pressButton(GROUP, message.message_id, ann, "rules");
expect(answer).toMatchObject({ answered: true, text: "Thanks!" });
```

The last argument is the button's `callback_data`, not its label; the press fails at once if the
message has no button with that data. If the bot does not answer within 10 seconds, the press
resolves `{ answered: false }`. Vitest and Jest stop a test after 5 seconds by default, so give a
test that may see no answer a longer timeout. Or start the press without awaiting it, then wait for
the bot's `answerCallbackQuery` call with `waitFor`, which fails after a second.

A bot can get the same press twice: when its webhook does not confirm an update, Telegram sends the
same update again, with the same `update_id` and callback query id. `deliverTwice` does that, so a
test can check that the bot acts on the press once:

```js
// Your bot, on a webhook, counts a "vote" press once per callback query id.
await server.pressButton(GROUP, message.message_id, ann, "vote", {
  deliverTwice: true,
});
expect(votes.get(ann)).toBe(1); // your app's own state
```

The press resolves with the bot's answer once the webhook has answered both deliveries. It needs a
webhook: a polling bot gets an update again only by not confirming it, so the press is refused.

A user can also open a URL button, named by its text or by its index (row by row, from 0). A link
to the bot does what Telegram's app does with it: `https://t.me/<bot>?start=<parameter>` sends
`/start <parameter>` from the user in their private chat with the bot, and a `startgroup` or
`startchannel` link adds the bot to the chat `addToChatId` names. Any other URL changes nothing and
comes back, for the test to follow:

```js
// Your bot's welcome message has a button to https://t.me/example_bot?start=verify.
await server.openUrlButton(GROUP, message.message_id, ann, "I'm human");
// Your bot got "/start verify" from Ann, and answers her privately.
await server.waitFor({
  kind: "message",
  chatId: ann,
  botId: BOT_ID,
  contains: "verified",
});
```

The test can also call the Bot API as the bot, for example to make an invite link, and then have
a user open it:

```js
// Your bot approves join requests.
const link = await bot.api.createChatInviteLink(GROUP, {
  creates_join_request: true,
});
const bob = await server.createUser({ first_name: "Bob" });
await server.joinByLink(link.invite_link, bob); // { chat_id, status: "requested" }
await server.waitFor({
  kind: "joinRequest",
  chatId: GROUP,
  userId: bob,
  state: "approved",
});
```

Members also share contacts and locations, and post an earlier file again, which keeps its
`file_unique_id`. Their text can carry entities the test gives, such as a `text_link`, or a
`phone_number`, which Telegram's server marks and this server does not find:

```js
const bob = await server.createUser({ first_name: "Bob" });
await server.join(GROUP, bob);
await server.post(GROUP, bob, { contact: { phoneNumber: "+15550100", firstName: "Bob" } });
await server.post(GROUP, bob, { location: { latitude: 51.5, longitude: -0.12 } });
await server.post(GROUP, bob, {
  text: "Call +1 212 555 0123",
  entities: [{ type: "phone_number", offset: 5, length: 15 }],
});
const first = await server.post(GROUP, bob, { photo });
const [size] = (await server.getMessage(GROUP, first)).message.photo;
await server.post(GROUP, bob, { fileId: size.file_id }); // the same file_unique_id
```

People promote and demote members as in Telegram's apps: the owner, or an administrator with
`can_promote_members`, grants the rights they choose (`by` names who acts; the owner by default).
The chat's administrator bots get `chat_member`. An administrator with `is_anonymous` posts as the
group, and a member with Telegram Premium may post as a channel they created:

```js
await server.promoteMember(GROUP, bob, {
  rights: { is_anonymous: true, can_delete_messages: true },
});
await server.post(GROUP, bob, "Read the rules"); // sender_chat is the group
await server.demoteMember(GROUP, bob);

const cy = await server.createUser({ first_name: "Cy", is_premium: true });
await server.join(GROUP, cy);
const news = await server.createChat({ type: "channel", title: "News", ownerId: cy });
await server.post(GROUP, cy, { text: "Follow us", sendAs: news }); // sender_chat is News
```

Such a post's `from` is `@GroupAnonymousBot` or `@Channel_Bot`, as the Bot API writes it. Waits,
failure rules and the [message log](#message-log-and-delivered-updates) still name the person who
posted it.

Reactions follow TDLib's rule: an anonymous administrator reacts as the group, and only the owner
may. So `react` refuses any other anonymous administrator, and a group whose owner stays anonymous
(`createChat({ ownerAnonymous: true })`) sends `message_reaction` with `actor_chat`, not `user`:

```js
const olga = await server.createUser({ first_name: "Olga" });
const club = await server.createChat({ ownerId: olga, ownerAnonymous: true });
const notice = await server.post(club, olga, "Meeting at six"); // sender_chat is the group
await server.react(club, notice, olga, "👍"); // message_reaction has actor_chat
```

No source shows how Telegram shows the service messages of an anonymous owner or administrator,
so their pins, title and photo changes, topics, and adding or removing members fail in a test.
So in a group whose owner is anonymous, `setBotMembership` needs `by`, an administrator who is not
anonymous: `setBotMembership(club, botId, { by: ada })`.

A bot bans a channel that members post as with `banChatSenderChat`. Until `unbanChatSenderChat`, the
channel's owner posts on behalf of none of their channels there.

People delete messages too. A member deletes their own message, and an administrator with
`can_delete_messages` (in a basic group, any administrator) anyone's. In their private chat with a
bot, a user deletes any message, for both sides. Bots get no update for a deletion, as on Telegram;
the message log and the viewer name who deleted it:

```js
const typo = await server.post(GROUP, ann, "helo");
await server.deleteMessage(GROUP, typo, ann); // { message_id, deleted: true }
```

In a business chat, `deleteBusinessMessage` deletes a message for both sides, and the connected bot
gets `deleted_business_messages`.

Users can also post photos, media, albums and forwards (of a user, a channel or a supergroup),
edit their messages, react, pin, press buttons in private chats and on ephemeral messages, change
their profile, and rename the chat or change its photo. [Test actions][ref-actions] lists them
all.

### Check what the bot did

`waitFor` waits for an outcome. It checks the condition when it is called and again whenever the
server's state changes; it never polls. It resolves with a copy of what matched:

```js
// Your bot deletes links and bans whoever posted them, as in the quick start.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
const spam = await server.post(GROUP, ann, "cheap followers at example.com");

// A message, by its id or by its author and exact text.
await server.waitFor({ kind: "message", chatId: GROUP, messageId: spam, deleted: true });
// A member's status in the chat.
await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "kicked" });
// A Bot API call the bot made. Receipts keep parameters as text.
const ban = await server.waitFor({
  kind: "call",
  botId: BOT_ID,
  method: "banChatMember",
  outcome: "succeeded",
});
expect(ban.params.user_id).toBe(String(ann));
```

A message can also be found by part of its text or caption, by a pattern, or by one of its inline
buttons, with or without its author:

```js
// Your bot answers /menu with "Pick a topic" and a "Rules" button (callback_data "rules").
await server.post(GROUP, ann, "/menu");
await server.waitFor({ kind: "message", chatId: GROUP, contains: "Pick" });
await server.waitFor({ kind: "message", chatId: GROUP, matches: /pick a topic/i });
await server.waitFor({
  kind: "message",
  chatId: GROUP,
  buttonText: "Rules",
  buttonData: "rules",
});
```

These find the oldest message that matches every field given, ephemeral messages included. To
skip messages from earlier in the test, add `since`, a cursor from the
[message log](#message-log-and-delivered-updates).

A wait fails after 1000 ms by default; `{ timeoutMs }` sets 1 to 30000 ms of wall time. Its error
names the exact expectation, what was observed (or up to eight matching requests) and the work still
outstanding, in at most 8000 characters with credentials redacted.

The outstanding work counts what is in progress: `controls` (test actions), `http` (open HTTP
requests to the server), `owners` (owner client calls), `deliveries` (webhook attempts queued or
running), `polls` (open long polls), `delayedOrNetworkRequests` (webhook connections and response
delays) and `waits` (waits, this one included). A polling bot always has a long poll open, so `http:
1` and `polls: 1` are normal.

[Wait conditions][ref-waits] lists every condition.

Once the outcome is there, read the state directly:

```js
const messages = await server.getMessages(GROUP); // newest first, deleted ones left out
const { deleted } = await server.getMessage(GROUP, spam);
const member = await server.getMember(GROUP, ann); // as getChatMember returns it
const { calls } = await server.getCalls(); // every Bot API call, in order
```

Messages are kept the way Telegram returns them: `parse_mode` formatting becomes plain `text` plus
`entities`, and text is trimmed, so wait for the plain text the user would see. `getMessages` and
`getDirectMessages` include service messages, such as `new_chat_members` for each join and
`pinned_message` for each pin.

`getCalls()` keeps requests as they came, fixture secrets included, so do not dump it
indiscriminately. It returns copies, and so do `getMessage`, `getMessages`, `getEphemeralMessage`
and `getDirectMessages`: changing what they return changes nothing on the server.

To show that the bot did **not** act, without sleeping, give it something it does act on
afterwards, in the same chat, and wait for that:

```js
// Your bot deletes links, as in the quick start.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
const hello = await server.post(GROUP, ann, "Hello, no links here");
// A later message the bot acts on marks the point where it has handled the first.
const marker = await server.post(GROUP, ann, "see example.com");
await server.waitFor({ kind: "message", chatId: GROUP, messageId: marker, deleted: true });
expect((await server.getMessage(GROUP, hello)).deleted).toBe(false);
```

One chat's messages reach the bot in order, so this holds for a bot that handles them one at a
time: grammY's `bot.start()`, or any webhook that answers after its handler has run, as grammY's
and Telegraf's do. Telegraf's polling handles each batch of updates at once, so there the marker
is not enough. A webhook bot can instead `await server.drainDeliveries()`, which returns once the
webhook has answered every update sent so far.

Or wait until there is nothing left to do: every update confirmed by the bots, no Bot API call,
webhook attempt or test action in progress, and no call for `ms` milliseconds of wall time:

```js
const hello = await server.post(GROUP, ann, "Hello, no links here");
await server.waitFor({ kind: "quiet", ms: 200 }, { timeoutMs: 2000 });
expect((await server.getMessage(GROUP, hello)).deleted).toBe(false);
```

grammY's `bot.start()` and Telegraf's polling confirm an update with their next `getUpdates`, after
handling it, and their webhooks answer after their handlers, so the wait holds while such a bot
works on an update.

The server sees only what reaches it: work a bot does after it confirmed an update, such as a job
started in the background, looks quiet once `ms` has passed without a call.

`botIds` limits the wait to some bots; leave out a bot that is not running, since it never confirms
its updates. A deleted bot is not counted.

### Message log and delivered updates

Every message the server stores, in any chat, gets the next number of one server-wide sequence,
its `seq`; so do events, edits and deletions. `getMessageLog` reads a chat's messages after a mark
on that sequence, deleted ones too when asked, so "everything since my mark" stays exact when the
bot deletes messages:

```js
// Your bot deletes links, as in the quick start.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
const mark = await server.getMessageLog(GROUP); // mark.cursor: the latest seq
await server.post(GROUP, ann, "hello");
const spam = await server.post(GROUP, ann, "cheap followers at example.com");
await server.waitFor({ kind: "message", chatId: GROUP, messageId: spam, deleted: true });

const { messages } = await server.getMessageLog(GROUP, {
  since: mark.cursor,
  includeDeleted: true,
});
console.log(messages.map((entry) => [entry.message.text, entry.deleted_by?.bot_id ?? null]));
// [["hello", null], ["cheap followers at example.com", 123456]]
```

- It returns `{ chat_id, epoch, cursor, messages }`, oldest first. Pass `cursor` as the next
  `since` to read on from there.
- Each entry has the stored `message` (with the first bot's file ids, and in a basic group the
  chat's own message id, with each bot's in `bot_message_ids`), its `seq`, `at` (server
  time), `author` (the user id of who posted it, also when the message names only a chat: a
  channel post, or a post on behalf of a chat), `request_id` (the Bot API call that stored it, or
  `null` for a test action), `after_request` (how many Bot API requests had arrived when it was
  stored; the viewer places calls by it), `ephemeral`, and `deleted` with `deleted_by`:
  `{ seq, bot_id, user_id, method, request_id, at }` of the deletion, or `null`. A bot's deletion
  has its `bot_id` and `method`; a person's has their `user_id`, and `bot_id` and `method` are
  `null`. `edited_by` has the same fields for the latest edit, or is `null`. A poll that has votes
  has `votes` by user id.
- A message stored before the mark but edited after it is listed too, its `edited_by.seq` after
  the mark. Without `includeDeleted`, only messages not deleted are listed. With it, a message
  stored before the mark but deleted after it is listed too.
- A user id instead of a chat id reads the user's private chat with a bot, and each entry has the
  chat's `bot_id`. `botId` names the bot, a deleted bot's too; it is needed when the user has
  private chats with more than one bot, as their message ids overlap.
- After a `restore`, the sequence goes back with the state. Pass the mark's `epoch` and a read
  from an older epoch fails instead of mixing the two.

`getBotUpdates` lists the updates the server sent a bot, as the bot got them, so a test can prove
what a bot did **not** receive. The [recipe](#prove-a-bot-did-not-receive-something) shows it.

- As on Telegram, `allowed_updates` applies from the `getUpdates` call that carries it, and
  updates made before that call still arrive. grammY's `onStart` runs before its first
  `getUpdates`, so wait for that call, as above, before users act. A long poll's `offset` and
  `allowed_updates` apply as soon as it arrives, so a plain call wait is enough.
- Each test action resolves once the updates it causes are handed to the bots, so a read right
  after it already lists them.
- `type` (one type or a list), `chatId` and `since` (an `update_id`) narrow the list.
- Each entry has `update_id`, `type`, `chat_id` (`null` for updates about no chat, such as `poll`),
  `at`, `state`, `received` and `update`, the exact JSON the bot was sent. `state` is `pending`
  until the bot confirms the update, then `delivered`, or `dropped` when it expired or was
  discarded, such as by `drop_pending_updates`. `received` says whether `getUpdates` returned it
  or a webhook was sent it.

`waitFor({ kind: "update", botId, type, chatId, afterUpdateId, state })` waits for such an update,
for example `state: "delivered"` once the bot has confirmed it.

### Webhooks and polling

A bot that polls needs nothing more: its `getUpdates` calls get the updates waiting for it. A bot
that uses a webhook calls `setWebhook` with its URL, as it would on Telegram, and the server then
posts each update there. Like a Bot API server run with `--local`, this one takes `http` URLs, any
port and local addresses.

```js
import http from "node:http";
import { Bot, webhookCallback } from "grammy";
import { startTestServer } from "telegram-bot-test-server";

const BOT_ID = 123456;
const GROUP = -1001000000001;
const server = await startTestServer({
  botToken: "123456:TEST",
  chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
});
const bot = new Bot("123456:TEST", { client: { apiRoot: server.origin } });
bot.on("message:text", (ctx) => ctx.reply(`You said: ${ctx.message.text}`));

// The bot's webhook, on a free local port.
const receiver = http.createServer(webhookCallback(bot, "http"));
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
await bot.api.setWebhook(`http://127.0.0.1:${receiver.address().port}/`);

const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
await server.post(GROUP, ann, "hello");
await server.waitFor({
  kind: "message",
  chatId: GROUP,
  botId: BOT_ID,
  text: "You said: hello",
});

await server.stop();
receiver.close();
```

Updates reach the bot as Telegram sends them:

- Each bot has its own update queue. An update stays pending until the bot confirms it, with a
  `getUpdates` offset or by answering its webhook with a 2XX status. It expires a day after it
  happened, and a button press after 150 seconds.
- A webhook that does not answer 2XX within a minute gets the update again: at once, then after 2,
  4, 8 ... seconds up to a random 60 to 120, or after its `Retry-After`. `getWebhookInfo` reports
  the pending count and the last error. Make your webhook answer even when a handler throws.
- Updates wait in queues keyed as Telegram keys them: messages by chat; `chat_member` updates,
  join requests and button presses by user; `my_chat_member` updates and reactions by chat, apart
  from the messages. A queue's updates reach a webhook one at a time, in order; different queues go
  out at once, up to `max_connections` (default 40). So a join's `chat_member` update can arrive
  while the chat's messages are still on their way. `getUpdates` returns all of them in order.
- A webhook may answer an update with a Bot API call, as Telegraf does by default; the call runs.
- Without `allowed_updates`, a bot gets every update but `chat_member`, `message_reaction` and
  `message_reaction_count`. `chat_member` and `message_reaction` reach only administrator bots,
  and `chat_join_request` only bots with `can_invite_users`.
- `getUpdates` fails with 409 while a webhook is set, and a new long poll ends the one before it
  with 409, so run one poller per bot.

The full rules, with Telegram's error texts, are under [Update delivery][behavior-delivery].

Three server methods help with webhooks. `drainDeliveries({ botId?, timeoutMs? })` waits until the
server's queued and in-flight webhook attempts have settled, retries still due and calls a webhook
answered with included. It does not empty `getUpdates` queues, check that the webhook answered 2XX,
or wait for what the bot does after answering.

`getDeliveries()` lists each attempt with its update and bot id, attempt number (each retry is one),
`epoch` (the number of restores before it), when it was queued, started and completed, its status
and outcome. Sent updates and this list are kept until a restore.

`redeliverUpdate(updateId, { botId })` has Telegram deliver an update again, byte for byte, callback
queries included, as it does when a webhook does not confirm one. Each bot numbers its own updates,
and bots added in the same second start at the same number, so with more than one bot always pass
`botId`. It sends the saved update, so do not restore an earlier snapshot between the steps of a
replay.

### More than one bot

The bot named by `botToken` is the first bot. `addBot` adds another, with its own webhook or update
queue; it is in no chat until added:

```js
const second = await server.addBot({ token: "654321:SECOND", username: "second_bot" });
await server.setBotMembership(GROUP, second.id, {
  status: "administrator",
  rights: { can_restrict_members: false },
});
const secondBot = new Bot("654321:SECOND", { client: { apiRoot: server.origin } });
```

`setBotMembership` adds, promotes, demotes or removes a bot as the chat's owner would. Without
`status` the bot becomes an administrator; `rights` grants or withholds rights, such as
`{ can_post_messages: false }`. The bot gets `my_chat_member`, the chat's administrator bots
`chat_member`, and a group a service message when the bot joins or leaves.

`deleteBot(second.id)` deletes a bot that `addBot` added. It leaves every chat it is in, as when a
bot leaves: its status there becomes `left`, the chat's administrator bots get `chat_member`, and a
group gets a `left_chat_member` service message, which `getMessageLog` and `getBotUpdates` list.

Its token then gets 401 `Unauthorized`. A waiting `getUpdates` answers at once with what is pending,
and the next call gets the 401, so a polling library stops with an error (grammY's `bot.start()`
rejects): have the app catch it. The first bot can't be deleted.

Each bot has its own membership and rights in each chat, its own `update_id` sequence, its own
`file_id`s, and hears only the button presses on keyboards it put on messages. `getMember` answers
as `getChatMember` would to the first bot, and the control API shows messages with the first bot's
file_ids. Name a bot with `botId` in waits, failure rules and `connectBusiness`. More under
[More than one bot][behavior-bots].

Each bot has its own private chat with a user, as on Telegram, and all of a bot's private chats
share one message id sequence with its view of basic groups. A bot reaches only its own: it can
message a user who wrote to it, or a join requester for five minutes, and gets 403 otherwise. Other
calls, `getChat` and `sendChatAction` among them, find the chat of any user the bot knows, empty if
they never wrote, and get 400 `chat not found` for anyone else. The private-chat actions take
`{ botId }` (`bot_id` over HTTP), and the first bot is the default:

```js
await server.sendDirectMessage(ann, "/start", { botId: second.id });
const replies = await server.getDirectMessages(ann, { botId: second.id });
await server.waitFor({ kind: "message", chatId: ann, botId: second.id, text: "Welcome!" });
```

A `start` link to any bot opens that bot's chat. In a message wait on a private chat, `botId` names
the bot's chat, and the author when `userId` does not.

A bot runs in privacy mode with the `privacyMode` option (the first bot) or `addBot({ privacyMode:
true })`. Off by default.

In a group where such a bot is not an administrator, it gets only what the
[Bot API docs][privacy-docs] list: service messages, commands meant for it (`/help@your_bot`),
general commands (`/help`) when it was the last bot to send a message to the group, and replies to
messages meant for it. A message reaches only one such bot: a reply before an explicit command, and
that before a general one. It gets the edits of only the messages it received. `getMe` says
`can_read_all_group_messages: false`. More under [Privacy mode][behavior-privacy].

### Channels, basic groups and forums

`chats` creates supergroups. `createChat` makes a supergroup, a forum (`isForum`), a basic group
(`type: "group"`) or a channel (`type: "channel"`) during a test, with no bot in it, and returns its
id. Add a bot with `setBotMembership`, or with `addBotViaLink` as a person who opens the bot's
`startgroup` or `startchannel` link.

```js
const OWNER = 5000000001;
const channel = await server.createChat({
  type: "channel",
  title: "News",
  ownerId: OWNER,
});
await server.setBotMembership(channel, BOT_ID, {
  rights: { can_post_messages: true },
});
await server.post(channel, OWNER, "First post"); // bots get it as channel_post

const forum = await server.createChat({ title: "Help", ownerId: OWNER, isForum: true });
const topic = await server.createTopic(forum, "Questions");
await server.post(forum, OWNER, { text: "How do I start?", threadId: topic });
```

- **Channels.** Every message in a channel comes from the channel (`sender_chat`, no `from`), and
  bots get it as `channel_post`, its edits as `edited_channel_post`. Only the creator and
  administrators with `can_post_messages` post; `post()` refuses anyone else with
  `CHAT_WRITE_FORBIDDEN`. Details under [Channels][behavior-channels].
- **Basic groups** have a negative id without the `-100` prefix. `migrateToSupergroup(chatId)`
  upgrades one as its creator or an administrator would and returns the new supergroup's id; later
  calls to the old id fail as Telegram's do ([Basic groups and the upgrade][behavior-upgrade]).
  As on Telegram, each bot numbers a basic group's messages from its own sequence, the one its
  private chats use, so two bots know one message by different ids, and neither by the id test
  actions use. Test actions, waits, failure rules, the message log and the viewer name a basic
  group's message by the chat's own count, the id `post` returns. `getMessage` and the message log
  give the id each bot knows it by, in `bot_message_ids`:

  ```js
  const basic = await server.createChat({ type: "group", ownerId: OWNER });
  await server.setBotMembership(basic, BOT_ID);
  const hello = await server.post(basic, OWNER, "hello");
  const { bot_message_ids } = await server.getMessage(basic, hello);
  // The id the bot got in its update, and names in its own calls.
  const botsId = bot_message_ids[BOT_ID];
  ```
- **Forums.** `createTopic` and `renameTopic` create and rename topics with Telegram's service
  message, and `post` takes a `threadId`. A send to a thread that is not a topic fails with
  `message thread not found`. Bots close, reopen, rename and delete topics, and close, reopen,
  hide, unhide and rename the General topic, with Telegram's rights, errors and service messages.
  A call without the right on a topic the bot never sent to gets 404, as no source gives
  Telegram's answer.
  A closed topic refuses messages, with `TOPIC_CLOSED`, from everyone but administrators with
  `can_manage_topics` and the topic's creator. Details under [Forum topics][behavior-topics].

### Failures, flood control and time

#### Injected failures

`failNext(rule)` makes the next matching Bot API calls fail, so a test can check how the bot copes:

```js
// The bot's next deleteMessage in the group fails as Telegram would refuse it.
await server.failNext({
  method: "deleteMessage",
  chatId: GROUP,
  errorCode: 400,
  description: "Bad Request: message can't be deleted",
});
// Its next sendMessage gets a 429 with retry_after 3, and the Retry-After header.
await server.failNext({ method: "sendMessage", errorCode: 429, retryAfter: 3 });
```

A rule counts only calls with its `method` and, where given, its `chatId`, `botId`, `userId` and
`messageId`; other calls do not use it up. `userId` is the user the call is about: its `user_id`, an
ephemeral message's receiver, or the author of the message `deleteMessage` deletes.

`messageId` also matches one id in a `deleteMessages` list; in a basic group it is the chat's own
id, whatever id the bot gave. `attempt: 2` starts at the second matching call after the rule is
added, and `times` (default 1) is how many matching calls in a row it applies to.

- With `errorCode`, the call fails before it runs. Without `description`, the error reads as
  Telegram's does for its code (`Bad Request`, `Forbidden`, `Conflict`, ...). A 429 needs
  `retryAfter`, a whole number of seconds, and `failNext` rejects a 429 rule without it. The call
  then reads `Too Many Requests: retry after N` and carries the `Retry-After` header, as on
  Telegram.
- With `dropAfterApply`, the call takes effect once, then the connection closes without an answer.
- `delayMs` (at most 30 seconds) delays the answer; on its own, the call runs normally. Delays end
  when the server stops.

`clearFailures()` drops the rules not used up.

#### Flood control

Off by default. With `floodControl: true`, the server limits a bot's sends the way Telegram does
once the bot goes over the limits Telegram publishes in its
[Bots FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this):

- one message a second in a chat. Telegram says it may allow short bursts above this; here an album
  is such a burst, sent once the chat's last message is a second old;
- 20 messages a minute in a group or supergroup;
- 30 messages a second from one bot across all its chats (paid broadcasts are not modeled).

These numbers are Telegram's published guidance, not its internal algorithm, which Telegram does
not publish. A bot that stays within them here can still be limited differently on Telegram.

Each bot has its own limits. A call that sends messages counts them after its parameters are
checked: `sendMessage`, the other `send…` methods, `forwardMessage` and `copyMessage` count one
message, and `sendMediaGroup` counts every message of the album. Edits, deletions,
`sendChatAction` and business messages (`business_connection_id`) are not counted.

A send over a limit has to wait. As Telegram's Bot API server does, this server holds a send that
has to wait 8 seconds or less, then sends it and answers 200: the bot sees only the delay. If the
send then has to wait again, the waits add up. A send whose waits would come to more than 8 seconds
stores nothing, does not count, and gets HTTP 429, a `Retry-After` header and

```json
{
  "ok": false,
  "error_code": 429,
  "description": "Too Many Requests: retry after 40",
  "parameters": { "retry_after": 40 }
}
```

`retry_after` is the seconds of its last wait, rounded up to whole seconds as Telegram gives them.
The limits run on the server clock, so on a manual clock a held send is answered only once a test
moves the clock past its wait with `advanceTime`. On a running clock it is also answered when real
time gets there. While a send is held, `snapshot()` and `restore()` refuse, as for a response delay;
a snapshot keeps and restores the recent sends.

`floodControl` also applies a limit of the Bot API server itself: a `setWebhook` with a URL less
than a second after the previous one gets 429 `Too Many Requests: retry after 1` before anything
else is checked, even when the earlier call was refused. `deleteWebhook` and `setWebhook` with an
empty URL are not limited.

#### Time

By default the server runs on real time. With `clock: { now: milliseconds }` it keeps a manual
clock that only `advanceTime(ms)` moves; `getClock()` returns `{ mode, now, scheduled }`. Start it
at `Date.now()` when your bot computes dates, such as an `until_date`, from its own clock:

```js
// With clock: { now: Date.now() } in the options.
// Your bot mutes newcomers for an hour.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "restricted" });
await server.advanceTime(2 * 60 * 60 * 1000); // two hours later
await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "member" });
```

A bot that lifts a mute itself calls `restrictChatMember` with every permission `true`, as the Bot
API docs say; the member is then a `member` again.

A manual clock stands still between advances. Messages posted a minute apart in real time get the
same date, and anything that counts by dates, such as a rate window, sees no time pass.

A running clock keeps moving instead. With `clock: { offset: milliseconds }`, the server's time is
real time plus the offset; `{ offset: 0 }` starts on real time. `advanceTime(ms)` adds `ms` to the
offset, so time jumps forward, and it keeps moving between jumps. `getClock()` then returns `{ mode:
"running", now, offset, scheduled }`:

```js
// With clock: { offset: 0 } in the options.
await server.post(GROUP, ann, "first"); // dated now
await server.advanceTime(24 * 60 * 60 * 1000);
await server.post(GROUP, ann, "second"); // dated a day later, and the clock keeps moving
```

Advances run one at a time, and each runs what has come due, in deadline order: restriction and ban
expiry, response delays (`delayMs`, and owner call delays), sends held by flood control, webhook
retries and delayed `getUpdates` conflicts. On a running clock, these also come due as real time
passes. Message, login and business dates, the five minutes a bot may message a join requester, and
flood control follow this clock too.

A restore sets a manual clock back to the snapshot's time, and a running clock's offset back to the
snapshot's offset. Real time is never rewound, so after a restore a running clock is later than the
snapshot by the real time that passed.

The global `Date`, timers and your app's jobs are untouched. Webhook connections and their
one-minute timeout, long polling and `waitFor` deadlines use wall time, so an advance does not wait
for deliveries or for your bot to act. To have your app follow this clock, see
[Testing time-based app logic](#testing-time-based-app-logic).

### Testing time-based app logic

`advanceTime` moves only the server's clock. Your app still reads its own `Date.now()`, so a
nightly job, a "three strikes in 30 days" rule or a mute the app lifts itself cannot be tested by
moving time, unless the app reads the server's clock in tests. The package ships a helper for
that, `fakeClockNow()`: the server's time when the `TELEGRAM_FAKE_CLOCK_URL` environment variable
names a server, and `Date.now()` otherwise. The app calls it wherever it read `Date.now()`.

This bot reminds the chat an hour after `/remind`, and the test moves time instead of waiting:

```js
import http from "node:http";
import { Bot } from "grammy";
import { startTestServer } from "telegram-bot-test-server";
import {
  fakeClockHandler,
  fakeClockNow,
  refreshFakeClock,
} from "telegram-bot-test-server/clock";

const BOT_ID = 123456;
const GROUP = -1001000000001;
const HOUR = 60 * 60 * 1000;

// The app takes the server's clock pushes here.
const receiver = http.createServer(fakeClockHandler);
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const server = await startTestServer({
  botToken: "123456:TEST",
  chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
  clock: { now: Date.now() },
  clockWebhook: `http://127.0.0.1:${receiver.address().port}/`,
});
process.env.TELEGRAM_FAKE_CLOCK_URL = server.origin;
await refreshFakeClock(); // once, before the app reads the clock

// The app: it reads fakeClockNow() where it read Date.now().
const bot = new Bot("123456:TEST", { client: { apiRoot: server.origin } });
const reminders = [];
bot.command("remind", async (ctx) => {
  reminders.push({ chatId: ctx.chat.id, at: fakeClockNow() + HOUR });
  await ctx.reply("I will remind you in an hour.");
});
// Its scheduler looks for due reminders every second.
const scheduler = setInterval(async () => {
  const due = reminders.filter((reminder) => reminder.at <= fakeClockNow());
  for (const reminder of due) {
    reminders.splice(reminders.indexOf(reminder), 1);
    await bot.api.sendMessage(reminder.chatId, "Reminder!");
  }
}, 1000);
await new Promise((resolve) => bot.start({ onStart: resolve }));

// The test.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
await server.post(GROUP, ann, "/remind");
await server.waitFor({ kind: "message", chatId: GROUP, botId: BOT_ID, contains: "an hour" });
await server.advanceTime(HOUR); // resolves once the app has the new time
await server.waitFor(
  { kind: "message", chatId: GROUP, botId: BOT_ID, text: "Reminder!" },
  { timeoutMs: 2000 },
);

clearInterval(scheduler);
await bot.stop();
await server.stop();
receiver.close();
```

What the app has to do:

- **Read the clock with `fakeClockNow()`.** It is synchronous and reads a cached time, so a call is
  cheap. With `TELEGRAM_FAKE_CLOCK_URL` unset it returns `Date.now()`, so production code can call
  it too. The variable takes the server's origin or its `/_fake/clock` URL, and is read on every
  call.
- **Call `await refreshFakeClock()` once** at start, after setting the variable. It reads
  `GET /_fake/clock`, caches the time and returns it. Until the app has the time of the server the
  variable names, from a read or a push, `fakeClockNow()` throws, so a missed setup fails instead
  of mixing clocks. On a server running on real time, `fakeClockNow()` returns `Date.now()`.
- **A running clock keeps moving in the app too.** For it, the cache holds the server's offset, not
  a time, and `fakeClockNow()` returns `Date.now()` plus the offset. Its time moves on between
  reads, and only a jump or a restore needs a new read or push. This assumes the app and the
  server read the same system clock, as they do on one computer.
- **Keep the time current**, in one of two ways. With the `clockWebhook` option and a manual or
  running clock, the server posts `{ now, mode }` to that URL, and `offset` for a running clock,
  after each `advanceTime` and each `restore`. They resolve only once the post has finished, so the
  app has the new time when the test goes on. Mount `fakeClockHandler` there (a Node
  `(request, response)` handler that takes a POST on any path), or pass the parsed body to
  `receiveFakeClock(body)` if your framework has read it already. A push counts as the time of the
  server the variable names when the push arrives, so set the variable before the first
  `advanceTime`. Without the option, call `await refreshFakeClock()` before time-dependent work.
- **Expect timers to run on wall time.** Moving the clock fires none of them; a scheduler that
  checks `fakeClockNow()` as it runs, as above, sees the new time on its next check. Or have the
  test run the app's job after `advanceTime`.

An app in another process needs the route's address before the server starts, and the server's
origin after. So, in this order:

1. Start the app. It serves `fakeClockHandler` in its own HTTP server, on a free port, and tells
   the test the port, over IPC or on its output.
2. Start the server with `clockWebhook` set to that route.
3. Send the app `server.origin`. The app sets `process.env.TELEGRAM_FAKE_CLOCK_URL` to it, calls
   `await refreshFakeClock()`, then starts its bot with the origin as its Bot API root.

With a fixed port for the app's route, start the server first and spawn the app with
`TELEGRAM_FAKE_CLOCK_URL` in its environment.

An app in another language reads `GET <origin>/_fake/clock`, which answers `{ mode, now, scheduled
}`, and uses `now` while `mode` is `manual`. While `mode` is `running`, the answer also has
`offset`, and the app adds it to its own clock.

A push that fails, or takes over 2 seconds, goes to the `log` option as `clock webhook failed:
<reason>` and fails nothing. The bot's own webhook deliveries stay as Telegram sends them.

### Snapshots

A snapshot saves the server's state so a test can return to it, instead of starting a fresh server.
A snapshot needs an idle server, so this bot makes its calls without polling:

```js
import { Bot } from "grammy";
import { startTestServer } from "telegram-bot-test-server";

const GROUP = -1001000000001;
const server = await startTestServer({
  botToken: "123456:TEST",
  chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
});
const bot = new Bot("123456:TEST", { client: { apiRoot: server.origin } });

const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
const saved = await server.snapshot();

await bot.api.banChatMember(GROUP, ann);
await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "kicked" });

await server.restore(saved); // Ann is a member again
await server.waitFor({ kind: "member", chatId: GROUP, userId: ann, status: "member" });
await server.releaseSnapshot(saved);
await server.stop();
```

In a real test, trigger your app instead of calling the Bot API directly, and wait for the same
condition.

`snapshot()` returns an opaque handle that only this server accepts. `snapshot()` and
`restore(handle)` need the server to be idle: no Bot API, control or owner request in progress, no
long poll, no webhook attempt (an update waiting for a retry counts until it is delivered, dropped
or its webhook removed), no response delay, no send held by flood control and no clock advance.
Pending restriction and ban expiries and unused failure rules are fine.

Drain deliveries and finish requests before taking a snapshot; `restore` fails with outstanding work
rather than mix it with the restored state.

`restore` puts back users, bots, chats (groups, private and business chats, owner accounts), file
bytes, members, messages, invite links and join requests, id counters, call receipts, failure rules
and how far they have counted, sent updates with their bytes and queues, webhook and
`allowed_updates` settings, login codes and flood control's recent sends. Expiries are scheduled
again from the restored members.

A snapshot can be restored any number of times; `releaseSnapshot(handle)` frees it. A restore
cancels waits in progress and returns `{ restored: true, epoch }`, where `epoch` counts the restores
so far; it keeps later `request_id`s apart from earlier ones although ids and receipts go back. The
origin and the login signing key stay the same. Nothing outside the server is restored: your webhook
receiver, its sockets and timers, your database and your app's state.

Between independent scenarios, drop unused failure rules with `clearFailures()`, then restore a
snapshot or start a fresh server.

### Watch the chats in a browser

<img src="https://raw.githubusercontent.com/anatolyben/telegram-bot-test-server/v0.13.1/docs/images/viewer-as-member.png"
  alt="The book club group on a phone, seen as Carol: the bot's welcome with its Rules button, the
  messages and their reactions, and no deleted link" width="320">

The viewer draws the server's chats the way Telegram's apps draw them, live, as the test runs.
Above, a book club group on a phone, seen as its member Carol.

Turn it on with `ui: true`. The server then serves the viewer at `server.viewerUrl`:

```js
const server = await startTestServer({
  botToken: "123456:TEST",
  chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
  ui: true,
});
console.log(server.viewerUrl); // http://127.0.0.1:54321/_fake/ui
```

From the command line, `--ui` prints the address. The viewer answers only on this computer. It never
changes the server's state, and Bot API answers and updates stay the same.

To watch a test by eye, give the server a fixed `port` and open the address before the test runs.
Keep the server running until you have looked, for example with `await page.pause()` in a
Playwright test. To look at a fast test afterwards, [record it](#record-a-scenario).

It opens on **Activity**: every chat in one feed, in the order things happened. Messages are
bubbles, as in Telegram. Each Bot API call is a bubble from the bot, with the method, the outcome
and Telegram's error text. A change to a member is a centered line, such as "Ann joined". A deleted
message stays, grayed and marked with who deleted it.

The toolbar switches to the chat list, one chat, its members, or the chats as one member sees them.
Click a call to mark what it touched. The view lives in the URL, so a link opens the same view.
The [viewer reference][ref-viewer] lists everything it shows, its URL parameters, the data
attributes for Playwright and its routes.

### Watch several servers at once

<img src="https://raw.githubusercontent.com/anatolyben/telegram-bot-test-server/v0.15.1/docs/images/watch-five-servers.jpg"
  alt="Five servers on one page, side by side: a book club, a running club, a study group, a garden
  swap and a chess night, each with its own bot welcoming members and removing a spam link">

When several servers run at the same time, for example one per parallel test worker, watch them on
one page:

```sh
npx telegram-bot-test-server watch   # http://127.0.0.1:8090/
```

Every server started with `ui: true` on this computer appears as its own panel, side by side with
draggable dividers, and disappears when it stops. Give a server a `name` (`--name` on the command
line) to label its panel. `--port` changes the page's port, and `--exit-when-idle <seconds>` closes
it once no server has run for that long.

### Record a scenario

A recording keeps what happened in Telegram between two points of a test, as one HTML page that
opens offline, with no server running, and its JSON twin. A test report can link each scenario to
its page:

```js
const server = await startTestServer({
  botToken: "123456:TEST",
  chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
  recordDir: "test-results/recordings",
});

await server.startRecording("spam-is-removed", { chats: [GROUP] });
// The scenario: users act, the bot answers.
const { files } = await server.stopRecording("spam-is-removed");
console.log(files.html); // /…/test-results/recordings/spam-is-removed.html
```

Or one recording per test, named after it:

```js
// Declare these hooks after the ones that start and stop the server. Vitest runs afterEach
// hooks in reverse order, so each recording then stops before server.stop().
const nameOf = (task) =>
  task.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, 100);
beforeEach(async ({ task }) => {
  await server.startRecording(nameOf(task));
});
afterEach(async ({ task }) => {
  await server.stopRecording(nameOf(task));
});
```

- `startRecording(name, { chats })` starts one. The name is letters, digits, `.`, `_` and `-`,
  starting with a letter or digit; it also names the files. `chats` names chats as the viewer's
  `chat` parameter does: a group id, `<user id>:<bot id>`, a user id (their chat with the first
  bot) or `calls`. Without it, the recording holds every chat something happened in. A chat may be
  named before it exists; one that still does not exist at the stop is listed in `missing_chats`.
  Any number of recordings run at once, each under its own name.
- `stopRecording(name)` returns `{ name, html, json, files }`: `html` is the page as text and
  `json` its twin as an object; `files` comes only with `recordDir`. They hold every message and
  event stored after the start, deleted ones included, and every Bot API call received after it,
  with the members and each message's reactions as they are at the stop. Older messages that a
  recorded call names (a forward's in the chat it came from) or that a recorded message replies
  to are included too, marked "from before the recording".
- With the `recordDir` option, `stopRecording` also writes `<name>.html` and `<name>.json` there,
  making the directory if needed and replacing earlier files of that name, and returns their paths
  in `files` as `{ html, json }`. Only the option chooses the directory, never a request.
- The page is the viewer in a single file: the same panels, layouts, call filters, view as and
  highlights, and the same URL parameters (`spam-is-removed.html?chat=-1001000000001&layout=split`).
  Its scripts, styles, data and images are inside it, and its content security policy lets it load
  nothing else. It needs JavaScript. Recording works with the `ui` option on or off.
- The JSON twin has `format: "telegram-bot-test-server-recording"` and `format_version: 1`; the
  recording's `name`; in `chats_filter`, the chats asked for, as text (`null` for every chat); the
  marks in `window` (`start_seq` and `stop_seq` on the message log's cursor, `start_request` and
  `stop_request` on the count of Bot API requests, `started_at` and `stopped_at` in server time);
  the chat list in `state`; in `pages`, one page per chat, in the shape of the viewer's
  `/_fake/ui/api/chats/<chat>`, with all its items, members and calls (context items carry
  `before_window: true`); every image once, as a `data:` URI, in `files`; and in `scenarios`, every
  [scenario](#report-scenarios) with a start or finish in the window.
- Recordings are not part of snapshots. One that started before a `restore` cannot be stopped:
  `stopRecording` fails and drops it, since its marks belong to the state the restore replaced.
  When tests restore a snapshot, restore first, then start recording. `stop()` drops recordings
  still running.

### Report scenarios

A test runner can tell the server which scenario is running and how it ended, so the viewer and
recordings show each scenario's start, result, failure and labels among the chats. These are test
controls only: Telegram and the bots see nothing of them. The runner decides every status and
result; the server never infers one, and a scenario it was never told finished stays `running`.

The [recipe](#report-a-scenario-to-the-viewer) has a helper that reports each test this way. A
failed scenario names its evidence by message log seq, call `request_id` or event id:

```js
await server.startScenario({ runId: "nightly-42", scenarioId: "spam-is-removed", chats: [GROUP] });
const mark = await server.getMessageLog(GROUP);
// The scenario runs, and its wait for the bot fails.
const { messages } = await server.getMessageLog(GROUP, { since: mark.cursor });
await server.finishScenario({
  runId: "nightly-42",
  scenarioId: "spam-is-removed",
  result: "failed",
  failure: {
    message: "the bot kept the spam",
    evidence: [{ kind: "message", seq: messages[0].seq, labels: { role: "trigger" } }],
  },
});
await server.finishScenario({ runId: "nightly-42", scenarioId: "photos", result: "skipped" });
```

- `startScenario({ runId, scenarioId, title, labels, chats })` reports a start. `runId` and
  `scenarioId` (1 to 200 characters) name the scenario; another run may use the same
  `scenarioId`, so runs that overlap on one server stay apart. A run reports each scenario once.
  `title` defaults to `scenarioId`. `chats` names the chats it happens in, as the viewer's `chat`
  parameter does.
- `finishScenario({ runId, scenarioId, result, failure, labels, title })` reports the result:
  `passed`, `failed` or `skipped`. A scenario that never started, such as a skipped one, is
  reported here first. A failed one may carry `failure: { message, evidence }`. Each piece of
  evidence names something the server stored: `{ kind: "message", seq }` (a
  [message log](#message-log-and-delivered-updates) seq), `{ kind: "call", requestId }` (a
  [call receipt][ref-receipts]'s `request_id`) or `{ kind: "event", eventId }` (an event's
  `data-event-id` in the viewer), each with optional `labels`. Evidence that does not exist is
  refused.
- `labels` are free key and value pairs, such as `{ model: "local", mode: "fixture" }`; values are
  kept as text, and a finish adds to the start's. The server gives no key a meaning.
- `getScenarios({ runId })` lists the scenarios, one run's or all, in the order first reported,
  with their status, result, labels, failure and the marks of their start and finish.

In the viewer, a scenario's start and finish are cards among the chat's items, in the order things
happened: the result, the title, the run, and the labels. Each card lists every label key its run
uses, and `unknown` for one it lacks.

A failure shows its message and a list of its evidence, each in words: a message's sender, a short
quote and its chat; a call's bot, method and outcome; an event as the chat shows it, such as "Bob
banned forever by Shop Guard". Each keeps its labels. **Show evidence** marks them on the page, as
clicking a call marks what the call touched.

The Activity feed shows every scenario. A chat shows those that name it, those whose evidence is in
it, and, when a scenario names no chat, those with something in the chat between their start and
finish. The **Run** select in the toolbar, or `runs=` in the URL, keeps one run's cards.

Recordings keep the cards, their labels and evidence (older evidence as context), and list the
scenarios in the twin's `scenarios`. Like recordings, scenario reports are not part of snapshots:
after a `restore`, the viewer shows only those reported since.

### Telegram Login

The server also answers Telegram Login (OpenID Connect) at oauth.telegram.org's paths, so an app
logs in against it by changing only the origin: `GET /.well-known/openid-configuration`,
`GET /.well-known/jwks.json`, `GET /auth` (a page with a "Log in as ..." button per test user, and
Cancel) and `POST /token`. A test approves the login instead of a browser:

```js
import { startTestServer } from "telegram-bot-test-server";

const server = await startTestServer({
  botToken: "123456:TEST",
  loginClientSecret: "test-secret",
});
const ann = await server.createUser({ first_name: "Ann", username: "ann" });

// Your app sends the browser to /auth; the test logs in as Ann.
const redirectUri = "https://app.example/callback";
const authUrl = new URL("/auth", server.origin);
authUrl.search = new URLSearchParams({
  client_id: "123456",
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "openid profile",
  state: "xyz",
});
const back = new URL(await server.approveLogin(authUrl.href, ann));

// Your app trades the code for an ID token with the bot's client secret.
const response = await fetch(new URL("/token", server.origin), {
  method: "POST",
  headers: { Authorization: `Basic ${btoa("123456:test-secret")}` },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: back.searchParams.get("code"),
    redirect_uri: redirectUri,
  }),
});
const { id_token } = await response.json();
const claims = JSON.parse(
  Buffer.from(id_token.split(".")[1], "base64url").toString(),
);
console.log(claims.name, claims.preferred_username); // Ann ann

await server.stop();
```

It follows [Telegram's docs](https://core.telegram.org/bots/telegram-login) and its
[discovery document](https://oauth.telegram.org/.well-known/openid-configuration):

- The client id is the bot id and each bot has a client secret (`loginClientSecret`, random by
  default and readable from `GET /_fake/bot` and `GET /_fake/bots`). `/token` takes it by HTTP
  Basic, as the docs show, or in the form (`client_secret_post`, which the discovery document
  lists).
- `/auth` needs `response_type=code` and the `openid` scope. PKCE is recommended, not required, with
  `S256` or `plain`, as the discovery document lists. An unknown `client_id`, a bad
  `response_type`, a missing `openid` or a bad challenge method gets a 400 page, never a redirect.
- `approveLogin(authUrl, userId)` returns the `redirect_uri` URL with `code` and `state`, and
  `cancelLogin(authUrl)` the `redirect_uri` URL with `error=access_denied` and `state`.
- A code works once, only with the same `redirect_uri`, and only with a `code_verifier` that
  matches its challenge; otherwise `/token` answers `invalid_grant`, and a wrong secret
  `invalid_client` (401). `grant_type` must be `authorization_code`. Codes expire after 60 seconds
  here; Telegram does not document how long they last.
- The ID token is signed RS256 with the published key and names it in `kid`. It has `iss`
  (`https://oauth.telegram.org`), `aud` (the bot id), `sub`, `iat`, `exp` (an hour later, as
  `expires_in: 3600` says) and `nonce` when the app sent one. `sub` is an opaque id that stays the
  same for a user, not their Telegram id, as in Telegram's example. The `profile` scope adds `id`,
  `name`, `given_name`, `family_name`, `preferred_username` and `picture` (served by this server).
- `telegram:bot_access` lets the bot message the user afterwards, as documented.
- Each server makes its own signing key the first time a token or `jwks.json` needs it, so tests
  that never log in do not wait for it.

### Owner accounts (GramJS)

Some apps also read a user's **own** Telegram account through GramJS (MTProto): their dialog list,
folders and history. The owner client stands in for GramJS's `TelegramClient` for exactly the calls
listed in the [owner accounts reference][owner-docs] (`connect`, `getMe`, `getEntity`,
`getDialogs`, `getMessages`, `invoke` with `GetDialogFilters` and a few more), answering from owner
state a test seeds on the server. It is **not** MTProto: there is no wire protocol, encryption,
phone login or real session, and it never contacts Telegram. Never give it, or a test built on it,
a real phone number, session string or API hash.

```js
import {
  createOwnerClient,
  ownerApi,
  startTestServer,
} from "telegram-bot-test-server";

const server = await startTestServer({ botToken: "123456:TEST-TOKEN" });
const owner = await server.createOwner({ firstName: "Ana" });
const { id: group } = await server.addOwnerDialog(owner.id, {
  kind: "supergroup",
  id: 701,
  title: "Builders",
});
await server.addOwnerMessages(owner.id, group, [
  { id: 1, date: 1_700_000_000, text: "hi" },
]);

const client = createOwnerClient({ origin: server.origin, userId: owner.id });
await client.connect();
const dialogs = await client.getDialogs({ folder: 0, limit: 50 }); // [{ id: -1000000000701, ... }]
const history = await client.getMessages(await client.getEntity(group), {
  limit: 20,
});
const { filters } = await client.invoke(
  new ownerApi.messages.GetDialogFilters({}),
);

await client.disconnect();
await server.stop();
```

The client answers over HTTP, so a test process and an app process can share one server. In the
app's tests, construct `createOwnerClient({ origin, userId })` where the app would construct its
`TelegramClient`, for example by giving the app's lifecycle a subclass of its MTProto adapter whose
start-up assigns the owner client (and `ownerApi` as the request namespace) instead of connecting
to Telegram. Everything above that point (routes, authentication, cursors, normalization and error
mapping) stays the app's real code. Production code needs no change.

The [owner accounts reference][owner-docs] lists what each client call answers, dialog order and
paging, the owner test actions (`createOwner`, `addOwnerDialog`, `addOwnerMessages`,
`setOwnerFilter`, `failOwnerCall`, `getOwnerCalls` and the rest) and their HTTP routes, delays and
failures, and what is not modeled.

### Other languages: command line and HTTP

Tests in Python, Go or any other language run the server from the command line and drive it over
HTTP:

```sh
npx telegram-bot-test-server --token 123456:TEST --port 0 --config chats.json
```

Once it listens, it prints its origin as its first line, then any log lines:

```text
[telegram-bot-test-server] listening at http://127.0.0.1:52428
```

Read the origin from that line. With `--ui`, the next line gives the viewer's address:
`[telegram-bot-test-server] viewer at http://127.0.0.1:52428/_fake/ui`. SIGTERM or Ctrl-C stops
the server.

| Flag                 | Default         | Meaning                                                 |
| -------------------- | --------------- | ------------------------------------------------------- |
| `--token`            | required        | The bot's token.                                        |
| `--port`, `--host`   | 8081, 127.0.0.1 | Where to listen. `--port 0` picks a free port.          |
| `--username`         | `example_bot`   | The bot's username.                                     |
| `--config`           | none            | A JSON file with `chats` and `publicChats`.             |
| `--unimplemented-ok` | off             | Answer `true` to unsupported methods that return True.  |
| `--ui`               | off             | Serve the [chat viewer](#watch-the-chats-in-a-browser). |
| `--record-dir`       | none            | Where [recordings](#record-a-scenario) are written.     |
| `--clock-now`        | real time       | A [manual clock](#time): Unix ms or an ISO date.        |
| `--clock-offset`     | real time       | A [running clock](#time): real time plus ms.            |
| `--clock-webhook`    | none            | Where clock changes go, as with `clockWebhook`.         |

These are all the flags; there is no `--help`. Without `--token` it prints its usage line, and an
unknown flag stops it with an error. So does a clock value it cannot read, or both clock flags.

`chats.json` holds `{ "chats": [...], "publicChats": [...] }` in the shape of the
[options][ref-options], with their camelCase keys:

```json
{
  "chats": [{ "id": -1001000000001, "title": "Test Group", "ownerId": 5000000001 }]
}
```

Your bot sends its Bot API calls to `<origin>/bot<token>/<method>`, such as
`http://127.0.0.1:8081/bot123456:TEST/getUpdates`, and downloads files from
`<origin>/file/bot<token>/<file_path>`, as it would from `https://api.telegram.org`. With
python-telegram-bot, call `.base_url(f"{origin}/bot")` and `.base_file_url(f"{origin}/file/bot")`
on `Application.builder()`; with aiogram, give the bot
`session=AiohttpSession(api=TelegramAPIServer.from_base(origin))`.

The test drives the test actions through the [control API][ref-control]: JSON routes under
`/_fake/`, a prefix no Bot API path uses. This pytest test starts the server on a free port and the
bot under test (here `bot.py`, which takes the origin as its argument), then plays the quick
start's user:

```python
# test_moderation.py: run with pytest, with chats.json and your bot.py beside it.
import json
import subprocess
import sys
import threading
import urllib.request

import pytest

GROUP = -1001000000001


@pytest.fixture
def control():
    # The server picks a free port and prints its origin on its first line.
    server = subprocess.Popen(
        ["npx", "telegram-bot-test-server", "--token", "123456:TEST",
         "--port", "0", "--config", "chats.json"],
        stdout=subprocess.PIPE, text=True,
    )
    origin = server.stdout.readline().split(" listening at ")[1].strip()
    threading.Thread(target=server.stdout.read, daemon=True).start()
    # The bot under test, with the origin as its Bot API base URL.
    bot = subprocess.Popen([sys.executable, "bot.py", origin])

    def control(method, path, body=None):
        request = urllib.request.Request(
            f"{origin}/_fake/{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    yield control
    for process in (bot, server):
        process.terminate()
        process.wait()


def test_bans_whoever_posts_a_link(control):
    def wait_for(condition):
        return control("POST", "wait", {"condition": condition, "timeoutMs": 2000})

    ann = control("POST", "users", {"first_name": "Ann"})["id"]
    control("POST", f"chats/{GROUP}/join", {"user_id": ann})
    spam = control("POST", f"chats/{GROUP}/messages",
                   {"user_id": ann, "text": "cheap followers at example.com"})

    wait_for({"kind": "message", "chatId": GROUP,
              "messageId": spam["message_id"], "deleted": True})
    wait_for({"kind": "member", "chatId": GROUP, "userId": ann, "status": "kicked"})
    assert control("GET", f"chats/{GROUP}/members/{ann}")["status"] == "kicked"
```

The thread keeps reading the server's output, so its log never fills the pipe. A wait that times
out raises `urllib.error.HTTPError` with status 408, and its `{ error }` body says what was
expected and what was observed.

The control API takes snake_case fields, like the Bot API; the waits, snapshots, clock and
deliveries routes take camelCase fields, like their JavaScript methods.

---

## Reference

The full reference is in [docs/reference.md][ref]:

- [Options][ref-options]: everything `startTestServer` takes.
- [Test actions][ref-actions]: every method that plays a person on Telegram or reads the state.
- [Wait conditions][ref-waits]: every condition `waitFor` takes.
- [Control API][ref-control]: the test actions over HTTP, for other languages.
- [Supported Bot API methods][ref-methods]: what the server answers, and how it reads requests.
- [Call receipts][ref-receipts]: what `getCalls()` records about each Bot API call.
- [Viewer][ref-viewer]: what the viewer shows, its URL parameters, data attributes and routes.

How the server follows Telegram, rule by rule, with Telegram's error texts, is in
[Telegram behavior][behavior].

---

## Development

```sh
pnpm install
pnpm test
```

`pnpm bench`, `node bench/reuse.mjs` and `node --expose-gc bench/scaling.mjs` measure the server.
The scaling benchmark accepts `BENCH_HISTORY`, `BENCH_MESSAGES`, `BENCH_OBSERVERS` and
`BENCH_ROUNDS` for larger runs; a small sample is not a throughput guarantee. The
[performance measurements][performance] give the observed costs.

`node scripts/screenshots.mjs` makes the two screenshots in `docs/images` again. A small grammY bot
looks after a book club while the script plays its members, and Playwright takes the pictures.
Playwright is not a dependency, so install it with its Chromium anywhere and point `PLAYWRIGHT`
at it:

```sh
npm install --prefix /tmp/shots playwright
/tmp/shots/node_modules/.bin/playwright install chromium
PLAYWRIGHT=/tmp/shots/node_modules/playwright node scripts/screenshots.mjs
```

The README links the pictures at a release tag, so each release's README on npm keeps its own.
Change the tag in those links when the pictures change.

---

## License

MIT

[behavior-bots]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#more-than-one-bot
[behavior-channels]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#channels
[behavior-delivery]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#update-delivery
[behavior-privacy]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#privacy-mode
[behavior-topics]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#forum-topics
[behavior-upgrade]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#basic-groups-and-the-upgrade
[behavior]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md
[owner-docs]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/owner-accounts.md
[performance]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/performance.md
[privacy-docs]: https://core.telegram.org/bots/features#privacy-mode
[ref-actions]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md#test-actions
[ref-control]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md#control-api
[ref-methods]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md#supported-bot-api-methods
[ref-options]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md#options
[ref-receipts]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md#call-receipts
[ref-viewer]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md#viewer
[ref-waits]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md#wait-conditions
[ref]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/reference.md
