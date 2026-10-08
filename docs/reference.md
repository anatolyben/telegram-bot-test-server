# Reference

The full reference of the local test server. The [README](../README.md) has the guide and recipes.

## Contents

- [Options](#options)
- [Test actions](#test-actions)
- [Wait conditions](#wait-conditions)
- [Control API](#control-api)
- [Supported Bot API methods](#supported-bot-api-methods)
- [Call receipts](#call-receipts)
- [Viewer](#viewer): [What it shows](#what-it-shows) · [URL parameters](#url-parameters) ·
  [View as a member](#view-as-a-member) ·
  [Long chats and live updates](#long-chats-and-live-updates) · [Call timeline](#call-timeline) ·
  [Selecting with Playwright](#selecting-with-playwright) · [Viewer routes](#viewer-routes)

---

## Options

`startTestServer(options)` takes:

- `botToken` (required): the first bot's token, `<numeric id>:<secret>`. The numeric id is the bot's
  user id. Calls with any other token get 401.
- `port`, `host` (default `0`, `127.0.0.1`): where to listen. Port 0 picks a free port.
- `botUsername`, `botName` (default `example_bot`, `Example Bot`): returned by `getMe`.
- `chats` (default `[]`): supergroups `{ id, title, ownerId, ownerName? }`. The bot is an
  administrator with `can_manage_chat`, `can_change_info`, `can_delete_messages`,
  `can_invite_users`, `can_restrict_members` and `can_pin_messages`.
- `publicChats` (default `[]`): channels, groups and bots `{ username, type, title? }` resolvable by
  `getChat("@username")`; `type` is `"channel"`, `"supergroup"` or `"bot"`, and `username` may start
  with `@`.
- `supportsJoinRequestQueries` (default `false`): a guard bot: where it has `can_invite_users`, join
  requests reach it with a `query_id` ([Join request queries][behavior-join-queries]).
- `loginClientSecret` (default random): the first bot's
  [Telegram Login](../README.md#telegram-login) client secret.
- `privacyMode` (default `false`): the first bot runs in privacy mode
  ([More than one bot](../README.md#more-than-one-bot)).
- `unimplemented` (default `"error"`): Telegram's 404 for an unsupported method, or `"ok"`: `true`
  for one that returns True ([Supported Bot API methods](#supported-bot-api-methods)).
- `floodControl` (default `false`): hold or refuse sends over Telegram's published limits
  ([Flood control](../README.md#flood-control)).
- `clock` (default real time): `{ now: <Unix ms> }`: a manual clock that only `advanceTime` moves;
  or `{ offset: <ms> }`: a running clock, real time plus an offset that `advanceTime` adds to
  ([Time](../README.md#time)).
- `clockWebhook` (default none): an `http(s)` URL. With a manual or running clock, the server POSTs
  `{ now, mode }` there, and `offset` for a running clock, after each `advanceTime` and each
  restore, so the app under test can follow the clock
  ([Testing time-based app logic](../README.md#testing-time-based-app-logic)). The bot's own webhook
  deliveries stay as Telegram sends them.
- `ui` (default `false`): serve the [chat viewer](../README.md#watch-the-chats-in-a-browser) at
  `server.viewerUrl`, to this computer only. It needs a loopback or wildcard `host`; another throws
  `ui needs a loopback or wildcard host`.
- `recordDir` (default none): the directory `stopRecording` writes each recording into
  ([Record a scenario](../README.md#record-a-scenario)).
- `log` (default none): receives one line per notable event: unsupported methods, webhook failures,
  internal errors.

---

## Test actions

`startTestServer()` returns the server with these methods; `server.origin` is its base URL, for the
bot's Bot API root, and `server.viewerUrl` the
[chat viewer](../README.md#watch-the-chats-in-a-browser)'s address (`null` without `ui: true`). Each
action resolves once the update it causes has been handed to the bot
([Make users act](../README.md#make-users-act)). The owner account actions are in the
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

- `post(chatId, userId, text)`: the user posts a message; returns its `message_id`. Fails if the
  user is not allowed to post. Text and captions are trimmed as Telegram's apps send them, and
  text that then shows nothing fails with `MESSAGE_EMPTY`. Instead of text, it takes an object
  with `text` or one other kind of content, and the fields that go with it:
  - `photo`: image bytes (a PNG, GIF or JPEG header gives its size). `media`:
    `{ type, bytes, fileName?, mimeType? }` with `type` `video`, `animation`, `sticker`, `voice`,
    `audio`, `video_note` or `document`. A `caption` goes with every kind but stickers and video
    notes.
  - `fileId`: a file from an earlier message, by any bot's `file_id` for it. The message keeps the
    file's kind and `file_unique_id`, and needs the permission for that kind; a caption may go
    with it.
  - `poll`: a poll of the user's own, with `sendPoll`'s fields (`question`, `options`, `type`,
    `is_anonymous`, `allows_multiple_answers`, `allows_revoting`, `correct_option_ids`,
    `explanation`) and checks. It needs `can_send_polls`.
  - `contact`: `{ phoneNumber, firstName, lastName?, vcard?, userId? }`, and `location`:
    `{ latitude, longitude, horizontalAccuracy?, livePeriod?, heading?, proximityAlertRadius? }`
    (live when `livePeriod` is not 0). Each needs `can_send_messages`. `horizontalAccuracy` is
    kept in whole meters, rounded up, at most 1500. A contact without a phone number or first
    name fails as incomplete; what Telegram answers is unverified.
  - `entities` and `captionEntities`: `MessageEntity` objects for the text and the caption,
    checked as Telegram checks a user's. Types Telegram finds by itself are ignored, except
    `phone_number` and `bank_card_number`, which this server does not find. A `text_link` URL is
    kept as Telegram rewrites it, so `https://example.com` comes back as `https://example.com/`.
  - `replyTo`: the `message_id` it replies to. `threadId`: a forum topic.
  - `forwardFrom`: where a forward comes from: `{ userId }`, `{ senderName }` (a hidden user),
    `{ chatId, messageId? }` (a channel post) or `{ chatId }` of a supergroup (a post made on its
    behalf), with `authorSignature?` for a channel or supergroup.
  - `sendAs`: in a supergroup, the chat to post on behalf of: the group itself, for an anonymous
    administrator, or a channel the user created. Others fail with `SEND_AS_PEER_INVALID`. An
    administrator with `is_anonymous` posts as the group even without it, and anyone else may
    name themselves. A channel needs Telegram Premium (`is_premium`), or the post fails with
    `PREMIUM_ACCOUNT_REQUIRED` (unverified). Telegram offers only public channels; chats made in
    a test have no public username, so here any channel the user created counts.
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
  back with `null`. The emoji must be one of the Bot API's reactions
  ([ReactionTypeEmoji](https://core.telegram.org/bots/api#reactiontypeemoji)); any other fails with
  `The reaction isn't available for the message`, as does any reaction by an anonymous
  administrator other than the owner. An owner who stays anonymous reacts as the group: bots get
  `actor_chat`. Returns `{ reactions }`.
- `deleteMessage(chatId, messageId, userId)`: the user deletes a message for everyone: their own
  (not a service message; in a channel, with `can_post_messages`), or, with `can_delete_messages`,
  anyone's but the chat's creation, upgrade and topic-creation messages. In a basic group, an
  administrator deletes any message. Refusals read `Message can't be deleted` (supergroups and
  channels) or `Message can't be deleted for everyone`. A message that is not there is skipped.
  Bots get no update. Returns `{ message_id, deleted }`.
- `pinMessage(chatId, messageId, userId)`: a person with `can_pin_messages` (in a channel,
  `can_edit_messages`) pins the message; bots get the `pinned_message` service message, whose
  `{ message_id }` it returns.
- `postGuestBotReply(chatId, userId, botUsername, text)`: the user calls a guest bot (Bot API 10.0
  guest mode); its answer appears in the group from that bot, with `guest_bot_caller_user` set.
  Returns its `message_id`.

**Buttons**

- `pressButton(chatId, messageId, userId, data, { deliverTwice })`: the user presses the inline
  button whose `callback_data` is `data` (not its label); resolves with the bot's
  `answerCallbackQuery` answer, `{ answered, text, show_alert }`. It fails at once if the message
  has no button with that data. Once the press has reached the bot (for a webhook, once it
  answered, within a minute), it waits up to 10 seconds for the answer, and resolves
  `{ answered: false }` if none came. An answer Telegram refuses, such as text over 200
  characters, does not count. The bot that put the keyboard on the message gets the press. With
  `deliverTwice: true` (default off), its webhook then gets the same update again, as Telegram
  sends an update its webhook did not confirm; a bot without a webhook is refused.
- `pressEphemeralButton(chatId, ephemeralMessageId, userId, data, { deliverTwice })`: the receiver
  presses an inline button on an ephemeral message; works like `pressButton`.
- `pressDirectButton(userId, messageId, data, { deliverTwice, botId })`: the user presses a button
  in their private chat with the bot (`botId`, by default the first).
- `openUrlButton(chatId, messageId, userId, button, { addToChatId })`: the user opens a URL
  button, named by its text or its index (row by row, from 0). A link to one of the server's bots
  does what Telegram's app does with it. `https://t.me/<bot>?start=<parameter>` (or
  `tg://resolve?domain=<bot>&start=<parameter>`) sends `/start <parameter>` from the user in their
  private chat with the bot. A `startgroup=<parameter>` or `startchannel` link adds the bot, as the
  user, to the group or channel `addToChatId` names, with the rights its `admin=` asks for, as
  `addBotViaLink` does. Resolves with `{ url }`, and for such a link also `link`, `bot_id`,
  `chat_id` and, for `start`, the message's `message_id`. Any other URL changes nothing
  ([URL buttons][behavior-url-buttons]). It fails for a button that is not a URL button.
- `openEphemeralUrlButton(chatId, ephemeralMessageId, userId, button, { addToChatId })`: the
  receiver opens a URL button on an ephemeral message; works like `openUrlButton`.
- `openDirectUrlButton(userId, messageId, button, { addToChatId, botId })`: the user opens a URL
  button in their private chat with the bot (`botId`, by default the first).

**Private chats**

Each bot has its own private chat with a user. These actions take `{ botId }` to name the bot;
the first bot is the default.

- `sendDirectMessage(userId, message, { botId })`: the user messages the bot privately; returns
  the `message_id`. `message` is text, or anything `post` takes but `threadId` and `sendAs`: a
  photo, other media with a caption, a reply to one of the bot's messages, a forward, a poll, a
  contact, a location or an earlier file. Empty text fails with `MESSAGE_EMPTY`.
- `voteDirect(userId, messageId, optionIds, { botId })`: the user votes in a poll the bot sent to
  their private chat; works like `vote`.
- `deleteDirectMessage(userId, messageId, { botId })`: the user deletes any message of their
  private chat with the bot, for both sides, but a dice less than a day old. The bot gets no
  update. Returns `{ message_id, deleted }`.
- `getDirectMessages(userId, { botId })`: an array of the messages in the private chat between the
  user and the bot, newest first.

**Reading state**

- `getMessages(chatId)`: an array of the chat's messages not deleted, newest first. Ephemeral
  messages are included in their place, with `receiver_user`; all of them have `message_id` 0, so
  tell them apart by `ephemeral_message_id`. File ids are the first bot's.
- `getMessage(chatId, id)`: a regular message by `message_id`, as
  `{ exists, deleted, message, reactions }`. In a basic group, `id` is the chat's own id, and
  `bot_message_ids` gives the id each bot knows the message by.
- `getEphemeralMessage(chatId, ephemeralMessageId)`: an ephemeral message by its
  `ephemeral_message_id`, as `{ exists, deleted, message }`.
- `getMember(chatId, userId)`: the member as `getChatMember` returns them to the first bot:
  status, restrictions, ban.
- `getJoinRequests(chatId)`: user ids waiting for approval.
- `getChat(chatId)`: the chat, its pinned message ids (newest first by sending date) and its
  members.
- `getCalls()`: every Bot API call received, with the bot that made it, and any unsupported
  methods called ([Call receipts](#call-receipts)).
- `getMessageLog(chatId, { since, includeDeleted, botId, epoch })`: the chat's messages stored
  after the cursor `since` (default 0), oldest first, as `{ chat_id, epoch, cursor, messages }`;
  with `includeDeleted`, deleted ones too, with who deleted them; a message edited after `since`
  too, with who edited it. A user id reads their private chat with `botId`, needed when they have
  chats with more than one bot. An `epoch` other than the server's fails
  ([Message log and delivered updates](../README.md#message-log-and-delivered-updates)).
- `getBotUpdates(botId, { type, chatId, since, epoch })`: the updates the bot was sent after the
  `update_id` `since`, in order, as `{ bot_id, epoch, updates }`, each with its type, chat, state
  and the exact update.

**Bots and chats**

- `addBot({ token, username, firstName, loginClientSecret, supportsJoinRequestQueries,
  privacyMode })`: another bot, with its own webhook or update queue; it is in no chat yet.
  `privacyMode` (default `false`) runs it in privacy mode. Returns the bot's user, with its `id`.
- `deleteBot(botId)`: a bot `addBot` added is deleted. Its token gets 401 `Unauthorized` from then
  on, and a waiting `getUpdates` answers at once with what is pending. It leaves every chat it is
  in, as with `leaveChat`, and is `left` there; Telegram does not document what a deleted bot's
  chats see, so this is unverified.
  It stays a user that earlier messages name, and a press on its buttons goes unanswered. The
  message log, the viewer and recordings keep its messages, calls and private chats, and the
  viewer tags it as a deleted bot; `getBotUpdates` no longer takes its id. The first bot can't be
  deleted. Returns `{ deleted: true }`.
- `createChat({ ownerId, title, type, ownerName, isForum, ownerAnonymous })`: a new supergroup,
  forum (`isForum`), basic group (`type: "group"`) or channel (`type: "channel"`) with no bot in
  it; returns its id. With `ownerAnonymous` (default `false`), a supergroup's owner stays
  anonymous: they post and react as the group, and `getChatMember` says `is_anonymous: true`.
  Such an owner can't pin, add or remove members, change the title or photo, or make topics.
- `setBotMembership(chatId, botId, { status, rights, by })`: the owner (or `by`) adds, promotes,
  demotes or removes a bot; `status` is `administrator` (default), `member`, `left` or `kicked`.
  The bot gets `my_chat_member`. Returns its membership.
- `promoteMember(chatId, userId, { by, rights })`: a person (`by`, default the creator) makes a
  member an administrator with `rights`, such as `{ can_delete_messages: true }`. Rights left out
  are not granted, and no right at all makes them a member. The person must be the creator or an
  administrator with `can_promote_members`, who grants only rights they hold and edits only
  administrators they promoted. Refusals carry Telegram's texts, such as `Not enough rights`,
  `RIGHT_FORBIDDEN` or `CHAT_ADMIN_REQUIRED`. An edit keeps the custom title. In a basic group only
  the creator promotes, with the group's fixed rights. The chat's administrator bots get
  `chat_member`. Returns the member. Unverified: someone outside a supergroup or channel is
  refused (`USER_NOT_PARTICIPANT`). Telegram's apps add someone outside a basic group first; this
  server refuses them, so add them first.
- `demoteMember(chatId, userId, { by })`: a person makes an administrator a member again, under
  the same rules; an administrator may also step down, which is unverified. Demoting someone who
  is not an administrator changes nothing.
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
- `deleteBusinessMessage(connectionId, userId, messageId, sender)`: `"person"` or `"owner"`
  deletes a message of the business chat for both sides; the bot gets `deleted_business_messages`
  unless the connection is disabled. A message that is not there is skipped. Returns
  `{ message_id, deleted, update_id }`.
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
  (`dropAfterApply`) take effect and never answer
  ([Injected failures](../README.md#injected-failures)).
- `clearFailures()`: drop failure rules not used up.
- `redeliverUpdate(updateId, { botId })`: Telegram delivers that update again, byte for byte, to the
  same bot's webhook. `botId` names the bot; with more than one bot, always pass it, since two bots
  can get the same `update_id`.
- `drainDeliveries({ botId, timeoutMs })`, `getDeliveries()`: wait for webhook attempts to settle;
  list them ([Webhooks and polling](../README.md#webhooks-and-polling)).

**Waits, snapshots and time** (test controls, not Telegram methods)

- `waitFor(condition, { timeoutMs })`: resolves with what matched ([Wait
  conditions](#wait-conditions)).
- `snapshot()`, `restore(handle)`, `releaseSnapshot(handle)`: save and restore the server's state
  ([Snapshots](../README.md#snapshots)).
- `getClock()`, `advanceTime(ms)`: read the clock, and move a manual or running one
  ([Time](../README.md#time)).

**Recordings**

- `startRecording(name, { chats })`, `stopRecording(name)`: record what happens between the two as
  an HTML page and its JSON twin ([Record a scenario](../README.md#record-a-scenario)).

**Scenario reports**

- `startScenario({ runId, scenarioId, title?, labels?, chats? })`: a runner's scenario starts.
- `finishScenario({ runId, scenarioId, result, failure?, labels?, title? })`: it ends `passed`,
  `failed` or `skipped`; `failure` is `{ message, evidence? }`.
- `getScenarios({ runId? })`: `{ epoch, scenarios }`. Details under
  [Report scenarios](../README.md#report-scenarios).

**Stopping**

- `stop()`: shut the server down. It cancels waits and delays, aborts deliveries in progress,
  starts no queued ones, clears scheduled work and closes connections. Read-only controls still
  answer in-process after `stop()`, for diagnostics.

---

## Wait conditions

`waitFor(condition, { timeoutMs })` takes one of these conditions (`POST /_fake/wait` takes the
same):

- `{ kind: "message", chatId, ... }` needs `messageId`, or an author (`userId` or `botId`) plus
  exact `text` or `caption`. `deleted` checks whether it was deleted, and author, text and caption
  can also narrow a `messageId`. `userId` or `botId` identifies the author also in a channel post or
  a post on behalf of a chat, where the message itself names only the chat. It resolves with `{
  exists, deleted, message, author }`, where `author` is the author's user id, and finds ephemeral
  messages by author and text too. To tell apart the same ephemeral text sent to two members, read
  each one with `getEphemeralMessage`. It can instead, with or without an author, match `contains`
  (a part of the text or caption), `matches` (a `RegExp`, or `{ source, flags }` over HTTP; the `g`
  and `y` flags are dropped), `buttonText` and `buttonData` (an inline button's exact text and
  `callback_data`, the same button when both are given). Every field given must hold. With these, it
  resolves with the oldest match, ephemeral messages included, and `since` (a
  [message log](../README.md#message-log-and-delivered-updates) cursor) skips messages stored up to
  it. With a user id as `chatId`, it reads the user's private chat with the bot `botId` names (by
  default the first); there `botId` names the author only when `userId` does not.
- `{ kind: "member", chatId, userId, status }` reads the member's status in the chat, which every
  bot in it shares. `permissions` compares the returned `ChatMember`'s permission fields. It
  resolves with the `ChatMember`.
- `{ kind: "joinRequest", chatId, userId, state }`, with `state` `pending`, `approved` or
  `declined`, is what the test observed, not a `ChatMember` status; a declined requester stays
  outside. `botId` identifies the resolving bot. It resolves with `{ state, member, botId }`.
- `{ kind: "call", botId, method, ... }` looks in `calls`; with `includeRejectedRequests: true`, in
  `rejected_requests` too. It narrows by `chatId`, `userId`, `messageId` (in a basic group the
  chat's own id), exact `params` fields (as text: [Call receipts](#call-receipts)), `afterSeq`
  (which counts within each list), `requestId`, `outcome` and `stage`. Without `outcome` or `stage`,
  it can resolve as soon as the call is received, before it runs. A long poll stays `pending`, with
  only `received` in its timeline, until it answers; its `offset` and `allowed_updates` apply as it
  arrives. It resolves with the receipt.
- `{ kind: "quiet", ms, botIds }` holds when no bot has an update it has not confirmed, a Bot API
  call in progress (a long poll aside, a delayed or held call included) or a webhook attempt
  running; no test action, owner client call, clock advance or restore is under way; and `ms`
  milliseconds of wall time have passed since a bot's last call arrived or was answered. `ms` is 1
  to 30000 and below the wait's `timeoutMs`. `botIds` limits it to those bots (`[]`: test-side work
  only). It resolves with `{ quiet: true, idleMs }`; a timeout reports what was still in progress.
- `{ kind: "update", botId, type, chatId, afterUpdateId, state }` looks at the updates the bot was
  sent ([getBotUpdates](../README.md#message-log-and-delivered-updates)) after `afterUpdateId`:
  `type` is one type or a list, and `state` is `pending`, `delivered` or `dropped`. It resolves with
  the first match.

---

## Control API

The test actions, over HTTP, for tests written in other languages. All routes live under
`/_fake/`, a prefix no Bot API path uses, take and return JSON and use snake_case fields. A route
that fails answers `{ error }` with an HTTP status.

These routes have no authentication and answer anyone who can reach the server's port, as the Bot
API routes do; only the viewer (`/_fake/ui`) answers this computer alone. Keep the default host,
`127.0.0.1`.

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

- `POST chats/:id/messages`: the user posts, as `post` does, `{ user_id, text }`,
  `{ user_id, photo_base64, caption? }`,
  `{ user_id, media: { type, base64, file_name?, mime_type? }, caption? }`,
  `{ user_id, file_id, caption? }`, a poll `{ user_id, poll: { question, options, ... } }`,
  `{ user_id, contact: { phone_number, first_name, last_name?, vcard?, user_id? } }` or
  `{ user_id, location: { latitude, longitude, horizontal_accuracy?, live_period?, heading?,
  proximity_alert_radius? } }`; optionally with `entities` or `caption_entities`, `reply_to`,
  `message_thread_id`, `forward_from: { user_id | sender_name | chat_id, message_id?,
  author_signature? }` or `send_as`. Returns `{ message_id }`.
- `POST chats/:id/messages/:messageId/vote`: the user `{ user_id, option_ids }` votes in a poll
  (`option_ids: []` takes the vote back); returns the poll.
- `POST chats/:id/albums`: the user posts an album
  `{ user_id, items: [{ type: "photo" | "video", base64, caption? }] }`; returns
  `{ media_group_id, message_ids }`.
- `POST chats/:id/messages/:messageId/edit`: the author `{ user_id }` edits the `text` or
  `caption`.
- `POST chats/:id/messages/:messageId/delete`: the user `{ user_id }` deletes the message, as
  `deleteMessage` does; returns `{ message_id, deleted }`.
- `POST chats/:id/messages/:messageId/reactions`: the user `{ user_id, emoji }` reacts, or takes
  the reaction back with `emoji: null`.
- `POST chats/:id/messages/:messageId/pin`: the user `{ user_id }` pins the message, with
  `can_pin_messages` (in a channel, `can_edit_messages`); returns the service message's
  `{ message_id }`.
- `POST chats/:id/guest-bot-reply`: a guest bot answers the user
  `{ caller_user_id, bot_username, text }` in the group; returns `{ message_id }`.
- `GET chats/:id/messages`: an array of the messages not deleted, newest first, as
  `getMessages` returns it.
- `GET chats/:id/messages?since=&include_deleted=&epoch=`: with any of these, the message log as
  `getMessageLog` returns it: `{ chat_id, epoch, cursor, messages }`. `include_deleted` is `true`
  or `1`. A bad `since` answers 400, and an `epoch` other than the server's 409.
- `GET chats/:id/messages/:messageId`: `{ exists, deleted, message, reactions }`, reactions by user
  id, each a list of emoji; a custom emoji is `#` and its `custom_emoji_id`, such as
  `#5368324170671202286`. A basic group's message also has `bot_message_ids`.
- `GET chats/:id/ephemeral-messages/:eid`: `{ exists, deleted, message }` for the ephemeral message
  with `ephemeral_message_id` `:eid`.
- `GET chats/:id/members/:userId`: the member as `getChatMember` would return it.

**Buttons**

- `POST chats/:id/messages/:messageId/callback`: the user `{ user_id, data }` presses an inline
  button; returns the bot's answer.
- `POST chats/:id/ephemeral-messages/:eid/callback`: its receiver `{ user_id, data }` presses an
  inline button; returns the bot's answer.
- `POST users/:id/dm/:messageId/callback`: the user presses a button in the private chat
  `{ data, bot_id? }`.

`data` is the button's `callback_data`; a message with no button with that data answers 400 at
once. A press waits as `pressButton` does, up to 10 seconds once it has reached the bot, for the
bot to call `answerCallbackQuery`, and returns `{ answered, text, show_alert }`, or
`{ answered: false }`. An answer Telegram refuses, such as text over 200 characters, does not
count. With `deliver_twice: true`, the bot's webhook gets the same update twice, as `deliverTwice`
does; a bot without a webhook answers 409.

- `POST chats/:id/messages/:messageId/open-url`: the user `{ user_id, button, add_to_chat_id? }`
  opens a URL button, as `openUrlButton` does.
- `POST chats/:id/ephemeral-messages/:eid/open-url`: its receiver
  `{ user_id, button, add_to_chat_id? }` opens a URL button.
- `POST users/:id/dm/:messageId/open-url`: the user opens a URL button in the private chat
  `{ button, add_to_chat_id?, bot_id? }`.

`button` is the button's text, or its index counted row by row from 0. Each returns `{ url }`, and
for a link to one of the server's bots also `link`, `bot_id`, `chat_id` and, for `start`,
`message_id`. A button that is not a URL button, an ephemeral message's button opened by anyone
but its receiver, and a `startgroup` or `startchannel` link without `add_to_chat_id` answer 400.

**Private chats**

Each route takes `bot_id`, the bot whose private chat with the user it acts in: in the body, or in
the query of a `GET`. The first bot is the default.

- `POST users/:id/dm`: the user sends the bot a direct message, with the same body as
  `POST chats/:id/messages` without `user_id`, `message_thread_id` and `send_as`: `{ text }`,
  `{ photo_base64, caption? }`, `{ media, caption? }`, `reply_to`, `forward_from`, `poll`,
  `contact`, `location`, `file_id`, `entities` or `caption_entities`, and `bot_id?`.
- `POST users/:id/dm/:messageId/vote`: the user `{ option_ids, bot_id? }` votes in a poll the bot
  sent privately.
- `POST users/:id/dm/:messageId/delete`: the user `{ bot_id? }` deletes a message of the private
  chat, as `deleteDirectMessage` does.
- `GET users/:id/dm?bot_id=`: an array of the private chat's messages, newest first.
- `GET users/:id/dm?since=&include_deleted=&epoch=&bot_id=`: with any of the first three, the
  user's private chat with `bot_id` as a message log, like `GET chats/:id/messages?since=`, each
  entry with its `bot_id`. Without `bot_id` it fails (400) when the user has private chats with
  more than one bot.

**Bots and chats**

- `GET bot`: the first bot's user, with its `login_client_secret`.
- `GET webhook`: the first bot's registered webhook.
- `POST bots`: add a bot
  `{ token, username, first_name?, login_client_secret?, supports_join_request_queries?,
  privacy_mode? }`; it is in no chat yet.
- `GET bots`: every bot, with its webhook URL and `login_client_secret`.
- `DELETE bots/:id`: delete a bot added with `POST bots`, as `deleteBot` does; returns
  `{ deleted: true }`.
- `POST chats`: create
  `{ owner_id, title?, type?: "supergroup" | "group" | "channel", owner_name?, is_forum?,
  owner_anonymous? }`; returns the chat.
- `GET chats/:id`: the chat with its pinned message ids and members.
- `POST chats/:id/bots`: add, promote, demote or remove a bot `{ bot_id, status?, rights?, by? }`,
  as the owner would.
- `POST chats/:id/bots` with `start_parameter`: a person `{ by?, bot_id, start_parameter, rights? }`
  adds the bot through its `startgroup` link, or, with `rights` and an empty `start_parameter`, a
  channel's `startchannel` link.
- `POST chats/:id/members/:userId/promote`: a person `{ by?, rights }` makes the member an
  administrator, as `promoteMember` does; returns the member.
- `POST chats/:id/members/:userId/demote`: a person `{ by? }` makes the administrator a member
  again; returns the member.
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
- `POST business/connections/:id/chats/:userId/messages/:messageId/delete`:
  `{ sender: "person" | "owner" }` deletes the message, as `deleteBusinessMessage` does.
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
- `GET bots/:id/updates?type=&chat_id=&since=&epoch=`: the updates the bot was sent, as
  `getBotUpdates` returns them; `type` is comma-separated. An unknown bot answers 400.
- `POST updates/:updateId/redeliver`: deliver that update again to its bot's webhook
  `{ bot_id? }`; 404 for an unknown update, 409 when the bot has no webhook or `bot_id` must name
  one of several bots that got it. Returns `{ update_id }`.

**Recordings**

- `POST record/start`: start recording `{ name, chats? }`; returns
  `{ name, started_at, epoch, start_seq, start_request }`. A bad name or chat answers 400, and a
  name already recording 409.
- `POST record/stop`: stop `{ name }`; returns `{ name, html, json, files? }`. An unknown name
  answers 404, and a recording that started before a restore 409.

**Scenario reports**

- `POST scenarios/start`: `{ run_id, scenario_id, title?, labels?, chats? }`; returns the
  scenario. A run's scenario reported again answers 409.
- `POST scenarios/finish`: `{ run_id, scenario_id, result, failure?, labels?, title? }`, with
  `failure: { message, evidence? }` and each piece of evidence `{ kind: "message", seq }`,
  `{ kind: "call", request_id }` or `{ kind: "event", event_id }`, each with optional `labels`;
  returns the scenario. A missing or unknown `result`, a failure on a result other than `failed`,
  or evidence that does not exist answers 400, and a scenario already finished 409.
- `GET scenarios?run_id=`: `{ epoch, scenarios }`, each scenario as `{ run_id, scenario_id,
  title, labels, chats, status, result, failure, started, finished }`; `started` and `finished`
  are `{ seq, at, epoch }` or `null`.

**Waits, snapshots, time and deliveries**

These controls take camelCase fields:

| Request                           | Body/result                                          |
| --------------------------------- | ---------------------------------------------------- |
| `POST /_fake/wait`                | `{ condition, timeoutMs? }` → matching observation   |
| `POST /_fake/snapshots`           | `{}` → JSON string handle                            |
| `POST /_fake/restore`             | `{ snapshot: handle }` → `{ restored: true, epoch }` |
| `DELETE /_fake/snapshots/:handle` | release handle                                       |
| `GET /_fake/clock`                | `{ mode, now, scheduled }`, and `offset` if running  |
| `POST /_fake/clock`               | `{ ms }` → advanced clock; manual or running clock   |
| `GET /_fake/deliveries`           | the deliveries `getDeliveries()` lists               |
| `POST /_fake/deliveries`          | `{ botId?, timeoutMs? }` → drain deliveries          |

A wait, drain or clock advance that fails answers `{ error }`: 400 for bad input, 408 when the
deadline passes, and 409 when the wait is canceled or the server runs on real time. A snapshot or
restore while the server is busy answers 409, and an unknown handle 404.

**Owner accounts** have their routes under `/_fake/owners`, listed in the
[owner accounts reference][owner-docs].

---

## Supported Bot API methods

These read or change the server's state:

- **Updates and the bot:** `getMe`, `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`,
  `setMyCommands`, `deleteMyCommands`, `getMyCommands`.
- **Chats and members:** `getChat`, `getChatMember`, `getChatAdministrators`, `getChatMemberCount`,
  `getUserProfilePhotos`, `leaveChat`, `restrictChatMember`, `banChatMember`, `unbanChatMember`,
  `promoteChatMember`, `setChatAdministratorCustomTitle`, `setChatPermissions`, `setChatTitle`,
  `setChatDescription`, `setChatPhoto`, `deleteChatPhoto`, `banChatSenderChat`,
  `unbanChatSenderChat`.
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
- **Forum topics:** `editForumTopic`, `closeForumTopic`, `reopenForumTopic`, `deleteForumTopic`,
  `unpinAllForumTopicMessages`, `editGeneralForumTopic`, `closeGeneralForumTopic`,
  `reopenGeneralForumTopic`, `hideGeneralForumTopic`, `unhideGeneralForumTopic`,
  `unpinAllGeneralForumTopicMessages`.
- **Business:** `getBusinessConnection`, and `sendMessage`, `editMessageText` and
  `editMessageReplyMarkup` with `business_connection_id`.

These are not modeled: `setMyDescription`, `setMyShortDescription`, `setChatMenuButton`,
`setMyDefaultAdministratorRights`.

They, any other method not listed, `editMessageCaption` and `editMessageMedia` with
`business_connection_id`, `editForumTopic` with a custom emoji icon, and the forum topic calls no
source gives Telegram's answer to ([Forum topics][behavior-topics]) get Telegram's answer to a
method it does not know: 404 `Not Found: method not found`, so a test cannot pass against behavior
the server does not have.
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

---

## Call receipts

`getCalls()` (`GET /_fake/calls`) returns copies, so changing them changes nothing on the server.
`calls` lists every Bot API call made with a known token and a body that could be read.
`rejected_requests` lists the calls refused before that: an unknown token (its numeric part as
`bot_id`; the token itself is not kept) or form data that cannot be read (kept as `raw_body`, and
left out of wait failure reports). `unimplemented` names the unsupported methods called.

Each receipt has `seq` (its place in its list), `method`, `bot_id`, `params`, `at`, `outcome`,
`status`, `completed_at`, `description`, the text the answer carried (Telegram's error text for a
refusal, or a success's such as `Webhook was set`), and `target_user_id`, the user the call is about
(as `userId` in [failure rules](../README.md#injected-failures)), read before the call runs.
`params` are the parameters as Telegram's server reads them: text, with the JSON-serialized ones
(`reply_markup`, `media`, `permissions`, ...) parsed, so a call wait that narrows by `params` gives
`chat_id` as text, such as `"-100123"`.

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

---

## Viewer

The [README](../README.md#watch-the-chats-in-a-browser) shows how to turn the viewer on. It is off
by default, and it answers only on this computer: a request from another machine, through a proxy or
tunnel, or under another host name gets 403. It never changes the server's state, adds nothing to
Bot API answers or updates, and an open viewer does not hold up `snapshot()`, `restore()` or a wait.

### What it shows

The viewer shows only what the server stores. In **Activity**, every chat is in one feed, drawn as a
chat window, and a small "In Book Club" line marks which chat the next items belong to.

- **Chats**: groups, supergroups, channels, forums and each user's private chat with each bot, a
  deleted bot's included, most recently active first. The search box hides the chats whose title
  does not match; their rows stay in the page, so count rows with Playwright's `:visible`.
- **Messages**: the sender's name and initial, bots tagged as the first bot, an added bot, a
  deleted bot or a guest bot; a channel post or a post on behalf of a chat as the chat, with its
  signature and, in the test's view, who posted it; text with its entities (hover a text link for
  its address, a text mention for the user), replies, forwards (from a user, a hidden user, a
  channel or a supergroup, with the signature) and captions; photos as the images themselves, a
  file posted again included; a contact as a card with the name, the phone and the account it
  names; a location as a card with its point and accuracy, and for a live one how long it is
  shared, its heading and alert radius (no map); other media as labeled placeholders; inline
  keyboards as buttons (hover one for its callback data); edits (not a bot's change of only the
  keyboard, which Telegram's apps do not mark either); and service messages: joins, leaves, pins,
  title and photo changes, upgrades and topics. Times are UTC.
- **Reactions** under each message: a chip for each emoji or custom emoji, with how many chose
  it, the most chosen first, as TDLib sorts them. A custom emoji's image is not stored, so a mark
  stands in for it (hover for its id). In the test's view, hover a chip for who chose it; seen
  as a member, their own reaction is marked. A screen reader reads the same from each chip's
  label. Unverified: the order of reactions chosen equally often. TDLib orders them by Telegram's
  list of active reactions, which this server does not have; here they follow the members who
  chose them, by when each first reacted to the message.
- **Deletions**: a deleted message stays, grayed and marked with the bot or person that deleted it.
- **Ephemeral messages**, marked with the member who sees them.
- **Events** Telegram shows as no message: member changes by a bot or a person (restrictions,
  bans, promotions, their expiry), join requests (pending, approved, declined) and unpins. When
  events have a panel of their own, as in the `split` layout, it also lists the chat's service
  messages, such as joins and leaves, so every change to the chat is in one list there.
- **Members**: the chat's default permissions, then each member, the bots included, with their
  status (creator, administrator, member, restricted or banned until a UTC time or forever, left),
  what a restricted member cannot do and an administrator's rights; then pending join requests.
  The count is of those in the chat now; the panel also lists those who left or were banned, up to
  200 members in all.

### URL parameters

The view lives in the URL, so a link, a test or a Playwright script reproduces it exactly, and
everything changed on the page (panels, layout, view as, topic, theme, the open chat) updates the
URL:

- `chat`: a group id, `<user id>:<bot id>` for a private chat, a user id for their chat with the
  first bot, or `all` for the Activity feed. Without it, Activity.
- `chats`: up to four chats, comma-separated, shown side by side.
- `show`: the panels, comma-separated: `list`, `chat`, `calls`, `events`, `members`. Default: all
  for one chat; `chat,calls,events` for Activity, which has no members panel. In the combined
  layout, `calls` and `events` turn the inline calls and events on or off.
- `layout`: `combined` (calls and events inline in the chat; the default) or `split` (each in its
  own panel).
- `as`: a user id: the chats as that member sees them. Default: the test's view of everything.
- `bots`, `methods`: comma-separated: calls from these bots or of these methods only. Default: all.
- `runs`: comma-separated run ids: only these runs' [scenario](../README.md#report-scenarios) cards.
  Default: all.
- `topic`: a forum topic's `message_thread_id`, or `general`. Default: all topics.
- `theme`: `light` or `dark`. Default: the system's.

Unknown parameters and values are ignored, and the page drops them from the URL, so a typo such as
`show=member` shows the default.

For example, `/_fake/ui?chats=-1001000000001,-1001000000002&show=chat,calls,events` shows a group
beside a second group, each with its bot calls and events, and `?chat=-1001000000001&show=members`
only the members. A page opened without `chat` shows Activity and writes `chat=all` into the URL.
Each panel's ↗ opens it alone in a new tab, and × hides it; a panel alone on the page has neither.
The dividers between columns resize them, with the mouse or the arrow keys. On a phone the panels
that are on stack one under another on one scrolling page, a panel alone fills the screen, and the
toolbar is one compact row, with the run filter, when there is one, in a row under it.

### View as a member

`as=<user id>`, or the select in the toolbar, shows each chat as that member sees it (in Activity,
only the chats they can open): no deleted messages, no other member's ephemeral messages (their own
read "only you see this"), no events, calls, scenario cards or member panels, a reply to or pin of a
deleted message as Telegram shows it, and a poll's results only once they have voted or it has
closed. The chat list holds only their chats. They see everything in a channel, forum or supergroup
they are in now and nothing in one they are not in (a note says why); in a basic group, what was
posted while they were in it, and nothing after a ban with `revoke_messages`. Not modeled: whether a
private supergroup hides its earlier history from new members (the view marks where that history
would start), and members a chat was created with count as present from the start.

### Long chats and live updates

A chat shows its latest 200 messages and events; "Load older messages" adds 200 at a time. At most
600 stay loaded: loading more drops the newest, and "Jump to latest", which says how many newer
messages are not loaded, goes back to the end.

The page follows the server over a server-sent event stream: every change shows within a moment,
without a reload, and after a `restore`, or with a new server on the same port, the page loads
everything again. The status in the toolbar reads Live, Connecting… or Server stopped; a stopped
page tries its address every 2 seconds and connects again once a server answers there. All viewer
tabs of one browser share one event stream, so any number of them stay live. A page whose server
stopped keeps the last state, so it misses a server that starts and stops between its tries, as a
fast test's does. A Playwright script that opens `server.viewerUrl` from inside the test needs no
fixed port.

### Call timeline

The viewer draws every Bot API call from the [call receipts](#call-receipts) beside the chat it
acted on: the bot (first, added or deleted), the method, what it asked for in words (the user, the
messages, `until_date` as a UTC time or "forever", the permissions as Telegram reads them (a
permission left out is off; hover for what was sent) or the rights it grants, the text), its
outcome (`succeeded`, `rejected 400`, `delayed`, `response lost`, ...), and,
for every answer other than 200, Telegram's description exactly as the bot got it. A call a failure
rule failed, delayed or dropped is tagged `injected`, and a method this server lacks
`unimplemented`.

- A call belongs to the chat its `chat_id` names (a private chat as the user's chat with the
  calling bot); `answerCallbackQuery` and `answerChatJoinRequestQuery` to the chat of the button
  press or join request they answer. The rest, such as `getUpdates`, `setWebhook`, business sends,
  unknown tokens and requests that could not be read, are under **Bot calls without a chat**
  (`chat=calls`).
- In the `combined` layout the calls are in the chat in the order things happened, each right
  before the messages and events it produced. `layout=split` lists them in a panel of their own,
  and `show=calls` shows the timeline alone.
- **Filter calls**, or `bots=` and `methods=` in the URL, keeps only some bots' calls or some
  methods.
- In a forum, a topic shows only its calls: those whose message landed in it, or that named it as
  `message_thread_id`, or that acted on one of its messages. Any other call is under General.
- Clicking a call marks what it touched: the messages it names (for a forward or a copy, in the chat
  they came from), its ephemeral message, the member it acted on, and what it produced. A message
  that is not loaded gets a note instead.
- A chat's page holds at most 1000 calls; **Load older calls** fetches the earlier ones.

### Selecting with Playwright

Chats, messages, buttons and members carry stable data attributes. A flag, such as `data-deleted` or
`data-member-bot`, reads `true` when set and is left out otherwise. In a recording, items from
before it carry `data-before-window`.

- **The page**: `[data-role="app"]` with `data-instance`, `data-epoch`, `data-version`, and
  `data-busy="true"` while loading.
- **Chat list row**: `data-chat-key`, `data-chat-id`, `data-chat-type` (`supergroup`, `group`,
  `channel`, `private`, `calls`), `data-forum`; for a private chat `data-user-id` and
  `data-bot-id`; `aria-current="true"` when open.
- **Column**: `data-column-id` (`list` or `<panel>:<chat>`), `data-panel`, `data-chat-key`,
  `data-chat-id`, `data-view-as`.
- **Message**: `data-kind="message"`, `data-chat-key`, `data-seq`, `data-message-id` (in a basic
  group, the chat's own id) or, for an ephemeral message, `data-ephemeral-id` and
  `data-receiver-id`; `data-author-id`,
  `data-author-kind` (`user`, `first-bot`, `added-bot` (a deleted one too), `guest-bot`, `bot`,
  `channel` for a channel post or a post on behalf of a chat),
  `data-deleted` and `data-deleted-by` (the user id of the bot or person that deleted it),
  `data-edited` and `data-edit-hidden` (a bot changed only the keyboard), `data-service` (the
  service message's field, such as `new_chat_members`), `data-thread-id`, `data-reply-to`,
  `data-reply-deleted`, `data-pinned-deleted`, `data-request-id`.
- **Inline button**: `data-button-text`, `data-button-data`, `data-button-url`, `data-button-row`,
  `data-button-col`.
- **Reaction** (inside its message): `data-reaction-type` (`emoji` or `custom_emoji`),
  `data-reaction-emoji` or `data-custom-emoji-id`, `data-reaction-count`; in the test's view
  `data-reaction-user-ids` (space-separated), and seen as a member `data-reaction-mine`.
- **Event**: `data-kind="event"`, `data-chat-key`, `data-event-id`, `data-event-type` (`member`,
  `join_request`, `unpin`), `data-user-id`, `data-request-id`.
- **Call**: `data-kind="call"`, `data-chat-key` (`calls` for calls without a chat),
  `data-request-id`, `data-request-number`, `data-call-seq` and `data-call-journal` (the receipt's
  `seq` and its list: `calls` or `rejected_requests`), `data-call-bot-id`, `data-call-method`,
  `data-call-outcome` (the receipt's `outcome`, such as `succeeded` or `rejected`, without the
  status code), `data-target-messages` (`<chat id>:<message id>`, space-separated, by the chat's
  own ids in a basic group),
  `data-target-user-id`, `data-target-ephemeral-id`.
- **Member**: `data-chat-key`, `data-member-id`, `data-member-status` (the Bot API status:
  `creator`, `administrator`, `member`, `restricted`, `left` or `kicked`, which the panel calls
  banned), `data-member-in-chat` (always `true` or `false`), `data-member-bot`.
- **Join request**: `data-chat-key`, `data-join-request-user-id`.
- **Scenario card**: `data-kind="scenario"`, `data-seq`, `data-scenario-phase` (`start` or
  `finish`), `data-run-id`, `data-scenario-id`, `data-scenario-status` (`running` or `finished`),
  `data-scenario-result` (`passed`, `failed` or `skipped`, left out while running),
  `data-evidence-seqs` and `data-evidence-requests`; each label is a `data-label-key` chip,
  with `data-label-unknown` when the scenario lacks it. **Show evidence** is
  `[data-role="show-evidence"]`.

`data-chat-key` tells a user's private chats with two bots apart. View as, the topic filter and the
call filters leave what is hidden out of the page, so a count of zero means it is not shown; the
chat search only hides rows.
Whatever a clicked call touched carries `data-highlighted="true"`. The page keeps its event
stream open, so Playwright's `networkidle` never settles; after acting, read the server's version
and wait for the page to catch up:

```js
// The viewer's own address: with host "0.0.0.0" or "::", server.origin is not a local one.
const viewer = new URL(server.viewerUrl).origin;
const { version } = await (await fetch(`${viewer}/_fake/ui/api/state`)).json();
await page.waitForFunction(
  (wanted) =>
    Number(document.body.dataset.version) >= wanted &&
    !document.body.hasAttribute("data-busy"),
  version,
);
const spam = page.locator(`[data-kind="message"][data-message-id="${spamId}"]`);
console.log(await spam.getAttribute("data-deleted-by")); // the bot that deleted it
```

### Viewer routes

The viewer's routes, all `GET` and all on this computer only:

- `/_fake/ui`: the page.
- `/_fake/ui/assets/<file>`: its scripts and stylesheet.
- `/_fake/ui/api/state`: the chat list (`?as=<user id>` for a member's).
- `/_fake/ui/api/chats/<chat>`: a chat's messages and events, members and calls (`limit`,
  `before`, `from`, `to`, `as`, `topic`, `members_limit`, `calls_before`). A message with
  reactions has `reactions`: for each, its `type`, `emoji` or `custom_emoji_id`, `total_count`
  and `user_ids`, the most chosen first.
- `/_fake/ui/files/<file_id>`: a stored image's bytes.
- `/_fake/ui/events`: the live event stream (server-sent events).

[behavior-join-queries]: telegram-behavior.md#join-request-queries-bot-api-101
[behavior-parameters]: telegram-behavior.md#parameters
[behavior-topics]: telegram-behavior.md#forum-topics
[behavior-url-buttons]: telegram-behavior.md#url-buttons
[owner-docs]: owner-accounts.md
