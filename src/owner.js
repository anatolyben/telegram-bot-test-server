/**
 * Owner accounts: what a Telegram user sees on their own account, as a GramJS
 * TelegramClient reads it (dialogs, folders, history, dialog filters). This is
 * not MTProto: there is no wire protocol, encryption or login. The exported
 * owner client (owner-client.js) calls this model over HTTP, so a test process
 * and an app process share one state.
 *
 * Every owner is separate: two owners may use the same peer and message ids,
 * and each has its own folders, unread counts, pins, filters, faults and calls.
 */

// PeerNotifySettings.mute_until for "muted forever".
const MUTE_FOREVER = 2_147_483_647;
// A supergroup or channel's peer id is -100<raw id>; a basic group's is -<raw id>.
const CHANNEL_PEER_OFFSET = 1_000_000_000_000;
const KINDS = new Set(["private", "bot", "group", "supergroup", "channel"]);
const MAX_DELAY_MS = 30_000;
const REDACTED_KEY = /session|token|hash|password|phone|secret|key/i;
const FILTER_FLAGS = [
  "contacts",
  "nonContacts",
  "groups",
  "broadcasts",
  "bots",
  "excludeMuted",
  "excludeRead",
  "excludeArchived",
];

// The Telegram request each owner-client method sends, named in errors as
// GramJS names them ("... (caused by messages.GetDialogs)").
const REQUESTS = {
  connect: null,
  disconnect: null,
  isUserAuthorized: "updates.GetState",
  getMe: "users.GetUsers",
  getEntity: "users.GetUsers",
  getInputEntity: "users.GetUsers",
  getDialogs: "messages.GetDialogs",
  getMessages: "messages.GetHistory",
  invoke: null,
};
const PRESETS = new Set([
  "flood_wait",
  "permission_denied",
  "reconnect_required",
  "stale_entity",
  "malformed_page",
  "dropped",
]);

export class OwnerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A GramJS RPCError or FloodWaitError, as JSON the client turns back into one. */
function rpcError(errorMessage, code, request, seconds = null) {
  if (seconds != null) {
    return {
      name: "FloodWaitError",
      message: `A wait of ${seconds} seconds is required${request ? ` (caused by ${request})` : ""}`,
      // GramJS's FloodWaitError carries "FLOOD", not the raw FLOOD_WAIT_<n>.
      errorMessage: "FLOOD",
      code: 420,
      seconds,
    };
  }
  return {
    name: "RPCError",
    message: `${code}: ${errorMessage}${request ? ` (caused by ${request})` : ""}`,
    errorMessage,
    code,
  };
}

class RpcFailure extends Error {
  constructor(error) {
    super(error.message);
    this.error = error;
  }
}

function notModelled(what) {
  return new RpcFailure({
    name: "Error",
    message: `${what} is not modelled by telegram-bot-test-server`,
    code: "OWNER_CLIENT_UNSUPPORTED",
  });
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        REDACTED_KEY.test(key) ? "[redacted]" : redact(entry),
      ]),
    );
  }
  return value;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new OwnerError(400, `${name} must be a positive whole number`);
  }
  return number;
}

function whole(value, name, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) {
    throw new OwnerError(
      400,
      `${name} must be a whole number of at least ${min}`,
    );
  }
  return number;
}

function markedId(kind, rawId) {
  if (kind === "private" || kind === "bot") return rawId;
  if (kind === "group") return -rawId;
  return -(CHANNEL_PEER_OFFSET + rawId);
}

// Stands in for a peer's access_hash: stable for a peer, never a real one.
function accessHash(rawId) {
  return (rawId * 2_654_435_761) % 2_147_483_647;
}

