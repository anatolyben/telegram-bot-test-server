# telegram-bot-test-server

`telegram-bot-test-server` is a local test server for the Telegram Bot API, for testing bots,
especially bots that manage groups. Your bot talks to it instead of Telegram, your test plays the
users, and then checks what the bot did. It keeps everything in memory and never talks to Telegram,
so tests need no real accounts, phone numbers or groups, and can run as often as they like in CI.

**Start:** [Install](#install) · [Quick start](#quick-start) · [How it works](#how-it-works)

**Guide:** [Write a test](#write-a-test) · [Make users act](#make-users-act) ·
[Check what the bot did](#check-what-the-bot-did) ·
[Webhooks and polling](#webhooks-and-polling) · [More than one bot](#more-than-one-bot) ·
[Channels, basic groups and forums](#channels-basic-groups-and-forums) ·
[Failures, flood control and time](#failures-flood-control-and-time) · [Snapshots](#snapshots) ·
[Telegram Login](#telegram-login) · [Owner accounts (GramJS)](#owner-accounts-gramjs) ·
[Other languages](#other-languages-command-line-and-http)

**Reference:** [Options](#options) · [Test actions](#test-actions) ·
[Wait conditions](#wait-conditions) · [Control API](#control-api) ·
[Supported Bot API methods](#supported-bot-api-methods) · [Call receipts](#call-receipts)

**About:** [How closely it matches Telegram](#how-closely-it-matches-telegram) ·
[What it does not do](#what-it-does-not-do) · [Upgrading from 0.10.0](#upgrading-from-0100) ·
[Changes](#changes) · [Development](#development) · [Status](#status)

## Install

```sh
npm install --save-dev telegram-bot-test-server
```

Requires Node.js 20 or newer. No runtime dependencies.

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

## How it works

Your bot sends its Bot API calls to `server.origin` instead of `https://api.telegram.org`, and the
server answers the way Telegram does, keeping the state a group bot depends on: members and their
status, restrictions and bans, messages and deletions, invite links, join requests and profile
photos. Your test plays the other side through **test actions**, methods such as `server.join`,
`server.post` and `server.pressButton`: users join, leave, post, ask to join, press buttons and
message the bot, and the server sends your bot the same updates Telegram would, by webhook or
through `getUpdates` polling. Your bot handles those updates in its own time, so the test then
waits for what it expects with `server.waitFor`, or reads the state with `server.getMessages`,
`server.getMember` and `server.getCalls`.

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

Test actions play people on Telegram. Each one resolves once the update it causes has been handed
to the bot: its first webhook attempt has finished (with any call the webhook answered with), it
waits behind an update the webhook refused, or it is queued for `getUpdates`. A webhook gets a
minute to answer, so one that never answers holds the action for a minute. What the bot does in
response happens after that, so wait for the outcome rather than checking it immediately. An action
fails where Telegram would refuse the person: `post` fails if the user is not allowed to post, for
example.

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

Users can also post photos, media, albums and forwards, edit their messages, react, pin, press
buttons in private chats and on ephemeral messages, change their profile, and rename the chat or
change its photo. [Test actions](#test-actions) lists them all.

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

A wait fails after 1000 ms by default; `{ timeoutMs }` sets 1 to 30000 ms of wall time. Its error
names the exact expectation, what was observed (or up to eight matching requests) and the work
still outstanding, in at most 8000 characters with credentials redacted. The outstanding work
counts what is in progress: `controls` (test actions), `http` (open HTTP requests to the server),
`owners` (owner client calls), `deliveries` (webhook attempts queued or running), `polls` (open
long polls), `delayedOrNetworkRequests` (webhook connections and response delays) and `waits`
(waits, this one included). A polling bot always has a long poll open, so `http: 1` and `polls: 1`
are normal. [Wait conditions](#wait-conditions) lists every condition.

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
indiscriminately.

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

### Webhooks and polling

A bot that polls needs nothing more: its `getUpdates` calls get the updates waiting for it. A bot
that uses a webhook calls `setWebhook` with its URL, as it would on Telegram, and the server then
posts each update there. Like a Bot API server run with `--local`, this one takes `http` URLs, any
port and local addresses.

```js
import http from "node:http";
import { Bot, webhookCallback } from "grammy";
import { startTestServer } from "telegram-bot-test-server";

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
  botId: 123456,
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
or wait for what the bot does after answering. `getDeliveries()` lists each attempt with its update
and bot id, attempt number (each retry is one), `epoch` (the number of restores before it), when it
was queued, started and completed, its status and outcome. Sent updates and this list are kept
until a restore. `redeliverUpdate(updateId, { botId })` has Telegram deliver an update again, byte
for byte, callback queries included, as it does when a webhook does not confirm one. Each bot
numbers its own updates, and bots added in the same second start at the same number, so with more
than one bot always pass `botId`. It sends the saved update, so do not restore an earlier snapshot
between the steps of a replay.

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

Each bot has its own membership and rights in each chat, its own `update_id` sequence, its own
`file_id`s, and hears only the button presses on keyboards it put on messages. Users write
privately only to the first bot, so no other bot can message them (403), except a join requester:
any bot that receives the request may message them for five minutes. `getMember` answers as
`getChatMember` would to the first bot, and the control API shows messages with the first bot's
file_ids. Name a bot with `botId` in waits, failure rules and `connectBusiness`. More under
[More than one bot][behavior-bots].

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
- **Forums.** `createTopic` and `renameTopic` create and rename topics with Telegram's service
  message, and `post` takes a `threadId`. A send to a thread that is not a topic fails with
  `message thread not found`.

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
`messageId`; other calls do not use it up. `userId` is the user the call is about: its `user_id`,
an ephemeral message's receiver, or the author of the message `deleteMessage` deletes. `messageId`
also matches one id in a `deleteMessages` list. `attempt: 2` starts at the second matching call
after the rule is added, and `times` (default 1) is how many matching calls in a row it applies to.

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
The limits run on the server clock, so with `clock` a held send is answered only once a test moves
the clock past its wait with `advanceTime`. While a send is held, `snapshot()` and `restore()`
refuse, as for a response delay; a snapshot keeps and restores the recent sends.

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

Advances run one at a time, and each runs what has come due, in deadline order: restriction and
ban expiry, response delays (`delayMs`, and owner call delays), sends held by flood control, webhook
retries and delayed `getUpdates` conflicts. Message, login and business dates, the five minutes a
bot may message a join requester, and flood control follow this clock too. A restore sets a manual
clock back to the snapshot's time; real time is never rewound. The global `Date`, timers and your
app's jobs are untouched. Webhook connections and their one-minute timeout, long polling and
`waitFor` deadlines use wall time, so an advance does not wait for deliveries or for your bot to
act.

### Snapshots

A snapshot saves the server's state so a test can return to it, instead of starting a fresh server.
This example also makes a real Bot API call, as a bot would:

```js
import { startTestServer } from "telegram-bot-test-server";

const GROUP = -1001234567890;
const server = await startTestServer({
  botToken: "123456:TEST",
  clock: { now: 1_800_000_000_000 }, // optional; omit for real time
  chats: [{ id: GROUP, title: "Test", ownerId: 5000000001 }],
});
try {
  const userId = await server.createUser();
  await server.join(GROUP, userId);
  const saved = await server.snapshot();
  try {
    const banned = server.waitFor(
      { kind: "member", chatId: GROUP, userId, status: "kicked" },
      { timeoutMs: 1000 },
    );
    await Promise.all([
      banned,
      (async () => {
        // A real Bot API call, as a bot would make it.
        const response = await fetch(
          `${server.origin}/bot123456:TEST/banChatMember`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: GROUP, user_id: userId }),
          },
        );
        const answer = await response.json();
        if (!answer.ok) throw new Error(answer.description);
      })(),
    ]);
    await server.restore(saved);
    await server.waitFor({
      kind: "member",
      chatId: GROUP,
      userId,
      status: "member",
    });
  } finally {
    await server.releaseSnapshot(saved);
  }
} finally {
  await server.stop();
}
```

In a real test, trigger your app instead of calling the Bot API directly, and wait for the same
condition.

`snapshot()` returns an opaque handle that only this server accepts. `snapshot()` and
`restore(handle)` need the server to be idle: no Bot API, control or owner request in progress, no
long poll, no webhook attempt (an update waiting for a retry counts until it is delivered, dropped
or its webhook removed), no response delay, no send held by flood control and no clock advance.
Pending restriction and ban expiries and unused failure rules are fine. Drain deliveries and finish
requests before taking a snapshot; `restore` fails with outstanding work rather than mix it with
the restored state.

`restore` puts back users, bots, chats (groups, private and business chats, owner accounts), file
bytes, members, messages, invite links and join requests, id counters, call receipts, failure rules
and how far they have counted, sent updates with their bytes and queues, webhook and
`allowed_updates` settings, login codes and flood control's recent sends. Expiries are scheduled
again from the restored members. A snapshot can be restored any number of times;
`releaseSnapshot(handle)` frees it. A restore cancels waits in progress and returns
`{ restored: true, epoch }`, where `epoch` counts the restores so far; it keeps later `request_id`s
apart from earlier ones although ids and receipts go back. The origin and the login signing key
stay the same. Nothing outside the server is restored: your webhook receiver, its sockets and
timers, your database and your app's state.

Between independent scenarios, drop unused failure rules with `clearFailures()`, then restore a
snapshot or start a fresh server.

### Watch the chats in a browser

A server started with `ui: true` serves a live view of its chats at `server.viewerUrl`
(`<origin>/_fake/ui`): every chat in a list on the left, the selected chat drawn as a chat window,
and panels for the chat's events, its members and the bot calls. It follows the test as it runs,
with no reload, so you can watch a scenario or screenshot it with Playwright.

```js
const server = await startTestServer({
  botToken: "123456:TEST",
  chats: [{ id: GROUP, title: "Test Group", ownerId: 5000000001 }],
  ui: true,
});
console.log(server.viewerUrl); // http://127.0.0.1:54321/_fake/ui
```

From the command line, `--ui` prints the address. The viewer is off by default, and it answers only
on this computer: a request from another machine, through a proxy or tunnel, or under another host
name gets 403. It never changes the server's state, adds nothing to Bot API answers or updates, and
an open viewer does not hold up `snapshot()`, `restore()` or a wait.

What it shows, only from what the server stores:

- **Chats**: groups, supergroups, channels, forums and each user's private chat with each bot,
  most recently active first.
- **Messages**: the sender's name and initial, bots tagged as the first bot, an added bot or a guest
  bot; text with its entities, replies, forwards and captions; photos as the images themselves and
  other media as labelled placeholders; inline keyboards as buttons (hover one for its callback
  data); edits; and service messages: joins, leaves, pins, title and photo changes, upgrades and
  topics. Times are UTC.
- **Deletions**: a deleted message stays, greyed and marked with the bot that deleted it.
- **Ephemeral messages**, marked with the member who sees them.
- **Events** Telegram shows as no message: member changes (restrictions, bans, promotions, their
  expiry), join requests (pending, approved, declined) and unpins.
- **Members**: each one's status, restrictions and rights, the bots' included, and pending join
  requests.

The view lives in the URL, so a link, a test or a Playwright script reproduces it exactly, and
everything changed on the page (panels, layout, view as, topic, theme, the open chat) updates the
URL:

| Parameter         | Values                                                                                              | Default                       |
| ----------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| `chat`            | a group id, `<user id>:<bot id>` for a private chat, or a user id for their chat with the first bot | the most recently active chat |
| `chats`           | up to four chats, comma-separated, shown side by side                                               |                               |
| `show`            | panels, comma-separated: `list`, `chat`, `calls`, `events`, `members`                               | all of them                   |
| `layout`          | `combined` (calls and events inline in the chat) or `split` (each in its own panel)                 | `combined`                    |
| `as`              | a user id: the chats as that member sees them                                                       | the test view                 |
| `bots`, `methods` | comma-separated: calls from these bots or of these methods only                                     | all                           |
| `topic`           | a forum topic's `message_thread_id`, or `general`                                                   | all topics                    |
| `theme`           | `light` or `dark`                                                                                   | the system's                  |

For example, `/_fake/ui?chats=-1001000000001,-1001000000002&show=chat` shows a group beside its log
chat, and `?chat=-1001000000001&show=members` only the members. A page opened without `chat` shows
the most recently active chat and writes it into the URL. Each panel's ↗ opens it alone in a new tab,
and × hides it. The dividers between columns resize them, with the mouse or the arrow keys. In a
narrow window one panel shows at a time, with a bar to switch.

**View as a member.** `as=<user id>`, or the select in the toolbar, shows each chat as that member
sees it: no deleted messages, no other member's ephemeral messages (their own read "only you see
this"), no events, calls or member panels, a reply to or pin of a deleted message as Telegram shows
it, and a poll's results only once they have voted or it has closed. The chat list holds only their
chats. They see everything in a channel, forum or supergroup they are in now and nothing in one they
are not in (a note says why); in a basic group, what was posted while they were in it, and nothing
after a ban with `revoke_messages`. Not modeled: whether a private supergroup hides its earlier
history from new members (the view marks where that history would start), and members a chat was
created with count as present from the start.

**Long chats.** A chat shows its latest 200 messages and events; "Load older messages" adds 200 at a
time. At most 600 stay loaded: loading more drops the newest, and "Jump to latest" goes back to the
end.

**Several tabs.** All viewer tabs of one browser share one event stream, so any number of them stay
live.

**Selecting with Playwright.** Chats, messages, buttons and members carry stable data attributes:

| Element       | Attributes                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the page      | `[data-role="app"]` with `data-instance`, `data-epoch`, `data-version`, and `data-busy="true"` while loading                                                                                                                                                                                                                                                                      |
| chat list row | `data-chat-key`, `data-chat-id`, `data-chat-type` (`supergroup`, `group`, `channel`, `private`), `data-forum`; private chats `data-user-id`, `data-bot-id`; `aria-current="true"` when open                                                                                                                                                                                       |
| column        | `data-column-id` (`list` or `<panel>:<chat>`), `data-panel`, `data-chat-key`, `data-chat-id`, `data-view-as`                                                                                                                                                                                                                                                                      |
| message       | `data-kind="message"`, `data-chat-key`, `data-seq`, `data-message-id` or, for an ephemeral message, `data-ephemeral-id` and `data-receiver-id`; `data-author-id`, `data-author-kind` (`user`, `first-bot`, `added-bot`, `guest-bot`, `bot`, `channel`), `data-deleted` and `data-deleted-by`, `data-edited`, `data-service`, `data-thread-id`, `data-reply-to`, `data-request-id` |
| inline button | `data-button-text`, `data-button-data`, `data-button-url`, `data-button-row`, `data-button-col`                                                                                                                                                                                                                                                                                   |
| event         | `data-kind="event"`, `data-chat-key`, `data-event-id`, `data-event-type` (`member`, `join_request`, `unpin`), `data-user-id`, `data-request-id`                                                                                                                                                                                                                                   |
| member        | `data-chat-key`, `data-member-id`, `data-member-status`, `data-member-in-chat`, `data-member-bot`                                                                                                                                                                                                                                                                                 |
| join request  | `data-chat-key`, `data-join-request-user-id`                                                                                                                                                                                                                                                                                                                                      |

`data-chat-key` tells a user's private chats with two bots apart. View as and the topic filter leave
what is hidden out of the page, so a count of zero means it is not shown. The page keeps its event
stream open, so Playwright's `networkidle` never settles; after acting, read the server's version
and wait for the page to catch up:

```js
const { version } = await (await fetch(`${server.origin}/_fake/ui/api/state`)).json();
await page.waitForFunction(
  (wanted) =>
    Number(document.body.dataset.version) >= wanted &&
    !document.body.hasAttribute("data-busy"),
  version,
);
const spam = page.locator(`[data-kind="message"][data-message-id="${spamId}"]`);
console.log(await spam.getAttribute("data-deleted-by")); // the bot that deleted it
```

The viewer's routes, all `GET` and all on this computer only:

| Route                        | Answer                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/_fake/ui`                  | the page                                                                                                          |
| `/_fake/ui/assets/<file>`    | its scripts and stylesheet                                                                                        |
| `/_fake/ui/api/state`        | the chat list (`?as=<user id>` for a member's)                                                                    |
| `/_fake/ui/api/chats/<chat>` | a chat's messages and events, members and calls (`limit`, `before`, `from`, `to`, `as`, `topic`, `members_limit`) |
| `/_fake/ui/files/<file_id>`  | a stored image's bytes                                                                                            |
| `/_fake/ui/events`           | the live event stream (server-sent events)                                                                        |

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
  (unverified: Telegram does not document how long).
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

Read the origin from that line. SIGTERM or Ctrl-C stops the server.

| Flag                 | Default         | Meaning                                                |
| -------------------- | --------------- | ------------------------------------------------------ |
| `--token`            | required        | The bot's token.                                       |
| `--port`, `--host`   | 8081, 127.0.0.1 | Where to listen. `--port 0` picks a free port.         |
| `--username`         | `example_bot`   | The bot's username.                                    |
| `--config`           | none            | A JSON file with `chats` and `publicChats`.            |
| `--unimplemented-ok` | off             | Answer `true` to unsupported methods that return True. |

These are all the flags; there is no `--help`. Without `--token` it prints its usage line, and an
unknown flag stops it with an error.

`chats.json` holds `{ "chats": [...], "publicChats": [...] }` in the shape of the
[options](#options), with their camelCase keys:

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

The test drives the test actions through the [control API](#control-api): JSON routes under
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

## Reference

### Options

`startTestServer(options)` takes:

- `botToken` (required): the first bot's token, `<numeric id>:<secret>`. The numeric id is the bot's
  user id. Calls with any other token get 401.
- `port`, `host` (default `0`, `127.0.0.1`): where to listen. Port 0 picks a free port.
- `botUsername`, `botName` (default `example_bot`, `Example Bot`): returned by `getMe`.
- `chats` (default `[]`): supergroups `{ id, title, ownerId, ownerName? }`. The bot is an
  administrator with `can_manage_chat`, `can_change_info`, `can_delete_messages`,
  `can_invite_users`, `can_restrict_members` and `can_pin_messages`.
- `publicChats` (default `[]`): channels, groups and bots `{ username, type, title? }` resolvable by
  `getChat("@username")`; `type` is `"channel"`, `"supergroup"` or `"bot"`, and `username` may
  start with `@`.
- `supportsJoinRequestQueries` (default `false`): a guard bot: where it has `can_invite_users`, join
  requests reach it with a `query_id` ([Join request queries][behavior-join-queries]).
- `loginClientSecret` (default random): the first bot's [Telegram Login](#telegram-login) client
  secret.
- `unimplemented` (default `"error"`): Telegram's 404 for an unsupported method, or `"ok"`: `true`
  for one that returns True ([Supported Bot API methods](#supported-bot-api-methods)).
- `floodControl` (default `false`): hold or refuse sends over Telegram's published limits
  ([Flood control](#flood-control)).
- `clock` (default real time): `{ now: <Unix ms> }`: a manual clock that only `advanceTime` moves
  ([Time](#time)).
- `log` (default none): receives one line per notable event: unsupported methods, webhook
  failures, internal errors.

### Test actions

`startTestServer()` returns the server with these methods; `server.origin` is its base URL, for
the bot's Bot API root. Each action resolves once the update it causes has been handed to the bot
([Make users act](#make-users-act)). The owner account actions are in the
[owner accounts reference][owner-docs].

**Users**

- `createUser({ first_name, last_name, username, language_code, bio, is_bot, is_premium })`: a new
  Telegram user; returns their id. All fields are optional: `first_name` defaults to
  `"Test Member"` and `language_code` to `"en"`; the user has no last name, username or bio, and
  is neither a bot nor premium.
- `updateProfile(userId, fields)`: the user changes their name, username or bio.
- `addProfilePhoto(userId, bytes)`: the user adds a profile photo.

**Joining and leaving**

- `join(chatId, userId)`: the user joins the group.
- `joinByLink(inviteLink, userId)`: the user opens an invite link: joins, or files a join request
  if the link requires approval; returns `{ chat_id, status: "member" | "requested" }`. A revoked,
  expired or full link fails with `INVITE_HASH_EXPIRED`.
- `leave(chatId, userId)`: the user leaves.

**Posting**

- `post(chatId, userId, text)`: the user posts a message; returns its `message_id`. Also takes
  `{ text, photo, media, caption, replyTo, threadId, forwardFrom, poll }`: `photo` is image bytes
  (a PNG, GIF or JPEG header gives its size); `media` is `{ type, bytes, fileName?, mimeType? }`
  with `type` `video`, `animation`, `sticker`, `voice`, `audio`, `video_note` or `document`; a
  caption goes with every kind but stickers and video notes; `replyTo` is the `message_id` it
  replies to; `threadId` is a forum topic; `forwardFrom` is `{ userId }`, `{ senderName }` (a hidden
  user) or `{ chatId, messageId? }` (a channel post); `poll` is a poll of the user's own, a message
  by itself, with `sendPoll`'s fields (`question`, `options`, `type`, `is_anonymous`,
  `allows_multiple_answers`, `allows_revoting`, `correct_option_ids`, `explanation`) and checks,
  and needs `can_send_polls`. Fails if the user is not allowed to post. Text and captions are
  trimmed as Telegram's apps send them, and text that then shows nothing fails with
  `MESSAGE_EMPTY`.
- `vote(chatId, messageId, userId, optionIds)`: the user votes in a poll: option indexes, or `[]` to
  take the vote back. Fails as Telegram's app refuses: `Can't answer closed poll`,
  `Can't choose more than 1 option in the poll`, `Invalid option identifier specified`,
  `Can't revote in a quiz` (or in any poll without `allows_revoting`),
  `Can't retract vote in the poll`, `Can't access the chat` for someone not in it, and
  `Message is not a poll`. Resolves with the poll once the bot that sent it has its updates.
- `postAlbum(chatId, userId, items, { threadId })`: the user posts 2 to 10 photos or videos as one
  album (`media_group_id`); `items` are `{ type: "photo" | "video", bytes, caption? }`. Returns
  `{ media_group_id, message_ids }`.
- `editMessage(chatId, messageId, userId, { text, caption })`: the author edits their message; bots
  get `edited_message` (`edited_channel_post` in a channel). Text that shows nothing fails with
  `MESSAGE_EMPTY`. Returns `{ message_id, edit_date }`.
- `react(chatId, messageId, userId, emoji)`: the user reacts to a message, or takes the reaction
  back with `null`. Returns `{ reactions }`.
- `pinMessage(chatId, messageId, userId)`: a person with `can_pin_messages` (in a channel,
  `can_edit_messages`) pins the message; bots get the `pinned_message` service message, whose
  `{ message_id }` it returns.
- `postGuestBotReply(chatId, userId, botUsername, text)`: the user calls a guest bot (Bot API 10.0
  guest mode); its answer appears in the group from that bot, with `guest_bot_caller_user` set.
  Returns its `message_id`.

**Buttons**

- `pressButton(chatId, messageId, userId, data)`: the user presses the inline button whose
  `callback_data` is `data` (not its label); resolves with the bot's `answerCallbackQuery` answer,
  `{ answered, text, show_alert }`. It fails at once if the message has no button with that data.
  Once the press has reached the bot (for a webhook, once it answered, within a minute), it waits
  up to 10 seconds for the answer, and resolves `{ answered: false }` if none came. An answer
  Telegram refuses, such as text over 200 characters, does not count. The bot that put the
  keyboard on the message gets the press.
- `pressEphemeralButton(chatId, ephemeralMessageId, userId, data)`: the receiver presses an inline
  button on an ephemeral message; resolves like `pressButton`.
- `pressDirectButton(userId, messageId, data)`: the user presses a button in their private chat
  with the bot.

**Private chats**

- `sendDirectMessage(userId, message)`: the user messages the bot privately; returns the
  `message_id`. `message` is text, or anything `post` takes but `threadId`: a photo, other media
  with a caption, a reply to one of the bot's messages, a forward or a poll. Empty text fails with
  `MESSAGE_EMPTY`.
- `voteDirect(userId, messageId, optionIds)`: the user votes in a poll the bot sent to their private
  chat; works like `vote`.
- `getDirectMessages(userId)`: an array of the messages in the private chat between the user and
  the bot, newest first.

**Reading state**

- `getMessages(chatId)`: an array of the chat's messages not deleted, newest first. Ephemeral
  messages are included in their place, with `receiver_user`; all of them have `message_id` 0, so
  tell them apart by `ephemeral_message_id`. File ids are the first bot's.
- `getMessage(chatId, id)`: a regular message by `message_id`, as
  `{ exists, deleted, message }`.
- `getEphemeralMessage(chatId, ephemeralMessageId)`: an ephemeral message by its
  `ephemeral_message_id`, as `{ exists, deleted, message }`.
- `getMember(chatId, userId)`: the member as `getChatMember` returns them to the first bot:
  status, restrictions, ban.
- `getJoinRequests(chatId)`: user ids waiting for approval.
- `getChat(chatId)`: the chat, its pinned message ids (newest first by sending date) and its
  members.
- `getCalls()`: every Bot API call received, with the bot that made it, and any unsupported
  methods called ([Call receipts](#call-receipts)).

**Bots and chats**

- `addBot({ token, username, firstName, loginClientSecret, supportsJoinRequestQueries })`: another
  bot, with its own webhook or update queue; it is in no chat yet. Returns the bot's user, with
  its `id`.
- `createChat({ ownerId, title, type, ownerName, isForum })`: a new supergroup, forum (`isForum`),
  basic group (`type: "group"`) or channel (`type: "channel"`) with no bot in it; returns its id.
- `setBotMembership(chatId, botId, { status, rights, by })`: the owner (or `by`) adds, promotes,
  demotes or removes a bot; `status` is `administrator` (default), `member`, `left` or `kicked`.
  The bot gets `my_chat_member`. Returns its membership.
- `addBotViaLink(chatId, botId, { by, startParameter, rights })`: a person adds the bot through its
  `startgroup` link (as an administrator with `rights`), then `/start@<bot> <startParameter>` is
  posted; or its `startchannel` link. Returns the bot's membership.
- `migrateToSupergroup(chatId, { by })`: the creator or an administrator upgrades a basic group;
  returns the supergroup's id.
- `renameChat(chatId, { by, title })`, `changeChatPhoto(chatId, { by, bytes })`: a person with
  `can_change_info` renames the chat or sets its photo; returns the service message's
  `{ message_id }`.
- `createTopic(chatId, name, { by })`, `renameTopic(chatId, threadId, name, { by })`: a forum topic
  is created or renamed, with Telegram's service message; `createTopic` returns its
  `message_thread_id`.

**Business accounts**

- `connectBusiness({ ownerId, rights, id, isEnabled, botId })`: the owner connects a bot (by
  default the first) to their business account, or changes the connection with `id`; the bot gets
  `business_connection`. Returns `{ connection, update_id }`; `update_id` is `null` when the bot's
  `allowed_updates` leave that update out.
- `getBusinessConnection(connectionId)`: the `BusinessConnection`.
- `sayInBusinessChat(connectionId, userId, sender, text)`: `"person"` writes to the owner, or
  `"owner"` answers by hand; the bot gets `business_message` unless the connection is disabled.
  Returns `{ message_id, date, update_id }`.
- `getBusinessChat(connectionId, userId)`: the business chat, newest first:
  `[{ direction: "inbound" | "owner" | "bot", deleted, message }]`.

**Telegram Login**

- `approveLogin(authUrl, userId)`: the user logs in on the Telegram Login page for that `/auth`
  URL; returns the `redirect_uri` URL with `code` and `state`.
- `cancelLogin(authUrl)`: the user cancels; returns the `redirect_uri` URL with
  `error=access_denied` and `state`.

**Failures and deliveries**

- `failNext({ method, chatId, botId, userId, messageId, attempt, times, errorCode, description,
  retryAfter, dropAfterApply, delayMs })`: the next matching Bot API calls fail with that error, or
  (`dropAfterApply`) take effect and never answer ([Injected failures](#injected-failures)).
- `clearFailures()`: drop failure rules not used up.
- `redeliverUpdate(updateId, { botId })`: Telegram delivers that update again, byte for byte, to the
  same bot's webhook. `botId` names the bot; with more than one bot, always pass it, since two bots
  can get the same `update_id`.
- `drainDeliveries({ botId, timeoutMs })`, `getDeliveries()`: wait for webhook attempts to settle;
  list them ([Webhooks and polling](#webhooks-and-polling)).

**Waits, snapshots and time** (test controls, not Telegram methods)

- `waitFor(condition, { timeoutMs })`: resolves with what matched ([Wait
  conditions](#wait-conditions)).
- `snapshot()`, `restore(handle)`, `releaseSnapshot(handle)`: save and restore the server's state
  ([Snapshots](#snapshots)).
- `getClock()`, `advanceTime(ms)`: read and move a manual clock ([Time](#time)).

**Stopping**

- `stop()`: shut the server down. It cancels waits and delays, aborts deliveries in progress,
  starts no queued ones, clears scheduled work and closes connections. Read-only controls still
  answer in-process after `stop()`, for diagnostics.

### Wait conditions

`waitFor(condition, { timeoutMs })` takes one of these conditions (`POST /_fake/wait` takes the
same):

- `{ kind: "message", chatId, ... }` needs `messageId`, or an author (`userId` or `botId`) plus
  exact `text` or `caption`. `deleted` checks whether it was deleted, and author, text and caption
  can also narrow a `messageId`. `userId` or `botId` identifies the author also in a channel, where
  the message itself names only the channel. It resolves with
  `{ exists, deleted, message, author }`, where `author` is the author's user id, and finds
  ephemeral messages by author and text too. To tell apart the same ephemeral text sent to two
  members, read each one with `getEphemeralMessage`.
- `{ kind: "member", chatId, userId, status }` reads the member's status in the chat, which every
  bot in it shares. `permissions` compares the returned `ChatMember`'s permission fields. It
  resolves with the `ChatMember`.
- `{ kind: "joinRequest", chatId, userId, state }`, with `state` `pending`, `approved` or
  `declined`, is what the test observed, not a `ChatMember` status; a declined requester stays
  outside. `botId` identifies the resolving bot. It resolves with `{ state, member, botId }`.
- `{ kind: "call", botId, method, ... }` looks in `calls`; with `includeRejectedRequests: true`, in
  `rejected_requests` too. It narrows by `chatId`, `userId`, `messageId`, exact `params` fields
  (as text: [Call receipts](#call-receipts)), `afterSeq` (which counts within each list),
  `requestId`, `outcome` and `stage`. Without `outcome` or `stage`, it can resolve as soon as the
  call is received, before it runs. It resolves with the receipt.

### Control API

The test actions, over HTTP, for tests written in other languages. All routes live under
`/_fake/`, a prefix no Bot API path uses, take and return JSON and use snake_case fields. A route
that fails answers `{ error }` with an HTTP status.

**Users**

- `POST users`: create a user
  `{ first_name?, last_name?, username?, language_code?, bio?, is_bot?, is_premium? }`; returns
  `{ id }`.
- `GET users/:id`: the user, with bio and photos.
- `POST users/:id/profile`: change `first_name`, `last_name`, `bio` or `username`.
- `POST users/:id/photos`: add a profile photo `{ base64 }`.
- `DELETE users/:id/photos/:fileId`: remove a profile photo.

**Joining and leaving**

- `POST chats/:id/join`: the user `{ user_id }` joins.
- `POST chats/:id/leave`: the user `{ user_id }` leaves.
- `POST invites/:hash/join`: the user `{ user_id }` opens `https://t.me/+<hash>`: joins, or files a
  join request if the link requires one. A revoked, expired or full link answers 400
  `INVITE_HASH_EXPIRED`.
- `POST invites/:hash/check`: whether the user `{ user_id }` is in the link's chat.
- `GET chats/:id/join-requests`: user ids with a pending join request.

**Messages**

- `POST chats/:id/messages`: the user posts `{ user_id, text }`, `{ user_id, photo_base64,
  caption? }` or `{ user_id, media: { type, base64, file_name?, mime_type? }, caption? }`,
  optionally `reply_to`, `message_thread_id` or
  `forward_from: { user_id | sender_name | chat_id, message_id? }`, or a poll
  `{ user_id, poll: { question, options, ... } }`; returns `{ message_id }`.
- `POST chats/:id/messages/:messageId/vote`: the user `{ user_id, option_ids }` votes in a poll
  (`option_ids: []` takes the vote back); returns the poll.
- `POST chats/:id/albums`: the user posts an album
  `{ user_id, items: [{ type: "photo" | "video", base64, caption? }] }`; returns
  `{ media_group_id, message_ids }`.
- `POST chats/:id/messages/:messageId/edit`: the author `{ user_id }` edits the `text` or
  `caption`.
- `POST chats/:id/messages/:messageId/reactions`: the user `{ user_id, emoji }` reacts, or takes
  the reaction back with `emoji: null`.
- `POST chats/:id/messages/:messageId/pin`: the user `{ user_id }` pins the message, with
  `can_pin_messages` (in a channel, `can_edit_messages`); returns the service message's
  `{ message_id }`.
- `POST chats/:id/guest-bot-reply`: a guest bot answers the user
  `{ caller_user_id, bot_username, text }` in the group; returns `{ message_id }`.
- `GET chats/:id/messages`: an array of the messages not deleted, newest first, as
  `getMessages` returns it.
- `GET chats/:id/messages/:messageId`: `{ exists, deleted, message, reactions }`, reactions by user
  id.
- `GET chats/:id/ephemeral-messages/:eid`: `{ exists, deleted, message }` for the ephemeral message
  with `ephemeral_message_id` `:eid`.
- `GET chats/:id/members/:userId`: the member as `getChatMember` would return it.

**Buttons**

- `POST chats/:id/messages/:messageId/callback`: the user `{ user_id, data }` presses an inline
  button; returns the bot's answer.
- `POST chats/:id/ephemeral-messages/:eid/callback`: its receiver `{ user_id, data }` presses an
  inline button; returns the bot's answer.
- `POST users/:id/dm/:messageId/callback`: the user presses a button in the private chat
  `{ data }`.

`data` is the button's `callback_data`; a message with no button with that data answers 400 at
once. A press waits as `pressButton` does, up to 10 seconds once it has reached the bot, for the
bot to call `answerCallbackQuery`, and returns `{ answered, text, show_alert }`, or
`{ answered: false }`. An answer Telegram refuses, such as text over 200 characters, does not
count.

**Private chats**

- `POST users/:id/dm`: the user sends the bot a direct message, with the same body as
  `POST chats/:id/messages` without `user_id` and `message_thread_id`: `{ text }`,
  `{ photo_base64, caption? }`, `{ media, caption? }`, `reply_to`, `forward_from` or `poll`.
- `POST users/:id/dm/:messageId/vote`: the user `{ option_ids }` votes in a poll the bot sent
  privately.
- `GET users/:id/dm`: an array of the private chat's messages, newest first.

**Bots and chats**

- `GET bot`: the first bot's user, with its `login_client_secret`.
- `GET webhook`: the first bot's registered webhook.
- `POST bots`: add a bot
  `{ token, username, first_name?, login_client_secret?, supports_join_request_queries? }`; it is
  in no chat yet.
- `GET bots`: every bot, with its webhook URL and `login_client_secret`.
- `POST chats`: create
  `{ owner_id, title?, type?: "supergroup" | "group" | "channel", owner_name?, is_forum? }`;
  returns the chat.
- `GET chats/:id`: the chat with its pinned message ids and members.
- `POST chats/:id/bots`: add, promote, demote or remove a bot `{ bot_id, status?, rights?, by? }`,
  as the owner would.
- `POST chats/:id/bots` with `start_parameter`: a person `{ by?, bot_id, start_parameter, rights? }`
  adds the bot through its `startgroup` link, or, with `rights` and an empty `start_parameter`, a
  channel's `startchannel` link.
- `POST chats/:id/migrate`: upgrade a basic group `{ by? }`; returns the new supergroup.
- `POST chats/:id/title`: a person renames the chat `{ by?, title }`.
- `POST chats/:id/photo`: a person sets the chat photo `{ by?, base64 }`.
- `POST chats/:id/topics`: create a forum topic `{ name, by? }`; returns
  `{ message_thread_id, name }`.
- `POST chats/:id/topics/:threadId/edit`: rename a topic `{ name, by? }`.
- `GET chats/:id/topics`: the forum's topics.

**Business accounts**

- `POST business/connections`: connect `{ owner_id, rights, id?, is_enabled?, bot_id? }`, or change
  the connection with `id`; returns `{ connection, update_id }`.
- `GET business/connections/:id`: the `BusinessConnection`.
- `POST business/connections/:id/chats/:userId/messages`: `{ sender: "person" | "owner", text }`;
  returns `{ message_id, date, update_id }`.
- `GET business/connections/:id/chats/:userId/messages`: the business chat, newest first, as
  `[{ direction, deleted, message }]`.

**Telegram Login**

- `POST login/approve`: the user `{ auth_url, user_id }` logs in; returns `{ redirect_url }` with
  the code and state.
- `POST login/cancel`: the user cancels `{ auth_url }`; returns `{ redirect_url }` with
  `error=access_denied`.

**Failures, calls and updates**

- `POST failures`: fail the next calls `{ method, chat_id?, bot_id?, user_id?, message_id?,
  attempt?, times?, error_code?, description?, retry_after?, drop_after_apply?, delay_ms? }`.
- `GET failures`, `DELETE failures`: the failure rules still waiting, or clear them.
- `GET calls`: every Bot API call received, with the bot that made it, and the unsupported methods
  called.
- `POST updates/:updateId/redeliver`: deliver that update again to its bot's webhook
  `{ bot_id? }`; 404 for an unknown update, 409 when the bot has no webhook or `bot_id` must name
  one of several bots that got it. Returns `{ update_id }`.

**Waits, snapshots, time and deliveries**

These controls take camelCase fields:

| Request                           | Body/result                                          |
| --------------------------------- | ---------------------------------------------------- |
| `POST /_fake/wait`                | `{ condition, timeoutMs? }` → matching observation   |
| `POST /_fake/snapshots`           | `{}` → JSON string handle                            |
| `POST /_fake/restore`             | `{ snapshot: handle }` → `{ restored: true, epoch }` |
| `DELETE /_fake/snapshots/:handle` | release handle                                       |
| `GET /_fake/clock`                | `{ mode, now, scheduled }`                           |
| `POST /_fake/clock`               | `{ ms }` → advanced clock; manual mode required      |
| `GET /_fake/deliveries`           | the deliveries `getDeliveries()` lists               |
| `POST /_fake/deliveries`          | `{ botId?, timeoutMs? }` → drain deliveries          |

A wait, drain or clock advance that fails answers `{ error }`: 400 for bad input, 408 when the
deadline passes, and 409 when the wait is canceled or the clock is not manual. A snapshot or
restore while the server is busy answers 409, and an unknown handle 404.

**Owner accounts** have their routes under `/_fake/owners`, listed in the
[owner accounts reference][owner-docs].

### Supported Bot API methods

These read or change the server's state:

- **Updates and the bot:** `getMe`, `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`,
  `setMyCommands`, `deleteMyCommands`, `getMyCommands`.
- **Chats and members:** `getChat`, `getChatMember`, `getChatAdministrators`, `getChatMemberCount`,
  `getUserProfilePhotos`, `leaveChat`, `restrictChatMember`, `banChatMember`, `unbanChatMember`,
  `promoteChatMember`, `setChatAdministratorCustomTitle`, `setChatPermissions`, `setChatTitle`,
  `setChatDescription`, `setChatPhoto`, `deleteChatPhoto`.
- **Join requests and invite links:** `approveChatJoinRequest`, `declineChatJoinRequest`,
  `answerChatJoinRequestQuery`, `createChatInviteLink`, `exportChatInviteLink`,
  `editChatInviteLink`, `revokeChatInviteLink`.
- **Sending:** `sendMessage`, `sendPhoto`, `sendDocument`, `sendVideo`, `sendAnimation`,
  `sendSticker`, `sendVoice`, `sendAudio`, `sendVideoNote`, `sendMediaGroup`, `sendLocation`,
  `sendVenue`, `sendContact`, `sendDice`, `sendPoll`, `stopPoll`, `sendChatAction`,
  `forwardMessage`, `copyMessage`, `getFile`.
- **Editing and deleting:** `editMessageText`, `editMessageReplyMarkup`, `editMessageCaption`,
  `editMessageMedia`, `deleteMessage`, `deleteMessages`.
- **Ephemeral messages:** `editEphemeralMessageText`, `editEphemeralMessageCaption`,
  `editEphemeralMessageMedia`, `editEphemeralMessageReplyMarkup`, `deleteEphemeralMessage`.
- **Pins, reactions and buttons:** `pinChatMessage`, `unpinChatMessage`, `unpinAllChatMessages`,
  `setMessageReaction`, `deleteMessageReaction`, `answerCallbackQuery`.
- **Business:** `getBusinessConnection`, and `sendMessage`, `editMessageText` and
  `editMessageReplyMarkup` with `business_connection_id`.

These are not modeled: `setMyDescription`, `setMyShortDescription`, `setChatMenuButton`,
`setMyDefaultAdministratorRights`.

They, any other method not listed, and `editMessageCaption` and `editMessageMedia` with
`business_connection_id` get Telegram's answer to a method it does not know: 404
`Not Found: method not found`, so a test cannot pass against behavior the server does not have.
`getCalls()` (`GET /_fake/calls`) lists the unsupported methods called (the business edits as, for
example, `editMessageCaption with business_connection_id`), and `log` reports each once. With
`unimplemented: "ok"`, an unsupported method that Telegram documents as returning `True` answers
`true` instead; any other still gets the 404. Methods are added when a real bot needs them; the
goal is not full coverage of the Bot API.

Method names are case-insensitive. Parameters come as a query string, JSON, or URL-encoded or
multipart form data, read as Telegram's server reads them: a body of any other type is ignored, a
JSON body keeps the fields read before anything malformed, and only form data that cannot be read
is refused, with an empty 400. A JSON body's values are text, as a query string's are: `null` is
the text `null`, `1.50` stays `1.50`, and a string may hold raw control characters. A parameter
given twice keeps its first value, and the query string comes before the body. How each kind of
parameter is then read is under [Parameters][behavior-parameters].

### Call receipts

`getCalls()` (`GET /_fake/calls`) returns copies, so changing them changes nothing on the server.
`calls` lists every Bot API call made with a known token and a body that could be read.
`rejected_requests` lists the calls refused before that: an unknown token (its numeric part as
`bot_id`; the token itself is not kept) or form data that cannot be read (kept as `raw_body`, and
left out of wait failure reports). `unimplemented` names the unsupported methods called.

Each receipt has `seq` (its place in its list), `method`, `bot_id`, `params`, `at`, `outcome`,
`status`, `completed_at`, and `target_user_id`, the user the call is about (as `userId` in
[failure rules](#injected-failures)), read before the call runs. `params` are the parameters as
Telegram's server reads them: text, with the JSON-serialized ones (`reply_markup`, `media`,
`permissions`, ...) parsed, so a call wait that narrows by `params` gives `chat_id` as text, such
as `"-100123"`.

- `outcome` is `pending`, `succeeded`, `delayed`, `response_lost`, `failed_after_apply`,
  `rejected` or `unimplemented_ok`.
- `applied` is true once the call took effect, or, for a read or a call that changes nothing, once
  it succeeded. It stays true when the call fails after taking effect (`failed_after_apply`).
- A call refused, by Telegram's rules or by a failure rule, is `rejected`, with its status in
  `failed`, and is never `applied`. `response_lost` (with `dropped: true`) means the call took
  effect and its answer never reached the bot.
- A call a failure rule matched carries the rule's `fault_id`, `attempt` and `delay_ms`, and
  `fault_injected` says whether the rule had started failing calls yet.
- `request_id` is unique across both lists, also after a restore. `timeline` holds the stages the
  call reached, with their times: `received` (when the request arrived), `validated`,
  `state_applied` (when a message or member changed), `handler_completed`, then `response_sent`
  (written out, not necessarily read by the bot) or `response_lost`. `completed_at` includes any
  injected delay.

Not every change records `state_applied`, so prove what a call changed with a `message` or `member`
wait, `getMember` or `getMessage`.

## How closely it matches Telegram

The server answers the way Telegram does wherever a bot can tell the difference: who may do what,
which bot gets which update, how text is cleaned and limited, Telegram's own error texts, and the
order in which checks run. The rules come from the Bot API docs and the source of Telegram's Bot
API server and TDLib, and each is covered by a test. Where neither settles a question, the behavior
notes say **Unverified** and name what this server does. It is a tested subset, not a claim that
every edge case or error description is byte for byte identical.

A few points matter in most tests:

- Refusals carry Telegram's error descriptions, such as
  `Bad Request: not enough rights to restrict/unrestrict chat member`, so assert on Telegram's
  text.
- Rights decide who may act and who hears what: a bot needs `can_restrict_members` to ban,
  `can_delete_messages` to delete others' messages, and administrator rights to get `chat_member`.
- A ban deletes no messages; a bot that wants them gone deletes them.
- A bot cannot message a user who has not written to it first (403), except a join requester for
  five minutes.
- Each bot has its own update queue, `update_id`s and `file_id`s.
- Messages, edits and captions are stored as Telegram stores them: formatted text becomes plain
  text with entities, trimmed, at most 4096 characters (1024 for a caption).

[docs/telegram-behavior.md][behavior] lists the rules area by area: members and moderation
(permissions, restrictions, bans, administrators, invite links), bots and chats (access, several
bots, private chats, channels, basic groups, business connections, command menus), messages
(deleting, editing, forwards, pins, polls, reactions, media and files), buttons and ephemeral
messages, text formatting and replies, and request parsing and update delivery.

## What it does not do

- Inline mode, payments, games, sticker sets, reaction counts, options added to a poll after it was
  sent, votes on behalf of a channel (`voter_chat`), or Telegram's exact
  rate limits: `floodControl` applies only its published numbers (a test can also make any call
  fail with a 429 through `POST failures`). Channel signatures are not modeled, and forum topics
  cannot be closed or deleted.
- Updates when a restriction or ban runs out: the member's status changes on time, and no update is
  sent.
- Privacy mode. Every bot in a group gets all its messages, as a bot with privacy mode off does,
  and `getMe` says `can_read_all_group_messages: true`.
- In Telegram Login: the `phone` scope's `phone_number` (test users have no phone numbers), the
  ES256, EdDSA and ES256K signing options (only the default RS256), the redirect URLs registered
  with BotFather (any `redirect_uri` is accepted), the `telegram-login.js` popup and native SDKs,
  and the legacy Login Widget's hash check. Telegram has no UserInfo endpoint, and neither does
  this server.
- Fetching media from HTTP URLs (a URL stands in as a one-byte file), several sizes per photo,
  `sendLivePhoto` and `editMessageLiveLocation`.
- Persistence. All state lives in memory and is lost when the server stops; recovering from a
  restart belongs to the application under test.
- Anything security-related. It is a test tool: bind it to localhost and never expose it to a
  network you do not control.

## Upgrading from 0.10.0

0.11.0 answers as Telegram does in many places where 0.10.0 did not, so a test that relied on the
old behavior can fail. Each item says what changed and how to adapt the test.

One rule covers many of them: compare the fields you need (with `toMatchObject`, for example), not
whole objects. Several objects gained fields: `getChat` has `invite_link` when the bot has
`can_invite_users`, the bot's `ChatMemberAdministrator` has `can_manage_tags`, a `Poll` has
`allows_revoting` and `members_only` and its options `persistent_id`, and `getWebhookInfo` has the
fields below.

- **The default bot is `example_bot`, named "Example Bot"** (was `fake_test_bot`, "Fake Test
  Bot"). Update expected usernames and commands such as `/start@example_bot`, or pass `botUsername`
  and `botName` (`--username` on the command line).
- **Unknown methods answer 404 `Not Found: method not found`**, Telegram's answer, instead of a
  description that named this server. See which methods your bot called in
  `getCalls().unimplemented`. With `unimplemented: "ok"`, only a method documented to return `True`
  answers `true`.
- **Error descriptions are Telegram's.** Update assertions that matched 0.10.0's texts. These are
  the ones tests most often assert; each is `400 Bad Request: ...` unless it says otherwise:
  - A bot never added to the chat: 403 `Forbidden: bot is not a member of the supergroup chat` is
    now `chat not found`, also for reads such as `getChat` and for `leaveChat`.
  - Banning, restricting or unbanning without `can_restrict_members`: `not enough rights` is now
    `not enough rights to restrict/unrestrict chat member`. `setChatPermissions` without it:
    `not enough rights to change chat permissions`.
  - A missing `chat_id`: `chat not found` is now `chat_id is empty`. A missing `user_id`:
    `user not found` is now `invalid user_id specified`.
  - `restrictChatMember` in a basic group: `restrictChatMember requires a supergroup` is now
    `method is available only in supergroups`.
  - `deleteMessages`: `message_ids must be a JSON array` is now
    `expected an Array of message identifiers`, and `message_ids must contain 1-100 identifiers`
    is now `too many message identifiers specified`.
  - `sendMediaGroup` with more than 10 items: `media group must include 2-10 items` is now
    `too many messages to send as an album`.
  - An empty poll question or chat title: `poll question must be non-empty` and
    `chat title can't be empty` are now `text must be non-empty` and `title must be non-empty`.
  - `sendContact` without a phone number: `contact needs phone_number and first_name` is now
    `parameter "phone_number" is required`. `sendLocation` with a bad position:
    `wrong latitude or longitude` is now `invalid location specified`.
- **Ephemeral messages have `message_id` 0** and an `ephemeral_message_id` of their own. A bot
  sends one with `ephemeral_message_parameters: { receiver_user_id }`. It edits or deletes one only
  with the `editEphemeralMessage…` methods and `deleteEphemeralMessage`, which take `chat_id`,
  `receiver_user_id` and `ephemeral_message_id`; the regular methods no longer reach it. A press on
  its button carries `ephemeral_message_id` in `callback_query.message`, so in grammY a button
  handler that removed the message with `ctx.deleteMessage()` now calls
  `ctx.deleteEphemeralMessage()`. In tests, find these messages with
  `getEphemeralMessage(chatId, ephemeralMessageId)`, or a `message` wait by author and text,
  instead of `getMessage`, and press their buttons with `pressEphemeralButton` instead of
  `pressButton`. Test helpers that key messages by `message_id` must use `ephemeral_message_id`
  for them.
- **Ephemeral messages to non-members are refused** (`USER_NOT_PARTICIPANT`), as are those to bots
  (`USER_IS_BOT`) and outside groups (`PEER_ID_INVALID`). Have the receiver join first. A bot that
  is not an administrator gets `CHAT_ADMIN_REQUIRED` unless it passes
  `ephemeral_message_parameters.callback_query_id`: the id of a press on its own button by the
  receiver, from the last 15 seconds.
- **Each pin posts a `pinned_message` service message**, in private chats too. `getMessages` and
  `getDirectMessages` list it, and every bot in the chat receives it, the pinning bot included.
  Find messages by id or text instead of position, and expect one more `message` update per pin.
- **A ban no longer deletes the user's messages**, as on Telegram, even with
  `revoke_messages: true`, which only decides whether the removed user can still see the chat's
  earlier messages. If your bot should remove the messages, it must delete them with
  `deleteMessage` or `deleteMessages`, so it has to keep their ids; tests then see what it deleted.
  A person banned in a basic group is `left`, not `kicked`, and the ban posts `left_chat_member`.
- **Call receipt `params` are text as sent**, such as `chat_id: "-100123"` and `user_id: "42"`.
  Compare with strings (`String(GROUP)`), also in call waits that narrow by `params`.
- **`getWebhookInfo` reports errors.** It now includes `last_error_date` and `last_error_message`,
  `max_connections`, `ip_address`, and the real `pending_update_count`. The last error stays after
  later deliveries succeed, until the next `setWebhook` that changes the webhook, or
  `deleteWebhook`. `allowed_updates` comes back in Telegram's order, not the order the bot gave,
  and is left out when it is the default, so compare it as a set.
- **`update_id` is per bot.** Each bot numbers its own updates, and bots added in the same second
  start at the same number, so two bots often get the same `update_id`. With more than one bot,
  always pass `botId` to `redeliverUpdate` (`bot_id` over HTTP); without it, such a redelivery fails
  with `More than one bot got update N; name one with bot_id`.
- **`chat_member`, `message_reaction` and `chat_join_request` reach only bots with the needed
  rights**: the first two only administrators that list them in `allowed_updates`, the last only
  bots with `can_invite_users`. Give the bot those rights with `setBotMembership` in tests that
  expect these updates. `getChatAdministrators` leaves out other bots unless `return_bots`.
- **Each bot has its own `file_id`s.** Another bot's, or a string that is neither a file id nor an
  HTTP URL (such as `"photo"`), is refused. Send an upload, a file id the same bot received, or a
  URL (any string with a dot). File ids, invite links and business connection ids are random, so do
  not match their format.
- **Channel messages come from the channel** and reach bots as `channel_post` and
  `edited_channel_post` (`sender_chat`, no `from`). `post()` in a channel needs the creator or an
  administrator with `can_post_messages`.
- **Access is checked on every call.** A bot never in a chat gets `chat not found`; one kicked from
  or no longer in a supergroup or channel gets a 403 for every call there, reads included.
  `promoteChatMember` and `unbanChatMember` refuse basic groups, and `restrictChatMember` works only
  in supergroups.
- **Webhooks behave as Telegram's.** A webhook gets a minute to answer (was 10 seconds), and one
  that does not answer 2XX gets the update again instead of losing it. Test actions wait for the
  first attempt, so a webhook that never answers, such as one whose handler threw, holds the action
  for a minute and can time out your test: make your webhook answer even when a handler throws. A
  Bot API call in its answer runs, and updates in different queues go out at once, up to
  `max_connections` ([Webhooks and polling](#webhooks-and-polling)). `setWebhook` refuses URLs and
  secret tokens Telegram refuses and resolves the host name, so use one that resolves, such as
  `127.0.0.1`. A new long poll ends the one before with 409, so run one poller per bot.
- **Text is cleaned and limited.** Text and captions are trimmed and limited to 4096 and 1024
  characters, and text that shows nothing fails; `parse_mode` wins over explicit entities. Members'
  text is trimmed too, and a blank post fails with `MESSAGE_EMPTY`. In members' text, `bot_command`
  is found anywhere, and `hashtag` and `cashtag` are found too. Without a scheme, a domain is a
  link only with a common top-level domain, as Telegram detects it: `example.com` and `shop.xyz`
  are links; `spam.test`, `evil.local` and `package.json` are not. In test posts, use a real
  top-level domain or `http://`.
- **Edits, buttons, reactions and flags follow Telegram's rules.** `editMessageText` needs a text
  message and `editMessageCaption` media; forwards and messages sent with a reply keyboard can't be
  edited. A text-only inline button
  (`can't parse InlineKeyboardButton: Text buttons are not allowed in the inline keyboard`),
  `callback_data` over 64 bytes (`BUTTON_DATA_INVALID`) or a `reply_markup` that is not JSON
  (`can't parse reply keyboard markup JSON object`) is refused, and a press reaches the bot that put
  the keyboard on the message. `setMessageReaction` takes only the emoji Telegram lists
  (`REACTION_INVALID` otherwise), and a custom emoji needs `custom_emoji_id`. A flag inside
  `reply_markup`, `reply_parameters`, `link_preview_options` or `permissions` must be a JSON
  boolean: `true`, not `"true"`.
- **Commands and invite links.** Commands are kept per scope and language. Invite links need
  `can_invite_users` (`not enough rights to manage chat invite link`), and each administrator has
  its own primary link.
- **Bots get more updates.** A bot gets the service messages its own calls post
  (`new_chat_title`, `new_chat_photo`, `delete_chat_photo`, `pinned_message`), and `stopPoll` sends
  the closed poll as a `poll` update. Bot API calls answer without waiting for the updates they
  cause.
- **Pins.** `getChat`'s `pinned_message` is the most recent pin by sending date, not the last one
  pinned, and `unpinChatMessage` with nothing pinned fails with `message to unpin not found`.
- **Some refusals are gone.** `sendMediaGroup` with one item sends an ordinary message, a poll may
  have one option, and `reply_parameters.chat_id` replies to another chat; all were refused. The
  current chat title set again succeeds, and a longer title or description is cut instead of
  refused. A bot may message a join requester for five minutes. A business send without
  `can_reply` is a 400, not a 403.
- **Injected failures.** A rule's default description follows its code (`Forbidden` for 403, and
  so on). `failNext` rejects a 429 rule without `retryAfter`, with
  `a 429 failure needs a retry_after`; add `retryAfter: 1`.
- **HTTP control errors.** A failed HTTP wait, drain or clock advance answers `{ error }` with 400,
  408 or 409 instead of a 500.

## Changes

- **0.11.0**: the server answers as Telegram does wherever 0.10.0 did not, checked against the Bot
  API docs and the source of Telegram's Bot API server and TDLib: channel posts, who receives which
  update, webhook retries and concurrency, per-bot updates and file ids, ephemeral messages, invite
  links, text cleaning and limits, entity detection, inline keyboards, command scopes, polls, pins,
  reactions, media, and Telegram's own error texts and order of checks.
  - New: the `floodControl` option (off by default), the `editEphemeralMessage…` and
    `deleteEphemeralMessage` methods, and the `pinMessage`, `getEphemeralMessage` and
    `pressEphemeralButton` test actions.
  - New: members vote in polls (`vote`, `voteDirect`), and the bot that sent a poll gets `poll` and
    `poll_answer` updates; members post polls of their own; direct messages to the bot carry
    photos, other media, captions, replies, forwards and polls, not only text. A channel takes
    anonymous polls only.
  - The default bot is now `example_bot` ("Example Bot").
  - Tests written for 0.10.0 may need changes: see
    [Upgrading from 0.10.0](#upgrading-from-0100).
- **0.10.0**: exact event-driven waits, fixture snapshots/restoration, a manual clock per server,
  delivery drains/journals, request timelines, detached request evidence, callback ownership
  protection and lazy login key generation. `setMyDescription`, `setMyShortDescription`,
  `setChatMenuButton` and `setMyDefaultAdministratorRights`, which stored nothing, get the
  unsupported-method error unless `unimplemented: "ok"`. `setChatPermissions` needs a group or
  supergroup and `can_restrict_members`, so fixtures whose bot changed default permissions without
  that right must give it. Receipts record state changes before webhook delivery completes. Owner
  receipts keep `pending` and `cancelled` outcomes and the server's time. Call waits avoid scanning
  unrelated history; large journals restore without argument-limit failures. Unauthorized and
  unreadable requests go to `rejected_requests`, so `calls` counts as in 0.9.x.
- **0.9.2**: plain stored text and validated UTF-16 entities, HTML/Markdown formatting, preserved
  original requests, and file/reply metadata.
- **0.9.1**: scoped ban message revocation, moderation/join/bulk-delete permission checks, finite
  restriction expiry, exact user/message/attempt faults, delayed responses and truthful
  execution/transport receipts. Owner-account behavior is unchanged.
- **0.9.0**: owner accounts: `createOwnerClient`, a test stand-in for the GramJS `TelegramClient`
  subset an app uses on a user's own account (dialogs, folders, history, dialog filters), with owner
  controls, paging, delays and failures, and a calls ledger. The Bot API side is unchanged: existing
  tests and imports keep working, and the new exports are additions.
- **0.8.1**: describes the package as a local test server.
- **0.8.0**: Telegram Login (OpenID Connect): discovery, keys, the login page, the token endpoint,
  signed ID tokens, a login client secret per bot, and `approveLogin` / `cancelLogin` for tests
  without a browser.
- **0.7.0**: adding the bot through a `startgroup` link, basic groups and their upgrade to a
  supergroup, people renaming the chat and changing its photo, and a bot's own `new_chat_members`
  and `left_chat_member` messages. Tests now cover `getChatMemberCount` following joins and leaves,
  and `leaveChat` sending `my_chat_member`.
- **0.6.0**: business connections and business chats (`business_connection`, `business_message`,
  `sendMessage` with `business_connection_id`, `getBusinessConnection`), `is_bot` and `is_premium`
  on test users, `can_connect_to_business` on `getMe`, and update redelivery.
- **0.5.0**: members post videos, voice notes, stickers, documents and other media, albums and
  forwards, edit their messages and react; `sendMediaGroup`, `sendVoice`, `sendAudio`,
  `sendVideoNote`, `sendLocation`, `sendVenue`, `sendContact`, `sendDice`, `sendChatAction`,
  `promoteChatMember`, `setChatAdministratorCustomTitle`, chat title, description and photo,
  `editChatInviteLink`, `setMessageReaction`, `deleteMessageReaction` and
  `answerChatJoinRequestQuery`; the command-line flags are documented.
- **0.4.0**: more than one bot, chats and forum topics created during a run, bot membership and
  administrator rights, `sendPoll`, `stopPoll`, `forwardMessage`, `copyMessage`, `editMessageMedia`,
  real pin state, and failures a test asks for.

## Development

```sh
pnpm install
pnpm test
```

`npm run bench`, `node bench/reuse.mjs` and `node --expose-gc bench/scaling.mjs` measure the server.
The scaling benchmark accepts `BENCH_HISTORY`, `BENCH_MESSAGES`, `BENCH_OBSERVERS` and
`BENCH_ROUNDS` for larger runs; a small sample is not a throughput guarantee. The
[measurements and regression record][performance] has the commands, raw samples and observed
costs.

## Status

This is an early-stage project with a deliberately small scope, and the public API may still change.
Pin an exact version:

```sh
pnpm add -D --save-exact telegram-bot-test-server@0.11.0
# or: npm install --save-dev --save-exact telegram-bot-test-server@0.11.0
```

## License

MIT

[behavior]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md
[behavior-bots]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#more-than-one-bot
[behavior-channels]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#channels
[behavior-delivery]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#update-delivery
[behavior-join-queries]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#join-request-queries-bot-api-10x
[behavior-parameters]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#parameters
[behavior-upgrade]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/telegram-behavior.md#basic-groups-and-the-upgrade
[owner-docs]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/owner-accounts.md
[performance]: https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/performance.md
