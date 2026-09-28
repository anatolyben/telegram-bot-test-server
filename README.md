# telegram-bot-test-server

`telegram-bot-test-server` is a local, in-memory fake of the Telegram Bot API for testing bots that
manage groups.

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

| Action                                                                | What happens                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `createUser({ first_name, last_name, username, language_code, bio })` | A new Telegram user; returns their id. All fields optional.                                                                                   |
| `updateProfile(userId, fields)`                                       | The user changes their name, username or bio.                                                                                                 |
| `addProfilePhoto(userId, bytes)`                                      | The user adds a profile photo.                                                                                                                |
| `join(chatId, userId)`                                                | The user joins the group.                                                                                                                     |
| `joinByLink(inviteLink, userId)`                                      | The user opens an invite link: joins, or files a join request if the link requires approval.                                                  |
| `leave(chatId, userId)`                                               | The user leaves.                                                                                                                              |
| `post(chatId, userId, text)`                                          | The user posts a message; returns its `message_id`. Also takes `{ text, photo, caption, replyTo }`. Fails if the user is not allowed to post. |
| `pressButton(chatId, messageId, userId, data)`                        | The user presses an inline button; resolves with the bot's `answerCallbackQuery` answer.                                                      |
| `sendDirectMessage(userId, text)`                                     | The user messages the bot privately.                                                                                                          |
| `pressDirectButton(userId, messageId, data)`                          | The user presses a button in their private chat with the bot.                                                                                 |
| `getMessages(chatId)`, `getMessage(chatId, id)`                       | The chat's messages, and whether one was deleted.                                                                                             |
| `getDirectMessages(userId)`                                           | The private chat between the user and the bot.                                                                                                |
| `getMember(chatId, userId)`                                           | The member as `getChatMember` returns them: status, restrictions, ban.                                                                        |
| `getJoinRequests(chatId)`                                             | User ids waiting for approval.                                                                                                                |
| `getCalls()`                                                          | Every Bot API call the bot made, and any unsupported methods it called.                                                                       |
| `stop()`                                                              | Shut the server down.                                                                                                                         |

## Use from any language

```sh
npx telegram-bot-test-server --token 123456:TEST --port 8081 --config chats.json
```

`chats.json` holds `{ "chats": [...], "publicChats": [...] }` in the same shape as the options
below. Point your bot's Bot API base URL at `http://127.0.0.1:8081` and drive the same test actions
over HTTP through the control API described below, from Python, Go or anything else.

## Options

| Option          | Default          | Meaning                                                                                      |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `botToken`      | required         | `<numeric id>:<secret>`. Calls with any other token get 401.                                 |
| `port`, `host`  | `0`, `127.0.0.1` | Where to listen. Port 0 picks a free port.                                                   |
| `botUsername`   | `fake_test_bot`  | Returned by `getMe`.                                                                         |
| `botName`       | `Fake Test Bot`  | Returned by `getMe`.                                                                         |
| `chats`         | `[]`             | Supergroups `{ id, title, ownerId, ownerName? }`. The bot is an administrator.               |
| `publicChats`   | `[]`             | Channels, groups and bots `{ username, type, title? }` resolvable by `getChat("@username")`. |
| `unimplemented` | `"error"`        | What an unsupported method returns: a 404 error naming it, or `"ok"` for `true`.             |
| `log`           | none             | Receives one line per notable event (unsupported methods, webhook failures).                 |

## Supported Bot API methods

These read or change the server's state:

`getMe`, `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`, `getChat`, `getChatMember`,
`getChatAdministrators`, `getChatMemberCount`, `getUserProfilePhotos`, `getFile`, `sendMessage`,
`sendPhoto`, `sendDocument`, `sendVideo`, `sendAnimation`, `sendSticker`, `editMessageText`,
`editMessageReplyMarkup`, `editMessageCaption`, `deleteMessage`, `deleteMessages`,
`restrictChatMember`, `banChatMember`, `unbanChatMember`, `setChatPermissions`,
`approveChatJoinRequest`, `declineChatJoinRequest`, `createChatInviteLink`, `exportChatInviteLink`,
`revokeChatInviteLink`, `answerCallbackQuery`, `setMyCommands`, `deleteMyCommands`,
`getMyCommands`.

These are accepted and return success without changing anything: `setMyDescription`,
`setMyShortDescription`, `setChatMenuButton`, `setMyDefaultAdministratorRights`, `pinChatMessage`,
`unpinChatMessage`, `leaveChat`.

Any other method returns a 404 error that names it, so a test cannot pass against behaviour the
server does not have. Methods are added when a real bot needs them; the goal is not full coverage of
the Bot API. Method names are case-insensitive, and parameters are accepted as a query string, JSON
or multipart form data, as with Telegram.

## Behaves like Telegram

The details a moderation bot depends on, each covered by a test:

- **Permissions.** Unspecified permissions are false, and unless `use_independent_chat_permissions`
  is set, broader permissions imply narrower ones (`can_send_other_messages` implies media and text).
  A member needs both their own permission and the chat's default from `setChatPermissions` to post;
  a photo needs `can_send_photos`, not only `can_send_messages`.
