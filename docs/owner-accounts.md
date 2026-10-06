# Owner accounts (GramJS): reference

The owner client stands in for GramJS's `TelegramClient` for the calls below, answering from owner
state a test seeds on the server. It is **not** MTProto: there is no wire protocol, encryption,
phone login or real session, and it never contacts Telegram. Never give it, or a test built on it,
a real phone number, session string or API hash.

The [README](https://github.com/anatolyben/telegram-bot-test-server#owner-accounts-gramjs) has an
example and shows where the client goes in an app's tests. This page lists what it answers.

## The client

`createOwnerClient({ origin, userId, session? })` returns a client for one owner of a running
server. `session` stands in for a `StringSession` and is only ever recorded redacted.

- `connect()`, `disconnect()`, `destroy()`: before `connect()` and after `disconnect()`, every call
  fails with GramJS's "Cannot send requests while disconnected".
- `isUserAuthorized()`: `false` after `updateOwner(id, { authorized: false })`; calls then fail
  with `AUTH_KEY_UNREGISTERED` (401).
- `getMe()`: the owner as a `User` with `self: true`.
- `getEntity(peer)`, `getInputEntity(peer)`: a peer id (number or string), `"me"`, a `@username`,
  or a GramJS entity/peer object, as a `User`, `Chat` or `Channel` / `InputPeerUser`,
  `InputPeerChat`, `InputPeerChannel` or `InputPeerSelf`. Unknown peers fail with GramJS's "Could
  not find the input entity".
- `getDialogs({ folder, archived, limit, ignorePinned, offsetDate, offsetId, offsetPeer })`: GramJS
  `Dialog` shapes: `id`, `entity`, `inputEntity`, `name`/`title`, `date`, `message`, `pinned`,
  `folderId`/`archived`, `unreadCount`, `isUser`/`isGroup`/`isChannel`, and the raw `dialog` with
  `notifySettings.muteUntil`. The array has a `total`.
- `getMessages(entity, { limit, offsetId, ids })`: `Message` / `MessageService` shapes: `id`,
  `message`/`rawText`/`text`, `date`, `editDate`, `out`, `fromId`, `senderId`, `sender`, `peerId`,
  `chatId`, `chat`, `replyTo`/`replyToMsgId`, `media`, `action`. The array has a `total`.
- `invoke(new ownerApi.messages.GetDialogFilters({}))`: `messages.DialogFilters` with
  `DialogFilterDefault` and `DialogFilter`s (`title` as `TextWithEntities`, `emoticon`, flags,
  include/exclude/pinned `InputPeer`s) in their order. GramJS's own `Api.messages.GetDialogFilters`
  request works too.
- `markAsRead()`, `sendMessage()`: reserved; they reject with code `OWNER_CLIENT_NOT_MODELLED`.

Anything else fails loudly and never answers a generic success: another client method (code
`OWNER_CLIENT_UNSUPPORTED`), another `invoke` request, or a `getDialogs`/`getMessages` option not
listed above (`filter`, `search`, `minId`, ...).

Peer ids follow the Bot API's: a user's id, `-<id>` for a basic group, `-100<id>` for a supergroup
or channel. Entities carry the raw id, as GramJS's do. Ids are plain numbers; GramJS uses
big-integer objects, which give the same `String()` and `Number()`. The client accepts GramJS peer
objects whose ids are big-integer objects or native `BigInt`.

## Order and paging

- **Folders.** `folder: 0` (or none) is the main list, `folder: 1` the archive; `archived: true`
  means folder 1, as in GramJS.
- **Dialogs** are newest first by their newest message's date, then its id, then the peer id, so
  equal timestamps still have one order. Pinned dialogs lead the **first** page only, most recently
  pinned first. A page with `offsetDate`/`offsetId`/`offsetPeer` continues strictly after that
  position, never repeating it, and never includes pinned dialogs; `ignorePinned` leaves them out of
  a first page too. An offset whose dialog has since moved or been deleted still resumes after its
  position.
- **History** is newest first by message id. `offsetId` returns messages strictly older than it.
  Deleted messages are skipped. `ids` returns the messages in the order asked, with `undefined` for
  a missing or deleted one, as GramJS does. No `limit` returns everything.
- The server defines only this order and paging; any cursor an app builds on top stays the
  app's.

## Owner test actions

These are methods of the server `startTestServer()` returns.

- `createOwner({ userId, firstName, lastName, username })`: an owner account; returns `{ id }`.
- `updateOwner(ownerId, { authorized })`: revoke or restore the owner's authorization.
- `getOwner(ownerId)`: the owner's dialogs (`id`, `kind`, `folder`, `pinned`, `mute_until`,
  `unread_count`, message count) and filter order.
- `addOwnerUser(ownerId, { id, firstName, lastName, username, bot })`: someone who can send in the
  owner's groups; returns `{ id }`.
- `addOwnerDialog(ownerId, { kind, id, title, firstName, lastName, username, participantsCount,
  folder, pinned, muted, muteUntil, unreadCount, date })`: a `private`, `bot`, `group`,
  `supergroup` or `channel` conversation; returns `{ id }`, its peer id. `id` is the raw id the peer
  id is derived from; `muted` mutes forever, `muteUntil` is a Unix time (0 is not muted), and
  `date` is the dialog's date while it has no messages.
- `updateOwnerDialog(ownerId, peerId, { folder, pinned, muted, muteUntil, unreadCount })`: move
  between main and archive, pin, mute, set the unread count.
