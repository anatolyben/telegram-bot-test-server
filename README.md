# telegram-bot-test-server

`telegram-bot-test-server` is a local test server for the Telegram Bot API, for testing bots that
manage groups. It keeps everything in memory.

Point your bot's Bot API base URL at it instead of `https://api.telegram.org`. It answers the way
Telegram does and keeps the state a group bot depends on: members and their status, restrictions and
bans, messages and deletions, invite links, join requests and profile photos. Your test plays the
other side: users join, leave, post, ask to join, press buttons and message the bot, and the server
sends your bot the same updates Telegram would, by webhook or through `getUpdates` polling.

Nothing here talks to Telegram, so tests need no real accounts, phone numbers or groups, and can run
as often as they like in CI.

The project is intentionally narrow and early-stage.

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
bot.start();

// Telegram's side, played by the test.
const ann = await server.createUser({ first_name: "Ann" });
await server.join(GROUP, ann);
const spam = await server.post(GROUP, ann, "cheap followers at example.com");

// Then check what the bot did. It runs asynchronously, so wait for the result:
// with Vitest, `await expect.poll(async () => (await server.getMember(GROUP, ann)).status).toBe("kicked")`.
(await server.getMember(GROUP, ann)).status; // "kicked"
(await server.getMessage(GROUP, spam)).deleted; // true

await bot.stop();
await server.stop();
```

The same works with other libraries; only the base URL option differs:

| Library       | Point it at the server                                                  |
| ------------- | ----------------------------------------------------------------------- |
| grammY        | `new Bot(token, { client: { apiRoot: server.origin } })`                |
| Telegraf      | `new Telegraf(token, { telegram: { apiRoot: server.origin } })`         |
| Anything else | Replace `https://api.telegram.org` with `server.origin` in its settings |

Both grammY and Telegraf are tested against the server, with polling and with a webhook.

## Test actions

`startTestServer()` returns the server with these actions. Each resolves once the update it causes
has been handed to the bot (sent to its webhook, or queued for `getUpdates`); what the bot does in
response happens after that, so wait for the outcome rather than checking it immediately.

| Action                                                                                                                                | What happens                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createUser({ first_name, last_name, username, language_code, bio, is_bot, is_premium })`                                             | A new Telegram user; returns their id. All fields optional.                                                                                                                 |
| `connectBusiness({ ownerId, rights, id, isEnabled, botId })`                                                                          | The owner connects a bot to their business account, or changes the connection with `id`; the bot gets `business_connection`. Returns `{ connection, update_id }`.           |
| `getBusinessConnection(connectionId)`                                                                                                 | The `BusinessConnection`.                                                                                                                                                   |
| `sayInBusinessChat(connectionId, userId, sender, text)`                                                                               | `"person"` writes to the owner, or `"owner"` answers by hand; the bot gets `business_message`. Returns `{ message_id, date, update_id }`.                                   |
| `getBusinessChat(connectionId, userId)`                                                                                               | The business chat, newest first: `[{ direction: "inbound" \| "owner" \| "bot", deleted, message }]`.                                                                        |
| `redeliverUpdate(updateId)`                                                                                                           | Telegram delivers that update again, byte for byte, to the same bot's webhook.                                                                                              |
| `updateProfile(userId, fields)`                                                                                                       | The user changes their name, username or bio.                                                                                                                               |
| `addProfilePhoto(userId, bytes)`                                                                                                      | The user adds a profile photo.                                                                                                                                              |
| `join(chatId, userId)`                                                                                                                | The user joins the group.                                                                                                                                                   |
| `joinByLink(inviteLink, userId)`                                                                                                      | The user opens an invite link: joins, or files a join request if the link requires approval.                                                                                |
| `leave(chatId, userId)`                                                                                                               | The user leaves.                                                                                                                                                            |
| `post(chatId, userId, text)`                                                                                                          | The user posts a message; returns its `message_id`. Also takes `{ text, photo, media, caption, replyTo, threadId, forwardFrom }`. Fails if the user is not allowed to post. |
| `postAlbum(chatId, userId, items)`                                                                                                    | The user posts 2 to 10 photos or videos as one album (`media_group_id`).                                                                                                    |
| `editMessage(chatId, messageId, userId, { text, caption })`                                                                           | The author edits their message; bots get `edited_message`.                                                                                                                  |
| `react(chatId, messageId, userId, emoji)`                                                                                             | The user reacts to a message, or takes the reaction back with `null`.                                                                                                       |
| `pressButton(chatId, messageId, userId, data)`                                                                                        | The user presses an inline button; resolves with the bot's `answerCallbackQuery` answer.                                                                                    |
| `postGuestBotReply(chatId, userId, botUsername, text)`                                                                                | The user calls a guest bot (Bot API 10.0 guest mode); its answer appears in the group from that bot, with `guest_bot_caller_user` set.                                      |
| `sendDirectMessage(userId, text)`                                                                                                     | The user messages the bot privately.                                                                                                                                        |
| `pressDirectButton(userId, messageId, data)`                                                                                          | The user presses a button in their private chat with the bot.                                                                                                               |
| `getMessages(chatId)`, `getMessage(chatId, id)`                                                                                       | The chat's messages, and whether one was deleted.                                                                                                                           |
| `getDirectMessages(userId)`                                                                                                           | The private chat between the user and the bot.                                                                                                                              |
| `getMember(chatId, userId)`                                                                                                           | The member as `getChatMember` returns them to the first bot: status, restrictions, ban.                                                                                     |
| `getJoinRequests(chatId)`                                                                                                             | User ids waiting for approval.                                                                                                                                              |
| `addBot({ token, username, firstName, loginClientSecret })`                                                                           | Another bot, with its own webhook or update queue; it is in no chat yet.                                                                                                    |
| `approveLogin(authUrl, userId)`                                                                                                       | The user logs in on the Telegram Login page for that `/auth` URL; returns the `redirect_uri` URL with `code` and `state`.                                                   |
| `cancelLogin(authUrl)`                                                                                                                | The user cancels; returns the `redirect_uri` URL with `error=access_denied` and `state`.                                                                                    |
| `createChat({ ownerId, title, type, ownerName, isForum })`                                                                            | A new supergroup, forum (`isForum`), basic group (`type: "group"`) or channel (`type: "channel"`) with no bot in it; returns its id.                                        |
| `addBotViaLink(chatId, botId, { by, startParameter, rights })`                                                                        | A person adds the bot through its `startgroup` link: it joins (as an administrator with `rights`), then `/start@<bot> <startParameter>` is posted from the person.          |
| `migrateToSupergroup(chatId, { by })`                                                                                                 | The creator or an administrator upgrades a basic group; returns the supergroup's id.                                                                                        |
| `renameChat(chatId, { by, title })`, `changeChatPhoto(chatId, { by, bytes })`                                                         | A person with `can_change_info` renames the chat or sets its photo.                                                                                                         |
| `setBotMembership(chatId, botId, { status, rights, by })`                                                                             | The owner adds, promotes, demotes or removes a bot; the bot gets `my_chat_member`.                                                                                          |
| `createTopic(chatId, name)`, `renameTopic(chatId, threadId, name)`                                                                    | A forum topic is created or renamed, with Telegram's service message; `createTopic` returns its `message_thread_id`.                                                        |
| `getChat(chatId)`                                                                                                                     | The chat, its pinned message ids and its members.                                                                                                                           |
| `failNext({ method, chatId, botId, userId, messageId, attempt, times, errorCode, description, retryAfter, dropAfterApply, delayMs })` | The next matching Bot API calls fail with that error, or (`dropAfterApply`) take effect and never answer.                                                                   |
| `clearFailures()`                                                                                                                     | Drop failure rules not used up.                                                                                                                                             |
| `getCalls()`                                                                                                                          | Every Bot API call received, with the bot that made it, and any unsupported methods called.                                                                                 |
| `stop()`                                                                                                                              | Shut the server down.                                                                                                                                                       |

## Use from any language

```sh
npx telegram-bot-test-server --token 123456:TEST --port 8081 --config chats.json
```

| Flag                 | Default         | Meaning                                                   |
| -------------------- | --------------- | --------------------------------------------------------- |
| `--token`            | required        | The bot's token.                                          |
| `--port`, `--host`   | 8081, 127.0.0.1 | Where to listen.                                          |
| `--username`         | `fake_test_bot` | The bot's username.                                       |
| `--config`           | none            | A JSON file with `chats` and `publicChats`.               |
| `--unimplemented-ok` | off             | Answer `true` to unsupported methods instead of an error. |

`chats.json` holds `{ "chats": [...], "publicChats": [...] }` in the same shape as the options
below. Point your bot's Bot API base URL at `http://127.0.0.1:8081` and drive the same test actions
over HTTP through the control API described below, from Python, Go or anything else.

