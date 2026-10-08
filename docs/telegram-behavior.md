# Telegram behavior

This page lists, area by area, how the local test server behaves where a bot can tell the difference
from Telegram. The [README](https://github.com/anatolyben/telegram-bot-test-server#readme) covers
how to use the server; this page is the detail behind its short summary.

The rules come from the [Bot API documentation](https://core.telegram.org/bots/api) and the source
of [Telegram's Bot API server](https://github.com/tdlib/telegram-bot-api) and
[TDLib](https://github.com/tdlib/td), and each one is covered by a test. Refusals carry Telegram's
own error texts, and checks run in the order Telegram's Bot API server runs them, so a malformed
argument is reported before a missing chat. Where neither the docs nor the source settle a
question, the text says **Unverified** and names what this server does. This is a tested subset,
not a claim that every Telegram edge case is implemented or every error description is byte for
byte identical.

## Contents

- [Members and moderation](#members-and-moderation): [permissions](#permissions),
  [restrictions](#restrictions-stick), [protected members](#protected-members),
  [moderation rights](#moderation-rights), [bans](#bans), [unbanning](#unbanning),
  [administrators and chat settings](#administrators-and-chat-settings),
  [join request queries](#join-request-queries-bot-api-101), [invite links](#invite-links)
- [Bots and chats](#bots-and-chats): [which chats a bot may use](#which-chats-a-bot-may-use),
  [more than one bot](#more-than-one-bot), [private chats](#private-chats),
  [privacy mode](#privacy-mode),
  [channels](#channels), [basic groups and the upgrade](#basic-groups-and-the-upgrade),
  [people changing the chat](#people-changing-the-chat),
  [adding the bot through a link](#adding-the-bot-through-a-link),
  [service messages about the bot itself](#service-messages-about-the-bot-itself),
  [forum topics](#forum-topics), [business connections](#business-connections),
  [command menus](#command-menus)
- [Messages](#messages): [what members send](#what-members-send),
  [posts on behalf of a chat](#posts-on-behalf-of-a-chat), [entities](#entities),
  [deleting](#deleting-messages), [editing](#editing), [editing media](#editing-media),
  [forwards and copies](#forwards-and-copies), [pins](#pins), [polls](#polls),
  [reactions](#reactions), [media](#media), [files](#files)
- [Buttons and ephemeral messages](#buttons-and-ephemeral-messages):
  [inline keyboards](#inline-keyboards), [callback queries](#callback-queries),
  [URL buttons](#url-buttons), [ephemeral messages](#ephemeral-messages)
- [Text formatting and replies](#text-formatting-and-replies): [formatting](#formatting),
  [cleaning](#text-cleaning), [length limits](#length-limits),
  [dates and explicit entities](#dates-and-explicit-entities),
  [replies and quotes](#replies-and-quotes), [link previews](#link-previews),
  [uploaded documents](#uploaded-documents)
- [Requests and updates](#requests-and-updates): [parameters](#parameters),
  [update delivery](#update-delivery), [redelivery](#redelivery)

## Members and moderation

### Permissions

Unspecified permissions are false, except that `can_manage_topics` and `can_edit_tag` follow
`can_pin_messages`, and `can_react_to_messages` follows `can_send_messages` as passed. Then, unless
`use_independent_chat_permissions` is set, broader permissions imply narrower ones
(`can_send_other_messages` implies media and text, `can_send_polls` implies text). Each permission
must be a JSON `true` or `false`
(`can't parse chat permissions: Field "can_send_polls" must be of type Boolean` otherwise), and
`permissions` given empty fail with `can't parse permissions JSON object`. A member needs both their
own permission and the chat's default from `setChatPermissions` to post; a photo needs
`can_send_photos`, not only `can_send_messages`. `setChatPermissions` needs `can_restrict_members`
(`not enough rights to change chat permissions`) and refuses a channel
(`can't change channel chat permissions`). `getChat` returns the default `permissions` for groups
and supergroups, not for channels.

### Restrictions stick

A restricted user who leaves and rejoins is still restricted. An `until_date` from 30 seconds to 366
days away ends the restriction or ban then, on the server's clock; any other date makes it
permanent. When it ends, a restricted user is a member again, or `left` if they left meanwhile, and
a banned user is `left`. No update is sent when a restriction or ban runs out: the Bot API server
sends `chat_member` and `my_chat_member` only for TDLib's `updateChatMember`
([Client.cpp][bot-api-server-client] `add_update_chat_member`), which TDLib makes only of an update
from Telegram (`DialogParticipantManager::send_update_chat_member`). When a restriction of the
bot's own ends, TDLib only changes its copy of the status (`ChatManager::on_channel_unban_timeout`),
and no source shows Telegram sending an update when one ends.

### Protected members

Restricting or banning the chat owner, an administrator or the bot itself fails with Telegram's
error.

### Moderation rights

`restrictChatMember` works only in supergroups, and `promoteChatMember` and `unbanChatMember` only
in supergroups and channels. Restricting, banning and unbanning need `can_restrict_members`, and
approving or declining a join request `can_invite_users`, checked before anything changes. Refusals
carry Telegram's own texts, such as `not enough rights to restrict/unrestrict chat member`,
`method is available only in supergroups` or, for a basic group that only an administrator may
remove members from, `CHAT_ADMIN_REQUIRED`. A pending join request does not make its user a member.

Telegram's docs: [banChatMember](https://core.telegram.org/bots/api#banchatmember),
[approveChatJoinRequest](https://core.telegram.org/bots/api#approvechatjoinrequest).

### Bans

A ban deletes no messages, as on Telegram: `revoke_messages` only decides what the removed user can
still see, which this server does not model. A bot that wants a banned user's messages gone deletes
them with `deleteMessage` or `deleteMessages`. A basic group keeps no ban list, so a person banned
there is then `left`, as TDLib reports someone no longer in the group; a bot removed from one sees
itself `kicked`. A ban in a basic group also posts `left_chat_member` from the bot that banned,
which that bot receives too, as
[messages.deleteChatUser](https://core.telegram.org/method/messages.deleteChatUser) "sends a service
message". Unverified: whether a supergroup ban posts one; this server posts none.

### Unbanning

`unbanChatMember` leaves a banned user outside the chat. Without `only_if_banned` it removes a
current member, as the docs guarantee; with it, a user who is not banned stays as they are.

### Administrators and chat settings

`promoteChatMember` needs `can_promote_members` and grants only rights the bot holds. Rights the
kind of chat does not have (below) are dropped first, as TDLib drops them, and so is `is_anonymous`
in a channel, which has no anonymous administrators; any one right left makes an administrator,
`can_send_welcome_messages`, `can_manage_tags` and `can_manage_direct_messages` included, and none
leaves a member. A channel promotion that names any right also grants `can_restrict_members`
unless the call says otherwise. The bot can then edit and title the administrators it promoted. An
edit keeps the custom title: TDLib's `channels.editAdmin` leaves the title out, which changes only
through `messages.editChatParticipantRank`. An administrator carries the rights its kind of chat
has, as Telegram writes them: `can_post_messages`, `can_edit_messages` and
`can_manage_direct_messages` in channels, `can_pin_messages` and `can_manage_tags` in groups, and
`can_manage_topics` in supergroups. The Bot API server also writes `can_manage_voice_chats`, the
older name of `can_manage_video_chats`, in every `ChatMemberAdministrator`, and
`promoteChatMember` takes either name.

People promote and demote members too (`promoteMember`, `demoteMember`), as Telegram's apps do
through TDLib's `setChatMemberStatus`. In a supergroup or channel, the creator or an administrator
with `can_promote_members` chooses the rights, which are dropped and checked as for
`promoteChatMember`. The person grants only rights they hold (`RIGHT_FORBIDDEN`), and only the
creator edits administrators someone else promoted (`CHAT_ADMIN_REQUIRED`). Nobody changes the
owner (`Can't remove chat owner`) or promotes themselves (`Can't promote self`), and anyone else
gets `Not enough rights`. In a basic group only the creator promotes
(`Need owner rights in the group chat`), never themselves (`Can't promote or demote self`), checked
before anything else. There every administrator has the group's fixed rights, as TDLib reads them,
since Telegram keeps only whether someone is one. A change to what the member already has succeeds
without an update, and demoting someone who is not an administrator changes nothing. Otherwise the
chat's administrator bots get `chat_member` from the person. The person is then the
administrator's promoter, so no bot may edit them (`can_be_edited` is false), also after an edit of
an administrator a bot promoted. An edit keeps the custom title. In a basic group, Telegram's apps
add someone outside it first; this server does not, and refuses them
(`the user is not in the chat; add them first`).
Unverified: that an administrator may demote themselves, as TDLib allows; that someone outside a
supergroup or channel is refused (`USER_NOT_PARTICIPANT`), where TDLib asks Telegram to promote
them directly; and that a change to nothing new succeeds in a basic group, where TDLib asks
Telegram all the same.

Telegram's server decides `can_be_edited`, and its code is not published. The Bot API's
`can_be_edited` says whether "the bot is allowed to edit administrator privileges", and
`setChatAdministratorCustomTitle` takes an administrator "promoted by the bot"; the Bot API server
refuses it when `can_be_edited` is false. Telegram sends it as `channelParticipantAdmin.can_edit`,
which TDLib passes on as it is, beside `promoted_by`, the user who promoted the administrator. One
method, `channels.editAdmin`, both promotes and edits. When their own user edits an administrator,
[TDLib's member cache][tdlib-participants] (`update_channel_participant_status_cache`) and
[Telegram Desktop][tdesktop-participants] (`applyAdminLocally`) keep the earlier `promoted_by`.
These are the apps' own copies, not what Telegram's server answers. Unverified: whether Telegram's
server also keeps the earlier promoter, and with it the bot's `can_edit`, after a person's edit.

Telegram's docs: [ChatMemberAdministrator][bot-api-chat-member-administrator],
[channelParticipantAdmin](https://core.telegram.org/constructor/channelParticipantAdmin),
[channels.editAdmin](https://core.telegram.org/method/channels.editAdmin).

`setChatTitle`, `setChatDescription`, `setChatPhoto` and `deleteChatPhoto` need `can_change_info`
and post Telegram's service messages to every bot in the chat, the bot that made the change
included. A title is cut to 128 characters and a description to 255, after TDLib's cleaning: blank
characters such as U+2800 become spaces, U+2028 to U+202E are dropped, only ASCII spaces are
trimmed, and in a title each run of spaces, newlines and no-break spaces becomes one space. A title
left empty fails with `title must be non-empty`. The current title set again succeeds without a
service message, while an unchanged description or a missing photo is refused.

### Join request queries (Bot API 10.1)

A guard bot (`supportsJoinRequestQueries`) with `can_invite_users` gets each join request with a
`query_id`, which it answers with `answerChatJoinRequestQuery` (`chat_join_request_query_id`,
`result`: `approve`, `decline` or `queue`, in any case).

### Invite links

Creating, exporting, editing and revoking links needs `can_invite_users`
(`not enough rights to manage chat invite link` otherwise); editing or revoking without a link fails
with `invite link must be non-empty`. Each administrator has its own primary link:
`exportChatInviteLink` replaces only the calling bot's, `getChat` returns it as `invite_link`
(generating one when the bot has none; an upgraded basic group has none), revoking it generates a
new one, and it cannot be edited (`CHAT_INVITE_PERMANENT`). A bot edits and revokes only links it
created. An edit sets every field: one it leaves out goes back to its default (no name, no
`expire_date`, no `member_limit`, no join requests). `member_limit` is capped at 100000. A link's
`member_limit` counts the members who joined through it and are still in the chat, restricted or
promoted ones included; a join past it, after `expire_date` or through a revoked link fails with
`INVITE_HASH_EXPIRED`, and a link that creates join requests cannot have a `member_limit`. A bot
sees a link another administrator created with the second part of its hash replaced by `...`
(TDLib's form; the Bot API docs print "…"). Links are `https://t.me/+` followed by a random hash.
Unverified: how much of the hash is hidden (here the second half), the error for revoking another
administrator's link (here `CHAT_ADMIN_REQUIRED`), and the error for joining through a full link
(here `INVITE_HASH_EXPIRED`, as Telegram's apps call such a link expired).

## Bots and chats

### Which chats a bot may use

Checked once a method has read its other arguments, as Telegram's Bot API server does, so a
malformed argument is reported first. A chat the bot was never in is
`400 Bad Request: chat not found`. A bot kicked from a supergroup or channel gets
`403 Forbidden: bot was kicked from the supergroup chat` (or `channel chat`) for every call, reads
like `getChat` included, and one that left or was removed gets
`403 Forbidden: bot is not a member of the supergroup chat`. The chat of a message the bot replies
to in another chat (`reply_parameters.chat_id`) gets the same checks. In a basic group, a bot that
left or was removed can still make the calls that need only read access: `getChat`, `leaveChat`,
`getChatMember` about itself, `setMessageReaction`, `deleteEphemeralMessage`, and naming the chat as
the source of a forward, copy or reply; every other call gets the `group chat` form of the same
errors.

### More than one bot

Each bot has its own webhook or update queue and its own membership and rights in each chat. A bot
posts only where it is a member (a channel needs `can_post_messages`), edits and stops only its own
messages and polls (in a channel, others' too with `can_edit_messages`), pins only with
`can_pin_messages` (a channel's `can_edit_messages`), and deletes others' messages only with
`can_delete_messages`. A bot hears of its own status changing as `my_chat_member`, whether the owner
or another bot changed it; the chat's administrator bots hear of it as `chat_member`.
`can_be_edited` is true only for the bot that promoted that administrator, and
`getChatAdministrators` leaves out other bots unless `return_bots` is set. Only the bot that put a
keyboard on a message, by sending the message or by the last edit that set the keyboard, hears its
buttons pressed. Each bot has its own private chat with a user, as under
[Private chats](#private-chats).

A test may delete a bot it added (`deleteBot`). Every call with its token then gets
`401 Unauthorized`, the Bot API server's answer once Telegram no longer accepts a token. Its webhook
goes, and a waiting `getUpdates` answers at once with what is pending, as the server does when it
closes a bot. Unverified, because Telegram does not document it: what a deleted bot's chats see.
Here it leaves each chat it is in, as with `leaveChat`, so the chat's administrator bots get
`chat_member` from it and a group gets `left_chat_member`. It stays a user that earlier messages and
member lists name, and a press on its buttons reaches no bot and goes unanswered at once.

### Private chats

Every bot is an account of its own, so a user's private chat with each bot is a chat of its own:
the Bot API server keeps one TDLib client, with its own messages, per bot token, and names a
private chat by the other party's id. All of a bot's private chats draw their message ids from one
sequence: "The sequence is shared by all private chats and basic group messages within the current
account" ([updates](https://core.telegram.org/api/updates)). So a bot's messages with two users
never share an id, and basic groups take ids from the same sequence
([Basic groups and the upgrade](#basic-groups-and-the-upgrade)). A bot reaches only its own chat
with a user, for sends, edits, deletions, pins, replies and forwards, and `getChat` shows its own
pinned message. The test actions for private chats take
the bot (`botId`), the first bot by default, and a `start` link to any bot opens that bot's chat.

The bot cannot message a user who has not written to it first (403). The exception is a join
request: a bot that receives it may message its `user_chat_id` for five minutes, until the request
is approved or declined, as [ChatJoinRequest](https://core.telegram.org/bots/api#chatjoinrequest)
documents. The five minutes follow the server's clock, so `advanceTime` can end them.

Any other call, `sendChatAction` included, checks the chat with TDLib's `getChat`
(`Client::check_chat`). It finds the private chat of a user the bot knows: one who has a private
chat with it, shares or shared a chat with it, asked to join a chat it is in, or was named in an
update it got. If that user never wrote to the bot, the chat is empty: `getChat` shows the user, and
`deleteMessage`, `pinChatMessage` or `forwardMessage` from it get `message to delete not found` and
the like (`Client::check_message`). For anyone else the call gets `400 Bad Request: chat not found`
(`TdOnCheckChatCallback`).

### Privacy mode

A bot can run in privacy mode (`privacyMode`, off by default), as BotFather sets it. In a group or
supergroup where it is not an administrator, it then gets only what the Bot API docs list
([privacy mode][privacy-mode], [what messages will my bot get][bots-faq]): "All service messages",
"Commands explicitly meant for them (e.g., /command@this_bot)", "General commands from users
(e.g. /start) if the bot was the last bot to send a message to the group", and "Replies to any
messages implicitly or explicitly meant for this bot". Note that "each particular message can only
be available to one privacy-enabled bot at a time", and "Replies have the highest priority", so a
reply goes to the bot it is meant for, then an explicit command to the bot it names, then a
general command to the last bot that sent a message. An administrator bot gets every message, and
privacy mode changes nothing in channels and private chats. `getMe` says
`can_read_all_group_messages: false`. Not modeled: messages sent via the bot in inline mode.

Where the docs do not decide, the server takes the narrowest reading of their examples:

- A command is a text message that starts with one, as `/command@this_bot` and `/start` do. A
  command later in the text, or in a caption, does not count.
- A message is meant for a bot when the bot sent it, got it by these rules, or it is a command
  that names the bot. So a reply to a command for the bot, or to a reply the bot got, reaches it.
- The last bot to send a message is the last to send one itself. A service message its action
  made, such as a pin, does not count.
- A message in a forum topic is not a reply to the topic's creation message, which the Bot API
  server adds as `reply_to_message` itself.
- The bot gets the edits of only the messages it received.

### Channels

Every message in a channel comes from the channel: `sender_chat` is the channel and there is no
`from`, both for what bots send and for what people post (channels that sign posts are not modeled,
so a post has no `author_signature`). Bots get the channel's messages, service messages such as
`new_chat_title` included, as `channel_post` and their edits as `edited_channel_post`, never as
`message`. Subscribers have no permissions: only the creator and administrators with
`can_post_messages` post, and only the creator and administrators with `can_change_info` change the
title or photo; `post()` refuses anyone else with `CHAT_WRITE_FORBIDDEN`, and `renameChat` and
`changeChatPhoto` with `CHAT_ADMIN_REQUIRED`. A bot with `can_edit_messages` edits any post and
stops any poll; without it, only its own, and only while it has `can_post_messages`. A bot deletes
its own posts with `can_post_messages` and anyone's with `can_delete_messages`. A press on a post's
button goes to the bot that put the keyboard there, also when it added the keyboard to someone
else's post by an edit (unverified: Telegram does not document which bot gets that press).

Telegram's docs: [Update](https://core.telegram.org/bots/api#update),
[ChatAdministratorRights](https://core.telegram.org/bots/api#chatadministratorrights).

### Basic groups and the upgrade

A basic group has a negative id without the `-100` prefix. The creator or an administrator can
upgrade it: a new supergroup takes its members, administrators and bots, the old chat posts
`migrate_to_chat_id` and the new one `migrate_from_chat_id`. Later Bot API calls to the old id fail
with `400 Bad Request: group chat was upgraded to a supergroup chat` and
`parameters.migrate_to_chat_id`
([ResponseParameters](https://core.telegram.org/bots/api#responseparameters)), except these:
`getChat` still returns the old group, `leaveChat` fails with
`400 Bad Request: chat is deactivated`, and a forward, copy or reply still takes a message from it.
Telegram's server raises the upgrade error only for calls that write or read the member list.
Unverified: what it answers to other calls on the old id (`getChatMember` about the bot itself,
`setMessageReaction`, edits), so this server keeps the upgrade error for them; and whether bots get
`my_chat_member` on the upgrade, which this server does not send.

Each account sees a basic group's messages under ids from its own common sequence, the one its
private chats use ([updates](https://core.telegram.org/api/updates): "The sequence is shared by all
private chats and basic group messages within the current account"). So two bots in one basic
group know the same message by different ids, and every call a bot makes about one (reply, edit,
delete, pin, reaction, stop a poll, forward or copy from the group) takes its own id; every update
and answer it gets shows its own ids, a button press's message and a reaction included. Every
account in the group when a message is posted gets an id for it, and so does the member a
`left_chat_member` message names. A bot that joins later has none for what came before: an id it
does not know is not found, and a reply to or pin of such a message shows without it, as the Bot
API leaves out a message it cannot get. Unverified: whether a bot in privacy mode, or one that never
gets another bot's messages, still takes an id for each message, as this server does. The
supergroup an upgrade makes numbers its messages once, for every account.

Telegram's docs: [migration](https://core.telegram.org/api/channel#migration).

### People changing the chat

A person with `can_change_info` renames the chat or sets its photo, with the same `new_chat_title`
and `new_chat_photo` service messages as `setChatTitle` and `setChatPhoto`; `getChat` returns the
title and a `ChatPhoto`. Its small and big photos, like those of a user's `ChatPhoto`, are files of
their own, apart from the `new_chat_photo` sizes: `getFile` serves them under `profile_photos/`, and
no send takes them (`can't use file of type ChatPhoto as Photo`).

### Adding the bot through a link

With admin rights requested, only the creator or an administrator with `can_promote_members` may
add it; without, anyone who can add members (`can_invite_users`). Otherwise the person gets
`CHAT_ADMIN_REQUIRED`. The bot gets `my_chat_member` from the person, the chat's administrator bots
`chat_member`, all bots the `new_chat_members` message, and then the person's
`/start@<bot> <parameter>` with a `bot_command` entity, as `messages.startBot` posts. An
administrator's existing rights are combined with the requested ones, and `/start` is still posted.
Unverified: Telegram does not document whether `my_chat_member` or the `/start` message arrives
first; this server sends `my_chat_member` first. A channel's `startchannel` link always asks for
admin rights and has no parameter, so the bot only gets `my_chat_member` and nothing is posted;
`addBotViaLink` on a channel fails without `rights` or with a `startParameter`.

Telegram's docs: [links](https://core.telegram.org/api/links#group-channel-bot-links),
[deep linking](https://core.telegram.org/bots/features#deep-linking).

### Service messages about the bot itself

A bot gets the `new_chat_members` and `left_chat_member` messages that name it, as the
[Message](https://core.telegram.org/bots/api#message) fields say it "may be the bot itself". It also
gets the `new_chat_title`, `new_chat_photo`, `delete_chat_photo` and `pinned_message` messages its
own calls post, as Telegram's Bot API server delivers them.

### Forum topics

In a forum, a send to a `message_thread_id` that is not a topic fails with
`message thread not found`, as does one to the General topic's id, 1. Every message in a topic other
than General that answers nothing else, a service message included, replies to the topic's creation
message while that is not deleted. The Bot API server adds that reply itself (Client.cpp
`get_implicit_reply_to_message_id`). This covers a bot's send to a topic without an explicit reply
too ([Replies and quotes](#replies-and-quotes)).

Bots close, reopen, rename and delete topics, and close, reopen, rename, hide and unhide the General
topic, as the Bot API server passes these methods to TDLib's `ForumTopicManager`. A chat that is no
forum fails with `the chat is not a forum`, and a `message_thread_id` of 0 or less with
`invalid forum topic identifier specified`. Closing, reopening and renaming need
`can_manage_topics`, unless the bot created the topic, and deleting needs `can_delete_messages`,
with no such exemption, as the Bot API docs say. TDLib refuses a bot without the right for a topic
it knows the bot did not create (`not enough rights to close or open the topic`,
`not enough rights to edit the topic`, `not enough rights to delete the topic`). A bot's TDLib
knows a topic once one of its sends named it. It may also learn a topic from messages it fetches
(`MessagesInfo.cpp`), and for a topic it does not know it passes the call on to Telegram, whose
answer no source gives. So a call without the right on a topic the bot never sent to, the General
topic included, and a deletion of the bot's own topic without the right are reported as
unimplemented, with 404 `Not Found: method not found`. Hiding and unhiding always need
`can_manage_topics`, with the first of those texts.

Telegram answers `TOPIC_ID_INVALID` for a topic that does not exist, `TOPIC_NOT_MODIFIED` for a
change to nothing new (closing a closed topic, a name it already has), and
`GENERAL_MODIFY_ICON_FORBIDDEN` for an icon for the General topic. A name is cleaned as a chat title
and cut to 128 characters; an empty name keeps the old one, and an edit with neither name nor icon
does nothing. Every change posts its service message from the bot, which that bot gets too:
`forum_topic_closed`, `forum_topic_reopened`, `forum_topic_edited` (with the new `name`),
`general_forum_topic_hidden` and `general_forum_topic_unhidden`; the General topic's have no
`message_thread_id`. Hiding the General topic also closes it, and reopening it also unhides it, as
the Bot API docs say. That reopening posts `forum_topic_reopened`: TDLib shows an edit that both
unhides and reopens a topic as reopened, not unhidden (`ForumTopicEditedData.cpp`,
`get_edited_data_message_content_object`).

A closed topic takes no messages from anyone but administrators with `can_manage_topics` and the
topic's creator, as TDLib's `can_send_message_to_forum_topic` decides: a bot gets
`Bad Request: TOPIC_CLOSED`, Telegram's 406, and `post()` fails with `TOPIC_CLOSED`. A message in
no topic goes to the General topic. Deleting a topic deletes all its messages, its creation message
included, and Telegram sends no update of its own for it ([forums][forum-docs]): bots get none, as
for any deletion. "All topics except for the "General" topic can be deleted"
([forums][forum-docs]), but no source gives Telegram's answer to deleting it, so that call is
reported as unimplemented.
`unpinAllForumTopicMessages` and `unpinAllGeneralForumTopicMessages` unpin a topic's messages with
the pinning right; a chat with no topics fails with `chat doesn't have topics`.

Not modeled: a custom emoji topic icon. `editForumTopic` with one gets the answer to a method this
server lacks.

### Business connections

An owner connects the bot to their account; the bot gets `business_connection` on every change, and
`business_message` for each message in the owner's private chats while the connection is enabled,
from the person or from the owner answering by hand. Their ids come from the owner's own sequence,
which the owner's private chats with bots and basic groups use too: such messages "will use the
connected user's common message ID sequence" ([updates](https://core.telegram.org/api/updates)).
`sendMessage` with `business_connection_id` answers as the owner, with `sender_business_bot` set.
It needs an enabled connection, `can_reply`, and a message from the person in the last 24 hours
(`BUSINESS_PEER_USAGE_MISSING` otherwise, as
[documented](https://core.telegram.org/method/messages.sendMessage)). An unknown connection is
`business connection not found`, as the Bot API says. Unverified: the error for a disabled
connection (`BUSINESS_CONNECTION_INVALID`) and for a missing `can_reply`
(`400 BOT_ACCESS_FORBIDDEN`; the Bot API never answers such an error with 403).

`editMessageText` and `editMessageReplyMarkup` with `business_connection_id` edit the bot's and the
owner's messages in a business chat, under the same rules as sending; the owner's own messages
without an inline keyboard only within 48 hours, as documented. Unverified: the errors, taken from
[messages.editMessage](https://core.telegram.org/method/messages.editMessage), for the person's
message (`MESSAGE_AUTHOR_REQUIRED`), an unknown one (`MESSAGE_ID_INVALID`) and the 48 hours
(`MESSAGE_EDIT_TIME_EXPIRED`). The connected bot may also message the owner's private chat
(`user_chat_id`). `getMe` reports `can_connect_to_business`. When the person or the owner deletes a
message of a business chat (`deleteBusinessMessage`), for both sides as in any private chat, the bot
gets `deleted_business_messages` with the connection id, the chat and the message ids, while the
connection is enabled, as for `business_message`.

Telegram's docs: [BusinessConnection](https://core.telegram.org/bots/api#businessconnection),
[connected business bots](https://core.telegram.org/api/bots/connected-business-bots).

### Command menus

`setMyCommands`, `getMyCommands` and `deleteMyCommands` keep one list for each `scope` and
`language_code`. `getMyCommands` returns only the list set for that exact scope and language (an
empty list if there is none), and `deleteMyCommands` removes only that list. A scope Telegram cannot
read fails with its `can't parse BotCommandScope: …` error: one that is not an object, an unknown
`type`, an empty `chat_id`, or a `chat_member` scope without a positive `user_id`. A chat scope's
chat must be one the bot can see (`chat not found` otherwise); a private chat takes only the `chat`
scope, and a channel takes none. `language_code` must be empty or two lower-case letters
(`invalid language code specified`). After the scope and language, each command is trimmed and loses
a leading `/`, and its description is trimmed; they are stored that way. An empty command or
description fails with `command must be non-empty` or `command description must be non-empty`, and
one over 32 or 256 characters with `command length must not exceed 32` or
`command description length must not exceed 256`. The characters a command may use are not checked
here.

## Messages

### What members send

Besides text and photos, members post videos, animations (which carry a `document` too), stickers,
voice notes, audio, video notes and documents, each needing its own permission (`can_send_videos`,
`can_send_voice_notes`, ...), plus albums sharing a `media_group_id` and forwards with
`forward_origin` (a user, a hidden user, a channel post, or a post made on behalf of a supergroup,
with `type: "chat"` and an optional `author_signature`). Only a supergroup or a channel posts on its
own behalf, so TDLib refuses a forward header from any other chat. An edit by the author reaches
bots as `edited_message` (in a channel, `edited_channel_post`) with `edit_date`. A member's text
and captions, in posts and in edits, are trimmed of spaces and newlines at both ends, as Telegram's
apps send them. A post, private message or edit whose text then shows nothing (only spaces,
zero-width or other blank characters) fails with `MESSAGE_EMPTY`; such a caption is dropped.

Contacts and locations need `can_send_messages`, as in TDLib's `can_send_message_content`, in groups
and in the bot's private chat. A contact keeps `last_name`, `vcard` and `user_id` when given; the
user must exist (`User not found`). Telegram fills `user_id` when the number belongs to an account;
test users have no phone numbers, so the test names the user. A location is checked with TDLib's
texts: a point off the map fails with `Invalid location specified` (`Invalid live location
specified` for a live one), and a `live_period` other than 0 makes it live, from 60 seconds to a day
or `0x7FFFFFFF`, with a heading of 1 to 360 and an alert radius up to 100000
(`Wrong live location period specified` and the like). `horizontal_accuracy` is held to 1500
meters and rounded up to whole meters, as TDLib sends it. A location without `latitude` or
`longitude` is refused as incomplete. Unverified: what Telegram answers an empty phone number or
first name, which TDLib does not check; this server refuses them as incomplete.

### Posts on behalf of a chat

In a supergroup, an administrator with `is_anonymous` posts as the group, as TDLib's
`create_message_to_send` does: the message has `sender_chat` (the group), `from` the
`@GroupAnonymousBot` user (id 1087968824) as the Bot API writes it, and the administrator's custom
title as `author_signature`. An administrator without `is_anonymous` posts as themselves. A member
may also post as a channel they created (`sendAs`); `from` is then `@Channel_Bot` (id 136817688)
and `sender_chat` the channel. A member who is not anonymous may name themselves, as TDLib lists
their own account. Naming any other chat, or any chat outside a supergroup or in a private chat,
fails with `SEND_AS_PEER_INVALID`. These are real messages of the chat: bots get them, delete them
with the usual rights, and a forward of one has the `chat` origin with the sender chat and
signature. Waits and failure rules still name the person who posted. Telegram offers only public
channels the user created; chats made in a test have no public username, so here any channel the
member created counts. Posting as a channel needs Telegram Premium, as TDLib's
`get_dialog_send_message_as_dialog_ids` marks it, unless the channel is verified or linked to the
group, which this server does not model. Unverified: what Telegram answers a member without it; here
`PREMIUM_ACCOUNT_REQUIRED` (403), which `messages.sendMessage` lists. Also unverified: what Bot API
calls answer for the `@GroupAnonymousBot` and `@Channel_Bot` users, such as `banChatMember` on the
`from` of such a post; here they are unknown users (`Bad Request: user not found`).

An anonymous administrator reacts as the supergroup, and only the owner may react as the chat:
TDLib offers no reaction at all to any other anonymous administrator
(`get_my_reaction_dialog_id`, `get_message_available_reactions`), so `react()` fails with
`The reaction isn't available for the message`. A group whose owner stays anonymous
(`ownerAnonymous`) has `is_anonymous: true` in the owner's `ChatMember`; the owner posts as the
group, and their reaction reaches administrator bots as `message_reaction` with `actor_chat`, not
`user`. `deleteMessageReaction` removes it by `actor_chat_id`, not by the owner's `user_id`. An
anonymous administrator or owner votes as the group ([Polls](#polls)). Not modeled: a member
whose default sender is a channel, who TDLib has react as that channel. Nor the service messages of
an anonymous owner or administrator: no source shows how Telegram shows their pins, new members,
title and photo changes or topics, so these test actions fail for such a person
(`... by an anonymous owner or administrator is not modeled`).

`banChatSenderChat` and `unbanChatSenderChat` need `can_restrict_members` in a supergroup or
channel and a `sender_chat_id` the bot can see (`member not found` otherwise); a basic group's id
there is refused (`can't restrict the chat`). A basic group bans no chat
(`can't ban chats in basic groups`) and unbans one as a no-op, and a private chat refuses both.
A user's id is banned or unbanned as that user, as TDLib does: a ban takes `until_date` as
`banChatMember` does, which the Bot API server reads for this method too, and in a basic group an
unban removes the user, as a ban does there (`DialogParticipantManager` sets the status to left
with `delete_chat_participant`). No `chat_member` update is sent for a chat. While a channel is
banned, its owner posts on behalf of none of their channels there. Unverified: the error such a
post gets; here `USER_BANNED_IN_CHANNEL`. A chat's ban lasts "Until the chat is unbanned", as the
Bot API docs say. They list no `until_date` for it, and no source shows what Telegram does with one,
so a chat's ban with `until_date` bans nothing and is reported as unimplemented, with 404
`Not Found: method not found`. Without `until_date` the chat is banned.

### Entities

Member messages and captions carry the entities Telegram finds by itself, found the way TDLib finds
them: `mention`, `bot_command` (anywhere it does not touch a letter, digit, `_`, `/`, `<` or `>`),
`hashtag`, `cashtag`, `url` and `email`, with UTF-16 offsets, in groups and in private chats. A link
without a protocol needs a common top-level domain, so `example.com` and `shop.xyz` are links and
`package.json`, `spam.test` and `evil.local` are not; with a protocol, as in
`http://spam.invalid/x`, any domain is. Phone numbers and bank card numbers are not marked.

A test may also give a member's text or caption `entities` in the Bot API's `MessageEntity` shape.
They are read as the Bot API reads them, then checked as TDLib checks a user's input entities
(`get_message_entities`, `fix_formatted_text`): ranges must fit the text, a `text_link` URL must
pass `LinkManager::check_link` and is kept as it rewrites it (`spam.example` becomes
`http://spam.example/`), a `tg://user?id=` link becomes a `text_mention`, a mentioned user must
exist, and a custom emoji id must not be 0. Refusals carry those texts, such as
`Entity URL 'nodot' is invalid: Wrong HTTP URL`, without the Bot API's `Bad Request: ` and
`can't parse entities: `. The types Telegram finds by itself are found here and ignored when given,
except `phone_number` and `bank_card_number`: Telegram's server marks them by rules it does not
publish, so the test marks them. Not modeled: Telegram drops a premium custom emoji from a user
without Premium.

### Deleting messages

A bot deletes its own messages, others' with `can_delete_messages`, and any message in its private
chat. A message sent 48 hours ago or earlier, the service message that created a supergroup, channel
or forum topic, and a dice in a private chat less than a day old can't be deleted
(`message can't be deleted`). `deleteMessages` skips ids it does not find and, as TDLib does, checks
every other message before deleting any, so one it can't delete fails the whole call.

People delete messages too (`deleteMessage`, `deleteDirectMessage`), for everyone, as TDLib's
`can_delete_message` and `can_revoke_message` allow. In a supergroup or channel, someone with
`can_delete_messages` deletes any message but the chat's first, its creation and upgrade messages
and a topic's creation message; anyone else only their own message that is not a service message,
in a channel only with `can_post_messages`. A person has no 48-hour limit; only bots do. In a basic
group, a person deletes their own message that is not a service message, and an administrator any
message. In a private chat with a bot, a user deletes any message for both sides but a dice less
than a day old. Refusals read `Message can't be deleted` or `Message can't be deleted for
everyone`; TDLib would delete such a message only for that person, which nobody else sees. A
message that is not there is skipped.

No bot gets an update when a message is deleted, by a bot or by a person: the Bot API server only
drops deleted messages from its cache (`updateDeleteMessages` in
[Client.cpp][bot-api-server-client]), and no `Update` field reports one, but
`deleted_business_messages` for a business chat ([Business connections](#business-connections)).

Telegram's docs: [deleteMessage](https://core.telegram.org/bots/api#deletemessage).

### Editing

Only the bot's own messages can be edited, except in a channel ([Channels](#channels)); an edit that
changes nothing fails with `message is not modified`; an edit without `reply_markup` removes the
inline keyboard, after which its buttons can no longer be pressed. As in TDLib's
[`can_edit_message`](https://github.com/tdlib/td/blob/master/td/telegram/MessagesManager.cpp), a
forward, and a message sent with a reply keyboard, `remove_keyboard` or `force_reply`, can't be
edited either, nor can its poll be stopped. Editing a message the bot can't edit fails with
`message can't be edited`, or `message media can't be edited` from `editMessageMedia`.
`editMessageText` needs a text message (`there is no text in the message to edit`), and
`editMessageCaption` a photo, video, animation, audio, document or voice message
(`there is no caption in the message to edit`); `editMessageMedia` replaces a photo, live photo,
video, animation, audio, document or text. A sticker, video note, location, contact or dice only has
its inline keyboard changed. A live location still counts as editable while its `live_period` runs,
so text and caption edits then fail with the two errors above rather than
`message can't be edited`. An empty caption is left out of the message.

### Editing media

`editMessageMedia` turns a text, or a photo, live photo, video, animation, audio or document
message, into any of these, from an upload (`attach://`), a `file_id` or a URL. It reads the
`InputMedia` before the message, in the Bot API's order: the caption's markup, `type`, which is
required, `media`, then whether the type can be edited to, each failing with
`can't parse InputMedia: …`. A document with `disable_content_type_detection` is a plain file, so
a photo is refused `as DocumentAsFile`. In an album, a photo or video becomes only a photo, live
photo or video, and an audio or document keeps its kind. Other messages' media cannot be edited.

### Forwards and copies

A forward carries `forward_origin`; a copy does not. Beside it, the Bot API server still writes the
older fields ([Client.cpp][bot-api-server-client] `JsonMessage`): `forward_from` for a user;
`forward_from_chat`, and `forward_signature` when signed, for a post on behalf of a chat;
`forward_sender_name`, when not empty, for a hidden user; `forward_from_chat`,
`forward_from_message_id` and `forward_signature` for a channel post; then `forward_date`, the
origin's date. A forward of a forward keeps the first origin
and its date. A message sent on behalf of a chat in a group (see
[Posts on behalf of a chat](#posts-on-behalf-of-a-chat)) is forwarded with a `chat` origin, as
TDLib's `MessageOrigin` reads Telegram's forward header. Its `author_signature` stays in the
origin: the bot's forward or copy has none of its own. A bot cannot forward from a chat it is
not in; the source chat gets the checks under
[Which chats a bot may use](#which-chats-a-bot-may-use) for a call that needs only read access,
before the chat the message goes to. A missing message fails with `message to forward not found` or
`message to copy not found`. Service messages can't be forwarded or copied
(`the message can't be forwarded` / `copied`). Nor can an open quiz be copied by a bot that does not
know its correct options (see [Polls](#polls)); once the quiz is closed any bot copies it. A send
with `protect_content`, a forward or an album included, has `has_protected_content`; it can't be
forwarded, but the bot can still copy it. One item of an album is forwarded or copied without its
`media_group_id`. A copy's `caption` replaces the original on media that takes one, formatted with
`parse_mode` or `caption_entities`, and an empty one removes it; a text message gets no caption, so
the 1024-character limit applies only to media.

### Pins

Pinned messages are kept newest first by sending date. `getChat` returns the most recent one that
was not deleted as `pinned_message`, and `unpinChatMessage` without `message_id` unpins it. This
works in groups, channels and private chats; each bot pins in its own private chat with a user.
The message is checked before the bot's rights: a missing message fails with
`message to pin not found` or `message to unpin not found` (also when nothing is pinned), and only
an existing one with `not enough rights to manage pinned messages in the chat`. Each pin,
by a bot or by a person (`pinMessage`), posts the `pinned_message` service message, which reaches
every bot in the chat, the pinning bot included. Neither `pinned_message` carries the pinned
message's `reply_to_message`.

Telegram's docs: [unpinChatMessage](https://core.telegram.org/bots/api#unpinchatmessage).

### Polls

`sendPoll` needs a question of up to 300 characters and 1 to 12 options of up to 100 characters
each. Both are kept trimmed of spaces and newlines, as Telegram keeps them, and the limits count
what is left; one that then shows nothing fails with `text must be non-empty`.
`question_parse_mode` and an option's `text_parse_mode` are not read. A `type` other than `regular`
or `quiz` fails with `unsupported poll type specified`. It keeps `is_anonymous`,
`allows_multiple_answers`, `allows_revoting` (on by default for regular polls, off for quizzes),
`members_only` (channels only), `is_closed`, `description` and an attached photo, and gives each
option a `persistent_id`. A quiz needs `correct_option_ids` (or the older `correct_option_id`) and
may have an `explanation`, formatted with `explanation_parse_mode` or `explanation_entities`; its
200-character limit is not checked. While a quiz is open, only a bot that knows its correct options
sees them and the explanation in the poll, in forwards, replies and pins too: the bot that sent it
itself, not as a forward, or a bot in a private chat
([Poll](https://core.telegram.org/bots/api#poll)). Once it is closed every bot sees them. `stopPoll`
closes a poll once; a poll in a message the bot can't edit (see [Editing](#editing)) fails with
`poll can't be stopped`. The bot that stopped it and the bot that sent it then get the closed poll
as a `poll` update, as [Update](https://core.telegram.org/bots/api#update) says. A channel takes
anonymous polls only (`non-anonymous polls can't be sent to channel chats`).

Members vote with the `vote` test action, checked as Telegram's app checks a vote (TDLib's
`set_poll_answer`): a closed poll, more than one option in a single-answer poll, an option that
does not exist, a changed or retracted vote where revoting is off (every quiz, by default), or a
voter who is not in the chat are refused with TDLib's texts. Bots get votes only in the polls they
sent ([Update](https://core.telegram.org/bots/api#update)): that bot gets the poll's new counts as
a `poll` update and, for a poll that is not anonymous, a `poll_answer` with the voter, `option_ids`
and `option_persistent_ids` (empty when the vote is taken back). An anonymous administrator or
owner of a supergroup votes as the group: `voter_chat` is the group, "if the voter is anonymous"
([PollAnswer](https://core.telegram.org/bots/api#pollanswer)), and `user` is the Channel bot, which
the Bot API server writes for older bots (`JsonPollAnswer`). Both wait in the poll's own
webhook queue, as the Bot API server queues them by poll id. Unverified, because Telegram does not
document it: the order of the two updates (`poll_answer` comes first here), and that a vote that
changes nothing sends no update. Members also post polls of their own, and may send one to a bot
in private, as TDLib allows; the bot gets the message but none of its votes.

### Reactions

A member's reaction reaches the chat's administrator bots as `message_reaction`, only when they list
it in `allowed_updates`, as on Telegram. A member reacts only with a reaction the message has
available, as TDLib's `addMessageReaction` checks; any other fails with
`The reaction isn't available for the message`, as does an emoji `$` or one starting with `#`,
which TDLib reads as no reaction. Unverified: the reactions available are taken to be the
[ReactionTypeEmoji](https://core.telegram.org/bots/api#reactiontypeemoji) list, while Telegram
sends its apps a list of its own. A bot sets at most one reaction, and only an emoji from the
[ReactionTypeEmoji](https://core.telegram.org/bots/api#reactiontypeemoji) list (any other emoji
fails with `REACTION_INVALID`, and a paid reaction is refused) or a custom emoji, whose
`custom_emoji_id` must be an integer. A custom emoji is accepted without checking that it is already
on the message or allowed by the chat's administrators. A reaction on an album lands on its first
message that is not deleted. The bot removes a member's reaction with `deleteMessageReaction` and
`can_delete_messages`; `actor_chat_id` may stand in for `user_id`, and removes a reaction made as
that chat ([Posts on behalf of a chat](#posts-on-behalf-of-a-chat)). A user's id there removes
that user's reaction, and a chat this server does not know fails with `reaction sender not found`.
The ids and the message are checked before the bot's rights. Reaction counts
(`message_reaction_count`) are not sent.

### Media

Sent photos, documents, videos, animations, stickers, voice notes, audio and video notes carry the
fields the Bot API requires and resolve through `getFile`. They keep what the sender says: a video's
or animation's `width`, `height` and `duration`, a video note's `length`, an audio's `title` and
`performer`, an uploaded sticker's `emoji`, capped as the Bot API caps them (sizes at 10000,
durations at a day). A video note's `length` over 640 then fails with `wrong video note length`, as
in TDLib. What the sender leaves out gets a stand-in (1280x720, one second). An animation also
carries `document`. A photo has one size: its image's, read from a PNG, GIF or JPEG header and
scaled down to fit 2560x2560, Telegram's largest, or 800x800 when the header cannot be read.
Telegram also lists smaller sizes. A contact keeps its `vcard`. A location with `live_period` is a
live location with its `heading` and `proximity_alert_radius`, refused out of Telegram's ranges, and
off the map with `invalid live location specified`. Coordinates are read by their leading number
(`12abc` is 12, and text without one is 0), and a point off the map is refused only after the chat
is checked.

`sendMediaGroup` sends up to 10 items as one album; a single item is sent as an ordinary message, as
TDLib does. Photos, live photos and videos can share an album. As in Telegram's Bot API server, it
reads `reply_parameters` before `media`, reads every item before the chat, failing with
`can't parse InputMedia: …` (such as `type "animation" can't be used in sendMediaGroup` or
`type "sticker" is unsupported`), and checks the replied message before it reads any file or counts
the album.

### Files

Each bot gets its own opaque `file_id` for a file, and `file_unique_id` is the same for every bot. A
bot can send again, `getFile` and download (with its own token) only the file_ids it was given.
`getFile` on another bot's fails with `wrong file_id or the file is temporarily unavailable`, and
sending it with `wrong file identifier/HTTP URL specified`, the Bot API's text for Telegram's
`MEDIA_EMPTY`. `editMessageMedia` with it fails with `MEDIA_EMPTY` itself, since only sends
translate it (unverified: Telegram does not document its answer to an edit). A send without its
file, or with an `attach://` name that has no upload, fails with `there is no photo in the request`
(`video`, `video note`, `voice` and so on). A string that is not a file_id fails with TDLib's
reason, such as `wrong remote file identifier specified: can't unserialize it`. As in TDLib, any
string with a dot is an HTTP URL, refused when TDLib cannot parse it, such as
`invalid file HTTP URL specified: Unsupported URL protocol` for anything but `http` and `https`;
this server does not fetch it and stores a one-byte file instead. A file sent again keeps its kind:
a photo cannot stand in for any other kind, nor any other kind for a photo
(`can't use file of type Photo as Document`), and a document, video or the like sent by another
method stays what it was; a live photo's video sent on its own is a video. `getFile`'s `file_path`
starts with the directory TDLib keeps that kind of file in, such as `photos/`, `voice/` or `music/`.
The control API shows messages with the first bot's file_ids. A member posts an earlier file again
by any bot's file_id for it (`fileId`): the message keeps its kind, `file_unique_id` and what its
first sender said, and needs the permission for that kind. A new upload of the same bytes is a new
file with a new `file_unique_id`.

Telegram's docs: [sending files](https://core.telegram.org/bots/api#sending-files).

## Buttons and ephemeral messages

### Inline keyboards

Every button needs `text` and an action: a button without `text` fails with
`can't parse InlineKeyboardButton: Can't find field "text"`, and one with only `text` (or an empty
`callback_data`) with Telegram's `Text buttons are not allowed in the inline keyboard`. A button
that sets several actions keeps only the first one Telegram reads (`url`, then `callback_data`, then
the others), so a button with both `url` and `callback_data` comes back with only its `url` and
cannot be pressed. A sent or edited message returns each button with only its `text`,
`icon_custom_emoji_id`, `style` and that one action. `callback_data` is limited to 64 bytes of
UTF-8, not 64 characters; longer data fails with `BUTTON_DATA_INVALID`. Buttons are checked when the
request is read, before the chat is looked up; the length of `callback_data` only after the chat and
message checks. Sends, business sends, edits, ephemeral edits and `stopPoll` all check this, and a
send checks `inline_keyboard` even when a reply `keyboard` sent with it wins. `stopPoll` does not
put its keyboard on the message here.

### Callback queries

Answering a query that was never sent fails. Answer text is limited to 200 characters; a longer
answer fails with `MESSAGE_TOO_LONG` and the query stays open, so the bot can answer it again.
`chat_instance` is an opaque number that is the same for every press in a chat; it is not the chat
id.

A bot can get one press twice. Telegram sends an update again when the webhook did not confirm it,
and a polling bot gets it again until it confirms it with its offset; either way it is the same
update, with the same `update_id` and callback query id ([Update delivery](#update-delivery)). A
test makes this happen with `deliverTwice` ([Redelivery](#redelivery)). Unverified: what Telegram
answers a second `answerCallbackQuery` for a query already answered; here it fails with
`query is too old and response timeout expired or query ID is invalid`.

### URL buttons

Opening a URL button asks Telegram nothing, so no bot hears of it unless the link is to a bot.
`openUrlButton` and its ephemeral and private-chat forms read the link as TDLib's `LinkManager`
does. A bot link is `https://t.me/<bot>` (or `telegram.me`, `telegram.dog`, `t.me/s/<bot>`),
`https://<bot>.t.me/` or `tg://resolve?domain=<bot>`; the username matches in any case. The first
argument TDLib knows decides what the link does, and three of them reach the bot:

- `start=<parameter>`: the user starts the bot in their private chat. The bot gets
  `/start <parameter>` from them, with a `bot_command` entity over `/start`, as
  `messages.startBot` sends it; with an empty parameter it gets only `/start`. On first contact
  Telegram's app shows a START button and sends this once the user presses it. In a chat that has
  messages, it sends it at once. Either way the bot gets the same message, and here the user always
  goes on. The bot may then write to the user.
- `startgroup=<parameter>`: the user adds the bot to the group they pick (`addToChatId`), as under
  [Adding the bot through a link](#adding-the-bot-through-a-link). `admin=`, such as
  `admin=delete_messages+restrict_members`, asks for those rights, with `can_manage_chat`. Rights a
  group cannot have, such as `post_messages`, are left out.
- `startchannel&admin=<rights>`: the user adds the bot to the channel they pick, as an
  administrator with those rights. Rights a channel cannot have, such as `pin_messages`, are left
  out, and without rights it is not such a link.

Any other argument TDLib knows, such as `startapp`, `game`, `ref`, `videochat`, `boost` or
`direct`, makes a link of another kind. So does a `start` parameter that begins with `_tgr_`, an
affiliate program's referrer, and a path that names a message, a story or a web app, such as
`t.me/<bot>/42`. Such a link changes nothing and comes back, as does any other URL, or a link to a
username that is no bot on this server. A parameter has only `A-Z`, `a-z`, `0-9`, `_` and `-`; with
any other character the argument is skipped. Telegram takes a parameter of up to 64 characters;
this server does not check the length.

The parameter is hidden from the user. TDLib's `sendBotStartMessage` keeps the user's own copy as
plain `/start` (`/start@<bot>` in a group), while the bot gets the parameter. This server keeps one
copy, the bot's, so `getDirectMessages`, `getMessages` and the viewer show the parameter.

Unverified, since the app asks Telegram nothing: only the receiver of an ephemeral
message opens its buttons, and a button that is not a URL button is refused. Anyone else opens a
button, someone outside the chat included, as anyone presses one. Also unverified: a link to a
deleted bot, which does nothing here.

Telegram's docs: [bot links](https://core.telegram.org/api/links#bot-links),
[group and channel bot links](https://core.telegram.org/api/links#group-channel-bot-links),
[deep linking](https://core.telegram.org/bots/features#deep-linking). TDLib:
`internalLinkTypeBotStart`, `internalLinkTypeBotStartInGroup`, `internalLinkTypeBotAddToChannel`
and `sendBotStartMessage`.

### Ephemeral messages

A send with `ephemeral_message_parameters: { receiver_user_id }` is shown to one member. It
returns `message_id` 0, `receiver_user` and an `ephemeral_message_id` of its own, and takes no
message id from the chat; a press on its button carries the same message in
`callback_query.message`. A poll, a dice or a live location cannot be sent this way
(`unallowed message content specified`). The regular edit and delete methods cannot reach it; only
the bot that sent it changes it, with the `editEphemeralMessage…` methods and
`deleteEphemeralMessage`, which take `chat_id`, `receiver_user_id` and `ephemeral_message_id` and
return `true`.
`editEphemeralMessageText` and `editEphemeralMessageCaption` reach Telegram as the same request, so
either one changes a text message's text or a media message's caption. The receiver must be a
member of the group or supergroup and not a bot. A bot that administers the chat may send one at any
time; any other bot needs to pass, as `ephemeral_message_parameters.callback_query_id`, the id of a
button press it received from the receiver, at most 15 seconds old. Who may get the message is
checked after the chat, the reply and the content. Members cannot send ephemeral commands here, so
`reply_parameters.ephemeral_message_id` never qualifies.

Unverified: Telegram does not document the errors (`PEER_ID_INVALID` outside groups,
`USER_IS_BOT`, `USER_NOT_PARTICIPANT`, `CHAT_ADMIN_REQUIRED` without an eligible action, and
`MESSAGE_ID_INVALID` for an unknown or deleted ephemeral message, or one another bot sent), whether
an ephemeral edit without `reply_markup` removes the keyboard (it does here) and an edit that
changes nothing fails (it does not here), or which text edits it refuses (here a caption may have
1024 characters, and an empty text, or a caption for content that takes none, leaves the message as
it was).

Tests see these messages in `getMessages`, with their receiver, and find one by
`ephemeral_message_id` with `getEphemeralMessage`; `pressEphemeralButton` presses its buttons as the
receiver. A `message` wait by author and exact text finds them too.

Telegram's docs: [Ephemeral messages and commands][ephemeral-docs].

## Text formatting and replies

### Formatting

Bot text and media captions support `parse_mode` (`HTML`, `MarkdownV2` and legacy `Markdown`) and
explicit `entities` / `caption_entities`. As on Telegram, a `parse_mode` other than `none` wins and
the explicit entities are ignored; `none` (in any letter case) sends the text as it is, and an
unknown mode fails with `unsupported parse_mode`. The stored response has plain text and UTF-16
entity offsets. Formatting also applies to album captions, media edits, copy captions, reply quotes
and business text sends. Links, mentions, commands, hashtags and cashtags can be detected inside
styles; code, pre and explicit links suppress overlapping automatic detection.

The tests cover malformed markup, crossed Markdown delimiters, invalid entity ranges
(including surrogate-pair boundaries), style splitting around code, and overlapping blockquote
normalization. These rules follow
[Bot API formatting options](https://core.telegram.org/bots/api#formatting-options) and Telegram's
[TDLib entity implementation][tdlib-entities]. Album captions are all parsed before any album
message is stored, following the [Bot API server's request parsing][bot-api-server-client].
This is a tested subset, not a claim that every Telegram parser edge case is implemented or every
error description is byte-for-byte identical.

### Text cleaning

Text is then kept the way Telegram keeps it. Control characters become spaces; `\r`, U+2028 to
U+202E and the combining marks U+030A, U+0333 and U+033F are dropped; in a run of left-to-right and
right-to-left marks all but the last become zero-width non-joiners; and spaces and newlines are cut
from both ends (from the start only up to the first entity), with the entities moved to match. Text
that then shows nothing, being only spaces or blank characters such as zero-width spaces, direction
marks, no-break, Braille or ideographic spaces, fails with `text must be non-empty`, unless
`link_preview_options` gives a `url` and does not disable the preview: then the message is sent with
empty text. A caption that is only spaces is dropped; other blank characters stay in a bot's
caption.

### Length limits

After parsing, text may have 4096 characters and a caption 1024, counted as Unicode code points, so
an emoji counts once. Longer sends fail with `message is too long` or `message caption is too long`
(also `editMessageMedia` and copies of media); Telegram's server answers a longer `editMessageText`
with `MESSAGE_TOO_LONG` and a longer `editMessageCaption` with `MEDIA_CAPTION_TOO_LONG`. The
ephemeral edits give the same answers, though Telegram does not document them; a text edit of an
ephemeral media message sets its caption, so more than 1024 characters fail with
`MEDIA_CAPTION_TOO_LONG`. An empty `text` and raw text over 32 KB (`text is too long`) fail as the
request is read, as do markup errors; whether text shows nothing and how long it is are checked only
after the chat, the reply and the edited message, so a missing chat or message is reported first.

### Dates and explicit entities

`<tg-time unix="1647531900" format="wDT">…</tg-time>` in HTML and
`![…](tg://time?unix=1647531900&format=wDT)` in MarkdownV2 make a `date_time` entity with
`unix_time` and `date_time_format`, the format written back in Telegram's order (`w`, then `d` or
`D`, then `t` or `T`, or `r`) and empty when none was given; a format naming both precisions keeps
the shorter one. Explicit entities are read as the Bot API reads them: `mention`, `hashtag`,
`cashtag`, `bot_command`, `url`, `email`, `phone_number` and `bank_card_number` are ignored, since
Telegram finds those by itself, and an unknown type fails with
`can't parse MessageEntity: Unsupported type specified`. An explicit `date_time` needs `unix_time`,
refuses a format other than `r`, `R` or letters from `tTdDwW` (`Invalid date-time format specified`)
and a `unix_time` of 0 or less (`invalid date specified`), and there the last of `d`/`D` and of
`t`/`T` wins. A `text_mention`, from a `tg://user?id=` link or an explicit entity, carries the whole
`User`; a user the server has never seen has only its id, `is_bot: false` and an empty `first_name`,
as the Bot API server writes it.

### Replies and quotes

`reply_parameters` and the older `reply_to_message_id` populate `reply_to_message`, without nested
reply chains, in every send method including `sendMediaGroup`, and `allow_sending_without_reply` is
supported. A `message_id` of 0, an ephemeral message's, names no message, so the send is not a
reply. With `reply_parameters.chat_id` the bot replies to a message in another chat it can read: the
message gets `external_reply` (the original's origin, its chat and id for a supergroup or channel,
and its media without the caption, a live photo as `live_photo` alone) instead of
`reply_to_message`, plus an automatic `quote` of the original's text or caption. The other chat gets
the checks under [Which chats a bot may use](#which-chats-a-bot-may-use): `chat not found` for an
unknown chat or one the bot was never in, and a 403 for a supergroup or channel it left or was
kicked from. A missing or deleted message fails with `message to be replied not found`.

A `quote` (with `quote_parse_mode` or `quote_entities`) must be an exact substring of the original,
including its bold, italic, underline, strikethrough, spoiler, custom emoji and date entities, or
the send fails with `QUOTE_TEXT_INVALID`
([messages.sendMessage](https://core.telegram.org/method/messages.sendMessage)); the message then
carries `quote` with `is_manual` and the `quote_position` given, moved past the spaces trimmed from
the quote's start (0 when it is below 0 or above 1000000). Forum-topic sends without an explicit
reply attach the topic's creation message. Not implemented: replies to another forum topic as
`external_reply`, reply metadata in business sends, and `checklist_task_id` and `poll_option_id`;
see [ReplyParameters](https://core.telegram.org/bots/api#replyparameters).

### Link previews

A text message carries `link_preview_options` when the options sent or edited with it differ from
the defaults, kept as Telegram keeps them: `is_disabled` only when the text has a link, and
`prefer_small_media` or `prefer_large_media` only with a `url`. No link previews are generated.

### Uploaded documents

Uploaded documents preserve their original filename and MIME type when reused by `file_id`
([Document](https://core.telegram.org/bots/api#document)).

## Requests and updates

### Parameters

A boolean parameter is true when it reads `true`, `yes` or `1`, in any case. A flag inside
`reply_parameters`, `link_preview_options`, `reply_markup` or `permissions` must be a JSON `true` or
`false`, or the call fails, for example with `field "remove_keyboard" must be of type Boolean`. A
user id is an optional `-` and the digits after it (`12abc` is 12; a leading space or `+` makes it
invalid), and `reply_to_message_id`, `message_thread_id` and `until_date` are read by their leading
digits too, so `null` is 0. A JSON-serialized parameter (`reply_markup`, `reply_parameters`,
`message_ids`, `media`, ...) may also come as a JSON string; one that cannot be read fails with
Telegram's parse error, such as `can't parse reply keyboard markup JSON object`. A missing required
parameter fails with Telegram's text, such as `chat_id is empty` or `invalid user_id specified`. If
this server itself fails, the bot gets Telegram's bare `500 Internal Server Error`, and the cause
goes to `log`.

How request bodies are read is in the reference, under [Supported Bot API methods][readme-methods].

### Update delivery

Each bot has its own update queue, as on Telegram, where
[Telegram's Bot API server](https://github.com/tdlib/telegram-bot-api) settles what the docs leave
out. Its updates are numbered in sequence, so two bots can get the same `update_id`. An update stays
pending until the bot confirms it: with a `getUpdates` offset, or by answering it from its webhook
with a 2XX status. A pending update expires a day after it happened, and a button press after 150
seconds.

- **Webhook requests** carry only the headers Telegram sends: `Host`, `Authorization` when the URL
  holds a user name and password, `X-Telegram-Bot-Api-Secret-Token` when a secret was set,
  `Content-Type: application/json`, `Content-Length`, `Connection: keep-alive` and
  `Accept-Encoding: gzip, deflate`.
- **Order.** Updates wait in queues keyed as Telegram keys them: a chat's messages, its
  `my_chat_member` updates and its reactions in three queues of the chat; a user's `chat_member`
  updates and join requests in one queue of the user, and their button presses in another. A
  queue's updates reach the webhook one at a time, in order; different queues are delivered at
  once, up to `max_connections` requests (1 to 100, default 40). When more queues are ready than
  connections are free, the queue ready longest goes first, then the one with the lowest queue id,
  as on Telegram. Updates pending when the webhook is set are ready together; an update the webhook
  refused is ready again only when its retry is due, behind the queues already waiting. Telegram
  also opens its connections gradually and loads at most twice `max_connections` updates at a
  time; this server does neither.
- **Retries.** An update the webhook does not answer with 2XX (another status, a refused or reset
  connection, or a minute without an answer) is sent again: at once after the first failure, then
  after 2, 4, 8 ... seconds up to a random 60 to 120, or after the answer's `Retry-After` (at most
  an hour). An update whose next try would come after it expires is dropped. These waits run on
  the server's clock, so on a manual or running clock `advanceTime` moves them.
- **Calls in the webhook's answer.** A webhook may answer an update with a Bot API call (JSON, form
  or multipart with a `method` field), as Telegraf does by default. It runs as that bot and appears
  in `getCalls()`; its result goes nowhere. `setWebhook`, `deleteWebhook`, `close`, `logOut` and
  any `get` method are not run.
- **`getWebhookInfo`** reports `pending_update_count`, `last_error_date` and `last_error_message`
  in Telegram's words: `Wrong response from the webhook: 500 Internal Server Error`, a connection
  error as Linux words it (`Connection refused`, `Connection reset by peer`,
  `Connection timed out`, `No route to host`, `Network is unreachable`, `Broken pipe`),
  `Read timeout expired`, or a TLS failure as OpenSSL 3 words it, such as
  `SSL error {error:0A000086:SSL routines::certificate verify failed}`. A connection closed without
  an answer records no error, and neither does any other connection error. The last error stays
  after later deliveries succeed, until a `setWebhook` that changes the webhook, or
  `deleteWebhook`. It also reports `max_connections`, `ip_address` (the `ip_address` given, or the
  address the host name resolved to; `<unknown>` only while `setWebhook` is still resolving it),
  `has_custom_certificate`, and `allowed_updates` unless it is the default.
- **`setWebhook`** answers `Webhook was set` or `Webhook is already set`, and `deleteWebhook`
  `Webhook was deleted` or `Webhook is already deleted`. It refuses a URL Telegram cannot read
  (`invalid webhook URL specified`; a URL without a scheme is taken as https) and a `secret_token`
  longer than 256 characters or with characters other than `A-Z`, `a-z`, `0-9`, `_` and `-`.
  Unless `ip_address` is given, it resolves the URL's host name before it answers and sends to the
  first IPv4 address (an IPv6 one only when there is none). A name that does not resolve is refused
  with `Bad Request: bad webhook: Failed to resolve host: Name or service not known` (the lookup
  error in glibc's words). Telegram looks the name up again about every half hour; this server
  keeps the first address. A new webhook replaces the old one first, so a refused URL leaves none,
  and a `setWebhook` still resolving when another one arrives gets 409
  `Conflict: terminated by other setWebhook`. `drop_pending_updates` empties the queue, even with
  an empty URL. With `floodControl`, a URL less than a second after the previous one gets 429
  ([Flood control](https://github.com/anatolyben/telegram-bot-test-server#flood-control)). An
  uploaded `certificate` only sets `has_custom_certificate`: deliveries over https trust what Node
  trusts, not that certificate as Telegram does. Like a Bot API server run with `--local`, this one
  takes `http` URLs, any port and local addresses.
- **Removing or replacing the webhook** ends its requests in progress. Every update it has not
  confirmed stays pending, the one in flight included, for `getUpdates` or the new webhook.
- **`getUpdates`** supports `offset`, `limit`, `allowed_updates` and long polling with `timeout`.
  Calling it while a webhook is set fails with 409. A new waiting poll ends the one before it with
  409 and this description: `Conflict: terminated by other getUpdates request; make sure that
  only one bot instance is running`.
  `setWebhook` ends it with 409 `Conflict: terminated by setWebhook request`. As on Telegram, a
  second conflict within 3 seconds is answered 3 seconds later. A poll whose client hangs up stops
  waiting.
- **`allowed_updates`**, from `setWebhook` or `getUpdates`, is a list or the same list as a JSON
  string, in any body. Names match in any case and unknown ones are skipped; an empty list, or one
  with no known name, means the default: every update but `chat_member`, `message_reaction` and
  `message_reaction_count`. As the `getUpdates` docs say, it does not affect updates made before
  the call that sets it; a long poll sets it as it arrives.
- **Rights decide who hears what**, as the [Update](https://core.telegram.org/bots/api#update) docs
  say: `chat_member` and `message_reaction` reach only bots that are administrators in the chat,
  and `chat_join_request` only bots with `can_invite_users`. A bot gets `my_chat_member` whenever
  its own status changes, whoever changed it.
- **A bot's own changes.** When the bot restricts, bans, unbans or approves a member, the server
  sends the resulting `chat_member` update back to the bot, as Telegram does. Nothing is sent when
  nothing changed.
- **Joins and leaves.** Joining, leaving and an approved join request produce both a `chat_member`
  update and the `new_chat_members` / `left_chat_member` service message.
- **Answers do not wait for updates.** Bot API calls answer without waiting for the updates they
  cause, so a webhook bot that leaves a chat or promotes someone inside its handler does not wait
  for itself.

The server delivers resulting updates asynchronously. Tests should wait for the exact update rather
than depend on response/update ordering; the Bot API does not promise that ordering.

### Redelivery

A test can have Telegram deliver any update again, byte for byte, callback queries included, as it
does when a webhook does not confirm one. It sends the saved update, so do not restore an earlier
snapshot between the steps of a replay. A press with `deliverTwice` does the same with its own
update: once the webhook has answered the press, it gets that update again. Only a webhook gets an
update again this way, so such a press to a bot without a webhook is refused before it is sent.

[privacy-mode]: https://core.telegram.org/bots/features#privacy-mode
[bots-faq]: https://core.telegram.org/bots/faq#what-messages-will-my-bot-get
[forum-docs]: https://core.telegram.org/api/forum
[bot-api-chat-member-administrator]: https://core.telegram.org/bots/api#chatmemberadministrator
[ephemeral-docs]: https://core.telegram.org/bots/api#ephemeral-messages-and-commands
[tdlib-entities]: https://github.com/tdlib/td/blob/master/td/telegram/MessageEntity.cpp
[tdlib-participants]: https://github.com/tdlib/td/blob/master/td/telegram/DialogParticipantManager.cpp
[bot-api-server-client]: https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp
[readme-methods]: reference.md#supported-bot-api-methods
[tdesktop-participants]: https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/boxes/peers/edit_participants_box.cpp