- **Restrictions stick.** A restricted user who leaves and rejoins is still restricted.
- **Protected members.** Restricting or banning the chat owner, an administrator or the bot itself
  fails with Telegram's error.
- **Unbanning.** `unbanChatMember` without `only_if_banned` removes a current member, as the docs
  guarantee.
- **Editing.** Only the bot's own messages can be edited; an edit that changes nothing fails with
  `message is not modified`; an edit without `reply_markup` removes the inline keyboard, after which
  its buttons can no longer be pressed.
- **Private chats.** The bot cannot message a user who has not written to it first (403).
- **Callback queries.** Answering a query that was never sent fails.
- **Invite links.** Exporting a new primary link revokes the previous one; joining through a
  revoked link fails.
- **Entities.** Member messages and captions carry `bot_command`, `mention`, `email` and `url`
  entities with UTF-16 offsets, in groups and in private chats.
- **Media.** Sent photos, documents, videos, animations and stickers carry the fields the Bot API
  requires and resolve through `getFile`.

## Update delivery

- With a webhook set, updates are delivered in order to its URL, with the
  `X-Telegram-Bot-Api-Secret-Token` header when a secret was set.
- Without one, updates queue for `getUpdates`, which supports `offset`, `limit`, `allowed_updates`
  and long polling with `timeout`. As on Telegram, calling it while a webhook is set fails with 409,
  and updates queued before a webhook is set are delivered to it.
- `allowed_updates`, from `setWebhook` or `getUpdates`, is respected. As on Telegram,
  `chat_member`, `message_reaction` and `message_reaction_count` updates are only sent when
  explicitly requested.
- When the bot restricts, bans, unbans or approves a member, the server sends the resulting
  `chat_member` update back to the bot, as Telegram does. Nothing is sent when nothing changed.
- Joining, leaving and an approved join request produce both a `chat_member` update and the
  `new_chat_members` / `left_chat_member` service message.

A Bot API call returns before the updates it causes are delivered, as on Telegram, so tests should
wait for the update rather than expect it immediately.

## Control API

The test actions above, over HTTP, for tests written in other languages. All routes live under
`/_fake/` and take and return JSON.

| Route                                         | Effect                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST users`                                  | Create a user `{ first_name?, last_name?, username?, language_code?, bio? }`; returns `{ id }`.               |
| `GET users/:id`                               | The user, with bio and photos.                                                                                |
| `POST users/:id/profile`                      | Change `first_name`, `last_name`, `bio` or `username`.                                                        |
| `POST users/:id/photos`                       | Add a profile photo `{ base64 }`.                                                                             |
| `DELETE users/:id/photos/:fileId`             | Remove a profile photo.                                                                                       |
| `POST chats/:id/join`                         | The user `{ user_id }` joins.                                                                                 |
| `POST chats/:id/leave`                        | The user `{ user_id }` leaves.                                                                                |
| `POST chats/:id/messages`                     | The user posts `{ user_id, text }` or `{ user_id, photo_base64, caption? }`, optionally `reply_to`.           |
| `GET chats/:id/messages`                      | Messages not deleted, newest first.                                                                           |
| `GET chats/:id/messages/:messageId`           | `{ exists, deleted, message }`.                                                                               |
| `POST chats/:id/messages/:messageId/callback` | The user `{ user_id, data }` presses an inline button; returns the bot's answer.                              |
| `GET chats/:id/members/:userId`               | The member as `getChatMember` would return it.                                                                |
| `GET chats/:id/join-requests`                 | User ids with a pending join request.                                                                         |
| `POST invites/:hash/join`                     | The user `{ user_id }` opens `https://t.me/+<hash>`: joins, or files a join request if the link requires one. |
| `POST invites/:hash/check`                    | Whether the user `{ user_id }` is in the link's chat.                                                         |
| `POST users/:id/dm`                           | The user sends the bot a direct message `{ text }`.                                                           |
| `GET users/:id/dm`                            | The private chat's messages, newest first.                                                                    |
| `POST users/:id/dm/:messageId/callback`       | The user presses a button in the private chat `{ data }`.                                                     |
| `GET bot`                                     | The bot user.                                                                                                 |
| `GET webhook`                                 | The registered webhook.                                                                                       |
| `GET calls`                                   | Every Bot API call received, and the unsupported methods called.                                              |

A button press waits up to 10 seconds for the bot to call `answerCallbackQuery` and returns
`{ answered, text, show_alert }`.

## What it does not do

- Channels, forum topics, inline mode, payments, games, sticker sets, reactions, or Telegram's rate
  limits.
- `parse_mode` formatting: text is stored exactly as sent, tags and all.
- Expiry: restrictions and bans with an `until_date` never lift on their own.
- Webhook retries: an update the webhook rejects, or does not answer within 10 seconds, is logged and
  dropped rather than retried.
- Persistence. All state lives in memory and is lost when the server stops.
- Anything security-related. It is a test tool: bind it to localhost and never expose it to a
  network you do not control.

## Development

```sh
pnpm install
pnpm test
```

## Status

This is an early-stage project with a deliberately small scope. It was extracted from the test suite
of a production group bot, and the public API may still change.

## License

MIT
