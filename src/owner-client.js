/**
 * A test stand-in for the GramJS TelegramClient an app uses on a user's own
 * Telegram account, for the calls listed in the README ("Owner accounts").
 * It reads and changes nothing on Telegram: every call goes to a
 * telegram-bot-test-server over HTTP, which answers from the owner state a test
 * seeded. Anything it does not model fails; nothing answers a generic success.
 */

/** Request classes for `client.invoke()`, in GramJS's shape (`className`). */
export const ownerApi = Object.freeze({
  messages: Object.freeze({
    GetDialogFilters: class GetDialogFilters {
      constructor(args = {}) {
        Object.assign(this, args);
        this.className = "messages.GetDialogFilters";
      }
    },
  }),
});

// Properties that tooling reads on any object; they must not look like calls.
const PASSTHROUGH = new Set([
  "then",
  "toJSON",
  "constructor",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
  "tagName",
  "inspect",
]);

function notModelledError(what) {
  const error = new Error(
    `${what} is not modelled by telegram-bot-test-server`,
  );
  error.code = "OWNER_CLIENT_NOT_MODELLED";
  return error;
}

/** The server's JSON error, back as the Error a GramJS caller would catch. */
function toError(body) {
  const error = new Error(body?.message ?? "Owner call failed");
  if (body?.name) error.name = body.name;
  for (const key of ["errorMessage", "code", "seconds"]) {
    if (body?.[key] !== undefined) error[key] = body[key];
  }
  return error;
}

/**
 * An id as a plain number. GramJS carries ids as big-integer objects and
 * accepts native BigInt; both print their decimal value.
 */
function plainId(value) {
  return typeof value === "bigint" ||
    (value !== null && typeof value === "object")
    ? Number(String(value))
    : value;
}

/** A peer argument as the server resolves it: an id, a username, or a GramJS object's identity. */
function peerRef(peer) {
  if (peer == null || typeof peer !== "object") return plainId(peer);
  if (typeof peer.className !== "string") return plainId(peer);
  const { className, id, userId, chatId, channelId } = peer;
  const ref = { className };
  for (const [key, value] of Object.entries({
    id,
    userId,
    chatId,
    channelId,
  })) {
    if (value !== undefined) ref[key] = plainId(value);
  }
  return ref;
}

/** GramJS returns arrays with a `total`; so does this client. */
function totalList(items, total) {
  const list = [...items];
  list.total = total;
  return list;
}

/**
 * The owner client for one owner of a telegram-bot-test-server.
 * @param {{ origin: string, userId: number, session?: string }} options
 *   `session` stands in for a StringSession; it is only ever recorded redacted.
 */
export function createOwnerClient({ origin, userId, session } = {}) {
  if (!origin || userId == null) {
    throw new TypeError("createOwnerClient needs { origin, userId }");
  }
  let connected = false;

  async function call(method, args = {}) {
    // Serialized before sending: an argument that cannot be sent is the
    // caller's error, not a lost connection.
    const payload = JSON.stringify(args, (_key, value) =>
      typeof value === "bigint" ? Number(value) : value,
    );
    let response;
    try {
      response = await fetch(
        new URL(
          `/_owner/${encodeURIComponent(String(userId))}/${method}`,
          origin,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        },
      );
    } catch (cause) {
      // The server applied the call and closed the connection without an answer.
      const error = new Error("TIMEOUT");
      error.cause = cause;
      throw error;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.error) {
      throw toError(
        body?.error ?? { message: `${method} answered ${response.status}` },
      );
    }
    return body.result;
  }

  function requireConnected() {
    if (!connected) {
      // GramJS's wording.
      throw new Error(
        "Cannot send requests while disconnected. You need to call .connect()",
      );
    }
  }

  const client = {
    async connect() {
      await call("connect", session ? { session } : {});
      connected = true;
    },
    async disconnect() {
      if (connected) await call("disconnect").catch(() => {});
      connected = false;
    },
    async destroy() {
      await client.disconnect();
    },
    async isUserAuthorized() {
      requireConnected();
      return call("isUserAuthorized");
    },
    async getMe() {
      requireConnected();
      return call("getMe");
    },
    async getEntity(peer) {
      requireConnected();
      return call("getEntity", { peer: peerRef(peer) });
    },
    async getInputEntity(peer) {
      requireConnected();
      return call("getInputEntity", { peer: peerRef(peer) });
    },
    async getDialogs(options = {}) {
      requireConnected();
      const args = { ...options };
      if (args.offsetPeer !== undefined)
        args.offsetPeer = peerRef(args.offsetPeer);
      const result = await call("getDialogs", args);
      return totalList(result.dialogs, result.total);
    },
    async getMessages(entity, options = {}) {
      requireConnected();
      const result = await call("getMessages", {
        ...options,
        entity: peerRef(entity),
      });
      return totalList(
        result.messages.map((message) => message ?? undefined),
        result.total,
      );
    },
    async invoke(request) {
      requireConnected();
      return call("invoke", { request: { ...request } });
    },
    // Reserved: named here so a caller gets a clear answer, not "is not a function".
    async markAsRead() {
      throw notModelledError("markAsRead");
    },
    async sendMessage() {
      throw notModelledError("sendMessage");
    },
  };

  return new Proxy(client, {
    get(target, property, receiver) {
      if (
        typeof property === "symbol" ||
        property in target ||
        PASSTHROUGH.has(property)
      ) {
        return Reflect.get(target, property, receiver);
      }
      return () => {
        const error = new Error(
          `owner client method ${property} is not modelled by telegram-bot-test-server`,
        );
        error.code = "OWNER_CLIENT_UNSUPPORTED";
        throw error;
      };
    },
  });
}