## Options

| Option                       | Default          | Meaning                                                                                      |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `botToken`                   | required         | `<numeric id>:<secret>`. Calls with any other token get 401.                                 |
| `port`, `host`               | `0`, `127.0.0.1` | Where to listen. Port 0 picks a free port.                                                   |
| `botUsername`                | `fake_test_bot`  | Returned by `getMe`.                                                                         |
| `botName`                    | `Fake Test Bot`  | Returned by `getMe`.                                                                         |
| `supportsJoinRequestQueries` | `false`          | A guard bot: join requests reach it with a `query_id` to answer.                             |
| `loginClientSecret`          | random           | The first bot's Telegram Login client secret.                                                |
| `chats`                      | `[]`             | Supergroups `{ id, title, ownerId, ownerName? }`. The bot is an administrator.               |
| `publicChats`                | `[]`             | Channels, groups and bots `{ username, type, title? }` resolvable by `getChat("@username")`. |
| `unimplemented`              | `"error"`        | What an unsupported method returns: a 404 error naming it, or `"ok"` for `true`.             |
| `log`                        | none             | Receives one line per notable event (unsupported methods, webhook failures).                 |

## Supported Bot API methods

These read or change the server's state:

`getMe`, `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`, `getChat`, `getChatMember`,
`getChatAdministrators`, `getChatMemberCount`, `getUserProfilePhotos`, `getFile`, `sendMessage`,
`sendPhoto`, `sendDocument`, `sendVideo`, `sendAnimation`, `sendSticker`, `sendPoll`, `stopPoll`,
`forwardMessage`, `copyMessage`, `editMessageText`, `editMessageReplyMarkup`, `editMessageCaption`,
`editMessageMedia`, `pinChatMessage`, `unpinChatMessage`, `unpinAllChatMessages`, `leaveChat`,
`deleteMessage`, `deleteMessages`, `sendVoice`, `sendAudio`, `sendVideoNote`, `sendMediaGroup`,
`sendLocation`, `sendVenue`, `sendContact`, `sendDice`, `sendChatAction`, `setMessageReaction`,
`deleteMessageReaction`, `restrictChatMember`, `banChatMember`, `unbanChatMember`,
`promoteChatMember`, `setChatAdministratorCustomTitle`, `setChatPermissions`, `setChatTitle`,
`setChatDescription`, `setChatPhoto`, `deleteChatPhoto`, `approveChatJoinRequest`,
`declineChatJoinRequest`, `answerChatJoinRequestQuery`, `createChatInviteLink`,
`exportChatInviteLink`, `editChatInviteLink`, `revokeChatInviteLink`, `answerCallbackQuery`,
`setMyCommands`, `deleteMyCommands`, `getMyCommands`, `getBusinessConnection`, and `sendMessage`
with `business_connection_id`.

These are not modelled: `setMyDescription`, `setMyShortDescription`,
`setChatMenuButton`, `setMyDefaultAdministratorRights`. In strict mode they return
an explicit unsupported-method error.

Any other method returns a 404 error that names it, so a test cannot pass against behaviour the
server does not have. Methods are added when a real bot needs them; the goal is not full coverage of
the Bot API. Method names are case-insensitive, and parameters are accepted as a query string, JSON
or multipart form data, as with Telegram.

## Behaves like Telegram

The details a moderation bot depends on, each covered by a test:

- **Permissions.** Unspecified permissions are false, except that `can_manage_topics` and
  `can_edit_tag` follow `can_pin_messages`, and `can_react_to_messages` follows `can_send_messages`
  as passed. Then, unless `use_independent_chat_permissions` is set, broader permissions imply
  narrower ones (`can_send_other_messages` implies media and text, `can_send_polls` implies text).
  A member needs both their own permission and the chat's default from `setChatPermissions` to post;
  a photo needs `can_send_photos`, not only `can_send_messages`. `getChat` returns the default
  `permissions` for groups and supergroups, not for channels.
- **Restrictions stick.** A restricted user who leaves and rejoins is still restricted.
- **Protected members.** Restricting or banning the chat owner, an administrator or the bot itself
  fails with Telegram's error.
- **Unbanning.** `unbanChatMember` without `only_if_banned` removes a current member, as the docs
  guarantee.
- **Editing.** Only the bot's own messages can be edited; an edit that changes nothing fails with
  `message is not modified`; an edit without `reply_markup` removes the inline keyboard, after which
  its buttons can no longer be pressed.