export function createOwnerModel({ log = () => {} } = {}) {
  const owners = new Map();
  const startSeconds = Math.floor(Date.now() / 1000);
  let nextOwnerId = 6_000_000_000 + (startSeconds % 1_000_000);
  let pinSequence = 0;

  function requireOwner(ownerId) {
    const owner = owners.get(Number(ownerId));
    if (!owner) throw new OwnerError(404, `No owner ${ownerId}`);
    return owner;
  }

  function requirePeer(owner, peerId) {
    const peer = owner.peers.get(Number(peerId));
    if (!peer) {
      throw new OwnerError(404, `Owner ${owner.id} has no dialog ${peerId}`);
    }
    return peer;
  }

  // ── Views in GramJS's shapes ──────────────────────────────────────────
  function userEntity(owner, user) {
    return {
      className: "User",
      id: user.id,
      self: user.id === owner.id,
      bot: user.bot === true,
      firstName: user.firstName,
      lastName: user.lastName ?? null,
      username: user.username ?? null,
      accessHash: accessHash(user.id),
      photo: null,
    };
  }

  function userById(owner, userId) {
    if (userId === owner.id) return owner.user;
    return owner.users.get(userId) ?? null;
  }

  function peerEntity(owner, peer) {
    if (peer.kind === "private" || peer.kind === "bot") {
      return userEntity(owner, owner.users.get(peer.rawId));
    }
    if (peer.kind === "group") {
      return {
        className: "Chat",
        id: peer.rawId,
        title: peer.title,
        participantsCount: peer.participantsCount,
        deactivated: false,
        photo: null,
      };
    }
    return {
      className: "Channel",
      id: peer.rawId,
      title: peer.title,
      username: peer.username ?? null,
      megagroup: peer.kind === "supergroup",
      broadcast: peer.kind === "channel",
      participantsCount: peer.participantsCount,
      accessHash: accessHash(peer.rawId),
      photo: null,
    };
  }

  function peerRef(peer) {
    if (peer.kind === "private" || peer.kind === "bot") {
      return { className: "PeerUser", userId: peer.rawId };
    }
    if (peer.kind === "group") {
      return { className: "PeerChat", chatId: peer.rawId };
    }
    return { className: "PeerChannel", channelId: peer.rawId };
  }

  function inputPeer(owner, markedPeerId) {
    if (markedPeerId === owner.id) return { className: "InputPeerSelf" };
    if (markedPeerId > 0) {
      return {
        className: "InputPeerUser",
        userId: markedPeerId,
        accessHash: accessHash(markedPeerId),
      };
    }
    if (markedPeerId > -CHANNEL_PEER_OFFSET) {
      return { className: "InputPeerChat", chatId: -markedPeerId };
    }
    const channelId = -markedPeerId - CHANNEL_PEER_OFFSET;
    return {
      className: "InputPeerChannel",
      channelId,
      accessHash: accessHash(channelId),
    };
  }

  function displayName(entity) {
    if (entity.className === "User") {
      return [entity.firstName, entity.lastName].filter(Boolean).join(" ");
    }
    return entity.title;
  }

  function mediaView(media, date) {
    if (!media) return null;
    if (media.type === "photo") {
      return {
        className: "MessageMediaPhoto",
        photo: {
          className: "Photo",
          id: media.id,
          date,
          sizes: [
            {
              className: "PhotoSize",
              type: "x",
              w: media.width ?? 800,
              h: media.height ?? 600,
              size: media.size ?? 0,
            },
          ],
        },
      };
    }
    return {
      className: "MessageMediaDocument",
      document: {
        className: "Document",
        id: media.id,
        date,
        mimeType: media.mimeType ?? "application/octet-stream",
        size: media.size ?? 0,
        attributes: media.fileName
          ? [
              {
                className: "DocumentAttributeFilename",
                fileName: media.fileName,
              },
            ]
          : [],
      },
    };
  }

  function messageView(owner, peer, message) {
    const chat = peerEntity(owner, peer);
    // In a private chat the other person's messages carry no fromId; the
    // sender follows from the chat, and the owner's own from `out`.
    let senderId;
    let fromId = null;
    if (message.fromId != null) {
      senderId = message.fromId;
      fromId = { className: "PeerUser", userId: message.fromId };
    } else if (peer.kind === "private" || peer.kind === "bot") {
      senderId = message.out ? owner.id : peer.rawId;
    } else {
      // A channel's own post, or an anonymous admin: the chat is the sender.
      senderId = peer.id;
    }
    const senderUser = senderId > 0 ? userById(owner, senderId) : null;
    const base = {
      className: message.action ? "MessageService" : "Message",
      id: message.id,
      peerId: peerRef(peer),
      date: message.date,
      out: message.out === true,
      post: peer.kind === "channel",
      fromId,
      senderId,
      sender: senderUser ? userEntity(owner, senderUser) : chat,
      chatId: peer.id,
      chat,
      replyTo:
        message.replyTo == null
          ? null
          : { className: "MessageReplyHeader", replyToMsgId: message.replyTo },
      replyToMsgId: message.replyTo ?? null,
    };
    if (message.action) {
      return { ...base, action: { ...message.action } };
    }
    const text = message.text ?? "";
    return {
      ...base,
      message: text,
      rawText: text,
      text,
      entities: [],
      editDate: message.editDate ?? null,
      media: mediaView(message.media, message.date),
      fwdFrom: null,
      groupedId: null,
      reactions: null,
    };
  }

  function liveMessages(peer) {
    return [...peer.messages.values()]
      .filter((message) => !message.deleted)
      .sort((left, right) => right.id - left.id);
  }

  /** The newest message decides a dialog's place: its date, then its id. */
  function dialogKey(peer) {
    const top = liveMessages(peer)[0];
    return {
      date: top?.date ?? peer.createdDate,
      messageId: top?.id ?? 0,
      peerId: peer.id,
      top,
    };
  }

  function dialogView(owner, peer) {
    const entity = peerEntity(owner, peer);
    const { date, top } = dialogKey(peer);
    const muted = peer.muteUntil;
    const archived = peer.folder === 1;
    return {
      id: peer.id,
      entity,
      inputEntity: inputPeer(owner, peer.id),
      name: displayName(entity),
      title: displayName(entity),
      date,
      message: top ? messageView(owner, peer, top) : undefined,
      pinned: peer.pinnedAt != null,
      // GramJS's Dialog: folderId is only set for the archive.
      ...(archived ? { folderId: 1 } : {}),
      archived,
      unreadCount: peer.unreadCount,
      unreadMentionsCount: 0,
      isUser: entity.className === "User",
      isGroup:
        entity.className === "Chat" ||
        (entity.className === "Channel" && entity.megagroup === true),
      isChannel: entity.className === "Channel",
      dialog: {
        className: "Dialog",
        peer: peerRef(peer),
        topMessage: top?.id ?? 0,
        pinned: peer.pinnedAt != null,
        unreadCount: peer.unreadCount,
        unreadMentionsCount: 0,
        ...(archived ? { folderId: 1 } : {}),
        notifySettings: { className: "PeerNotifySettings", muteUntil: muted },
      },
    };
  }

  function filterView(owner, filter) {
    const peers = (ids) => ids.map((id) => inputPeer(owner, id));
    return {
      className: "DialogFilter",
      id: filter.id,
      title: {
        className: "TextWithEntities",
        text: filter.title,
        entities: [],
      },
      ...(filter.emoticon ? { emoticon: filter.emoticon } : {}),
      ...(filter.color != null ? { color: filter.color } : {}),
      titleNoanimate: false,
      ...Object.fromEntries(
        FILTER_FLAGS.map((flag) => [flag, filter[flag] === true]),
      ),
      pinnedPeers: peers(filter.pinnedPeers),
      includePeers: peers(filter.includePeers),
      excludePeers: peers(filter.excludePeers),
    };
  }

  // ── Resolving the peers a client passes ────────────────────────────────
  function markedFromRef(owner, ref) {
    if (ref == null) return null;
    if (typeof ref === "number") return ref;
    if (typeof ref === "string") {
      if (ref === "me" || ref === "self") return owner.id;
      if (/^-?\d+$/.test(ref)) return Number(ref);
      const username = ref.replace(/^@/, "").toLowerCase();
      if (owner.user.username?.toLowerCase() === username) return owner.id;
      for (const user of owner.users.values()) {
        if (user.username?.toLowerCase() === username) return user.id;
      }
      for (const peer of owner.peers.values()) {
        if (peer.username?.toLowerCase() === username) return peer.id;
      }
      return null;
    }
    switch (ref.className) {
      case "User":
      case "PeerUser":
      case "InputPeerUser":
        return Number(ref.id ?? ref.userId);
      case "Chat":
      case "PeerChat":
      case "InputPeerChat":
        return -Number(ref.id ?? ref.chatId);
      case "Channel":
      case "PeerChannel":
      case "InputPeerChannel":
        return -(CHANNEL_PEER_OFFSET + Number(ref.id ?? ref.channelId));
      case "InputPeerSelf":
        return owner.id;
      case "InputPeerEmpty":
        return null;
      default:
        return null;
    }
  }

  function notFound(ref) {
    return new RpcFailure({
      name: "Error",
      // GramJS's wording when an entity is not known to the client.
      message: `Could not find the input entity for ${JSON.stringify(ref)}`,
    });
  }

  function resolveEntity(owner, ref) {
    const id = markedFromRef(owner, ref);
    if (id === owner.id) return userEntity(owner, owner.user);
    if (id != null && owner.peers.has(id)) {
      return peerEntity(owner, owner.peers.get(id));
    }
    if (id != null && id > 0 && owner.users.has(id)) {
      return userEntity(owner, owner.users.get(id));
    }
    throw notFound(ref);
  }

  function resolvePeer(owner, ref) {
    const id = markedFromRef(owner, ref);
    if (id != null && owner.peers.has(id)) return owner.peers.get(id);
    throw notFound(ref);
  }

  // ── The owner-client calls ─────────────────────────────────────────────
  const handlers = {
    connect: () => true,
    disconnect: () => true,
    isUserAuthorized: (owner) => owner.authorized,
    getMe: (owner) => userEntity(owner, owner.user),
    getEntity: (owner, args) => resolveEntity(owner, args.peer),
    getInputEntity: (owner, args) => {
      const entity = resolveEntity(owner, args.peer);
      return inputPeer(owner, markedFromRef(owner, entity));
    },
    getDialogs: (owner, args) => {
      const allowed = new Set([
        "folder",
        "archived",
        "limit",
        "ignorePinned",
        "ignoreMigrated",
        "offsetDate",
        "offsetId",
        "offsetPeer",
      ]);
      for (const key of Object.keys(args)) {
        if (!allowed.has(key)) throw notModelled(`getDialogs option ${key}`);
      }
      // GramJS: `archived` sets the folder; no folder is the main list.
      const folder =
        args.archived != null
          ? args.archived
            ? 1
            : 0
          : Number(args.folder ?? 0);
      if (folder !== 0 && folder !== 1) {
        throw new RpcFailure(
          rpcError("FOLDER_ID_INVALID", 400, "messages.GetDialogs"),
        );
      }
      const inFolder = [...owner.peers.values()].filter(
        (peer) => peer.folder === folder,
      );
      const offsetPeer = markedFromRef(owner, args.offsetPeer);
      const offsetDate = Number(args.offsetDate ?? 0);
      const offsetId = Number(args.offsetId ?? 0);
      const hasOffset = offsetDate > 0 || offsetId > 0 || offsetPeer != null;
      // Pinned dialogs lead the first page only, most recently pinned first.
      const pinned =
        hasOffset || args.ignorePinned === true
          ? []
          : inFolder
              .filter((peer) => peer.pinnedAt != null)
              .sort((left, right) => right.pinnedAt - left.pinnedAt);
      const compare = (left, right) =>
        right.date - left.date ||
        right.messageId - left.messageId ||
        right.peerId - left.peerId;
      let rest = inFolder
        .filter((peer) => peer.pinnedAt == null)
        .map((peer) => ({ peer, ...dialogKey(peer) }))
        .sort(compare);
      if (hasOffset) {
        // Strictly after the offset in the same order, so a page never repeats
        // the last dialog of the page before, even when dates are equal.
        const offset = {
          date: offsetDate,
          messageId: offsetId,
          peerId: offsetPeer ?? Number.POSITIVE_INFINITY,
        };
        rest = rest.filter((entry) => compare(offset, entry) < 0);
      }
      const ordered = [...pinned, ...rest.map((entry) => entry.peer)];
      const limit =
        args.limit == null ? ordered.length : whole(args.limit, "limit");
      return {
        total: inFolder.length,
        dialogs: ordered.slice(0, limit).map((peer) => dialogView(owner, peer)),
      };
    },
    getMessages: (owner, args) => {
      const allowed = new Set(["entity", "limit", "offsetId", "ids"]);
      for (const key of Object.keys(args)) {
        if (!allowed.has(key)) throw notModelled(`getMessages option ${key}`);
      }
      const peer = resolvePeer(owner, args.entity);
      if (args.ids != null) {
        // As GramJS: the messages in the order asked, undefined where missing.
        const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
        return {
          total: ids.length,
          messages: ids.map((id) => {
            const message = peer.messages.get(Number(id));
            return message && !message.deleted
              ? messageView(owner, peer, message)
              : null;
          }),
        };
      }
      const all = liveMessages(peer);
      const offsetId = Number(args.offsetId ?? 0);
      const older =
        offsetId > 0 ? all.filter((message) => message.id < offsetId) : all;
      const limit =
        args.limit == null ? older.length : whole(args.limit, "limit");
      return {
        total: all.length,
        messages: older
          .slice(0, limit)
          .map((message) => messageView(owner, peer, message)),
      };
    },
    invoke: (owner, args) => {
      const className = args.request?.className;
      if (className !== "messages.GetDialogFilters") {
        throw notModelled(`the ${className ?? "unnamed"} request`);
      }
      return {
        className: "messages.DialogFilters",
        tagsEnabled: false,
        filters: owner.filterOrder.map((id) =>
          id === 0
            ? { className: "DialogFilterDefault" }
            : filterView(owner, owner.filters.get(id)),
        ),
      };
    },
  };

  function takeFault(owner, method, args) {
    const target = args.peer ?? args.entity ?? args.offsetPeer ?? null;
    const peerId = target == null ? null : markedFromRef(owner, target);
    const index = owner.faults.findIndex(
      (fault) =>
        fault.method === method &&
        (fault.peerId == null || fault.peerId === peerId),
    );
    if (index < 0) return null;
    const fault = owner.faults[index];
    fault.remaining -= 1;
    if (fault.remaining <= 0) owner.faults.splice(index, 1);
    return fault;
  }

  function faultError(fault, method, args) {
    const request =
      method === "invoke" ? args.request?.className : REQUESTS[method];
    switch (fault.preset) {
      case "flood_wait":
        return rpcError("FLOOD", 420, request, fault.seconds ?? 30);
      case "permission_denied":
        return rpcError("CHAT_WRITE_FORBIDDEN", 403, request);
      case "reconnect_required":
        return rpcError("AUTH_KEY_UNREGISTERED", 401, request);
      case "stale_entity":
        return rpcError("PEER_ID_INVALID", 400, request);
      default:
        return fault.errorMessage
          ? rpcError(fault.errorMessage, fault.code ?? 400, request)
          : null;
    }
  }

  /** A page whose entries lack the entity and top message, as a broken answer would. */
  function malformed(result) {
    if (Array.isArray(result?.dialogs)) {
      return {
        ...result,
        dialogs: result.dialogs.map(
          ({ entity: _entity, message: _message, ...rest }) => rest,
        ),
      };
    }
    if (Array.isArray(result?.messages)) {
      return {
        ...result,
        messages: result.messages.map(
          (message) =>
            message && { className: message.className, id: message.id },
        ),
      };
    }
    return result;
  }

  /**
   * Run one owner-client call. Answers { result }, { error }, or { drop: true }
   * when the connection must close without an answer.
   */
  async function rpc(ownerId, method, args = {}) {
    const owner = owners.get(Number(ownerId));
    if (!owner) {
      return {
        status: 404,
        body: { error: { name: "Error", message: `No owner ${ownerId}` } },
      };
    }
    const call = {
      owner_id: owner.id,
      method,
      args: redact(args),
      at: new Date().toISOString(),
      outcome: "ok",
    };
    owner.calls.push(call);
    const started = Date.now();
    const finish = (outcome, extra = {}) => {
      Object.assign(
        call,
        { outcome, duration_ms: Date.now() - started },
        extra,
      );
    };
    if (!Object.hasOwn(handlers, method)) {
      const failure = notModelled(`owner client method ${method}`);
      finish("error", { error_message: failure.error.message });
      return { status: 200, body: { error: failure.error } };
    }
    const fault = takeFault(owner, method, args);
    if (fault?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    const injected = fault ? faultError(fault, method, args) : null;
    if (injected) {
      finish("error", { error_message: injected.errorMessage });
      return { status: 200, body: { error: injected } };
    }
    try {
      const needsAuthorization = ![
        "connect",
        "disconnect",
        "isUserAuthorized",
      ].includes(method);
      if (needsAuthorization && !owner.authorized) {
        throw new RpcFailure(
          rpcError(
            "AUTH_KEY_UNREGISTERED",
            401,
            REQUESTS[method] ?? args.request?.className,
          ),
        );
      }
      let result = handlers[method](owner, args);
      if (fault?.preset === "dropped") {
        finish("dropped");
        return { drop: true };
      }
      if (fault?.preset === "malformed_page") {
        result = malformed(result);
        finish("malformed");
      } else {
        finish("ok");
      }
      return { status: 200, body: { result } };
    } catch (error) {
      if (!(error instanceof RpcFailure)) throw error;
      finish("error", {
        error_message: error.error.errorMessage ?? error.error.message,
      });
      return { status: 200, body: { error: error.error } };
    }
  }

  // ── Test controls (/_fake/owners/...) ──────────────────────────────────
  function createOwner(body) {
    const id =
      body.user_id == null
        ? nextOwnerId++
        : positiveInt(body.user_id, "user_id");
    if (owners.has(id)) throw new OwnerError(409, `Owner ${id} already exists`);
    const user = {
      id,
      firstName: String(body.first_name ?? "Owner"),
      lastName: body.last_name ?? null,
      username: body.username ?? null,
      bot: false,
    };
    owners.set(id, {
      id,
      user,
      authorized: true,
      users: new Map(),
      peers: new Map(),
      filters: new Map(),
      filterOrder: [0],
      faults: [],
      calls: [],
      nextRawId: 10_000,
    });
    return { id };
  }

  function addUser(owner, body) {
    const id = body.id == null ? owner.nextRawId++ : positiveInt(body.id, "id");
    if (id === owner.id) throw new OwnerError(409, `${id} is the owner`);
    const existing = owner.users.get(id);
    const user = {
      id,
      firstName: String(body.first_name ?? existing?.firstName ?? "User"),
      lastName: body.last_name ?? existing?.lastName ?? null,
      username: body.username ?? existing?.username ?? null,
      bot: body.bot === true || existing?.bot === true,
    };
    owner.users.set(id, user);
    return user;
  }

  function applyDialogState(peer, body) {
    if (body.folder !== undefined) {
      const folder = Number(body.folder);
      if (folder !== 0 && folder !== 1) {
        throw new OwnerError(400, "folder must be 0 (main) or 1 (archive)");
      }
      peer.folder = folder;
    }
    if (body.pinned !== undefined) {
      peer.pinnedAt = body.pinned === true ? ++pinSequence : null;
    }
    if (body.muted !== undefined)
      peer.muteUntil = body.muted === true ? MUTE_FOREVER : 0;
    if (body.mute_until !== undefined)
      peer.muteUntil = whole(body.mute_until, "mute_until");
    if (body.unread_count !== undefined) {
      peer.unreadCount = whole(body.unread_count, "unread_count");
    }
  }

  function addDialog(owner, body) {
    const kind = String(body.kind ?? "");
    if (!KINDS.has(kind)) {
      throw new OwnerError(400, `kind must be one of ${[...KINDS].join(", ")}`);
    }
    const rawId =
      body.id == null ? owner.nextRawId++ : positiveInt(body.id, "id");
    const id = markedId(kind, rawId);
    if (owner.peers.has(id)) {
      throw new OwnerError(409, `Owner ${owner.id} already has dialog ${id}`);
    }
    if (kind === "private" || kind === "bot") {
      addUser(owner, { ...body, id: rawId, bot: kind === "bot" });
    } else if (typeof body.title !== "string" || !body.title) {
      throw new OwnerError(400, `a ${kind} needs a title`);
    }
    const peer = {
      id,
      kind,
      rawId,
      title: body.title ?? null,
      username:
        kind === "private" || kind === "bot" ? null : (body.username ?? null),
      participantsCount:
        body.participants_count == null
          ? null
          : whole(body.participants_count, "participants_count"),
      folder: 0,
      pinnedAt: null,
      muteUntil: 0,
      unreadCount: 0,
      createdDate:
        body.date == null
          ? Math.floor(Date.now() / 1000)
          : whole(body.date, "date"),
      messages: new Map(),
    };
    applyDialogState(peer, body);
    owner.peers.set(id, peer);
    return { id };
  }

  function addMessages(owner, peer, list) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new OwnerError(400, "messages must be a non-empty array");
    }
    const added = [];
    for (const item of list) {
      const id = positiveInt(item.id, "message id");
      if (peer.messages.has(id)) {
        throw new OwnerError(
          409,
          `Dialog ${peer.id} already has message ${id}`,
        );
      }
      const fromId = item.from_id == null ? null : Number(item.from_id);
      if (fromId != null && fromId !== owner.id && !owner.users.has(fromId)) {
        throw new OwnerError(
          400,
          `from_id ${fromId} is not a user of owner ${owner.id}`,
        );
      }
      const replyTo = item.reply_to == null ? null : Number(item.reply_to);
      if (
        replyTo != null &&
        !peer.messages.has(replyTo) &&
        !list.some((other) => Number(other.id) === replyTo)
      ) {
        throw new OwnerError(
          400,
          `reply_to ${replyTo} is not a message in dialog ${peer.id}`,
        );
      }
      if (item.action != null && typeof item.action?.className !== "string") {
        throw new OwnerError(
          400,
          "action needs a className, such as MessageActionChatAddUser",
        );
      }
      if (
        item.media != null &&
        !["photo", "document"].includes(item.media?.type)
      ) {
        throw new OwnerError(400, 'media.type must be "photo" or "document"');
      }
      peer.messages.set(id, {
        id,
        date: whole(item.date, "date"),
        fromId,
        out: item.out === true || (fromId != null && fromId === owner.id),
        text: item.action ? null : String(item.text ?? ""),
        action: item.action ?? null,
        replyTo,
        media: item.media ?? null,
        editDate:
          item.edit_date == null ? null : whole(item.edit_date, "edit_date"),
        deleted: false,
      });
      added.push(id);
    }
    return { ids: added };
  }

  function setFilter(owner, body) {
    const id = whole(body.id, "filter id", { min: 2 });
    const existing = owner.filters.get(id);
    const peersOf = (key) => {
      const ids = body[key] ?? existing?.[camel(key)] ?? [];
      if (!Array.isArray(ids))
        throw new OwnerError(400, `${key} must be an array of dialog ids`);
      return ids.map((peerId) => requirePeer(owner, peerId).id);
    };
    const title = body.title ?? existing?.title;
    if (typeof title !== "string" || !title.trim()) {
      throw new OwnerError(400, "a filter needs a title");
    }
    const filter = {
      id,
      title,
      emoticon: body.emoticon ?? existing?.emoticon ?? null,
      color: body.color ?? existing?.color ?? null,
      pinnedPeers: peersOf("pinned_peers"),
      includePeers: peersOf("include_peers"),
      excludePeers: peersOf("exclude_peers"),
    };
    for (const flag of FILTER_FLAGS) {
      const key = snake(flag);
      filter[flag] =
        body[key] !== undefined
          ? body[key] === true
          : existing?.[flag] === true;
    }
    owner.filters.set(id, filter);
    if (!owner.filterOrder.includes(id)) owner.filterOrder.push(id);
    return filterView(owner, filter);
  }

  function summary(owner) {
    return {
      id: owner.id,
      authorized: owner.authorized,
      dialogs: [...owner.peers.values()].map((peer) => ({
        id: peer.id,
        kind: peer.kind,
        folder: peer.folder,
        pinned: peer.pinnedAt != null,
        mute_until: peer.muteUntil,
        unread_count: peer.unreadCount,
        messages: liveMessages(peer).length,
      })),
      filter_order: [...owner.filterOrder],
    };
  }

  /**
   * /_fake/owners/... . `parts` follow "owners": [ownerId, section, id, sub, subId].
   */
  function control(method, parts, body) {
    const [ownerId, section, itemId, sub, subId] = parts;
    if (!ownerId) {
      if (method === "POST") return createOwner(body);
      if (method === "DELETE") {
        owners.clear();
        return { ok: true };
      }
      if (method === "GET") return [...owners.keys()].map((id) => ({ id }));
    }
    const owner = requireOwner(ownerId);
    if (!section) {
      if (method === "GET") return summary(owner);
      if (method === "DELETE") {
        owners.delete(owner.id);
        return { ok: true };
      }
      if (method === "POST") {
        if (body.authorized !== undefined)
          owner.authorized = body.authorized === true;
        return summary(owner);
      }
    }
    if (section === "users" && method === "POST" && !itemId) {
      return { id: addUser(owner, body).id };
    }
    if (section === "dialogs" && method === "POST" && !itemId) {
      return addDialog(owner, body);
    }
    if (section === "dialogs" && itemId) {
      const peer = requirePeer(owner, itemId);
      if (!sub && method === "POST") {
        applyDialogState(peer, body);
        return summary(owner).dialogs.find((dialog) => dialog.id === peer.id);
      }
      if (sub === "messages" && !subId && method === "POST") {
        return addMessages(owner, peer, body.messages);
      }
      if (sub === "messages" && subId) {
        const message = peer.messages.get(Number(subId));
        if (!message || message.deleted) {
          throw new OwnerError(
            404,
            `Dialog ${peer.id} has no message ${subId}`,
          );
        }
        if (method === "DELETE") {
          message.deleted = true;
          return { ok: true };
        }
        if (method === "POST") {
          if (message.action)
            throw new OwnerError(400, "a service message cannot be edited");
          if (typeof body.text !== "string")
            throw new OwnerError(400, "an edit needs text");
          message.text = body.text;
          message.editDate =
            body.edit_date == null
              ? Math.floor(Date.now() / 1000)
              : whole(body.edit_date, "edit_date");
          return messageView(owner, peer, message);
        }
      }
    }
    if (section === "filters") {
      if (method === "POST" && itemId === "order") {
        const ids = (body.ids ?? []).map(Number);
        const current = [...owner.filterOrder].sort((a, b) => a - b);
        if (
          JSON.stringify([...ids].sort((a, b) => a - b)) !==
          JSON.stringify(current)
        ) {
          throw new OwnerError(
            400,
            `ids must list every filter once, with 0 for the default: ${owner.filterOrder.join(", ")}`,
          );
        }
        owner.filterOrder = ids;
        return { order: ids };
      }
      if (method === "POST" && !itemId) return setFilter(owner, body);
      if (method === "DELETE" && itemId) {
        const id = Number(itemId);
        if (!owner.filters.delete(id))
          throw new OwnerError(404, `No filter ${itemId}`);
        owner.filterOrder = owner.filterOrder.filter((each) => each !== id);
        return { ok: true };
      }
    }
    if (section === "faults") {
      if (method === "DELETE") {
        owner.faults = [];
        return { ok: true };
      }
      if (method === "POST") {
        if (!Object.hasOwn(REQUESTS, body.method)) {
          throw new OwnerError(
            400,
            `method must be one of ${Object.keys(REQUESTS).join(", ")}`,
          );
        }
        if (body.preset != null && !PRESETS.has(body.preset)) {
          throw new OwnerError(
            400,
            `preset must be one of ${[...PRESETS].join(", ")}`,
          );
        }
        const delayMs =
          body.delay_ms == null ? 0 : whole(body.delay_ms, "delay_ms");
        if (delayMs > MAX_DELAY_MS) {
          throw new OwnerError(400, `delay_ms must be at most ${MAX_DELAY_MS}`);
        }
        if (
          body.preset == null &&
          body.error_message == null &&
          delayMs === 0
        ) {
          throw new OwnerError(
            400,
            "a fault needs a preset, an error_message or a delay_ms",
          );
        }
        const fault = {
          method: body.method,
          peerId: body.peer_id == null ? null : Number(body.peer_id),
          remaining: body.times == null ? 1 : positiveInt(body.times, "times"),
          delayMs,
          preset: body.preset ?? null,
          seconds:
            body.seconds == null ? null : positiveInt(body.seconds, "seconds"),
          errorMessage: body.error_message ?? null,
          code: body.code == null ? null : Number(body.code),
        };
        owner.faults.push(fault);
        return { faults: owner.faults.length };
      }
    }
    if (section === "calls" && method === "GET") return owner.calls;
    log(`unknown owner control ${method} /${parts.join("/")}`);
    throw new OwnerError(
      404,
      `Unknown owner control ${method} /owners/${parts.join("/")}`,
    );
  }

  return { rpc, control };
}

function snake(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function camel(name) {
  return name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}
