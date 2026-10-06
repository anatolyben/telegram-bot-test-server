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
has been handed to the bot: its first webhook attempt has finished (with any call the webhook
answered with), it waits behind an update the webhook refused, or it is queued for `getUpdates`.
What the bot does in response happens after that, so wait for the outcome rather than checking it
immediately.

| Action                                                                                                                                | What happens                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createUser({ first_name, last_name, username, language_code, bio, is_bot, is_premium })`                                             | A new Telegram user; returns their id. All fields optional.                                                                                                                 |
| `connectBusiness({ ownerId, rights, id, isEnabled, botId })`                                                                          | The owner connects a bot to their business account, or changes the connection with `id`; the bot gets `business_connection`. Returns `{ connection, update_id }`.           |
| `getBusinessConnection(connectionId)`                                                                                                 | The `BusinessConnection`.                                                                                                                                                   |
| `sayInBusinessChat(connectionId, userId, sender, text)`                                                                               | `"person"` writes to the owner, or `"owner"` answers by hand; the bot gets `business_message`. Returns `{ message_id, date, update_id }`.                                   |
| `getBusinessChat(connectionId, userId)`                                                                                               | The business chat, newest first: `[{ direction: "inbound" \| "owner" \| "bot", deleted, message }]`.                                                                        |
| `redeliverUpdate(updateId, { botId })`                                                                                                | Telegram delivers that update again, byte for byte, to the same bot's webhook; `botId` names the bot when two bots got that `update_id`.                                    |
| `updateProfile(userId, fields)`                                                                                                       | The user changes their name, username or bio.                                                                                                                               |
| `addProfilePhoto(userId, bytes)`                                                                                                      | The user adds a profile photo.                                                                                                                                              |
| `join(chatId, userId)`                                                                                                                | The user joins the group.                                                                                                                                                   |
| `joinByLink(inviteLink, userId)`                                                                                                      | The user opens an invite link: joins, or files a join request if the link requires approval. A revoked, expired or full link fails.                                         |
| `leave(chatId, userId)`                                                                                                               | The user leaves.                                                                                                                                                            |
| `post(chatId, userId, text)`                                                                                                          | The user posts a message; returns its `message_id`. Also takes `{ text, photo, media, caption, replyTo, threadId, forwardFrom }`. Fails if the user is not allowed to post. |
| `postAlbum(chatId, userId, items)`                                                                                                    | The user posts 2 to 10 photos or videos as one album (`media_group_id`).                                                                                                    |
| `editMessage(chatId, messageId, userId, { text, caption })`                                                                           | The author edits their message; bots get `edited_message` (`edited_channel_post` in a channel). Text that shows nothing fails with `MESSAGE_EMPTY`.                         |
| `react(chatId, messageId, userId, emoji)`                                                                                             | The user reacts to a message, or takes the reaction back with `null`.                                                                                                       |
| `pinMessage(chatId, messageId, userId)`                                                                                               | A person with `can_pin_messages` (in a channel, `can_edit_messages`) pins the message; bots get the `pinned_message` service message.                                       |
| `pressButton(chatId, messageId, userId, data)`                                                                                        | The user presses an inline button; resolves with the bot's `answerCallbackQuery` answer.                                                                                    |
| `pressEphemeralButton(chatId, ephemeralMessageId, userId, data)`                                                                      | The receiver presses an inline button on an ephemeral message; resolves like `pressButton`.                                                                                 |
| `postGuestBotReply(chatId, userId, botUsername, text)`                                                                                | The user calls a guest bot (Bot API 10.0 guest mode); its answer appears in the group from that bot, with `guest_bot_caller_user` set.                                      |
| `sendDirectMessage(userId, text)`                                                                                                     | The user messages the bot privately; empty text fails with `MESSAGE_EMPTY`.                                                                                                 |
| `pressDirectButton(userId, messageId, data)`                                                                                          | The user presses a button in their private chat with the bot.                                                                                                               |
| `getMessages(chatId)`, `getMessage(chatId, id)`                                                                                       | The chat's messages, ephemeral ones included; `getMessage` finds a regular one by `message_id` and says whether it was deleted. Their file_ids are the first bot's.         |
| `getEphemeralMessage(chatId, ephemeralMessageId)`                                                                                     | An ephemeral message by its `ephemeral_message_id`, and whether it was deleted.                                                                                             |
| `getDirectMessages(userId)`                                                                                                           | The private chat between the user and the bot.                                                                                                                              |
| `getMember(chatId, userId)`                                                                                                           | The member as `getChatMember` returns them to the first bot: status, restrictions, ban.                                                                                     |
| `getJoinRequests(chatId)`                                                                                                             | User ids waiting for approval.                                                                                                                                              |
| `addBot({ token, username, firstName, loginClientSecret })`                                                                           | Another bot, with its own webhook or update queue; it is in no chat yet.                                                                                                    |
| `approveLogin(authUrl, userId)`                                                                                                       | The user logs in on the Telegram Login page for that `/auth` URL; returns the `redirect_uri` URL with `code` and `state`.                                                   |
| `cancelLogin(authUrl)`                                                                                                                | The user cancels; returns the `redirect_uri` URL with `error=access_denied` and `state`.                                                                                    |
| `createChat({ ownerId, title, type, ownerName, isForum })`                                                                            | A new supergroup, forum (`isForum`), basic group (`type: "group"`) or channel (`type: "channel"`) with no bot in it; returns its id.                                        |
| `addBotViaLink(chatId, botId, { by, startParameter, rights })`                                                                        | A person adds the bot through its `startgroup` link (as an administrator with `rights`), then `/start@<bot> <startParameter>` is posted; or its `startchannel` link.        |
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

| Flag                 | Default         | Meaning                                                |
| -------------------- | --------------- | ------------------------------------------------------ |
| `--token`            | required        | The bot's token.                                       |
| `--port`, `--host`   | 8081, 127.0.0.1 | Where to listen.                                       |
| `--username`         | `fake_test_bot` | The bot's username.                                    |
| `--config`           | none            | A JSON file with `chats` and `publicChats`.            |
| `--unimplemented-ok` | off             | Answer `true` to unsupported methods that return True. |

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
| `supportsJoinRequestQueries` | `false`          | A guard bot: where it has `can_invite_users`, join requests reach it with a `query_id`.      |
| `loginClientSecret`          | random           | The first bot's Telegram Login client secret.                                                |
| `chats`                      | `[]`             | Supergroups `{ id, title, ownerId, ownerName? }`. The bot is an administrator.               |
| `publicChats`                | `[]`             | Channels, groups and bots `{ username, type, title? }` resolvable by `getChat("@username")`. |
| `unimplemented`              | `"error"`        | Telegram's 404 for an unsupported method, or `"ok"`: `true` for one that returns True.       |
| `floodControl`               | `false`          | Hold or refuse sends over Telegram's published limits ([Flood control](#flood-control)).     |
| `clock`                      | real time        | `{ now: <Unix ms> }`: a manual clock that only `advanceTime` moves ([Time](#time)).          |
| `log`                        | none             | Receives one line per notable event: unsupported methods, webhook failures, internal errors. |

## Supported Bot API methods

These read or change the server's state:

`getMe`, `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`, `getChat`, `getChatMember`,
`getChatAdministrators`, `getChatMemberCount`, `getUserProfilePhotos`, `getFile`, `sendMessage`,
`sendPhoto`, `sendDocument`, `sendVideo`, `sendAnimation`, `sendSticker`, `sendPoll`, `stopPoll`,
`forwardMessage`, `copyMessage`, `editMessageText`, `editMessageReplyMarkup`, `editMessageCaption`,
`editMessageMedia`, `editEphemeralMessageText`, `editEphemeralMessageCaption`,
`editEphemeralMessageMedia`, `editEphemeralMessageReplyMarkup`, `deleteEphemeralMessage`,
`pinChatMessage`, `unpinChatMessage`, `unpinAllChatMessages`, `leaveChat`, `deleteMessage`,
`deleteMessages`, `sendVoice`, `sendAudio`, `sendVideoNote`, `sendMediaGroup`, `sendLocation`,
`sendVenue`, `sendContact`, `sendDice`, `sendChatAction`, `setMessageReaction`,
`deleteMessageReaction`, `restrictChatMember`, `banChatMember`, `unbanChatMember`,
`promoteChatMember`, `setChatAdministratorCustomTitle`, `setChatPermissions`, `setChatTitle`,
`setChatDescription`, `setChatPhoto`, `deleteChatPhoto`, `approveChatJoinRequest`,
`declineChatJoinRequest`, `answerChatJoinRequestQuery`, `createChatInviteLink`,
`exportChatInviteLink`, `editChatInviteLink`, `revokeChatInviteLink`, `answerCallbackQuery`,
`setMyCommands`, `deleteMyCommands`, `getMyCommands`, `getBusinessConnection`, and `sendMessage`,
`editMessageText` and `editMessageReplyMarkup` with `business_connection_id`.

These are not modelled: `setMyDescription`, `setMyShortDescription`,
`setChatMenuButton`, `setMyDefaultAdministratorRights`.

They and any other method not listed get Telegram's answer to a method it does not know: 404
`Not Found: method not found`, so a test cannot pass against behaviour the server does not have;
so do `editMessageCaption` and `editMessageMedia` with `business_connection_id`. `getCalls()`
(`GET /_fake/calls`) lists the unsupported methods called (those two as, for example,
`editMessageCaption with business_connection_id`), and `log` reports each once. With
`unimplemented: "ok"`, an unsupported method that Telegram documents as returning `True` answers
`true` instead; any other still gets the 404. Methods are added when a real bot needs them; the
goal is not full coverage of the Bot API.

Method names are case-insensitive. Parameters come as a query string, JSON, or URL-encoded or
multipart form data, read as Telegram's server reads them: a body of any other type is ignored, a
JSON body keeps the fields read before anything malformed, and only form data that cannot be read
is refused, with an empty 400. A JSON body's values are text, as a query string's are: `null` is
the text `null`, `1.50` stays `1.50`, and a string may hold raw control characters. A parameter
given twice keeps its first value, and the query string comes before the body.

## Behaves like Telegram

The details a moderation bot depends on, each covered by a test:

- **Permissions.** Unspecified permissions are false, except that `can_manage_topics` and
  `can_edit_tag` follow `can_pin_messages`, and `can_react_to_messages` follows `can_send_messages`
  as passed. Then, unless `use_independent_chat_permissions` is set, broader permissions imply
  narrower ones (`can_send_other_messages` implies media and text, `can_send_polls` implies text).
  Each permission must be a JSON `true` or `false`
  (`can't parse chat permissions: Field "can_send_polls" must be of type Boolean` otherwise), and
  `permissions` given empty fail with `can't parse permissions JSON object`.
  A member needs both their own permission and the chat's default from `setChatPermissions` to post;
  a photo needs `can_send_photos`, not only `can_send_messages`. `setChatPermissions` needs
  `can_restrict_members` (`not enough rights to change chat permissions`) and refuses a channel
  (`can't change channel chat permissions`). `getChat` returns the default `permissions` for groups
  and supergroups, not for channels.