- **Private chats.** The bot cannot message a user who has not written to it first (403). The
  exception is a join request: a bot that receives it may message its `user_chat_id` for five
  minutes, until the request is approved or declined, as
  [ChatJoinRequest](https://core.telegram.org/bots/api#chatjoinrequest) documents. The five
  minutes follow the server's clock, so `advanceTime` can end them.
- **Ephemeral messages.** A send with `ephemeral_message_parameters` (Bot API 10.2) returns a message
  with `receiver_user` and `ephemeral_message_id`. Unlike Telegram, which gives it `message_id` 0, it
  keeps an ordinary message id, so tests can find it in the chat and press its buttons. The
  `editEphemeralMessage…` and `deleteEphemeralMessage` methods are not modelled.
- **Callback queries.** Answering a query that was never sent fails.
- **Invite links.** Exporting a new primary link revokes the previous one; joining through a
  revoked link fails.
- **Entities.** Member messages and captions carry `bot_command`, `mention`, `email` and `url`
  entities with UTF-16 offsets, in groups and in private chats.
- **Media.** Sent photos, documents, videos, animations and stickers carry the fields the Bot API
  requires and resolve through `getFile`. `editMessageMedia` replaces a message's media with an
  upload (`attach://`) or a held `file_id`.
- **More than one bot.** Each bot has its own webhook or update queue and its own membership and
  rights in each chat. A bot posts only where it is a member (a channel needs `can_post_messages`),
  edits and stops only its own messages and polls, pins only with `can_pin_messages` (a channel's
  `can_edit_messages`), and deletes others' messages only with `can_delete_messages`. A bot hears
  of its own status changing as `my_chat_member`, whether the owner or another bot changed it; the
  chat's administrator bots hear of it as `chat_member`. `can_be_edited` is true only for the bot
  that promoted that administrator, and `getChatAdministrators` leaves out other bots unless
  `return_bots` is set. Only the bot that sent a message hears its buttons pressed.
  Users write privately only to the first bot, so no other bot can message them (403).
- **Which chats a bot may use.** Checked before any method runs, as Telegram's Bot API server
  does. A chat the bot was never in is `400 Bad Request: chat not found`. A bot kicked from a
  supergroup or channel gets `403 Forbidden: bot was kicked from the supergroup chat` (or
  `channel chat`) for every call, reads like `getChat` included, and one that left or was removed
  gets `403 Forbidden: bot is not a member of the supergroup chat`. In a basic group, a bot that
  left or was removed can still call `getChat`, `leaveChat` and `getChatMember` about itself; every
  other call gets the `group chat` form of the same errors.
- **Polls.** `sendPoll` needs a question and 2 to 12 options and keeps `is_anonymous`,
  `allows_multiple_answers`, `description` and an attached photo; `stopPoll` closes a poll once.
- **Forwards and copies.** A forward carries `forward_origin`; a copy does not. A bot cannot forward
  from a chat it is not in; the source chat gets the same checks as above.
- **Pins.** Pinned messages are kept, newest first, and `getChat` returns the latest as
  `pinned_message`.
- **What members send.** Besides text and photos, members post videos, animations (which carry a
  `document` too), stickers, voice notes, audio, video notes and documents, each needing its own
  permission (`can_send_videos`, `can_send_voice_notes`, ...), plus albums sharing a
  `media_group_id` and forwards with `forward_origin` (a user, a hidden user or a channel post).
  An edit by the author reaches bots as `edited_message` with `edit_date`.
- **Reactions.** A member's reaction reaches the chat's administrator bots as `message_reaction`,
  only when they list it in `allowed_updates`, as on Telegram. A bot sets at most one reaction, and
  removes a member's with `deleteMessageReaction` and `can_delete_messages`.
- **Administrators and chat settings.** `promoteChatMember` needs `can_promote_members` and grants
  only rights the bot holds; any one right makes an administrator, `can_send_welcome_messages`,
  `can_manage_tags` and `can_manage_direct_messages` included, and a channel promotion grants
  `can_restrict_members` unless the call says otherwise. The bot can then edit and title the
  administrators it promoted. An administrator carries the rights its kind of chat has, as
  Telegram writes them: `can_post_messages`, `can_edit_messages` and `can_manage_direct_messages`
  in channels, `can_pin_messages` and `can_manage_tags` in groups, and `can_manage_topics` in
  supergroups.
  `setChatTitle`, `setChatDescription`, `setChatPhoto` and `deleteChatPhoto` need `can_change_info`,
  refuse a change that changes nothing, and post Telegram's service messages.
- **Join request queries (Bot API 10.x).** A guard bot (`supportsJoinRequestQueries`) gets each join
  request with a `query_id`, which it answers with `answerChatJoinRequestQuery`
  (`chat_join_request_query_id`, `result`: `approve`, `decline` or `queue`, in any case).
- **Business connections** ([Bot API](https://core.telegram.org/bots/api#businessconnection),
  [connected business bots](https://core.telegram.org/api/bots/connected-business-bots)). An owner
  connects the bot to their account; the bot gets `business_connection` on every change, and
  `business_message` for each message in the owner's private chats while the connection is enabled,
  from the person or from the owner answering by hand. `sendMessage` with `business_connection_id`
  answers as the owner, with `sender_business_bot` set. It needs an enabled connection, `can_reply`,
  and a message from the person in the last 24 hours (`BUSINESS_PEER_USAGE_MISSING` otherwise, as
  [documented](https://core.telegram.org/method/messages.sendMessage)). An unknown connection is
  `BUSINESS_CONNECTION_INVALID`. Unverified: the error for a disabled connection (treated as
  invalid) and for a missing `can_reply` (`403 BOT_ACCESS_FORBIDDEN`). The connected bot may also
  message the owner's private chat (`user_chat_id`). `getMe` reports `can_connect_to_business`.
- **Redelivery.** A test can have Telegram deliver any update again, byte for byte, as it does when a
  webhook does not confirm one.
- **Adding the bot through a link** ([links](https://core.telegram.org/api/links#group-channel-bot-links),
  [deep linking](https://core.telegram.org/bots/features#deep-linking)). With admin rights
  requested, only the creator or an administrator with `can_promote_members` may add it; without,
  anyone who can add members (`can_invite_users`). Otherwise the person gets `CHAT_ADMIN_REQUIRED`.
  The bot gets `my_chat_member` from the person, the chat's administrator bots `chat_member`, all bots the
  `new_chat_members` message, and then the person's `/start@<bot> <parameter>` with a
  `bot_command` entity, as `messages.startBot` posts. An administrator's existing rights are
  combined with the requested ones, and `/start` is still posted. Unverified: Telegram does not
  document whether `my_chat_member` or the `/start` message arrives first; this server sends
  `my_chat_member` first.
- **Service messages about the bot itself.** A bot gets the `new_chat_members` and
  `left_chat_member` messages that name it, as the
  [Message](https://core.telegram.org/bots/api#message) fields say it "may be the bot itself".
- **Basic groups and the upgrade** ([migration](https://core.telegram.org/api/channel#migration)).
  A basic group has a negative id without the `-100` prefix. The creator or an administrator can
  upgrade it: a new supergroup takes its members, administrators and bots, the old chat posts
  `migrate_to_chat_id` and the new one `migrate_from_chat_id`. Later Bot API calls to the old id
  fail with `400 Bad Request: group chat was upgraded to a supergroup chat` and
  `parameters.migrate_to_chat_id` ([ResponseParameters](https://core.telegram.org/bots/api#responseparameters)),
  except two: `getChat` still returns the old group, and `leaveChat` fails with
  `400 Bad Request: chat is deactivated`. Unverified: Telegram's server raises the upgrade error
  only for calls that write or read the member list, and what its other reads of the old id
  (`getChatMember` about the bot itself, `setMessageReaction`, edits) answer is not documented, so
  this server keeps the upgrade error for them. Also unverified: whether bots get
  `my_chat_member` on the upgrade; this server sends none.
- **People changing the chat.** A person with `can_change_info` renames the chat or sets its photo,
  with the same `new_chat_title` and `new_chat_photo` service messages as `setChatTitle` and
  `setChatPhoto`; `getChat` returns the title and a `ChatPhoto`, and `getFile` serves the photo.
- **Forum topics.** In a forum, a send to a `message_thread_id` that is not a topic fails with
  `message thread not found`. A member's message in a topic that answers nothing replies to the
  topic's creation message, as on Telegram.

### Telegram Login (OpenID Connect)

The server also answers at oauth.telegram.org's paths, so an app logs in against it by changing only
the origin: `GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json`, `GET /auth` (a
page with a "Log in as ..." button per test user, and Cancel) and `POST /token`. It follows
[Telegram's docs](https://core.telegram.org/bots/telegram-login) and its
[discovery document](https://oauth.telegram.org/.well-known/openid-configuration):

- The client id is the bot id and each bot has a client secret. `/token` takes it by HTTP Basic, as
  the docs show, or in the form (`client_secret_post`, which the discovery document lists).
- `/auth` needs `response_type=code` and the `openid` scope. PKCE is recommended, not required, with
  `S256` or `plain`, as the discovery document lists. An unknown `client_id`, a bad
  `response_type`, a missing `openid` or a bad challenge method gets a 400 page, never a redirect.
- A code works once, only with the same `redirect_uri`, and only with a `code_verifier` that
  matches its challenge; otherwise `/token` answers `invalid_grant`, and a wrong secret
  `invalid_client` (401). Codes expire after 60 seconds (unverified: Telegram does not document
  how long).
- The ID token is signed RS256 with the published key and names it in `kid`. It has `iss`
  (`https://oauth.telegram.org`), `aud` (the bot id), `sub`, `iat`, `exp` (an hour later, as
  `expires_in: 3600` says) and `nonce` when the app sent one. `sub` is an opaque id that stays the
  same for a user, not their Telegram id, as in Telegram's example. The `profile` scope adds `id`,
  `name`, `given_name`, `family_name`, `preferred_username` and `picture` (served by this server).
- `telegram:bot_access` lets the bot message the user afterwards, as documented.

## Owner accounts (GramJS)

Some apps also read a user's **own** Telegram account through GramJS (MTProto): their dialog list,
folders and history. The owner client stands in for GramJS's `TelegramClient` for exactly the calls
below, answering from owner state a test seeds on the server. It is **not** MTProto: there is no wire
protocol, encryption, phone login or real session, and it never contacts Telegram. Never give it,
or a test built on it, a real phone number, session string or API hash.

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
```

### Putting it in place of GramJS

The client answers over HTTP, so a test process and an app process can share one server. In the
app's tests, construct `createOwnerClient({ origin, userId })` where the app would construct its
`TelegramClient`, for example by giving the app's lifecycle a subclass of its MTProto adapter whose
start-up assigns the owner client (and `ownerApi` as the request namespace) instead of connecting to
Telegram. Everything above that point (routes, authentication, cursors, normalization and error
mapping) stays the app's real code. Production code needs no change.

### The client

| Method                                                                                    | Answers                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`, `disconnect()`, `destroy()`                                                  | Before `connect()` and after `disconnect()`, every call fails with GramJS's "Cannot send requests while disconnected".                                                                                                                                               |
| `isUserAuthorized()`                                                                      | `false` after `updateOwner(id, { authorized: false })`; calls then fail with `AUTH_KEY_UNREGISTERED` (401).                                                                                                                                                          |
| `getMe()`                                                                                 | The owner as a `User` with `self: true`.                                                                                                                                                                                                                             |
| `getEntity(peer)`, `getInputEntity(peer)`                                                 | A peer id (number or string), `"me"`, a `@username`, or a GramJS entity/peer object, as a `User`, `Chat` or `Channel` / `InputPeerUser`, `InputPeerChat`, `InputPeerChannel` or `InputPeerSelf`. Unknown peers fail with GramJS's "Could not find the input entity". |
| `getDialogs({ folder, archived, limit, ignorePinned, offsetDate, offsetId, offsetPeer })` | GramJS `Dialog` shapes: `id`, `entity`, `inputEntity`, `name`/`title`, `date`, `message`, `pinned`, `folderId`/`archived`, `unreadCount`, `isUser`/`isGroup`/`isChannel`, and the raw `dialog` with `notifySettings.muteUntil`. The array has a `total`.             |
| `getMessages(entity, { limit, offsetId, ids })`                                           | `Message` / `MessageService` shapes: `id`, `message`/`rawText`/`text`, `date`, `editDate`, `out`, `fromId`, `senderId`, `sender`, `peerId`, `chatId`, `chat`, `replyTo`/`replyToMsgId`, `media`, `action`. The array has a `total`.                                  |
| `invoke(new ownerApi.messages.GetDialogFilters({}))`                                      | `messages.DialogFilters` with `DialogFilterDefault` and `DialogFilter`s (`title` as `TextWithEntities`, `emoticon`, flags, include/exclude/pinned `InputPeer`s) in their order. GramJS's own `Api.messages.GetDialogFilters` request works too.                      |
| `markAsRead()`, `sendMessage()`                                                           | Reserved: they reject with code `OWNER_CLIENT_NOT_MODELLED`.                                                                                                                                                                                                         |

Anything else fails loudly and never answers a generic success: another client method (code
`OWNER_CLIENT_UNSUPPORTED`), another `invoke` request, or a `getDialogs`/`getMessages` option not
listed above (`filter`, `search`, `minId`, ...).

Peer ids follow the Bot API's: a user's id, `-<id>` for a basic group, `-100<id>` for a supergroup or
channel. Entities carry the raw id, as GramJS's do. Ids are plain numbers; GramJS uses big-integer
objects, which give the same `String()` and `Number()`. The client accepts GramJS peer objects whose
ids are big-integer objects or native `BigInt`.

### Order and paging

- **Folders.** `folder: 0` (or none) is the main list, `folder: 1` the archive; `archived: true` means
  folder 1, as in GramJS.
- **Dialogs** are newest first by their newest message's date, then its id, then the peer id, so equal
  timestamps still have one order. Pinned dialogs lead the **first** page only, most recently pinned
  first. A page with `offsetDate`/`offsetId`/`offsetPeer` continues strictly after that position,
  never repeating it, and never includes pinned dialogs; `ignorePinned` leaves them out of a first
  page too. An offset whose dialog has since moved or been deleted still resumes after its
  position.
- **History** is newest first by message id. `offsetId` returns messages strictly older than it.
  Deleted messages are skipped. `ids` returns the messages in the order asked, with `undefined` for
  a missing or deleted one, as GramJS does. No `limit` returns everything.
- The server owns only these provider semantics; any cursor an app builds on top stays the app's.

### Owner test actions

| Action                                                                                                                                                | What happens                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createOwner({ userId, firstName, lastName, username })`                                                                                              | An owner account; returns `{ id }`.                                                                                                                    |
| `updateOwner(ownerId, { authorized })`                                                                                                                | Revoke or restore the owner's authorization.                                                                                                           |
| `getOwner(ownerId)`                                                                                                                                   | The owner's dialogs (`id`, `kind`, `folder`, `pinned`, `mute_until`, `unread_count`, message count) and filter order.                                  |
| `addOwnerUser(ownerId, { id, firstName, lastName, username, bot })`                                                                                   | Someone who can send in the owner's groups; returns `{ id }`.                                                                                          |
| `addOwnerDialog(ownerId, { kind, id, title, firstName, lastName, username, participantsCount, folder, pinned, muted, muteUntil, unreadCount, date })` | A `private`, `bot`, `group`, `supergroup` or `channel` conversation; returns `{ id }`, its peer id.                                                    |
| `updateOwnerDialog(ownerId, peerId, { folder, pinned, muted, muteUntil, unreadCount })`                                                               | Move between main and archive, pin, mute, set the unread count.                                                                                        |
| `addOwnerMessages(ownerId, peerId, [{ id, date, fromId, out, text, action, replyTo, media, editDate }])`                                              | Messages with explicit ids and times; `action` makes a service message; `media` is `{ type: "photo" \| "document", id, fileName?, mimeType?, size? }`. |
| `editOwnerMessage(ownerId, peerId, messageId, { text, editDate })`, `deleteOwnerMessage(ownerId, peerId, messageId)`                                  | Edit or delete a message.                                                                                                                              |
| `setOwnerFilter(ownerId, { id, title, emoticon, includePeers, excludePeers, pinnedPeers, contacts, groups, ... })`                                    | Create or change a custom filter (id 2 or more).                                                                                                       |
| `orderOwnerFilters(ownerId, ids)`, `deleteOwnerFilter(ownerId, id)`                                                                                   | Reorder (every id once, `0` for the default) or delete.                                                                                                |
| `failOwnerCall(ownerId, { method, peerId, times, delayMs, preset, seconds, errorMessage, code })`                                                     | Delay or fail the next matching calls (below).                                                                                                         |
| `clearOwnerFaults(ownerId)`, `getOwnerCalls(ownerId)`                                                                                                 | Drop pending faults; every call the owner client made.                                                                                                 |
| `resetOwners()`                                                                                                                                       | Remove every owner, without restarting the server.                                                                                                     |

Every owner is separate: two owners may use the same peer and message ids and keep their own
folders, pins, unread counts, history, filters, faults and calls. No action or route shows one
owner's state under another.

The same actions over HTTP, under `/_fake/owners` (snake_case bodies):

| Route                                                            | Effect                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST owners`                                                    | `{ user_id?, first_name, last_name?, username? }` → `{ id }`.                                                                                 |
| `GET owners/:id`, `POST owners/:id`, `DELETE owners/:id`         | The owner's state; `{ authorized }`; remove the owner.                                                                                        |
| `DELETE owners`                                                  | Remove every owner.                                                                                                                           |
| `POST owners/:id/users`                                          | `{ id?, first_name, last_name?, username?, bot? }` → `{ id }`.                                                                                |
| `POST owners/:id/dialogs`                                        | `{ kind, id?, title?, first_name?, username?, participants_count?, folder?, pinned?, muted?, mute_until?, unread_count?, date? }` → `{ id }`. |
| `POST owners/:id/dialogs/:peerId`                                | `{ folder?, pinned?, muted?, mute_until?, unread_count? }`.                                                                                   |
| `POST owners/:id/dialogs/:peerId/messages`                       | `{ messages: [{ id, date, from_id?, out?, text?, action?, reply_to?, media?, edit_date? }] }` → `{ ids }`.                                    |
| `POST`, `DELETE owners/:id/dialogs/:peerId/messages/:messageId`  | Edit `{ text, edit_date? }`, or delete.                                                                                                       |
| `POST owners/:id/filters`, `DELETE owners/:id/filters/:filterId` | `{ id, title, emoticon?, include_peers?, exclude_peers?, pinned_peers?, contacts?, ... }`, or delete.                                         |
| `POST owners/:id/filters/order`                                  | `{ ids: [3, 0, 2] }`.                                                                                                                         |
| `POST`, `DELETE owners/:id/faults`                               | `{ method, peer_id?, times?, delay_ms?, preset?, seconds?, error_message?, code? }`, or clear.                                                |
| `GET owners/:id/calls`                                           | `[{ owner_id, method, args, at, outcome, error_message?, duration_ms }]`.                                                                     |

The owner client itself calls `POST /_owner/:ownerId/:method`; tests use the client, not this route.

### Delays and failures

`failOwnerCall` applies to one call (`times`, default 1: once) of `method`, optionally only for one
`peerId`, and can first wait `delayMs` (at most 30 s), so calls complete out of order.

| Preset                                 | What the caller gets                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `flood_wait`                           | A `FloodWaitError`: `errorMessage` `"FLOOD"`, `code` 420, `seconds` (default 30), as GramJS builds it. |
| `permission_denied`                    | An `RPCError` `CHAT_WRITE_FORBIDDEN`, code 403.                                                        |
| `reconnect_required`                   | An `RPCError` `AUTH_KEY_UNREGISTERED`, code 401.                                                       |
| `stale_entity`                         | An `RPCError` `PEER_ID_INVALID`, code 400.                                                             |
| `malformed_page`                       | A `getDialogs`/`getMessages` answer whose entries lack their entity and message fields.                |
| `dropped`                              | The call runs, then the connection closes unanswered; the client rejects with `TIMEOUT`.               |
| (none, with `errorMessage` and `code`) | Any other `RPCError`, e.g. `CHANNEL_PRIVATE`, 400.                                                     |

`getOwnerCalls` records every call with its outcome (`ok`, `error`, `malformed`, `dropped`); any
field named like a session, token, hash, key, secret, password or phone is recorded as
`[redacted]`.

### Not modelled, and unverified

- Not modelled: MTProto, login, updates and event handlers (`addEventHandler`), sending, reading
  and deleting from the client, media downloads, drafts, forum topics, reactions and forwards in
  history, `messages.getDialogFilters` for chatlists, and every other GramJS method.
- Unverified: Telegram does not document the order of dialogs with equal dates (this server breaks
  ties by message id, then peer id), whether a cursor page without `excludePinned` repeats pinned
  dialogs (here it does not), or what GramJS raises for a response lost mid-call (here `TIMEOUT`).
  Unread counts are what a test sets; they are not derived from messages.

## Update delivery

- With a webhook set, updates are delivered in order to its URL, with the
  `X-Telegram-Bot-Api-Secret-Token` header when a secret was set.
- Without one, updates queue for `getUpdates`, which supports `offset`, `limit`, `allowed_updates`
  and long polling with `timeout`. As on Telegram, calling it while a webhook is set fails with 409,
  and updates queued before a webhook is set are delivered to it.
- `allowed_updates`, from `setWebhook` or `getUpdates`, is respected. As on Telegram,
  `chat_member`, `message_reaction` and `message_reaction_count` updates are only sent when
  explicitly requested.
- Rights decide who hears what, as the [Update](https://core.telegram.org/bots/api#update) docs
  say: `chat_member` and `message_reaction` reach only bots that are administrators in the chat,
  and `chat_join_request` only bots with `can_invite_users`. A bot gets `my_chat_member` whenever
  its own status changes, whoever changed it.
- When the bot restricts, bans, unbans or approves a member, the server sends the resulting
  `chat_member` update back to the bot, as Telegram does. Nothing is sent when nothing changed.
- Joining, leaving and an approved join request produce both a `chat_member` update and the
  `new_chat_members` / `left_chat_member` service message. A ban in a basic group also posts
  `left_chat_member` from the bot that banned, which that bot receives too, as
  [messages.deleteChatUser](https://core.telegram.org/method/messages.deleteChatUser) "sends a
  service message". Unverified: whether a supergroup ban posts one; this server posts none.

The fake delivers resulting updates asynchronously. Tests should wait for the exact update
rather than depend on response/update ordering; the Bot API does not promise that ordering.

## Control API

The test actions above, over HTTP, for tests written in other languages. All routes live under
`/_fake/` and take and return JSON.

| Route                                                  | Effect                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST users`                                           | Create a user `{ first_name?, last_name?, username?, language_code?, bio?, is_bot?, is_premium? }`; returns `{ id }`.                                                                                                                                                    |
| `POST business/connections`                            | Connect `{ owner_id, rights, id?, is_enabled?, bot_id? }`, or change the connection with `id`; returns `{ connection, update_id }`.                                                                                                                                      |
| `GET business/connections/:id`                         | The `BusinessConnection`.                                                                                                                                                                                                                                                |
| `POST business/connections/:id/chats/:userId/messages` | `{ sender: "person" \| "owner", text }`; returns `{ message_id, date, update_id }`.                                                                                                                                                                                      |
| `GET business/connections/:id/chats/:userId/messages`  | The business chat, newest first, as `[{ direction, deleted, message }]`.                                                                                                                                                                                                 |
| `POST updates/:updateId/redeliver`                     | Deliver that update again to its bot's webhook; 404 for an unknown update, 409 when the bot has no webhook. Returns `{ update_id }`.                                                                                                                                     |
| `GET users/:id`                                        | The user, with bio and photos.                                                                                                                                                                                                                                           |
| `POST users/:id/profile`                               | Change `first_name`, `last_name`, `bio` or `username`.                                                                                                                                                                                                                   |
| `POST users/:id/photos`                                | Add a profile photo `{ base64 }`.                                                                                                                                                                                                                                        |
| `DELETE users/:id/photos/:fileId`                      | Remove a profile photo.                                                                                                                                                                                                                                                  |
| `POST chats/:id/join`                                  | The user `{ user_id }` joins.                                                                                                                                                                                                                                            |
| `POST chats/:id/leave`                                 | The user `{ user_id }` leaves.                                                                                                                                                                                                                                           |
| `POST chats/:id/messages`                              | The user posts `{ user_id, text }`, `{ user_id, photo_base64, caption? }` or `{ user_id, media: { type, base64, file_name?, mime_type? }, caption? }`, optionally `reply_to`, `message_thread_id` or `forward_from: { user_id \| sender_name \| chat_id, message_id? }`. |
| `POST chats/:id/albums`                                | The user posts an album `{ user_id, items: [{ type: "photo" \| "video", base64, caption? }] }`; returns `{ media_group_id, message_ids }`.                                                                                                                               |
| `POST chats/:id/messages/:messageId/edit`              | The author `{ user_id }` edits the `text` or `caption`.                                                                                                                                                                                                                  |
| `POST chats/:id/messages/:messageId/reactions`         | The user `{ user_id, emoji }` reacts, or takes the reaction back with `emoji: null`.                                                                                                                                                                                     |
| `GET chats/:id/messages`                               | Messages not deleted, newest first.                                                                                                                                                                                                                                      |
| `GET chats/:id/messages/:messageId`                    | `{ exists, deleted, message, reactions }`, reactions by user id.                                                                                                                                                                                                         |
| `POST chats/:id/messages/:messageId/callback`          | The user `{ user_id, data }` presses an inline button; returns the bot's answer.                                                                                                                                                                                         |
| `GET chats/:id/members/:userId`                        | The member as `getChatMember` would return it.                                                                                                                                                                                                                           |
| `GET chats/:id/join-requests`                          | User ids with a pending join request.                                                                                                                                                                                                                                    |
| `POST invites/:hash/join`                              | The user `{ user_id }` opens `https://t.me/+<hash>`: joins, or files a join request if the link requires one.                                                                                                                                                            |
| `POST invites/:hash/check`                             | Whether the user `{ user_id }` is in the link's chat.                                                                                                                                                                                                                    |
| `POST chats/:id/guest-bot-reply`                       | A guest bot answers the user `{ caller_user_id, bot_username, text }` in the group; returns `{ message_id }`.                                                                                                                                                            |
| `POST users/:id/dm`                                    | The user sends the bot a direct message `{ text }`.                                                                                                                                                                                                                      |
| `GET users/:id/dm`                                     | The private chat's messages, newest first.                                                                                                                                                                                                                               |
| `POST users/:id/dm/:messageId/callback`                | The user presses a button in the private chat `{ data }`.                                                                                                                                                                                                                |
| `GET bot`                                              | The first bot's user, with its `login_client_secret`.                                                                                                                                                                                                                    |
| `GET webhook`                                          | The first bot's registered webhook.                                                                                                                                                                                                                                      |
| `POST bots`                                            | Add a bot `{ token, username, first_name?, login_client_secret? }`; it is in no chat yet.                                                                                                                                                                                |
| `POST login/approve`                                   | The user `{ auth_url, user_id }` logs in; returns `{ redirect_url }` with the code and state.                                                                                                                                                                            |
| `POST login/cancel`                                    | The user cancels `{ auth_url }`; returns `{ redirect_url }` with `error=access_denied`.                                                                                                                                                                                  |
| `GET bots`                                             | Every bot, with its webhook URL and `login_client_secret`.                                                                                                                                                                                                               |
| `POST chats`                                           | Create `{ owner_id, title?, type?: "supergroup" \| "channel", owner_name?, is_forum? }`; returns the chat.                                                                                                                                                               |
| `GET chats/:id`                                        | The chat with its pinned message ids and members.                                                                                                                                                                                                                        |
| `POST chats/:id/bots`                                  | Add, promote, demote or remove a bot `{ bot_id, status?, rights?, by? }`, as the owner would.                                                                                                                                                                            |
| `POST chats/:id/bots` with `start_parameter`           | A person `{ by?, bot_id, start_parameter, rights? }` adds the bot through its `startgroup` link.                                                                                                                                                                         |
| `POST chats/:id/migrate`                               | Upgrade a basic group `{ by? }`; returns the new supergroup.                                                                                                                                                                                                             |
| `POST chats/:id/title`                                 | A person renames the chat `{ by?, title }`.                                                                                                                                                                                                                              |
| `POST chats/:id/photo`                                 | A person sets the chat photo `{ by?, base64 }`.                                                                                                                                                                                                                          |
| `POST chats/:id/topics`                                | Create a forum topic `{ name, by? }`; returns `{ message_thread_id, name }`.                                                                                                                                                                                             |
| `POST chats/:id/topics/:threadId/edit`                 | Rename a topic `{ name, by? }`.                                                                                                                                                                                                                                          |
| `GET chats/:id/topics`                                 | The forum's topics.                                                                                                                                                                                                                                                      |
| `POST failures`                                        | Fail the next calls `{ method, chat_id?, bot_id?, user_id?, message_id?, attempt?, times?, error_code?, description?, retry_after?, drop_after_apply?, delay_ms? }`.                                                                                                     |
| `GET failures`, `DELETE failures`                      | The failure rules still waiting, or clear them.                                                                                                                                                                                                                          |
| `GET calls`                                            | Every Bot API call received, with the bot that made it, and the unsupported methods called.                                                                                                                                                                              |

A button press waits up to 10 seconds for the bot to call `answerCallbackQuery` and returns
`{ answered, text, show_alert }`.

## Formatting, replies and uploads

Bot text and media captions support `parse_mode` (`HTML`, `MarkdownV2` and legacy
`Markdown`) and explicit `entities` / `caption_entities`. The stored response has plain
text and UTF-16 entity offsets. Formatting also applies to album captions, media edits
and business text sends. Links, mentions and commands can be detected inside styles;
code, pre and explicit links suppress overlapping automatic detection.

The contract cases cover malformed markup, crossed Markdown delimiters, invalid entity
ranges (including surrogate-pair boundaries), style splitting around code, and overlapping
blockquote normalization. These rules follow [Bot API formatting options](https://core.telegram.org/bots/api#formatting-options)
and Telegram's [TDLib entity implementation](https://github.com/tdlib/td/blob/master/td/telegram/MessageEntity.cpp).
Album captions are all parsed before any album message is stored, following the
[Bot API server's request parsing](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp).
This is a tested subset, not a claim that every Telegram parser edge case is implemented
or every error description is byte-for-byte identical.

Same-chat `reply_parameters` and the older `reply_to_message_id` populate
`reply_to_message`, without nested reply chains. The basic same-chat
`allow_sending_without_reply` option is supported. Forum-topic sends without an explicit
reply attach the topic's creation message. Cross-chat replies, quoted substrings and
business reply metadata are not implemented; see [ReplyParameters](https://core.telegram.org/bots/api#replyparameters)
for Telegram's broader contract. Uploaded documents preserve their original filename
and MIME type when reused by `file_id` ([Document](https://core.telegram.org/bots/api#document)).

## What it does not do

- Inline mode, payments, games, sticker sets, reaction counts, votes in polls, or Telegram's rate limits
  (a test makes a call fail with a 429 through `POST failures` instead). Channels have no
  subscribers and forum topics cannot be closed or deleted.
- Expiry is evaluated on state access, without a scheduler or an automatic expiry webhook. Restarting loses all state; restart recovery belongs to the application under test.
- Webhook retries: an update the webhook rejects, or does not answer within 10 seconds, is logged and
  dropped rather than retried.
- In Telegram Login: the `phone` scope's `phone_number` (test users have no phone numbers), the
  ES256, EdDSA and ES256K signing options (only the default RS256), the redirect URLs registered
  with BotFather (any `redirect_uri` is accepted), the `telegram-login.js` popup and native SDKs, and
  the legacy Login Widget's hash check. Telegram has no UserInfo endpoint, and neither does this
  server.
- Persistence. All state lives in memory and is lost when the server stops.
- Anything security-related. It is a test tool: bind it to localhost and never expose it to a
  network you do not control.

## Moderation fidelity and operation receipts

A ban deletes no messages, as on Telegram: `revoke_messages` only decides what the
removed user can still see, which this server does not model. A bot that wants a
banned user's messages gone deletes them with `deleteMessage` or `deleteMessages`.
`restrictChatMember` works only in supergroups, and `promoteChatMember` and
`unbanChatMember` only in supergroups and channels.
Restrict/ban/unban require `can_restrict_members` and protect
administrators; approval/decline require `can_invite_users` before touching pending
requests. Refusals carry Telegram's own texts, such as `not enough rights to
restrict/unrestrict chat member`, `method is available only in supergroups` or, for a
basic group that only an administrator may remove members from, `CHAT_ADMIN_REQUIRED`. Pending requests are not members. Unban leaves a banned user outside;
`only_if_banned` keeps an admitted user unchanged. Bulk deletion validates permissions
before changing any existing target and skips missing message IDs. Deletion enforces
the 48-hour limit, private dice minimum age, and undeletable creation service messages.

Finite restriction/ban dates from 30 seconds through 366 days are inclusive;
outside that range they are permanent. Expired restrictions become member/left
according to physical membership; expired bans become left. These contracts follow
[ban/unban/restrict](https://core.telegram.org/bots/api#banchatmember),
[join approval/decline](https://core.telegram.org/bots/api#approvechatjoinrequest), and
[deletion](https://core.telegram.org/bots/api#deletemessages).

Fault rules count only operations matching their method, chat, bot, user and message
selectors. `userId` identifies the method target, ephemeral recipient, or
`deleteMessage` author. `messageId` also matches an ID in a `deleteMessages` batch.
`attempt: 2` starts at the second matching request after installation;
`times` controls consecutive matching faulted attempts. Unrelated operations do not
consume the rule. `delayMs` alone executes normally and delays only the response.
Adding `errorCode` rejects before execution; `dropAfterApply` executes once then drops
the connection. Delays are bounded to 30 seconds and cancelled on server stop.

`getCalls()` / `GET /_fake/calls` retain append-only receipts with `seq`, `outcome`,
`applied`, `status`, `completed_at`, and matching `fault_id` / `attempt` / `delay_ms`.
`applied` means the handler succeeded, including reads/no-ops, rather than claiming a
state change. Actual permission rejection records `failed` as well as injected
rejection. A failed handler never records a successful response loss. Compare these
receipts with `getMember` / `getMessage` for physical-state proof.

Use `redeliverUpdate(updateId)` to replay the exact saved webhook bytes, including
callback queries. Do not clear messages, update history or receipts between replay
steps. Clear unused failure rules at scenario boundaries; use a fresh server or restore a
quiescent fixture snapshot for an independent fake fixture. This fake does not emulate application persistence or
Telegram's complete permission, media, rate-limit or delivery model. Bulk permission
validation before mutation is this fake's failure-isolation policy; Telegram's docs
do not specify partial execution of invalid mixed batches.

## Exact waits, reusable fixtures and fake-owned time (0.10.0)

These are test controls, not additional Telegram methods. Existing bot URLs,
fixture helpers, scoped `failNext`, delayed responses, `dropAfterApply` and exact
update replay continue to work.

```js
const fake = await startTestServer({
  botToken: "123456:TEST",
  clock: { now: 1_800_000_000_000 }, // optional; omit for real time
  chats: [{ id: -1001234567890, title: "Test", ownerId: 5000000001 }],
});
try {
  const userId = await fake.createUser();
  await fake.join(-1001234567890, userId);
  const saved = await fake.snapshot();
  try {
    const banned = fake.waitFor(
      {
        kind: "member",
        chatId: -1001234567890,
        userId,
        status: "kicked",
      },
      { timeoutMs: 1000 },
    );
    await Promise.all([
      banned,
      (async () => {
        // A real HTTP call to this local fake, without a production service.
        const response = await fetch(
          `${fake.origin}/bot123456:TEST/banChatMember`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: -1001234567890, user_id: userId }),
          },
        );
        const answer = await response.json();
        if (!answer.ok) throw new Error(answer.description);
      })(),
    ]);
    await fake.restore(saved);
    await fake.waitFor({
      kind: "member",
      chatId: -1001234567890,
      userId,
      status: "member",
    });
  } finally {
    await fake.releaseSnapshot(saved);
  }
} finally {
  await fake.stop();
}
```

For application enforcement, trigger the application instead of directly calling
the fake Bot API and await the same physical-state condition. The following
selectors are supported:

| `kind`        | Required identity                                                                   | Expected state / optional narrowing                                                                 |
| ------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `message`     | `chatId` plus `messageId`, or author (`userId`/`botId`) plus exact `text`/`caption` | `deleted`; author/text/caption can also narrow a message ID                                         |
| `member`      | `chatId`, `userId`, `status`                                                        | `permissions` compares returned ChatMember permission fields                                        |
| `joinRequest` | `chatId`, `userId`, `state`                                                         | `pending`, `approved`, `declined`; `botId` identifies the resolving bot                             |
| `call`        | `botId`, `method`                                                                   | `chatId`, `userId`, `messageId`, exact `params` fields, `afterSeq`, `requestId`, `outcome`, `stage` |

`waitFor(condition, { timeoutMs })` evaluates at registration and on changes; it
never polls. Deadlines use wall time, default 1000 ms, range 1–30000 ms. Results
are detached copies. Failure reports include the exact expectation, observed
state or up to eight matching requests, and outstanding fake work. Diagnostics
are capped at 8000 characters and redact credentials; raw request journals remain
original evidence and may contain fixture secrets. Do not dump them indiscriminately.
`botId` on a message identifies its author. Membership is physical chat/user
state, shared by the bots in that chat. Join decisions are a test observation
journal, not a new ChatMember status; decline leaves the requester outside.

Snapshot handles are opaque strings owned by one server. `snapshot()` and
`restore(handle)` require quiescence: no active HTTP/control/owner request,
long poll, webhook attempt, response delay or clock advance. Idle finite-expiry
timers and unused fault rules are allowed. Drain existing deliveries and finish
requests before taking a snapshot; restore fails explicitly with outstanding
work instead of silently mixing in-flight execution with restored state.

Restore replaces users, bots, chat/private/business/owner fixtures, media bytes,
memberships, messages, invite/join state, counters, calls, fault rules and their
attempt counters, saved update bytes, queues, webhook/subscription settings and
login codes. Aliases between bot/user/update records are retained. Finite expiry
work is reconstructed from restored membership. Snapshots are detached and reusable;
`releaseSnapshot(handle)` frees them. Restore cancels older waits. A monotonically
increasing restore epoch prevents request identities colliding when fixture IDs
and journals intentionally rewind. Server origin and per-instance login signing
identity remain fixed. External webhook consumers, sockets, timers, databases
and application state are not snapshotted.

With `clock: { now: milliseconds }`, `advanceTime(ms)` serializes advances and
runs due fake expiry and Bot/owner response-fault delays in deadline order. It
also controls fake message/login/business timestamps. Real mode remains the
default; real time is not rewound by restore. Manual time is restored with the
fixture. Global `Date`, timers and the consuming application's jobs are untouched.
Webhook network I/O, its safety deadline, long polling and diagnostic waits still
use wall time. A clock advance is not a network-delivery or enforcement barrier.

`drainDeliveries({ botId?, timeoutMs? })` waits for that server's queued/in-flight
webhook attempts to settle. It does not consume `getUpdates` queues, assert HTTP
success, or wait for the bot's moderation work after acknowledging a webhook.
Inspect `getDeliveries()` for update ID, bot ID, replay attempt, epoch, enqueue/start/
completion times, status and outcome. Saved updates and delivery evidence survive
until an explicit restore. `stop()` cancels waits/delays, aborts current deliveries,
prevents queued deliveries starting, clears scheduled work and closes connections.
Read-only in-process controls remain available after stopping for diagnostics.

The HTTP equivalents use camel-case control fields:

| Request                           | Body/result                                          |
| --------------------------------- | ---------------------------------------------------- |
| `POST /_fake/wait`                | `{ condition, timeoutMs? }` → matching observation   |
| `POST /_fake/snapshots`           | `{}` → JSON string handle                            |
| `POST /_fake/restore`             | `{ snapshot: handle }` → `{ restored: true, epoch }` |
| `DELETE /_fake/snapshots/:handle` | release handle                                       |
| `GET /_fake/clock`                | `{ mode, now, scheduled }`                           |
| `POST /_fake/clock`               | `{ ms }` → advanced clock; manual mode required      |
| `GET /_fake/deliveries`           | delivery journal                                     |
| `POST /_fake/deliveries`          | `{ botId?, timeoutMs? }` → drain fake deliveries     |

### Request timelines and compatibility

Each Bot API receipt has an instance/epoch/sequence `request_id` and a bounded
`timeline`: `received`, `validated`, `state_applied`, `handler_completed`, and
`response_sent` or `response_lost`. `received` timestamps HTTP arrival. Shared
message creation/edit/deletion and membership mutation paths checkpoint known
physical application before any awaited webhook finishes. Other handlers, and
successful reads/no-ops, retain a completion checkpoint. `handler_completed`
separately records successful handler return; it can occur later than application.
`validated` records successful validation at that checkpoint, not an instrumented
pretransaction barrier. Not every intermediate mutation is instrumented. Use exact
message/member waits for physical proof. Request context is scoped through
AsyncLocalStorage, so concurrent calls cannot borrow one another's checkpoints.
`applied` remains true if an instrumented mutation is followed by a handler
failure; `failed_after_apply` distinguishes that from a rejection before execution.
`response_sent` means Node finished writing locally, not that the remote
application processed the answer. Completion time includes injected response delays.
Lost responses preserve known application separately from transport loss;
permission/injected rejections do not record successful application.
`target_user_id` captures the target argument, ephemeral recipient, or
`deleteMessage` author before execution without altering original `params`.
Matching attempts before fault injection starts now retain
`fault_id`, `attempt`, and `fault_injected: false`; injected attempts set it true.

`getCalls()` is now detached: mutating its result cannot rewrite evidence.
Existing `calls` retains its authenticated, parsed-request scope. New
`rejected_requests` records unauthorized/malformed attempts separately, preserving
0.9.x call counts. Call waits use `calls` by default; set
`includeRejectedRequests: true` to observe the early-rejection journal too. Its
`bot_id` is the attempted numeric token prefix, not authenticated identity.
`afterSeq` is local to each journal; `requestId` is unique across both. A call
wait without an outcome/stage can resolve at receipt, before execution.
Unauthorized URL tokens are not journaled; malformed bodies
are retained as `raw_body` and suppressed in diagnostics. Calls refused for chat
access (including an upgraded basic group) receive the same identity/timeline as
other parsed calls. Owner RPCs retain their
existing owner ledger and duration fields. Owner receipts now use fake time,
start as `pending`, and become `cancelled` if shutdown interrupts a delay before
execution. `getOwnerCalls()` is detached too. These are diagnostic outcomes of
the fake, not invented Telegram RPC errors. Successful owner response shapes are
unchanged. Call observers use derived per-bot/method indexes and journal sequence
bounds; restore rebuilds the indexes without removing replay evidence. Large
restored journals are copied without exceeding JavaScript function argument limits.

Four former no-op setters (`setMyDescription`, `setMyShortDescription`,
`setChatMenuButton`, `setMyDefaultAdministratorRights`) now report unsupported in
strict mode instead of claiming to store state. This is an intentional compatibility
change. The explicitly selected legacy `unimplemented: "ok"` mode remains for
existing consumers and is not an accuracy mode; strict `"error"` is the default.
`setChatPermissions` now requires a group/supergroup and the caller’s
`can_restrict_members` right; an unauthorized call cannot change default
permissions. Consumers whose fixtures depended on unauthorized success must
correct their administrator setup. Dependency versions remain unchanged.

RSA login keys are generated only on first signing/JWKS use, separately per
instance. Bot-only tests avoid the key-generation cost. Login tests still pay
that cost at first use; this is deferred work, not cheaper cryptography.

### Verification and upgrading

The retained suites cover stored plain text versus original HTML/`parse_mode`,
UTF-16 entities, literal user markup, emoji/nested/link/mention formatting,
permissions and membership, join decisions, edit/delete, callbacks, bans that
leave messages in place, mute history preservation, response-loss faults,
replay and bot/chat isolation. Contracts:
[MessageEntity](https://core.telegram.org/bots/api#messageentity),
[formatting](https://core.telegram.org/bots/api#formatting-options),
[ban](https://core.telegram.org/bots/api#banchatmember),
[restrict](https://core.telegram.org/bots/api#restrictchatmember),
[default permissions](https://core.telegram.org/bots/api#setchatpermissions),
[join decisions](https://core.telegram.org/bots/api#approvechatjoinrequest), and
[callback queries](https://core.telegram.org/bots/api#callbackquery).
These do not imply complete Telegram compatibility or verified Telegram callback
expiry/retry timing; the fake's callback wait deadline remains its own test policy.

See the [measurements and regression record](https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/performance.md)
for reproducible commands, raw samples, observed costs and remaining gaps.
In a source checkout, run `npm test`, `npm run bench`, `node bench/reuse.mjs`,
and `node --expose-gc bench/scaling.mjs`. The scaling benchmark accepts
`BENCH_HISTORY`, `BENCH_MESSAGES`, `BENCH_OBSERVERS` and `BENCH_ROUNDS` for
explicit capacity runs; do not interpret a small sample as a throughput guarantee.
Version **0.10.0** adds these test controls and fidelity fixes. Pin it explicitly:

```sh
pnpm add -D --save-exact telegram-bot-test-server@0.10.0
# or: npm install --save-dev --save-exact telegram-bot-test-server@0.10.0
```

Existing consumers can keep using real time and their current helpers. Adopt
exact waits first, then snapshots only with fake and application state reset
under each component's ownership. Do not apply 0.9.x source patches blindly to
0.10.0; rebase and verify only still-needed patches against this source. No
consumer repository or downstream test runner is changed by this package work.

## Changes

- **0.10.0**: exact event-driven waits, fixture snapshots/restoration,
  instance-owned manual time, delivery drains/journals, request timelines, detached
  request evidence, callback ownership protection and lazy login key generation.
  Former unmodelled metadata setters now fail explicitly in strict mode.
  Default chat permissions enforce administrator restriction rights; shared physical
  checkpoints precede webhook completion. Owner receipts preserve pending/cancelled
  outcomes and fake time. Exact call observers avoid unrelated history scans; large
  journals restore without argument-limit failures.
- **0.9.2**: plain stored text and validated UTF-16 entities, HTML/Markdown formatting,
  preserved original requests, and file/reply metadata.

- **0.9.1**: scoped ban message revocation, moderation/join/bulk-delete permission checks,
  finite restriction expiry, exact user/message/attempt faults, delayed responses and
  truthful execution/transport receipts. Owner-account behavior is unchanged.

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
  and `left_chat_member` messages. Tests now cover `getChatMemberCount` following joins and
  leaves, and `leaveChat` sending `my_chat_member`.
- **0.6.0**: business connections and business chats (`business_connection`,
  `business_message`, `sendMessage` with `business_connection_id`, `getBusinessConnection`),
  `is_bot` and `is_premium` on test users, `can_connect_to_business` on `getMe`, and update
  redelivery.
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

## Status

This is an early-stage project with a deliberately small scope, and the public API may still change.

## License

MIT