- `addOwnerMessages(ownerId, peerId, [{ id, date, fromId, out, text, action, replyTo, media,
  editDate }])`: messages with explicit ids and times (Unix seconds); `action` makes a service
  message, such as `{ className: "MessageActionChatAddUser", users: [id] }`; `media` is
  `{ type: "photo" | "document", id, fileName?, mimeType?, size? }`. Returns `{ ids }`.
- `editOwnerMessage(ownerId, peerId, messageId, { text, editDate })`,
  `deleteOwnerMessage(ownerId, peerId, messageId)`: edit or delete a message.
- `setOwnerFilter(ownerId, { id, title, emoticon, includePeers, excludePeers, pinnedPeers,
  contacts, groups, ... })`: create or change a custom filter (id 2 or more). The other flags are
  `color`, `nonContacts`, `broadcasts`, `bots`, `excludeMuted`, `excludeRead` and
  `excludeArchived`.
- `orderOwnerFilters(ownerId, ids)`, `deleteOwnerFilter(ownerId, id)`: reorder (every id once, `0`
  for the default) or delete.
- `failOwnerCall(ownerId, { method, peerId, times, delayMs, preset, seconds, errorMessage, code })`:
  delay or fail the next matching calls ([Delays and failures](#delays-and-failures)).
- `clearOwnerFaults(ownerId)`, `getOwnerCalls(ownerId)`: drop pending faults; every call the owner
  client made.
- `resetOwners()`: remove every owner, without restarting the server.

Every owner is separate: two owners may use the same peer and message ids and keep their own
folders, pins, unread counts, history, filters, faults and calls. No action or route shows one
owner's state under another.

## Over HTTP

The same actions over HTTP, under `/_fake/owners` (snake_case bodies):

- `POST owners`: `{ user_id?, first_name, last_name?, username? }` → `{ id }`.
- `GET owners/:id`, `POST owners/:id`, `DELETE owners/:id`: the owner's state; `{ authorized }`;
  remove the owner.
- `DELETE owners`: remove every owner.
- `POST owners/:id/users`: `{ id?, first_name, last_name?, username?, bot? }` → `{ id }`.
- `POST owners/:id/dialogs`: `{ kind, id?, title?, first_name?, username?, participants_count?,
  folder?, pinned?, muted?, mute_until?, unread_count?, date? }` → `{ id }`.
- `POST owners/:id/dialogs/:peerId`: `{ folder?, pinned?, muted?, mute_until?, unread_count? }`.
- `POST owners/:id/dialogs/:peerId/messages`: `{ messages: [{ id, date, from_id?, out?, text?,
  action?, reply_to?, media?, edit_date? }] }` → `{ ids }`.
- `POST`, `DELETE owners/:id/dialogs/:peerId/messages/:messageId`: edit `{ text, edit_date? }`, or
  delete.
- `POST owners/:id/filters`, `DELETE owners/:id/filters/:filterId`: `{ id, title, emoticon?,
  include_peers?, exclude_peers?, pinned_peers?, contacts?, ... }`, or delete.
- `POST owners/:id/filters/order`: `{ ids: [3, 0, 2] }`.
- `POST`, `DELETE owners/:id/faults`: `{ method, peer_id?, times?, delay_ms?, preset?, seconds?,
  error_message?, code? }`, or clear.
- `GET owners/:id/calls`: `[{ owner_id, method, args, at, outcome, error_message?, duration_ms }]`.

The owner client itself calls `POST /_owner/:ownerId/:method`; tests use the client, not this route.

## Delays and failures

`failOwnerCall` applies to one call (`times`, default 1: once) of `method`, optionally only for one
`peerId`, and can first wait `delayMs` (at most 30 s), so calls complete out of order. `method` is
one of `connect`, `disconnect`, `isUserAuthorized`, `getMe`, `getEntity`, `getInputEntity`,
`getDialogs`, `getMessages` and `invoke`.

`preset` picks what the caller gets:

- `flood_wait`: a `FloodWaitError`: `errorMessage` `"FLOOD"`, `code` 420, `seconds` (default 30),
  as GramJS builds it.
- `permission_denied`: an `RPCError` `CHAT_WRITE_FORBIDDEN`, code 403.
- `reconnect_required`: an `RPCError` `AUTH_KEY_UNREGISTERED`, code 401.
- `stale_entity`: an `RPCError` `PEER_ID_INVALID`, code 400.
- `malformed_page`: a `getDialogs`/`getMessages` answer whose entries lack their entity and message
  fields.
- `dropped`: the call runs, then the connection closes unanswered; the client rejects with
  `TIMEOUT`.
- No preset, with `errorMessage` and `code`: any other `RPCError`, e.g. `CHANNEL_PRIVATE`, 400.

`getOwnerCalls` returns a copy of every call with its outcome: `pending` until it answers, then
`ok`, `error`, `malformed` or `dropped`, or `cancelled` when the server stops during its delay.
Times follow the server's clock. Any field named like a session, token, hash, key, secret, password
or phone is recorded as `[redacted]`.

## Not modeled, and unverified

- Not modeled: MTProto, login, updates and event handlers (`addEventHandler`), sending, reading and
  deleting from the client, media downloads, drafts, forum topics, reactions and forwards in
  history, `messages.getDialogFilters` for chatlists, and every other GramJS method.
- Unverified: Telegram does not document the order of dialogs with equal dates (this server breaks
  ties by message id, then peer id), whether a cursor page without `excludePinned` repeats pinned
  dialogs (here it does not), or what GramJS raises for a response lost mid-call (here `TIMEOUT`).
  Unread counts are what a test sets; they are not derived from messages.