- **Restrictions stick.** A restricted user who leaves and rejoins is still restricted. An
  `until_date` from 30 seconds to 366 days away ends the restriction or ban then, on the server's
  clock; any other date makes it permanent. When it ends, a restricted user is a member again, or
  `left` if they left meanwhile, and a banned user is `left`.
- **Protected members.** Restricting or banning the chat owner, an administrator or the bot itself
  fails with Telegram's error.
- **Moderation rights** ([banChatMember](https://core.telegram.org/bots/api#banchatmember),
  [approveChatJoinRequest](https://core.telegram.org/bots/api#approvechatjoinrequest)).
  `restrictChatMember` works only in supergroups, and `promoteChatMember` and `unbanChatMember` only
  in supergroups and channels. Restricting, banning and unbanning need `can_restrict_members`, and
  approving or declining a join request `can_invite_users`, checked before anything changes.
  Refusals carry Telegram's own texts, such as
  `not enough rights to restrict/unrestrict chat member`, `method is available only in supergroups`
  or, for a basic group that only an administrator may remove members from, `CHAT_ADMIN_REQUIRED`.
  A pending join request does not make its user a member.
- **Bans.** A ban deletes no messages, as on Telegram: `revoke_messages` only decides what the
  removed user can still see, which this server does not model. A bot that wants a banned user's
  messages gone deletes them with `deleteMessage` or `deleteMessages`. A basic group keeps no ban
  list, so a person banned there is then `left`, as TDLib reports someone no longer in the group; a
  bot removed from one sees itself `kicked`.
- **Unbanning.** `unbanChatMember` leaves a banned user outside the chat. Without `only_if_banned`
  it removes a current member, as the docs guarantee; with it, a user who is not banned stays as
  they are.
- **Deleting messages** ([deleteMessage](https://core.telegram.org/bots/api#deletemessage)). A bot
  deletes its own messages, others' with `can_delete_messages`, and any message in a private chat.
  A message sent 48 hours ago or earlier, the service message that created a supergroup, channel or
  forum topic, and a dice in a private chat less than a day old can't be deleted
  (`message can't be deleted`). `deleteMessages` skips ids it does not find and, as TDLib does,
  checks every other message before deleting any, so one it can't delete fails the whole call.
- **Editing.** Only the bot's own messages can be edited, except in a channel (below); an edit that
  changes nothing fails with `message is not modified`; an edit without `reply_markup` removes the
  inline keyboard, after which its buttons can no longer be pressed. As in TDLib's
  [`can_edit_message`](https://github.com/tdlib/td/blob/master/td/telegram/MessagesManager.cpp),
  a forward, and a message sent with a reply keyboard, `remove_keyboard` or `force_reply`, can't be
  edited either, nor can its poll be stopped. Editing a message the bot can't edit fails with
  `message can't be edited`, or `message media can't be edited` from `editMessageMedia`.
  `editMessageText` needs a text message (`there is no text in the message to edit`), and
  `editMessageCaption` a photo, video, animation, audio, document or voice message
  (`there is no caption in the message to edit`); `editMessageMedia` replaces a photo, live photo,
  video, animation, audio, document or text. A sticker, video note, location, contact or dice only
  has its inline keyboard changed. A live location still counts as editable while its
  `live_period` runs, so text and caption edits then fail with the two errors above rather than
  `message can't be edited`. An empty caption is left out of the message.
- **Channels** ([Update](https://core.telegram.org/bots/api#update),
  [ChatAdministratorRights](https://core.telegram.org/bots/api#chatadministratorrights)). Every
  message in a channel comes from the channel: `sender_chat` is the channel and there is no `from`,
  both for what bots send and for what people post (channel signatures are not modelled). Bots get
  the channel's messages, service messages such as `new_chat_title` included, as `channel_post` and
  their edits as `edited_channel_post`, never as `message`. Subscribers have no permissions: only the
  creator and administrators with `can_post_messages` post, and only the creator and administrators
  with `can_change_info` change the title or photo; `post()` refuses anyone else with
  `CHAT_WRITE_FORBIDDEN`, and `renameChat` and `changeChatPhoto` with `CHAT_ADMIN_REQUIRED`. A bot
  with `can_edit_messages` edits any post and stops any poll; without it, only its own, and only
  while it has `can_post_messages`. A bot deletes its own posts with `can_post_messages` and anyone's
  with `can_delete_messages`. A press on a post's button goes to the bot that put the keyboard
  there, also when it added the keyboard to someone else's post by an edit (unverified: Telegram
  does not document which bot gets that press).
- **Private chats.** The bot cannot message a user who has not written to it first (403). The
  exception is a join request: a bot that receives it may message its `user_chat_id` for five
  minutes, until the request is approved or declined, as
  [ChatJoinRequest](https://core.telegram.org/bots/api#chatjoinrequest) documents. The five
  minutes follow the server's clock, so `advanceTime` can end them.
- **Ephemeral messages** ([Bot API](https://core.telegram.org/bots/api#ephemeral-messages-and-commands)).
  A send with `ephemeral_message_parameters` is shown to one member. It returns `message_id` 0,
  `receiver_user` and an `ephemeral_message_id` of its own, and takes no message id from the chat.
  A poll, a dice or a live location cannot be sent this way (`unallowed message content specified`).
  The regular edit and delete methods cannot reach it; only the bot that sent it changes it, with the
  `editEphemeralMessage…` methods and `deleteEphemeralMessage`, which return `true`.
  `editEphemeralMessageText` and `editEphemeralMessageCaption` reach Telegram as the same request,
  so either one changes a text message's text or a media message's caption. The receiver must be a
  member of the group or supergroup and not a bot. A bot that administers the chat may send one at
  any time; any other bot needs the `callback_query_id` of a button press it received from the
  receiver, at most 15 seconds old. Who may get the message is checked after the chat, the reply and
  the content. Members cannot send ephemeral commands here, so `reply_parameters.ephemeral_message_id`
  never qualifies. Unverified: Telegram does not document the errors (`PEER_ID_INVALID` outside
  groups, `USER_IS_BOT`, `USER_NOT_PARTICIPANT`, `CHAT_ADMIN_REQUIRED` without an eligible action,
  and `MESSAGE_ID_INVALID` for an unknown or deleted ephemeral message, or one another bot sent),
  whether an ephemeral edit without `reply_markup` removes the keyboard (it does here) and an edit
  that changes nothing fails (it does not here), or which text edits it refuses (here a caption may
  have 1024 characters, and an empty text, or a caption for content that takes none, leaves the
  message as it was). Tests see these messages in `getMessages`, with their receiver, and find one
  by `ephemeral_message_id` with `getEphemeralMessage`; `pressEphemeralButton` presses its buttons as
  the receiver. A `message` wait by author and exact text finds them too.
- **Inline keyboards.** Every button needs `text` and an action: a button without `text` fails with
  `can't parse InlineKeyboardButton: Can't find field "text"`, and one with only `text` (or an empty
  `callback_data`) with Telegram's `Text buttons are not allowed in the inline keyboard`. A button
  that sets several actions keeps only the first one Telegram reads (`url`, then `callback_data`,
  then the others), so a button with both `url` and `callback_data` comes back with only its `url`
  and cannot be pressed. A sent or edited message returns each button with only its `text`,
  `icon_custom_emoji_id`, `style` and that one action. `callback_data` is limited to 64 bytes of
  UTF-8, not 64 characters; longer data fails with `BUTTON_DATA_INVALID`. Buttons are checked when
  the request is read, before the chat is looked up; the length of `callback_data` only after the
  chat and message checks. Sends, business sends, edits, ephemeral edits and `stopPoll` all check
  this, and a send checks `inline_keyboard` even when a reply `keyboard` sent with it wins.
  `stopPoll` does not put its keyboard on the message here.
- **Callback queries.** Answering a query that was never sent fails. Answer text is limited to 200
  characters; a longer answer fails with `MESSAGE_TOO_LONG` and the query stays open, so the bot can
  answer it again. `chat_instance` is an opaque number that is the same for every press in a chat;
  it is not the chat id.
- **Command menus.** `setMyCommands`, `getMyCommands` and `deleteMyCommands` keep one list for each
  `scope` and `language_code`. `getMyCommands` returns only the list set for that exact scope and
  language (an empty list if there is none), and `deleteMyCommands` removes only that list. A scope
  Telegram cannot read fails with its `can't parse BotCommandScope: …` error: one that is not an
  object, an unknown `type`, an empty `chat_id`, or a `chat_member` scope without a positive
  `user_id`. A chat scope's chat must be one the bot can see (`chat not found` otherwise); a private
  chat takes only the `chat` scope, and a channel takes none. `language_code` must be empty or two
  lower-case letters (`invalid language code specified`). After the scope and language, each command
  is trimmed and loses a leading `/`, and its description is trimmed; they are stored that way. An
  empty command or description fails with `command must be non-empty` or
  `command description must be non-empty`, and one over 32 or 256 characters with
  `command length must not exceed 32` or `command description length must not exceed 256`. The
  characters a command may use are not checked here.
- **Parameters.** A boolean parameter is true when it reads `true`, `yes` or `1`, in any case. A
  flag inside `reply_parameters`, `link_preview_options`, `reply_markup` or `permissions` must be a
  JSON `true` or `false`, or the call fails, for example with
  `field "remove_keyboard" must be of type Boolean`. A user id is an optional `-` and the digits
  after it (`12abc` is 12; a leading space or `+` makes it invalid), and `reply_to_message_id`,
  `message_thread_id` and `until_date` are read by their leading digits too, so `null` is 0. A
  JSON-serialized parameter (`reply_markup`, `reply_parameters`, `message_ids`, `media`, ...) may
  also come as a JSON string; one that cannot be read fails with Telegram's parse error, such as
  `can't parse reply keyboard markup JSON object`. A missing required parameter fails with
  Telegram's text, such as `chat_id is empty` or `invalid user_id specified`. If this server itself
  fails, the bot gets Telegram's bare `500 Internal Server Error`, and the cause goes to `log`.
- **Invite links.** Creating, exporting, editing and revoking links needs `can_invite_users`
  (`not enough rights to manage chat invite link` otherwise); editing or revoking without a link
  fails with `invite link must be non-empty`. Each administrator has its own primary link:
  `exportChatInviteLink` replaces only the calling bot's, `getChat` returns it as `invite_link`
  (generating one when the bot has none; an upgraded basic group has none), revoking it generates
  a new one, and it cannot be edited (`CHAT_INVITE_PERMANENT`). A bot edits and revokes only links
  it created. An edit sets every field: one it leaves out goes back to its default (no name, no
  `expire_date`, no `member_limit`, no join requests). `member_limit` is capped at 100000. A
  link's `member_limit` counts the members who joined through it and are still in the chat,
  restricted or promoted ones included; a join past it, after `expire_date` or through a revoked
  link fails with `INVITE_HASH_EXPIRED`, and a link that creates join requests cannot have a
  `member_limit`. A bot sees a link another administrator created with the second part of its hash
  replaced by `...` (TDLib's form; the Bot API docs print "…"). Links are `https://t.me/+`
  followed by a random hash. Unverified: how much of the hash is hidden (here the
  second half), the error for revoking another administrator's link (here `CHAT_ADMIN_REQUIRED`),
  and the error for joining through a full link (here `INVITE_HASH_EXPIRED`, as Telegram's apps
  call such a link expired).
- **Entities.** Member messages and captions carry the entities Telegram finds by itself, found
  the way TDLib finds them: `mention`, `bot_command` (anywhere it does not touch a letter, digit,
  `_`, `/`, `<` or `>`), `hashtag`, `cashtag`, `url` and `email`, with UTF-16 offsets, in groups
  and in private chats. A link without a protocol needs a common top-level domain, so `example.com` is a
  link and `package.json` is not. Phone numbers are not marked.
- **Media.** Sent photos, documents, videos, animations, stickers, voice notes, audio and video
  notes carry the fields the Bot API requires and resolve through `getFile`. They keep what the
  sender says: a video's or animation's `width`, `height` and `duration`, a video note's `length`,
  an audio's `title` and `performer`, an uploaded sticker's `emoji`, capped as the Bot API caps
  them (sizes at 10000, durations at a day). A video note's `length` over 640 then fails with
  `wrong video note length`, as in TDLib. What the sender leaves out gets a stand-in (1280x720,
  one second). An animation also carries `document`. A photo has one size: its image's, read from
  a PNG, GIF or JPEG header and scaled down to fit 2560x2560, Telegram's largest, or 800x800 when
  the header cannot be read. Telegram also lists smaller sizes. A contact keeps its `vcard`. A
  location with `live_period` is a live location with its `heading` and `proximity_alert_radius`,
  refused out of Telegram's ranges, and off the map with `invalid live location specified`.
  Coordinates are read by their leading number (`12abc` is 12, and text without one is 0), and a
  point off the map is refused only after the chat is checked.
  `sendMediaGroup` sends up to 10 items as one album; a single item is sent as an ordinary
  message, as TDLib does. Photos, live photos and videos can share an album. As in Telegram's Bot
  API server, it reads `reply_parameters` before `media`, reads every item before the chat, failing
  with `can't parse InputMedia: …` (such as `type "animation" can't be used in sendMediaGroup` or
  `type "sticker" is unsupported`), and checks the replied message before it reads any file or
  counts the album.
- **Files** ([sending files](https://core.telegram.org/bots/api#sending-files)). Each bot gets its
  own opaque `file_id` for a file, and `file_unique_id` is the same for every bot. A bot can send
  again, `getFile` and download (with its own token) only the file_ids it was given. `getFile` on
  another bot's fails with `wrong file_id or the file is temporarily unavailable`, and sending it
  with `wrong file identifier/HTTP URL specified`, the Bot API's text for Telegram's `MEDIA_EMPTY`.
  `editMessageMedia` with it fails with `MEDIA_EMPTY` itself, since only sends translate it
  (unverified: Telegram does not document its answer to an edit). A send without its file, or with
  an `attach://` name that has no upload, fails with `there is no photo in the request` (`video`,
  `video note`, `voice` and so on). A string that is not a file_id fails with TDLib's reason, such
  as `wrong remote file identifier specified: can't unserialize it`. As in TDLib, any string with a
  dot is an HTTP URL, refused when TDLib cannot parse it, such as
  `invalid file HTTP URL specified: Unsupported URL protocol` for anything but `http` and `https`;
  this server does not fetch it and stores a one-byte file instead. A file sent again keeps its
  kind: a photo cannot stand in for any other kind, nor any other kind for a photo
  (`can't use file of type Photo as Document`), and a document, video or the like sent by another
  method stays what it was; a live photo's video sent on its own is a video. `getFile`'s
  `file_path` starts with the directory TDLib keeps that kind of file in, such as `photos/`,
  `voice/` or `music/`. The control API shows messages with the first bot's file_ids.
- **Editing media.** `editMessageMedia` turns a text, or a photo, live photo, video, animation,
  audio or document message, into any of these, from an upload (`attach://`), a `file_id` or a
  URL. It reads the `InputMedia` before the message, in the Bot API's order: the caption's markup,
  `type`, which is required, `media`, then whether the type can be edited to, each failing with
  `can't parse InputMedia: …`. A document with `disable_content_type_detection` is a plain file, so
  a photo is refused `as DocumentAsFile`. In an album, a photo or video becomes only a photo, live
  photo or video, and an audio or document keeps its kind. Other messages' media cannot be edited.
- **More than one bot.** Each bot has its own webhook or update queue and its own membership and
  rights in each chat. A bot posts only where it is a member (a channel needs `can_post_messages`),
  edits and stops only its own messages and polls (in a channel, others' too with
  `can_edit_messages`), pins only with `can_pin_messages` (a channel's `can_edit_messages`), and
  deletes others' messages only with `can_delete_messages`. A bot hears of its own status changing
  as `my_chat_member`, whether the owner or another bot changed it; the chat's administrator bots
  hear of it as `chat_member`. `can_be_edited` is true only for the bot that promoted that
  administrator, and `getChatAdministrators` leaves out other bots unless `return_bots` is set. Only
  the bot that put a keyboard on a message, by sending the message or by the last edit that set the
  keyboard, hears its buttons pressed. Users write privately only to the first bot, so no other bot
  can message them (403), except a join requester: any bot that receives the request may message
  them for five minutes, as under **Private chats**.
- **Which chats a bot may use.** Checked once a method has read its other arguments, as
  Telegram's Bot API server does, so a malformed argument is reported first. A chat the bot was
  never in is `400 Bad Request: chat not found`. A bot kicked from a supergroup or channel gets
  `403 Forbidden: bot was kicked from the supergroup chat` (or `channel chat`) for every call,
  reads like `getChat` included, and one that left or was removed gets
  `403 Forbidden: bot is not a member of the supergroup chat`. The chat of a message the bot
  replies to in another chat (`reply_parameters.chat_id`) gets the same checks. In a basic group,
  a bot that left or was removed can still make the calls that need only read access: `getChat`,
  `leaveChat`, `getChatMember` about itself, `setMessageReaction`, `deleteEphemeralMessage`, and
  naming the chat as the source of a forward, copy or reply; every other call gets the
  `group chat` form of the same errors.
- **Polls.** `sendPoll` needs a question of up to 300 characters and 1 to 12 options of up to 100
  characters each. Both are kept trimmed of spaces and newlines, as Telegram keeps them, and the
  limits count what is left; one that then shows nothing fails with `text must be non-empty`.
  `question_parse_mode` and an option's `text_parse_mode` are not read. A `type` other than
  `regular` or `quiz` fails with `unsupported poll type specified`. It keeps `is_anonymous`,
  `allows_multiple_answers`, `allows_revoting` (on by default for regular polls, off for
  quizzes), `members_only` (channels only), `is_closed`, `description` and an attached photo, and
  gives each option a `persistent_id`. A quiz needs `correct_option_ids` (or the older
  `correct_option_id`) and may have an `explanation`, formatted with `explanation_parse_mode` or
  `explanation_entities`; its 200-character limit is not checked. While a quiz is open, only a bot
  that knows its correct options sees them and the explanation in the poll, in forwards, replies
  and pins too: the bot that sent it itself, not as a forward, or a bot in a private chat
  ([Poll](https://core.telegram.org/bots/api#poll)). Once it is closed every bot sees them.
  `stopPoll` closes a poll once; a poll in a message the bot can't edit (see **Editing**) fails
  with `poll can't be stopped`. The bot that stopped it and the bot that sent it then get the
  closed poll as a `poll` update, as [Update](https://core.telegram.org/bots/api#update) says.
  Members do not vote.
- **Forwards and copies.** A forward carries `forward_origin`; a copy does not. A forward of a
  forward keeps the first origin and its date. A bot cannot forward from a chat it is not in; the
  source chat gets the checks above for a call that needs only read access, before the chat the
  message goes to. A missing message fails with `message to forward not found` or
  `message to copy not found`. Service messages can't be forwarded or copied
  (`the message can't be forwarded` / `copied`). Nor can an open quiz be copied by a bot that does
  not know its correct options (see **Polls**); once the quiz is closed any bot copies it. A send
  with `protect_content`, a forward or an album included, has `has_protected_content`; it can't be
  forwarded, but the bot can still copy it. One item of an album is forwarded or copied without
  its `media_group_id`. A copy's `caption` replaces the original on media that takes one,
  formatted with `parse_mode` or `caption_entities`, and an empty one removes it; a text message
  gets no caption, so the 1024-character limit applies only to media.
- **Pins** ([unpinChatMessage](https://core.telegram.org/bots/api#unpinchatmessage)). Pinned
  messages are kept newest first by sending date. `getChat` returns the most recent one that was
  not deleted as `pinned_message`, and `unpinChatMessage` without `message_id` unpins it. This
  works in groups, channels and private chats; a private chat's pin shows only to the first bot,
  since that is the bot users write to. The message is checked before the bot's rights: a missing
  message fails with `message to pin not found` or `message to unpin not found` (also when nothing
  is pinned), and only an existing one with
  `not enough rights to manage pinned messages in the chat`. Each pin, by a bot or by a person
  (`pinMessage`), posts the `pinned_message` service message, which reaches every bot in the chat,
  the pinning bot included. Neither `pinned_message` carries the pinned message's
  `reply_to_message`.
- **What members send.** Besides text and photos, members post videos, animations (which carry a
  `document` too), stickers, voice notes, audio, video notes and documents, each needing its own
  permission (`can_send_videos`, `can_send_voice_notes`, ...), plus albums sharing a
  `media_group_id` and forwards with `forward_origin` (a user, a hidden user or a channel post).
  An edit by the author reaches bots as `edited_message` (in a channel, `edited_channel_post`) with
  `edit_date`. A member's text and captions, in posts and in edits, are trimmed of spaces and
  newlines at both ends, as Telegram's apps send them. A post, private message or edit whose text
  then shows nothing (only spaces, zero-width or other blank characters) fails with
  `MESSAGE_EMPTY`; such a caption is dropped.
- **Reactions.** A member's reaction reaches the chat's administrator bots as `message_reaction`,
  only when they list it in `allowed_updates`, as on Telegram. A bot sets at most one reaction,
  and only an emoji from the [ReactionTypeEmoji](https://core.telegram.org/bots/api#reactiontypeemoji)
  list (any other emoji fails with `REACTION_INVALID`, and a paid reaction is refused) or a custom
  emoji, whose `custom_emoji_id` must be an integer. A custom emoji is accepted without checking
  that it is already on the message or allowed by the chat's administrators. A reaction on an
  album lands on its first message that is not deleted. The bot removes a member's reaction with
  `deleteMessageReaction` and `can_delete_messages`; `actor_chat_id` may stand in for `user_id`,
  though members here never react as a chat. A user's id there removes that user's reaction, and
  a chat this server does not know fails with `reaction sender not found`. The ids and the message
  are checked before the bot's rights.
- **Administrators and chat settings.** `promoteChatMember` needs `can_promote_members` and grants
  only rights the bot holds. Rights the kind of chat does not have (below) are dropped first, as
  TDLib drops them; any one right left makes an administrator, `can_send_welcome_messages`,
  `can_manage_tags` and `can_manage_direct_messages` included, and none leaves a member. A channel
  promotion that names any right also grants `can_restrict_members` unless the call says
  otherwise. The bot can then edit and title the administrators it promoted. An administrator
  carries the rights its kind of chat has, as Telegram writes them: `can_post_messages`,
  `can_edit_messages` and `can_manage_direct_messages` in channels, `can_pin_messages` and
  `can_manage_tags` in groups, and `can_manage_topics` in supergroups.
  `setChatTitle`, `setChatDescription`, `setChatPhoto` and `deleteChatPhoto` need `can_change_info`
  and post Telegram's service messages to every bot in the chat, the bot that made the change
  included. A title is cut to 128 characters and a description to 255, after TDLib's cleaning:
  blank characters such as U+2800 become spaces, U+2028 to U+202E are dropped, only ASCII spaces
  are trimmed, and in a title each run of spaces, newlines and no-break spaces becomes one space.
  A title left empty fails with `title must be non-empty`. The current title set again succeeds
  without a service message, while an unchanged description or a missing photo is refused.
- **Join request queries (Bot API 10.x).** A guard bot (`supportsJoinRequestQueries`) with
  `can_invite_users` gets each join request with a `query_id`, which it answers with
  `answerChatJoinRequestQuery` (`chat_join_request_query_id`, `result`: `approve`, `decline` or
  `queue`, in any case).
- **Business connections** ([Bot API](https://core.telegram.org/bots/api#businessconnection),
  [connected business bots](https://core.telegram.org/api/bots/connected-business-bots)). An owner
  connects the bot to their account; the bot gets `business_connection` on every change, and
  `business_message` for each message in the owner's private chats while the connection is enabled,
  from the person or from the owner answering by hand. `sendMessage` with `business_connection_id`
  answers as the owner, with `sender_business_bot` set. It needs an enabled connection, `can_reply`,
  and a message from the person in the last 24 hours (`BUSINESS_PEER_USAGE_MISSING` otherwise, as
  [documented](https://core.telegram.org/method/messages.sendMessage)). An unknown connection is
  `business connection not found`, as the Bot API says. Unverified: the error for a disabled
  connection (`BUSINESS_CONNECTION_INVALID`) and for a missing `can_reply`
  (`400 BOT_ACCESS_FORBIDDEN`; the Bot API never answers such an error with 403).
  `editMessageText` and `editMessageReplyMarkup` with `business_connection_id` edit the bot's and
  the owner's messages in a business chat, under the same rules as sending; the owner's own
  messages without an inline keyboard only within 48 hours, as documented. Unverified: the errors,
  taken from [messages.editMessage](https://core.telegram.org/method/messages.editMessage), for the
  person's message (`MESSAGE_AUTHOR_REQUIRED`), an unknown one (`MESSAGE_ID_INVALID`) and the 48
  hours (`MESSAGE_EDIT_TIME_EXPIRED`). The connected bot may also message the owner's private chat
  (`user_chat_id`). `getMe` reports `can_connect_to_business`.
- **Redelivery.** A test can have Telegram deliver any update again, byte for byte, callback queries
  included, as it does when a webhook does not confirm one. It sends the saved update, so do not
  restore an earlier snapshot between the steps of a replay.
- **Adding the bot through a link** ([links](https://core.telegram.org/api/links#group-channel-bot-links),
  [deep linking](https://core.telegram.org/bots/features#deep-linking)). With admin rights
  requested, only the creator or an administrator with `can_promote_members` may add it; without,
  anyone who can add members (`can_invite_users`). Otherwise the person gets `CHAT_ADMIN_REQUIRED`.
  The bot gets `my_chat_member` from the person, the chat's administrator bots `chat_member`, all
  bots the `new_chat_members` message, and then the person's `/start@<bot> <parameter>` with a
  `bot_command` entity, as `messages.startBot` posts. An administrator's existing rights are
  combined with the requested ones, and `/start` is still posted. Unverified: Telegram does not
  document whether `my_chat_member` or the `/start` message arrives first; this server sends
  `my_chat_member` first. A channel's `startchannel` link always asks for admin rights and has no
  parameter, so the bot only gets `my_chat_member` and nothing is posted; `addBotViaLink` on a
  channel fails without `rights` or with a `startParameter`.
- **Service messages about the bot itself.** A bot gets the `new_chat_members` and
  `left_chat_member` messages that name it, as the
  [Message](https://core.telegram.org/bots/api#message) fields say it "may be the bot itself". It
  also gets the `new_chat_title`, `new_chat_photo`, `delete_chat_photo` and `pinned_message`
  messages its own calls post, as Telegram's Bot API server delivers them.
- **Basic groups and the upgrade** ([migration](https://core.telegram.org/api/channel#migration)).
  A basic group has a negative id without the `-100` prefix. The creator or an administrator can
  upgrade it: a new supergroup takes its members, administrators and bots, the old chat posts
  `migrate_to_chat_id` and the new one `migrate_from_chat_id`. Later Bot API calls to the old id
  fail with `400 Bad Request: group chat was upgraded to a supergroup chat` and
  `parameters.migrate_to_chat_id` ([ResponseParameters](https://core.telegram.org/bots/api#responseparameters)),
  except these: `getChat` still returns the old group, `leaveChat` fails with
  `400 Bad Request: chat is deactivated`, and a forward, copy or reply still takes a message from
  it. Telegram's server raises the upgrade error only for calls that write or read the member
  list. Unverified: what it answers to other calls on the old id (`getChatMember` about the bot
  itself, `setMessageReaction`, edits), so this server keeps the upgrade error for them; and
  whether bots get `my_chat_member` on the upgrade, which this server does not send.
- **People changing the chat.** A person with `can_change_info` renames the chat or sets its photo,
  with the same `new_chat_title` and `new_chat_photo` service messages as `setChatTitle` and
  `setChatPhoto`; `getChat` returns the title and a `ChatPhoto`. Its small and big photos, like
  those of a user's `ChatPhoto`, are files of their own, apart from the `new_chat_photo` sizes:
  `getFile` serves them under `profile_photos/`, and no send takes them
  (`can't use file of type ChatPhoto as Photo`).
- **Forum topics.** In a forum, a send to a `message_thread_id` that is not a topic fails with
  `message thread not found`. A member's message in a topic that answers nothing replies to the
  topic's creation message, as on Telegram.

### Flood control

Off by default. With `floodControl: true`, the server limits a bot's sends the way Telegram does
once the bot goes over the limits Telegram publishes in its
[Bots FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this):

- one message a second in a chat. Telegram says it may allow short bursts above this; here an album
  is such a burst, sent once the chat's last message is a second old;
- 20 messages a minute in a group or supergroup;
- 30 messages a second from one bot across all its chats (paid broadcasts are not modelled).

These numbers are Telegram's published guidance, not its internal algorithm, which Telegram does not
publish. A bot that stays within them here can still be limited differently on Telegram.

Each bot has its own limits. A call that sends messages counts them after its parameters are
checked: `sendMessage`, the other `send…` methods, `forwardMessage` and `copyMessage` count one
message, and `sendMediaGroup` counts every message of the album. Edits, deletions, `sendChatAction`
and business messages (`business_connection_id`) are not counted.

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
- Each server makes its own signing key the first time a token or `jwks.json` needs it, so tests
  that never log in do not wait for it.

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

`getOwnerCalls` returns a copy of every call with its outcome: `pending` until it answers, then
`ok`, `error`, `malformed` or `dropped`, or `cancelled` when the server stops during its delay.
Times follow the server's clock. Any field named like a session, token, hash, key, secret, password
or phone is recorded as `[redacted]`.

### Not modelled, and unverified

- Not modelled: MTProto, login, updates and event handlers (`addEventHandler`), sending, reading
  and deleting from the client, media downloads, drafts, forum topics, reactions and forwards in
  history, `messages.getDialogFilters` for chatlists, and every other GramJS method.
- Unverified: Telegram does not document the order of dialogs with equal dates (this server breaks
  ties by message id, then peer id), whether a cursor page without `excludePinned` repeats pinned
  dialogs (here it does not), or what GramJS raises for a response lost mid-call (here `TIMEOUT`).
  Unread counts are what a test sets; they are not derived from messages.

## Update delivery

Each bot has its own update queue, as on Telegram, where
[Telegram's Bot API server](https://github.com/tdlib/telegram-bot-api) settles what the docs leave
out. Its updates are numbered in sequence, so two bots can get the same `update_id`. An update
stays pending until the bot confirms it: with a `getUpdates` offset, or by answering it from its
webhook with a 2XX status. A pending update expires a day after it happened, and a button press
after 150 seconds.

- **Webhook requests** carry only the headers Telegram sends: `Host`, `Authorization` when the URL
  holds a user name and password, `X-Telegram-Bot-Api-Secret-Token` when a secret was set,
  `Content-Type: application/json`, `Content-Length`, `Connection: keep-alive` and
  `Accept-Encoding: gzip, deflate`.
- **Order.** Updates wait in queues keyed as Telegram keys them: messages and `my_chat_member` by
  chat, `chat_member`, join requests and button presses by user, reactions by chat. A queue's updates
  arrive one at a time, in order; different queues are delivered at once, up to `max_connections`
  requests (1 to 100, default 40). When more queues are ready than connections are free, the queue
  ready longest goes first, then the one with the lowest queue id, as on Telegram. Updates pending
  when the webhook is set are ready together; an update the webhook refused is ready again only
  when its retry is due, behind the queues already waiting. Telegram also opens its connections
  gradually and loads at most twice `max_connections` updates at a time; this server does neither.
- **Retries.** An update the webhook does not answer with 2XX (another status, a refused or reset
  connection, or a minute without an answer) is sent again: at once after the first failure, then
  after 2, 4, 8 ... seconds up to a random 60 to 120, or after the answer's `Retry-After` (at most an
  hour). An update whose next try would come after it expires is dropped. These waits run on the
  server's clock, so on a manual clock `advanceTime` moves them.
- **Calls in the webhook's answer.** A webhook may answer an update with a Bot API call (JSON, form or
  multipart with a `method` field), as Telegraf does by default. It runs as that bot and appears in
  `getCalls()`; its result goes nowhere. `setWebhook`, `deleteWebhook`, `close`, `logOut` and any
  `get` method are not run.
- **`getWebhookInfo`** reports `pending_update_count`, `last_error_date` and `last_error_message`
  in Telegram's words: `Wrong response from the webhook: 500 Internal Server Error`, a connection
  error as Linux words it (`Connection refused`, `Connection reset by peer`, `Connection timed out`,
  `No route to host`, `Network is unreachable`, `Broken pipe`), `Read timeout expired`, or a TLS
  failure as OpenSSL 3 words it, such as
  `SSL error {error:0A000086:SSL routines::certificate verify failed}`. A connection closed without
  an answer records no error, and neither does any other connection error. It also reports
  `max_connections`, `ip_address` (the `ip_address` given, or the address the host name resolved
  to; `<unknown>` only while `setWebhook` is still resolving it), `has_custom_certificate`, and
  `allowed_updates` unless it is the default.
- **`setWebhook`** answers `Webhook was set` or `Webhook is already set`, and `deleteWebhook`
  `Webhook was deleted` or `Webhook is already deleted`. It refuses a URL Telegram cannot read
  (`invalid webhook URL specified`; a URL without a scheme is taken as https) and a `secret_token`
  longer than 256 characters or with characters other than `A-Z`, `a-z`, `0-9`, `_` and `-`. Unless
  `ip_address` is given, it resolves the URL's host name before it answers and sends to the first
  IPv4 address (an IPv6 one only when there is none). A name that does not resolve is refused with
  `Bad Request: bad webhook: Failed to resolve host: Name or service not known` (the lookup error in
  glibc's words). Telegram looks the name up again about every half hour; this server keeps the
  first address. A new webhook replaces the old one first, so a refused URL leaves none, and a
  `setWebhook` still resolving when another one arrives gets 409
  `Conflict: terminated by other setWebhook`. `drop_pending_updates` empties the queue, even with an
  empty URL. With `floodControl`, a URL less than a second after the previous one gets 429
  ([Flood control](#flood-control)). An uploaded `certificate` only sets `has_custom_certificate`:
  deliveries over https trust what Node trusts, not that certificate as Telegram does. Like a Bot
  API server run with `--local`, this one takes `http` URLs, any port and local addresses.
- **Removing or replacing the webhook** ends its requests in progress. Every update it has not
  confirmed stays pending, the one in flight included, for `getUpdates` or the new webhook.
- **`getUpdates`** supports `offset`, `limit`, `allowed_updates` and long polling with `timeout`.
  Calling it while a webhook is set fails with 409. A new waiting poll ends the one before it with
  409 and this description:
  `Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`.
  `setWebhook` ends it with 409 `Conflict: terminated by setWebhook request`. As on Telegram, a
  second conflict within 3 seconds is answered 3 seconds later. A poll whose client hangs up stops
  waiting.
- **`allowed_updates`**, from `setWebhook` or `getUpdates`, is a list or the same list as a JSON
  string, in any body. Names match in any case and unknown ones are skipped; an empty list, or one
  with no known name, means the default: every update but `chat_member`, `message_reaction` and
  `message_reaction_count`.
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
- Bot API calls answer without waiting for the updates they cause, so a webhook bot that leaves a
  chat or promotes someone inside its handler does not wait for itself.

The server delivers resulting updates asynchronously. Tests should wait for the exact update
rather than depend on response/update ordering; the Bot API does not promise that ordering.

## Control API

The test actions above, over HTTP, for tests written in other languages. All routes live under
`/_fake/` and take and return JSON. A route that fails answers `{ error }` with an HTTP status.

| Route                                                  | Effect                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST users`                                           | Create a user `{ first_name?, last_name?, username?, language_code?, bio?, is_bot?, is_premium? }`; returns `{ id }`.                                                                                                                                                    |
| `POST business/connections`                            | Connect `{ owner_id, rights, id?, is_enabled?, bot_id? }`, or change the connection with `id`; returns `{ connection, update_id }`.                                                                                                                                      |
| `GET business/connections/:id`                         | The `BusinessConnection`.                                                                                                                                                                                                                                                |
| `POST business/connections/:id/chats/:userId/messages` | `{ sender: "person" \| "owner", text }`; returns `{ message_id, date, update_id }`.                                                                                                                                                                                      |
| `GET business/connections/:id/chats/:userId/messages`  | The business chat, newest first, as `[{ direction, deleted, message }]`.                                                                                                                                                                                                 |
| `POST updates/:updateId/redeliver`                     | Deliver that update again to its bot's webhook `{ bot_id? }`; 404 for an unknown update, 409 when the bot has no webhook or `bot_id` must name one of several bots that got it. Returns `{ update_id }`.                                                                 |
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
| `POST chats/:id/messages/:messageId/pin`               | The user `{ user_id }` pins the message, with `can_pin_messages` (in a channel, `can_edit_messages`); returns the service message's `{ message_id }`.                                                                                                                    |
| `GET chats/:id/messages`                               | Messages not deleted, newest first, ephemeral ones (`message_id` 0, with `receiver_user`) included in the order they were sent.                                                                                                                                          |
| `GET chats/:id/ephemeral-messages/:eid`                | `{ exists, deleted, message }` for the ephemeral message with `ephemeral_message_id` `:eid`.                                                                                                                                                                             |
| `POST chats/:id/ephemeral-messages/:eid/callback`      | Its receiver `{ user_id, data }` presses an inline button; returns the bot's answer.                                                                                                                                                                                     |
| `GET chats/:id/messages/:messageId`                    | `{ exists, deleted, message, reactions }`, reactions by user id.                                                                                                                                                                                                         |
| `POST chats/:id/messages/:messageId/callback`          | The user `{ user_id, data }` presses an inline button; returns the bot's answer.                                                                                                                                                                                         |
| `GET chats/:id/members/:userId`                        | The member as `getChatMember` would return it.                                                                                                                                                                                                                           |
| `GET chats/:id/join-requests`                          | User ids with a pending join request.                                                                                                                                                                                                                                    |
| `POST invites/:hash/join`                              | The user `{ user_id }` opens `https://t.me/+<hash>`: joins, or files a join request if the link requires one. A revoked, expired or full link answers 400 `INVITE_HASH_EXPIRED`.                                                                                         |
| `POST invites/:hash/check`                             | Whether the user `{ user_id }` is in the link's chat.                                                                                                                                                                                                                    |
| `POST chats/:id/guest-bot-reply`                       | A guest bot answers the user `{ caller_user_id, bot_username, text }` in the group; returns `{ message_id }`.                                                                                                                                                            |
| `POST users/:id/dm`                                    | The user sends the bot a direct message `{ text }`.                                                                                                                                                                                                                      |
| `GET users/:id/dm`                                     | The private chat's messages, newest first.                                                                                                                                                                                                                               |
| `POST users/:id/dm/:messageId/callback`                | The user presses a button in the private chat `{ data }`.                                                                                                                                                                                                                |
| `GET bot`                                              | The first bot's user, with its `login_client_secret`.                                                                                                                                                                                                                    |
| `GET webhook`                                          | The first bot's registered webhook.                                                                                                                                                                                                                                      |
| `POST bots`                                            | Add a bot `{ token, username, first_name?, login_client_secret?, supports_join_request_queries? }`; it is in no chat yet.                                                                                                                                                |
| `POST login/approve`                                   | The user `{ auth_url, user_id }` logs in; returns `{ redirect_url }` with the code and state.                                                                                                                                                                            |
| `POST login/cancel`                                    | The user cancels `{ auth_url }`; returns `{ redirect_url }` with `error=access_denied`.                                                                                                                                                                                  |
| `GET bots`                                             | Every bot, with its webhook URL and `login_client_secret`.                                                                                                                                                                                                               |
| `POST chats`                                           | Create `{ owner_id, title?, type?: "supergroup" \| "group" \| "channel", owner_name?, is_forum? }`; returns the chat.                                                                                                                                                    |
| `GET chats/:id`                                        | The chat with its pinned message ids and members.                                                                                                                                                                                                                        |
| `POST chats/:id/bots`                                  | Add, promote, demote or remove a bot `{ bot_id, status?, rights?, by? }`, as the owner would.                                                                                                                                                                            |
| `POST chats/:id/bots` with `start_parameter`           | A person `{ by?, bot_id, start_parameter, rights? }` adds the bot through its `startgroup` link, or, with `rights` and an empty `start_parameter`, a channel's `startchannel` link.                                                                                      |
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
`{ answered, text, show_alert }`. An answer Telegram refuses, such as text over 200 characters, does
not count.

## Formatting, replies and uploads

Bot text and media captions support `parse_mode` (`HTML`, `MarkdownV2` and legacy
`Markdown`) and explicit `entities` / `caption_entities`. As on Telegram, a `parse_mode`
other than `none` wins and the explicit entities are ignored; `none` (in any letter case)
sends the text as it is, and an unknown mode fails with `unsupported parse_mode`. The
stored response has plain text and UTF-16 entity offsets. Formatting also applies to
album captions, media edits, copy captions, reply quotes and business text sends. Links,
mentions, commands, hashtags and cashtags can be detected inside styles; code, pre and
explicit links suppress overlapping automatic detection.

Text is then kept the way Telegram keeps it. Control characters become spaces; `\r`,
U+2028 to U+202E and the combining marks U+030A, U+0333 and U+033F are dropped; in a run of
left-to-right and right-to-left marks all but the last become zero-width non-joiners; and
spaces and newlines are cut from both ends (from the start only up to the first entity),
with the entities moved to match. Text that then shows nothing, being only spaces or blank
characters such as zero-width spaces, direction marks, no-break, Braille or ideographic
spaces, fails with `text must be non-empty`, unless `link_preview_options` gives a `url` and
does not disable the preview: then the message is sent with empty text. A caption that is
only spaces is dropped; other blank characters stay in a bot's caption.

After parsing, text may have 4096 characters and a caption 1024, counted as Unicode code
points, so an emoji counts once. Longer sends fail with `message is too long` or
`message caption is too long` (also `editMessageMedia` and copies of media); Telegram's
server answers a longer `editMessageText` with `MESSAGE_TOO_LONG` and a longer
`editMessageCaption` with `MEDIA_CAPTION_TOO_LONG`. The ephemeral edits give the same
answers, though Telegram does not document them; a text edit of an ephemeral media message
sets its caption, so more than 1024 characters fail with `MEDIA_CAPTION_TOO_LONG`. An empty
`text` and raw text over 32 KB (`text is too long`) fail as the request is read, as do
markup errors; whether text shows nothing and how long it is are checked only after the
chat, the reply and the edited message, so a missing chat or message is reported first.

`<tg-time unix="1647531900" format="wDT">…</tg-time>` in HTML and
`![…](tg://time?unix=1647531900&format=wDT)` in MarkdownV2 make a `date_time` entity with
`unix_time` and `date_time_format`, the format written back in Telegram's order (`w`, then
`d` or `D`, then `t` or `T`, or `r`) and empty when none was given; a format naming both
precisions keeps the shorter one. Explicit entities are read as the Bot API reads them:
`mention`, `hashtag`, `cashtag`, `bot_command`, `url`, `email`, `phone_number` and
`bank_card_number` are ignored, since Telegram finds those by itself, and an unknown type
fails with `can't parse MessageEntity: Unsupported type specified`. An explicit `date_time`
needs `unix_time`, refuses a format other than `r`, `R` or letters from `tTdDwW`
(`Invalid date-time format specified`) and a `unix_time` of 0 or less
(`invalid date specified`), and there the last of `d`/`D` and of `t`/`T` wins. A
`text_mention`, from a `tg://user?id=` link or an explicit entity, carries the whole `User`;
a user the server has never seen has only its id, `is_bot: false` and an empty `first_name`,
as the Bot API server writes it.

The contract cases cover malformed markup, crossed Markdown delimiters, invalid entity
ranges (including surrogate-pair boundaries), style splitting around code, and overlapping
blockquote normalization. These rules follow [Bot API formatting options](https://core.telegram.org/bots/api#formatting-options)
and Telegram's [TDLib entity implementation](https://github.com/tdlib/td/blob/master/td/telegram/MessageEntity.cpp).
Album captions are all parsed before any album message is stored, following the
[Bot API server's request parsing](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp).
This is a tested subset, not a claim that every Telegram parser edge case is implemented
or every error description is byte-for-byte identical.

`reply_parameters` and the older `reply_to_message_id` populate `reply_to_message`, without
nested reply chains, in every send method including `sendMediaGroup`, and
`allow_sending_without_reply` is supported. A `message_id` of 0, an ephemeral message's, names no
message, so the send is not a reply. With `reply_parameters.chat_id` the bot replies to a
message in another chat it can read: the message gets `external_reply` (the original's origin, its
chat and id for a supergroup or channel, and its media without the caption, a live photo as
`live_photo` alone) instead of `reply_to_message`, plus an automatic `quote` of the original's text
or caption. The other chat gets the checks under **Which chats a bot may use**: `chat not found`
for an unknown chat or one the bot was never in, and a 403 for a supergroup or channel it left or
was kicked from. A missing or deleted message fails with `message to be replied not found`. A
`quote` (with `quote_parse_mode` or `quote_entities`) must be an exact substring of the original,
including its bold, italic, underline, strikethrough, spoiler, custom emoji and date entities, or
the send fails with `QUOTE_TEXT_INVALID`
([messages.sendMessage](https://core.telegram.org/method/messages.sendMessage)); the message then
carries `quote` with `is_manual` and the `quote_position` given, moved past the spaces trimmed
from the quote's start (0 when it is below 0 or above 1000000). Forum-topic sends without an
explicit reply attach the topic's creation message. Not implemented: replies to another forum
topic as `external_reply`, reply metadata in business sends, and `checklist_task_id` and
`poll_option_id`; see [ReplyParameters](https://core.telegram.org/bots/api#replyparameters).

A text message carries `link_preview_options` when the options sent or edited with it differ from
the defaults, kept as Telegram keeps them: `is_disabled` only when the text has a link, and
`prefer_small_media` or `prefer_large_media` only with a `url`. No link previews are generated.

Uploaded documents preserve their original filename and MIME type when reused by `file_id`
([Document](https://core.telegram.org/bots/api#document)).

## Injected failures

`failNext(rule)` (`POST /_fake/failures`) makes the next matching Bot API calls fail. A rule counts
only calls with its `method` and, where given, its `chatId`, `botId`, `userId` and `messageId`;
other calls do not use it up. `userId` is the user the call is about: its `user_id`, an ephemeral
message's receiver, or the author of the message `deleteMessage` deletes. `messageId` also matches
one id in a `deleteMessages` list. `attempt: 2` starts at the second matching call after the rule
is added, and `times` (default 1) is how many matching calls in a row it applies to.

- With `errorCode`, the call fails before it runs. Without `description`, the error reads as
  Telegram's does for its code (`Bad Request`, `Forbidden`, `Conflict`, ...). A 429 needs
  `retryAfter`, a whole number of seconds: it reads `Too Many Requests: retry after N` and carries
  the `Retry-After` header, as on Telegram.
- With `dropAfterApply`, the call takes effect once, then the connection closes without an answer.
- `delayMs` (at most 30 seconds) delays the answer; on its own, the call runs normally. Delays end
  when the server stops.

`clearFailures()` (`DELETE /_fake/failures`) drops the rules not used up.

## Call receipts

`getCalls()` (`GET /_fake/calls`) returns copies, so changing them changes nothing on the server.
`calls` lists every Bot API call made with a known token and a body that could be read.
`rejected_requests` lists the calls refused before that: an unknown token (its numeric part as
`bot_id`; the token itself is not kept) or form data that cannot be read (kept as `raw_body`, and
left out of wait failure reports). `unimplemented` names the unsupported methods called.

Each receipt has `seq` (its place in its list), `method`, `bot_id`, `params`, `at`, `outcome`,
`status`, `completed_at`, and `target_user_id`, the user the call is about (as `userId` above),
read before the call runs. `params` are the parameters as Telegram's server reads them: text, with
the JSON-serialized ones (`reply_markup`, `media`, `permissions`, ...) parsed, so a call wait that
narrows by `params` gives `chat_id` as text, such as `"-100123"`.

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

## Waits, snapshots and time

These are test controls, not Telegram methods.

```js
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

### Waiting for an outcome

In a real test, trigger your app instead of calling the Bot API directly, and wait for the same
condition. `waitFor` takes these conditions:

| `kind`        | Required identity                                                                   | Expected state / optional narrowing                                                                 |
| ------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `message`     | `chatId` plus `messageId`, or author (`userId`/`botId`) plus exact `text`/`caption` | `deleted`; author/text/caption can also narrow a message ID                                         |
| `member`      | `chatId`, `userId`, `status`                                                        | `permissions` compares returned ChatMember permission fields                                        |
| `joinRequest` | `chatId`, `userId`, `state`                                                         | `pending`, `approved`, `declined`; `botId` identifies the resolving bot                             |
| `call`        | `botId`, `method`                                                                   | `chatId`, `userId`, `messageId`, exact `params` fields, `afterSeq`, `requestId`, `outcome`, `stage` |

`waitFor(condition, { timeoutMs })` checks the condition when it is called and again whenever the
server's state changes; it never polls. Its deadline is wall time: 1000 ms by default, 1 to 30000
ms. It resolves with a copy of what matched. A wait that times out fails with the exact
expectation, what was observed (or up to eight matching requests) and the work still outstanding,
in at most 8000 characters with credentials redacted. `getCalls()` itself keeps requests as they
came, fixture secrets included, so do not dump it indiscriminately.

- `userId` or `botId` on a message identifies its author, also in a channel, where the message
  itself names only the channel.
- A `member` condition reads the member's status in the chat, which every bot in it shares.
- A `joinRequest` state is what the test observed, not a `ChatMember` status; a declined requester
  stays outside.
- A `call` wait looks in `calls`; with `includeRejectedRequests: true`, in `rejected_requests` too.
  `afterSeq` counts within each list. Without `outcome` or `stage`, it can resolve as soon as the
  call is received, before it runs.

### Snapshots

`snapshot()` returns an opaque handle that only this server accepts. `snapshot()` and
`restore(handle)` need the server to be idle: no Bot API, control or owner request in progress, no
long poll, no webhook attempt (an update waiting for a retry counts until it is delivered, dropped
or its webhook removed), no response delay, no send held by flood control and no clock advance.
Pending restriction and ban expiries and unused failure rules are fine. Drain deliveries and finish
requests before taking a snapshot; `restore` fails with outstanding work rather than mix it with
the restored state.

`restore` puts back users, bots, chats (groups, private and business chats, owner accounts), file
bytes, members, messages, invite links and join requests, id counters, call receipts, failure
rules and how far they have counted, sent updates with their bytes and queues, webhook and
`allowed_updates` settings, login codes and flood control's recent sends. Expiries are scheduled
again from the restored members. A snapshot can be restored any number of times;
`releaseSnapshot(handle)` frees it. A restore cancels waits in progress and starts a new `epoch`,
which keeps later `request_id`s apart from earlier ones although ids and receipts go back. The
origin and the login signing key stay the same. Nothing outside the server is restored: your
webhook receiver, its sockets and timers, your database and your app's state.

Between independent scenarios, drop unused failure rules with `clearFailures()`, then restore a
snapshot or start a fresh server.

### Time

By default the server runs on real time. With `clock: { now: milliseconds }` it keeps a manual
clock that only `advanceTime(ms)` moves; `getClock()` returns `{ mode, now, scheduled }`. Advances
run one at a time, and each runs what has come due, in deadline order: restriction and ban expiry,
response delays (`delayMs`, and owner call delays), sends held by flood control, webhook retries
and delayed `getUpdates` conflicts. Message, login and business dates, the five minutes a bot may
message a join requester, and flood control follow this clock too. A restore sets a manual clock
back to the snapshot's time; real time is never rewound. The global `Date`, timers and your app's
jobs are untouched. Webhook connections and their one-minute timeout, long polling and `waitFor`
deadlines use wall time, so an advance does not wait for deliveries or for your bot to act.

### Webhook deliveries

`drainDeliveries({ botId?, timeoutMs? })` waits until the server's queued and in-flight webhook
attempts have settled, retries still due and calls a webhook answered with included. It does not
empty `getUpdates` queues, check that the webhook answered 2XX, or wait for what the bot does after
answering. `getDeliveries()` lists each attempt with its update and bot id, attempt number (each
retry is one), restore epoch, when it was queued, started and completed, its status and outcome.
Sent updates and this list are kept until a restore.

`stop()` cancels waits and delays, aborts deliveries in progress, starts no queued ones, clears
scheduled work and closes connections. Read-only controls still answer in-process after `stop()`,
for diagnostics.

### Over HTTP

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
deadline passes, and 409 when the wait is cancelled or the clock is not manual. A snapshot or
restore while the server is busy answers 409, and an unknown handle 404.

## What it does not do

- Inline mode, payments, games, sticker sets, reaction counts, votes in polls, or Telegram's exact
  rate limits: `floodControl` applies only its published numbers (a test can also make any call
  fail with a 429 through `POST failures`). Channel signatures are not modelled, and forum topics
  cannot be closed or deleted.
- Updates when a restriction or ban runs out: the member's status changes on time, and no update is
  sent.
- In Telegram Login: the `phone` scope's `phone_number` (test users have no phone numbers), the
  ES256, EdDSA and ES256K signing options (only the default RS256), the redirect URLs registered
  with BotFather (any `redirect_uri` is accepted), the `telegram-login.js` popup and native SDKs, and
  the legacy Login Widget's hash check. Telegram has no UserInfo endpoint, and neither does this
  server.
- Fetching media from HTTP URLs (a URL stands in as a one-byte file), several sizes per photo,
  `sendLivePhoto` and `editMessageLiveLocation`.
- Persistence. All state lives in memory and is lost when the server stops; recovering from a
  restart belongs to the application under test.
- Anything security-related. It is a test tool: bind it to localhost and never expose it to a
  network you do not control.

## Changes

- **0.11.0**: the server answers as Telegram does wherever 0.10.0 did not, checked against the Bot
  API docs and the source of Telegram's Bot API server and TDLib: channel posts, who receives which
  update, webhook retries and concurrency, per-bot updates and file ids, ephemeral messages, invite
  links, text cleaning and limits, entity detection, inline keyboards, command scopes, polls, pins,
  reactions, media, and Telegram's own error texts and order of checks. New: the `floodControl`
  option (off by default), the `editEphemeralMessage…` and `deleteEphemeralMessage` methods, and the
  `pinMessage`, `getEphemeralMessage` and `pressEphemeralButton` test actions. Tests written for
  0.10.0 may need these changes:
  - Error descriptions are Telegram's, so tests that matched 0.10.0's texts need the new ones. A
    method the server lacks answers `Not Found: method not found`; with `unimplemented: "ok"`, only
    a method documented to return `True` answers `true`.
  - Channel messages reach bots as `channel_post` and `edited_channel_post`, sent by the channel
    (`sender_chat`, no `from`). `post()` in a channel needs the creator or `can_post_messages`.
  - `banChatMember` deletes no messages. A person banned in a basic group is `left`.
    `promoteChatMember` and `unbanChatMember` refuse basic groups.
  - A bot never in a chat gets `chat not found`; one kicked from or no longer in a supergroup or
    channel gets a 403 for every call there, reads included.
  - `chat_member` and `message_reaction` reach only administrator bots, and `chat_join_request` only
    bots with `can_invite_users`. `getChatAdministrators` leaves out other bots unless
    `return_bots`.
  - Each bot numbers its own updates, so two bots can get the same `update_id`; `redeliverUpdate`
    then needs `botId`. Each bot has its own `file_id`s: another bot's, or a string that is neither
    a file id nor a URL, is refused. File ids, invite links and business connection ids are random.
  - A webhook that does not answer 2XX gets the update again instead of losing it, a Bot API call in
    its answer runs, and different chats' updates go out at once, up to `max_connections`.
    `setWebhook` refuses URLs and secret tokens Telegram refuses, and resolves the host name. A new
    long poll ends the one before with 409.
  - Ephemeral messages have `message_id` 0 and an `ephemeral_message_id` of their own; the regular
    edit and delete methods no longer reach them.
  - Text and captions are cleaned, trimmed and limited to 4096 and 1024 characters, and text that
    shows nothing fails; `parse_mode` wins over explicit entities. Members' text is trimmed too, and
    a blank post fails with `MESSAGE_EMPTY`. In members' text, `bot_command` is found anywhere,
    `hashtag` and `cashtag` are found too, and `package.json` is not a link.
  - `editMessageText` needs a text message and `editMessageCaption` media; forwards and messages
    sent with a reply keyboard can't be edited. A text-only inline button, or `callback_data` over
    64 bytes, is refused, and a press reaches the bot that put the keyboard on the message.
  - Commands are kept per scope and language. Invite links need `can_invite_users`, and each
    administrator has its own primary link.
  - Pins post a `pinned_message` service message, and a bot gets the service messages its own
    calls post. `stopPoll` sends the closed poll as a `poll` update.
  - `sendMediaGroup` with one item sends an ordinary message, and `reply_parameters.chat_id` replies
    to another chat; both were refused. The current chat title set again succeeds, and a longer
    title or description is cut instead of refused. A business send without `can_reply` is a 400,
    not a 403.
  - Call receipts keep `params` as text (`chat_id: "-100123"`), so call waits that narrow by
    `params` need strings. An injected failure's default description follows its code, and a 429
    needs `retryAfter`. A failed HTTP wait, drain or clock advance answers `{ error }` with 400, 408
    or 409 instead of a 500.
- **0.10.0**: exact event-driven waits, fixture snapshots/restoration, a manual clock per
  server, delivery drains/journals, request timelines, detached request evidence, callback
  ownership protection and lazy login key generation. `setMyDescription`,
  `setMyShortDescription`, `setChatMenuButton` and `setMyDefaultAdministratorRights`, which
  stored nothing, get the unsupported-method error unless `unimplemented: "ok"`.
  `setChatPermissions` needs a group or supergroup and `can_restrict_members`, so fixtures whose
  bot changed default permissions without that right must give it. Receipts record state
  changes before webhook delivery completes. Owner receipts keep pending/cancelled outcomes and
  the server's time. Call waits avoid scanning unrelated history; large journals restore
  without argument-limit failures. Unauthorized and unreadable requests go to
  `rejected_requests`, so `calls` counts as in 0.9.x.
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

`npm run bench`, `node bench/reuse.mjs` and `node --expose-gc bench/scaling.mjs` measure the server.
The scaling benchmark accepts `BENCH_HISTORY`, `BENCH_MESSAGES`, `BENCH_OBSERVERS` and
`BENCH_ROUNDS` for larger runs; a small sample is not a throughput guarantee. The
[measurements and regression record](https://github.com/anatolyben/telegram-bot-test-server/blob/main/docs/performance.md)
has the commands, raw samples and observed costs.

## Status

This is an early-stage project with a deliberately small scope, and the public API may still change.
Pin an exact version:

```sh
pnpm add -D --save-exact telegram-bot-test-server@0.11.0
# or: npm install --save-dev --save-exact telegram-bot-test-server@0.11.0
```

## License

MIT
