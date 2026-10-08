// The viewer's client: the view in the URL, the chat list, each open chat's
// loaded window (paging, refresh, detach), keyed DOM updates, and the two
// sources: the live server (fetch plus one shared event stream per browser)
// and a recording's JSON twin. No imports and no top-level side effects, so
// a recording can inline it; render, interact and views come in as objects.

const PAGE_SIZE = 200;
const LOADED_LIMIT = 600;
const MEMBERS_SHOWN = 200;
const STOPPED_RETRY_MS = 2000;
const DEFAULT_WEIGHTS = Object.freeze({
  list: 0.2,
  chat: 0.5,
  calls: 0.25,
  events: 0.25,
  members: 0.25,
});
const drawnHtml = new WeakMap();

/** Replaces an element's content only when its HTML changed. */
function patchHtml(element, html) {
  if (!element || drawnHtml.get(element) === html) return;
  element.innerHTML = html;
  drawnHtml.set(element, html);
}

/**
 * Brings a container's children in line with keyed entries ({ key, html }):
 * a child whose HTML is unchanged stays the same node (its hover tooltip,
 * loaded image and focus survive), a changed one is replaced, new ones are
 * inserted in order and missing ones removed.
 */
function patchKeyed(container, entries) {
  const byKey = new Map();
  for (const child of [...container.children]) {
    if (child.tvKey != null && !byKey.has(child.tvKey))
      byKey.set(child.tvKey, child);
    else child.remove();
  }
  const template = container.ownerDocument.createElement("template");
  let cursor = container.firstElementChild;
  for (const { key, html } of entries) {
    let node = byKey.get(key) ?? null;
    byKey.delete(key);
    if (node && drawnHtml.get(node) !== html) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      node.remove();
      node = null;
    }
    if (!node) {
      template.innerHTML = html;
      node = template.content.firstElementChild;
      if (!node) continue;
      node.tvKey = key;
      drawnHtml.set(node, html);
    }
    if (node === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(node, cursor);
  }
  for (const node of byKey.values()) node.remove();
}

const following = new WeakMap();

/** How long the reader may look back before the list returns to the newest. */
const RESUME_FOLLOW_MS = 8_000;

/**
 * Whether the list follows the newest item. Only the reader stops it, by
 * scrolling up (wheel, touch, keys or the scrollbar), and only for a while:
 * once they stop scrolling for RESUME_FOLLOW_MS, or reach the bottom, the
 * list returns to the newest item and follows again. Nothing the page does
 * on its own (an image loading, a batch arriving, items dropped, the tab in
 * the background) unpins it: while following, it stays at the bottom.
 */
function follows(scroller, container) {
  if (!following.has(scroller)) {
    following.set(scroller, true);
    const atBottom = () =>
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
    let readerScrolling = false;
    let resume = null;
    const pause = () => {
      following.set(scroller, false);
      clearTimeout(resume);
      resume = setTimeout(() => {
        following.set(scroller, true);
        scroller.scrollTop = scroller.scrollHeight;
      }, RESUME_FOLLOW_MS);
    };
    const reader = () => {
      readerScrolling = true;
    };
    scroller.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY < 0 || !following.get(scroller)) pause();
      },
      { passive: true },
    );
    for (const type of ["touchmove", "pointerdown"])
      scroller.addEventListener(type, reader, { passive: true });
    scroller.addEventListener("keydown", (event) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause();
    });
    scroller.addEventListener(
      "scroll",
      () => {
        if (atBottom()) {
          clearTimeout(resume);
          following.set(scroller, true);
        } else if (readerScrolling) pause();
      },
      { passive: true },
    );
    for (const type of ["touchend", "pointerup", "pointercancel"])
      scroller.addEventListener(
        type,
        () => {
          readerScrolling = false;
        },
        { passive: true },
      );
    if (typeof ResizeObserver === "function")
      new ResizeObserver(() => {
        if (following.get(scroller)) scroller.scrollTop = scroller.scrollHeight;
      }).observe(container);
  }
  return following.get(scroller);
}

/**
 * Patches a scrolled list and keeps the reader's place: pinned to the
 * bottom while it follows the newest item, else the first visible item stays
 * where it was (older items prepended, far ones dropped).
 */
function patchScrolled(
  scroller,
  container,
  entries,
  { toBottom = false, keepPlace = false } = {},
) {
  if (!scroller || !container) return;
  const atBottom = follows(scroller, container);
  let anchor = null;
  let offset = 0;
  if (!toBottom)
    for (const child of container.children) {
      // Day separators move as items arrive; anchor on an item.
      if (
        !child.hasAttribute("data-seq") &&
        !child.hasAttribute("data-request-number")
      )
        continue;
      const top = child.offsetTop - scroller.scrollTop;
      if (top + child.offsetHeight > 0) {
        anchor = child;
        offset = top;
        break;
      }
    }
  patchKeyed(container, entries);
  if (toBottom || (atBottom && !keepPlace))
    scroller.scrollTop = scroller.scrollHeight;
  else if (anchor?.isConnected) scroller.scrollTop = anchor.offsetTop - offset;
}

/** Calls by request number, oldest first; the newer copy of a call wins. */
function mergeCalls(current, incoming) {
  const byId = new Map(current.map((call) => [call.request_id, call]));
  for (const call of incoming ?? []) byId.set(call.request_id, call);
  return [...byId.values()].sort(
    (left, right) => left.request_number - right.request_number,
  );
}

/** The higher of two "calls below this may be missing" marks. */
function higherGap(left, right) {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return Math.max(left, right);
}

function refOfColumn(columnId) {
  const text = String(columnId ?? "");
  return text.includes(":") ? text.slice(text.indexOf(":") + 1) : null;
}

/**
 * Starts the viewer in `root` (the page body). `source` answers state(),
 * page() and subscribe(): liveSource() for the server, staticSource() for a
 * recording. Everything the page shows follows the view in the URL.
 */
export function startViewer({ render, interact, views, source, root }) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const recording = source.recording ?? null;
  const ui = {
    view: render.parseView(win.location.search),
    instance: null,
    epoch: null,
    generation: 0,
    state: null,
    stateVersion: 0,
    stateBusy: false,
    stateDirty: false,
    defaultResolved: false,
    slots: new Map(),
    weights: new Map(),
    widths: new Map(),
    phonePane: null,
    search: "",
    status: recording ? "recording" : "reconnecting",
    signature: null,
    eventVersion: 0,
    filtersOpen: false,
  };
  root.innerHTML = [
    '<div class="tv-app">',
    '<header class="tv-toolbar" data-role="toolbar">',
    '<span class="tv-brand">Chats<span class="tv-brand-note">local test server</span></span>',
    '<div class="tv-toolbar-controls" data-slot="controls"></div>',
    '<div data-slot="status"></div>',
    "</header>",
    '<main class="tv-workspace" data-role="workspace"></main>',
    '<nav class="tv-phone-nav" data-role="phone-nav" aria-label="Panels"></nav>',
    "</div>",
  ].join("");
  const workspace = root.querySelector("[data-role='workspace']");
  const controls = root.querySelector("[data-slot='controls']");
  const statusSlot = root.querySelector("[data-slot='status']");
  const phoneNav = root.querySelector("[data-role='phone-nav']");

  // ── view and URL ────────────────────────────────────────────────────
  function writeUrl(mode) {
    const search = render.viewToSearch(ui.view);
    if (win.location.search === search) return;
    try {
      win.history[mode === "push" ? "pushState" : "replaceState"](
        null,
        "",
        search,
      );
    } catch {
      // A recording opened from a file may refuse a changed URL; the view still applies.
    }
  }

  function applyTheme() {
    if (ui.view.theme)
      doc.documentElement.setAttribute("data-theme", ui.view.theme);
    else doc.documentElement.removeAttribute("data-theme");
  }

  function membersShown(ref) {
    return (
      ui.view.as == null && ui.view.show.includes("members") && ref !== "calls"
    );
  }

  function setView(next, mode = "replace") {
    const before = ui.view;
    ui.view = {
      ...next,
      show: next.show?.length ? next.show : [...render.PANELS],
    };
    writeUrl(mode);
    applyTheme();
    if (before.as !== ui.view.as) {
      reset();
      return;
    }
    syncSlots();
    for (const slot of ui.slots.values()) {
      if (before.topic !== ui.view.topic && slot.page?.chat?.is_forum)
        loadSlot(slot, "latest");
      else if (membersShown(slot.ref) && !before.show.includes("members"))
        loadSlot(slot, "refresh");
    }
    renderAll();
  }

  // ── loading ─────────────────────────────────────────────────────────
  function newSlot(ref) {
    return {
      ref,
      page: null,
      items: [],
      files: {},
      users: {},
      attached: true,
      hasOlder: false,
      loaded: false,
      missing: false,
      error: null,
      busy: false,
      dirty: false,
      next: null,
      version: 0,
      newer: 0,
      countedAt: null,
      scroll: null,
      // The calls of the loaded range, and the request number below which
      // some may not be loaded yet (null: none missing).
      calls: [],
      callsGap: null,
    };
  }

  function syncSlots() {
    const refs = new Set(ui.view.chats);
    for (const ref of [...ui.slots.keys()])
      if (!refs.has(ref)) ui.slots.delete(ref);
    for (const ref of refs)
      if (!ui.slots.has(ref)) {
        const slot = newSlot(ref);
        ui.slots.set(ref, slot);
        loadSlot(slot, "latest");
      }
  }

  /** A new server (instance) or a restore (epoch): drop everything loaded and load again. */
  function reset() {
    ui.generation += 1;
    ui.stateVersion = 0;
    ui.state = null;
    for (const ref of [...ui.slots.keys()]) ui.slots.set(ref, newSlot(ref));
    renderAll();
    loadState();
    for (const slot of ui.slots.values()) loadSlot(slot, "latest");
  }

  function noteInstance(json) {
    if (!json || json.instance == null) return false;
    if (ui.instance === json.instance && ui.epoch === json.epoch) return false;
    const first = ui.instance == null;
    ui.instance = json.instance;
    ui.epoch = json.epoch ?? 0;
    if (first) return false;
    reset();
    return true;
  }

  function markBusy() {
    const slots = [...ui.slots.values()];
    const busy =
      ui.stateBusy ||
      ui.stateDirty ||
      slots.some((slot) => slot.busy || slot.dirty || slot.next);
    if (busy) root.setAttribute("data-busy", "true");
    else root.removeAttribute("data-busy");
    root.setAttribute(
      "data-version",
      String(Math.min(ui.stateVersion, ...slots.map((slot) => slot.version))),
    );
    root.setAttribute("data-instance", ui.instance ?? "");
    root.setAttribute("data-epoch", ui.epoch ?? "");
  }

  async function loadState() {
    if (ui.stateBusy) {
      ui.stateDirty = true;
      markBusy();
      return;
    }
    ui.stateBusy = true;
    markBusy();
    const generation = ui.generation;
    try {
      const json = await source.state(
        ui.view.as != null ? { as: ui.view.as } : {},
      );
      if (generation !== ui.generation || noteInstance(json)) return;
      if (json.version < ui.stateVersion) return;
      ui.state = json;
      ui.stateVersion = json.version;
      if (!ui.view.chats.length && !ui.defaultResolved) {
        const chat = render.defaultChat(json);
        if (chat) {
          ui.defaultResolved = true;
          setView({ ...ui.view, chats: [chat] }, "replace");
          return;
        }
      }
      renderAll();
    } catch {
      // The status line tells a stopped or unreachable server; the next change retries.
    } finally {
      ui.stateBusy = false;
      if (ui.stateDirty) {
        ui.stateDirty = false;
        loadState();
      }
      markBusy();
    }
  }

  function chatQuery(slot) {
    const forum = slot.page?.chat?.is_forum === true;
    return {
      as: ui.view.as ?? undefined,
      topic: forum && ui.view.topic != null ? ui.view.topic : undefined,
      members_limit: membersShown(slot.ref) ? MEMBERS_SHOWN : 0,
    };
  }

  /**
   * Loads a chat: "latest" (the newest page, attached), "older" (the page
   * before the oldest loaded item), "refresh" (exactly the loaded range,
   * plus new items while attached) or "older-calls" (the calls before the
   * oldest loaded one, when some are missing). One fetch per chat at a time;
   * a change meanwhile marks the chat for one more refresh.
   */
  async function loadSlot(slot, mode = "refresh") {
    if (slot.busy) {
      if (mode === "refresh") slot.dirty = true;
      else slot.next = mode;
      markBusy();
      return;
    }
    if (mode === "older-calls" && slot.callsGap == null) return;
    slot.busy = true;
    markBusy();
    const generation = ui.generation;
    const base = chatQuery(slot);
    const oldest = slot.items[0]?.seq;
    const newest = slot.items.at(-1)?.seq;
    let params;
    if (mode === "older-calls")
      params = { ...base, calls_before: slot.callsGap };
    else if (mode === "older" && oldest != null)
      params = { ...base, before: oldest, limit: PAGE_SIZE };
    else if (mode === "latest" || oldest == null)
      params = { ...base, limit: PAGE_SIZE };
    else if (slot.attached) params = { ...base, from: oldest };
    else params = { ...base, from: oldest, to: newest };
    const effective =
      mode === "older" && oldest == null
        ? "latest"
        : mode === "refresh" && oldest == null
          ? "latest"
          : mode;
    try {
      const askedAt = Math.max(ui.eventVersion, ui.stateVersion);
      const page = await source.page(slot.ref, params);
      if (generation !== ui.generation || ui.slots.get(slot.ref) !== slot)
        return;
      if (page.missing) {
        Object.assign(slot, {
          page: null,
          items: [],
          missing: true,
          loaded: true,
          error: null,
        });
        slot.version = Math.max(slot.version, askedAt);
      } else {
        if (noteInstance(page) || page.version < slot.version) return;
        applyPage(slot, page, effective, mode);
        // The first answer tells whether the chat is a forum; a topic filter then applies.
        if (
          page.chat?.is_forum &&
          ui.view.topic != null &&
          params.topic === undefined
        )
          slot.next = "latest";
        // The chat's newest item, whichever page this was.
        const latest = page.chat_latest_seq ?? page.latest_seq;
        const last = slot.items.at(-1)?.seq ?? 0;
        if (effective === "older-calls") {
          // A page of calls says nothing about newer items.
        } else if (
          !slot.attached &&
          latest != null &&
          latest > last &&
          slot.countedAt !== latest
        ) {
          const newer = await source.page(slot.ref, {
            ...base,
            members_limit: 0,
            from: last + 1,
          });
          if (generation !== ui.generation || ui.slots.get(slot.ref) !== slot)
            return;
          slot.newer = newer.items?.length ?? 0;
          slot.countedAt = latest;
        } else if (slot.attached || latest == null || latest <= last) {
          slot.newer = 0;
          slot.countedAt = latest;
        }
      }
      renderSlot(slot);
      renderList();
      renderControls();
    } catch (error) {
      slot.error = String(error?.message ?? error);
    } finally {
      slot.busy = false;
      if (ui.slots.get(slot.ref) === slot) {
        const next = slot.next;
        slot.next = null;
        if (next) loadSlot(slot, next);
        else if (slot.dirty) {
          slot.dirty = false;
          loadSlot(slot, "refresh");
        }
      }
      markBusy();
    }
  }

  /**
   * Takes a page into the chat's loaded range. Calls only accumulate (a call
   * never goes away, only its outcome changes): a refresh merges them, and
   * only the calls of items dropped from the range leave with them.
   */
  function applyPage(slot, page, mode, asked = mode) {
    slot.page = page;
    slot.missing = false;
    slot.loaded = true;
    slot.error = null;
    slot.version = page.version;
    slot.files = { ...slot.files, ...(page.files ?? {}) };
    slot.users = { ...slot.users, ...(page.users ?? {}) };
    const calls = page.calls ?? [];
    const pageGap = page.calls_truncated ? page.calls_oldest_request : null;
    if (mode === "older-calls") {
      slot.calls = mergeCalls(slot.calls, calls);
      slot.callsGap = pageGap;
      slot.scroll = "keep";
      return;
    }
    if (mode === "latest" && asked !== "refresh") {
      slot.calls = calls;
      slot.callsGap = pageGap;
    } else if (mode === "older") {
      slot.calls = mergeCalls(slot.calls, calls);
      slot.callsGap = higherGap(slot.callsGap, pageGap);
    } else {
      // A refresh covers the whole loaded range: when it holds every call,
      // none is missing; else what was missing still is.
      slot.calls = mergeCalls(slot.calls, calls);
      if (!page.calls_truncated) slot.callsGap = null;
    }
    if (mode === "older") {
      const known = new Set(slot.items.map((item) => item.seq));
      const merged = [
        ...page.items.filter((item) => !known.has(item.seq)),
        ...slot.items,
      ];
      slot.hasOlder = page.has_older;
      if (merged.length > LOADED_LIMIT) {
        slot.items = merged.slice(0, LOADED_LIMIT);
        slot.attached = false;
        slot.countedAt = null;
        // Calls after the newest item kept go with the dropped items.
        const upTo = slot.items.at(-1).after_request;
        slot.calls = slot.calls.filter((call) => call.request_number <= upTo);
      } else slot.items = merged;
      slot.scroll = "keep";
    } else if (mode === "latest") {
      slot.items = page.items;
      slot.hasOlder = page.has_older;
      slot.attached = true;
      slot.scroll = "bottom";
    } else {
      slot.items = page.items;
      slot.hasOlder = page.has_older;
      if (slot.attached && slot.items.length > LOADED_LIMIT) {
        // Calls up to the newest item dropped go with it.
        const dropped =
          slot.items[slot.items.length - LOADED_LIMIT - 1].after_request;
        slot.items = slot.items.slice(-LOADED_LIMIT);
        slot.hasOlder = true;
        slot.calls = slot.calls.filter((call) => call.request_number > dropped);
        if (slot.callsGap != null && slot.callsGap <= dropped + 1)
          slot.callsGap = null;
      }
    }
  }

  function refreshAll() {
    loadState();
    for (const slot of ui.slots.values()) loadSlot(slot, "refresh");
  }

  // ── drawing ─────────────────────────────────────────────────────────
  function columnElement(id) {
    return workspace.querySelector(
      `:scope > [data-column-id="${CSS.escape(id)}"]`,
    );
  }

  function listEntryOf(slot) {
    const key = slot.page?.chat?.key ?? slot.ref;
    return (
      (ui.state?.chats ?? []).find(
        (entry) => entry.key === key || entry.key === slot.ref,
      ) ?? null
    );
  }

  function contextOf(slot) {
    const page = slot.page ?? { bots: ui.state?.bots ?? [] };
    return render.makeContext(
      { ...page, files: slot.files, users: slot.users },
      {
        as: ui.view.as,
        key: page.chat?.key ?? slot.ref,
        links: render.serviceLinks(slot.items),
      },
    );
  }

  function renderFrame() {
    const columns = render.columnsFor(ui.view);
    const signature = JSON.stringify([
      columns.map((column) => column.id),
      ui.view.as,
    ]);
    if (signature === ui.signature) return columns;
    ui.signature = signature;
    // A chat's first column is its main one (the chat, or a panel shown without it).
    for (const column of columns)
      if (!ui.weights.has(column.id)) {
        const main =
          column.ref != null &&
          columns.find((other) => other.ref === column.ref) === column;
        ui.weights.set(
          column.id,
          main ? DEFAULT_WEIGHTS.chat : (DEFAULT_WEIGHTS[column.panel] ?? 0.25),
        );
      }
    const titles = (column) =>
      column.panel === "list" ? "chat list" : column.id;
    workspace.innerHTML = columns
      .map(
        (column, index) =>
          `${index ? render.renderDivider(columns[index - 1].id, titles(columns[index - 1])) : ""}${render.renderColumn(
            column,
            {
              key: ui.slots.get(column.ref)?.page?.chat?.key,
              chatId: ui.slots.get(column.ref)?.page?.chat?.id,
              viewAs: ui.view.as ?? "",
            },
          )}`,
      )
      .join("");
    workspace.setAttribute("data-columns", String(columns.length));
    if (!columns.length)
      workspace.innerHTML =
        '<p class="tv-empty tv-empty--page" data-role="no-panels">No chats yet.</p>';
    interact.layoutColumns(workspace, ui.weights, ui.widths);
    if (!columns.some((column) => column.id === ui.phonePane))
      ui.phonePane =
        (
          columns.find((column) => column.panel === "chat") ??
          columns.find((column) => column.panel !== "list") ??
          columns[0]
        )?.id ?? null;
    return columns;
  }

  function renderControls() {
    const people = new Map();
    for (const slot of ui.slots.values())
      for (const user of Object.values(slot.users))
        if (user && !user.is_bot) people.set(String(user.id), user);
    if (ui.view.as != null && !people.has(String(ui.view.as)))
      people.set(String(ui.view.as), {
        id: ui.view.as,
        first_name: `User ${ui.view.as}`,
      });
    const list = [...people.values()]
      .map((user) => ({
        id: String(user.id),
        name:
          [user.first_name, user.last_name].filter(Boolean).join(" ") ||
          `User ${user.id}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    patchHtml(
      controls,
      render.renderToolbar(ui.view, {
        people: list,
        runs: ui.state?.runs ?? [],
      }),
    );
    patchHtml(statusSlot, render.renderStatus(ui.status, recording));
  }

  function renderList() {
    const column = columnElement("list");
    if (!column) return;
    const entries = ui.state ? ui.state.chats : [];
    const header = column.querySelector("[data-slot='header']");
    patchHtml(
      header,
      render.renderListHeader(
        render.viewToSearch({ ...ui.view, show: ["list"] }),
      ),
    );
    // The box keeps what the reader typed; a redrawn one gets it back.
    const input = header.querySelector("[data-role='chat-search']");
    if (input && input.value !== ui.search) input.value = ui.search;
    const current = [...ui.slots.values()].map(
      (slot) => slot.page?.chat?.key ?? slot.ref,
    );
    const rows = render.chatListEntries(ui.state ?? { chats: [] }, {
      view: ui.view,
      current,
      search: ui.search,
    });
    const count = header.querySelector("[data-role='chat-count']");
    if (count)
      count.textContent = render.renderChatCount(
        entries.length,
        rows.filter((row) => !row.hidden).length,
        ui.search.trim() !== "",
      );
    patchKeyed(
      column.querySelector("[data-slot='items']"),
      rows.length
        ? rows
        : [
            {
              key: "empty",
              html: '<p class="tv-empty" data-role="no-chats">No chats yet.</p>',
            },
          ],
    );
  }

  function openAloneHref(column) {
    return render.viewToSearch({
      ...ui.view,
      chats: column.ref ? [column.ref] : ui.view.chats,
      show: [column.panel],
    });
  }

  /** The loaded calls the view's bots and methods filters let through. */
  function shownCalls(slot) {
    return slot.calls.filter((call) => render.callShown(call, ui.view));
  }

  function renderSlot(slot) {
    const ctx = contextOf(slot);
    const page = slot.page;
    const entry = listEntryOf(slot);
    // In the combined layout the chat column carries the calls inline.
    const inlineCalls =
      ui.view.layout === "combined" &&
      ui.view.show.includes("calls") &&
      ui.view.as == null;
    for (const column of render.columnsFor(ui.view)) {
      if (column.ref !== slot.ref) continue;
      const element = columnElement(column.id);
      if (!element) continue;
      if (page?.chat) {
        element.setAttribute("data-chat-key", page.chat.key);
        element.setAttribute("data-chat-id", String(page.chat.id ?? ""));
      }
      patchHtml(
        element.querySelector("[data-slot='header']"),
        render.renderPaneHeader(column, {
          page,
          entry,
          ctx,
          openAlone: openAloneHref(column),
          topic: ui.view.topic,
          missing: slot.missing,
        }),
      );
      const tools = element.querySelector("[data-slot='tools']");
      const scroller = element.querySelector("[data-slot='scroll']");
      const top = element.querySelector("[data-slot='top']");
      const items = element.querySelector("[data-slot='items']");
      const bottom = element.querySelector("[data-slot='bottom']");
      if (slot.missing) {
        patchHtml(
          top,
          '<div class="tv-banner" data-role="chat-missing">No such chat yet</div>',
        );
        patchKeyed(items, []);
        patchHtml(bottom, "");
        continue;
      }
      if (!slot.loaded) {
        patchHtml(top, '<p class="tv-empty" data-role="loading">Loading…</p>');
        continue;
      }
      const scrollMode = {
        toBottom: slot.scroll === "bottom",
        keepPlace: slot.scroll === "keep",
      };
      if (column.panel === "chat") {
        const notMember = render.renderNotMember(page, ctx);
        const older = slot.hasOlder
          ? `<div class="tv-older"><button type="button" class="tv-pill-button" data-role="load-older" data-before-seq="${slot.items[0]?.seq ?? ""}">Load older messages</button></div>`
          : slot.items.length
            ? '<div class="tv-history-start" data-role="history-start">Start of the loaded history</div>'
            : "";
        patchHtml(
          top,
          `${notMember}${render.renderAccessNote(page)}${notMember ? "" : older}${inlineCalls ? render.renderOlderCalls(slot.callsGap) : ""}`,
        );
        patchHtml(
          tools,
          inlineCalls
            ? render.renderCallFilters(slot.calls, ui.view, ctx, {
                open: ui.filtersOpen,
              })
            : "",
        );
        const list = render.chatStream(
          slot.items.filter((item) => render.scenarioShown(item, ui.view)),
          ctx,
          {
            layout: ui.view.layout,
            show: ui.view.show,
            calls: shownCalls(slot),
          },
        );
        const empty = notMember
          ? ""
          : '<p class="tv-empty" data-role="no-messages">No messages in this chat yet</p>';
        patchScrolled(
          scroller,
          items,
          render.streamEntries(list, ctx, { empty }),
          scrollMode,
        );
        patchHtml(
          bottom,
          slot.attached
            ? ""
            : `<div class="tv-jump"><button type="button" class="tv-pill-button tv-pill-button--accent" data-role="jump-latest" data-newer="${slot.newer}">Jump to latest${slot.newer ? ` · ${slot.newer >= 1000 ? "1000+" : slot.newer} newer` : ""}</button></div>`,
        );
      } else if (column.panel === "events") {
        patchHtml(
          top,
          slot.hasOlder
            ? '<p class="tv-note">Events of the loaded messages</p>'
            : "",
        );
        const list = render.eventsStream(slot.items);
        patchScrolled(
          scroller,
          items,
          render.streamEntries(list, ctx, {
            empty:
              '<p class="tv-empty" data-role="no-events">No events yet</p>',
          }),
          scrollMode,
        );
      } else if (column.panel === "members") {
        patchHtml(top, "");
        patchKeyed(items, page ? render.memberEntries(page, ctx) : []);
      } else if (column.panel === "calls") {
        patchHtml(
          tools,
          render.renderCallFilters(slot.calls, ui.view, ctx, {
            open: ui.filtersOpen,
          }),
        );
        patchHtml(top, render.renderOlderCalls(slot.callsGap));
        patchScrolled(
          scroller,
          items,
          render.streamEntries(shownCalls(slot), ctx, {
            empty: `<p class="tv-empty" data-role="no-calls">${slot.calls.length ? "No calls match the filter" : "No bot calls yet"}</p>`,
          }),
          scrollMode,
        );
      }
    }
    slot.scroll = null;
  }

  function renderAll() {
    const columns = renderFrame();
    renderControls();
    renderList();
    for (const slot of ui.slots.values()) renderSlot(slot);
    const titles = {};
    for (const slot of ui.slots.values())
      titles[slot.ref] = slot.page?.chat?.title ?? slot.ref;
    patchHtml(phoneNav, render.renderPhoneNav(columns, ui.phonePane, titles));
    interact.showPhonePane(root, ui.phonePane);
    markBusy();
  }

  function setStatus(status) {
    ui.status = status;
    renderControls();
  }

  // ── actions from the page ───────────────────────────────────────────
  const actions = {
    selectChat(key) {
      ui.phonePane = ui.view.show.includes("chat") ? `chat:${key}` : null;
      setView({ ...ui.view, chats: [key], topic: null }, "push");
      // On a phone the panels are stacked: bring the chosen chat into view.
      if (window.matchMedia("(max-width: 799px)").matches)
        root
          .querySelector("[data-role='workspace'] > [data-panel='chat']")
          ?.scrollIntoView({ block: "start" });
    },
    togglePanel(panel) {
      const shown = new Set(ui.view.show);
      if (shown.has(panel)) shown.delete(panel);
      else shown.add(panel);
      if (!shown.size) return;
      setView({
        ...ui.view,
        show: render.PANELS.filter((name) => shown.has(name)),
      });
    },
    hidePanel(panel) {
      const show = ui.view.show.filter((name) => name !== panel);
      if (show.length) setView({ ...ui.view, show });
    },
    setLayout(layout) {
      if (render.LAYOUTS.includes(layout)) setView({ ...ui.view, layout });
    },
    setAs(value) {
      const id = Number(value);
      setView({
        ...ui.view,
        as: Number.isSafeInteger(id) && id > 0 ? id : null,
      });
    },
    setTopic(value) {
      const topic =
        value === "general"
          ? "general"
          : Number(value) > 0
            ? Number(value)
            : null;
      setView({ ...ui.view, topic });
    },
    setRun(value) {
      setView({ ...ui.view, runs: value ? [String(value)] : null });
    },
    setTheme(value) {
      setView({
        ...ui.view,
        theme: ["light", "dark"].includes(value) ? value : null,
      });
    },
    search(text) {
      ui.search = text;
      renderList();
    },
    loadOlder(columnId) {
      const slot = ui.slots.get(refOfColumn(columnId));
      if (slot) loadSlot(slot, "older");
    },
    jumpLatest(columnId) {
      const slot = ui.slots.get(refOfColumn(columnId));
      if (slot) loadSlot(slot, "latest");
    },
    loadOlderCalls(columnId) {
      const slot = ui.slots.get(refOfColumn(columnId));
      if (slot) loadSlot(slot, "older-calls");
    },
    filterCalls(kind, values) {
      const list = values?.length
        ? kind === "bots"
          ? values.map(Number)
          : values
        : null;
      setView({ ...ui.view, [kind]: list });
    },
    callFiltersOpen(open) {
      ui.filtersOpen = open === true;
    },
    phonePane(columnId) {
      ui.phonePane = columnId;
      interact.showPhonePane(root, columnId);
    },
    resize(weights, widths) {
      for (const [id, weight] of weights) ui.weights.set(id, weight);
      for (const [id, width] of widths) ui.widths.set(id, width);
      interact.layoutColumns(workspace, ui.weights, ui.widths);
    },
  };
  interact.bindViewer(root, actions, { recording: recording !== null });
  win.addEventListener("popstate", () => {
    const next = render.parseView(win.location.search);
    if (!next.chats.length) next.chats = ui.view.chats;
    setView(next, "none");
  });
  if (typeof ResizeObserver === "function")
    new ResizeObserver(() =>
      interact.layoutColumns(workspace, ui.weights, ui.widths),
    ).observe(workspace);

  // ── start ───────────────────────────────────────────────────────────
  applyTheme();
  writeUrl("replace");
  renderAll();
  syncSlots();
  loadState();
  source.subscribe((message) => {
    const data = message.data ?? {};
    if (message.type === "status") setStatus(message.status);
    else if (message.type === "hello") {
      setStatus("live");
      ui.eventVersion = Number(data.version) || 0;
      if (
        ui.instance != null &&
        data.instance != null &&
        (data.instance !== ui.instance || data.epoch !== ui.epoch)
      ) {
        ui.instance = data.instance;
        ui.epoch = data.epoch ?? 0;
        reset();
      } else refreshAll();
    } else if (message.type === "change") {
      ui.eventVersion = Math.max(ui.eventVersion, Number(data.version) || 0);
      if (
        ui.instance != null &&
        data.instance != null &&
        (data.instance !== ui.instance || data.epoch !== ui.epoch)
      ) {
        ui.instance = data.instance;
        ui.epoch = data.epoch ?? 0;
        reset();
      } else refreshAll();
    } else if (message.type === "stopped") setStatus("stopped");
  });
  return { refresh: refreshAll, view: () => ui.view };
}

// ── live source ───────────────────────────────────────────────────────

function queryOf(params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params ?? {}))
    if (value != null && value !== "") search.set(name, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return { missing: true };
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

/** One EventSource; reports hello, change, stopped and its status, and after "stopped" waits for a server to answer again. */
function directStream(eventsUrl, stateUrl, deliver) {
  let source = null;
  let closed = false;
  let timer = null;
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const open = () => {
    if (closed) return;
    source = new EventSource(eventsUrl);
    source.addEventListener("hello", (event) => {
      deliver({ type: "status", status: "live" });
      deliver({ type: "hello", data: parse(event.data) });
    });
    source.addEventListener("change", (event) =>
      deliver({ type: "change", data: parse(event.data) }),
    );
    source.addEventListener("stopped", () => {
      source.close();
      deliver({ type: "stopped", data: {} });
      deliver({ type: "status", status: "stopped" });
      waitForServer();
    });
    source.onerror = () => {
      if (closed || source.readyState === 2) {
        if (!closed) {
          deliver({ type: "status", status: "reconnecting" });
          waitForServer();
        }
        return;
      }
      deliver({ type: "status", status: "reconnecting" });
    };
  };
  const waitForServer = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const response = await fetch(stateUrl, { cache: "no-store" });
        if (response.ok) return open();
      } catch {
        // Still down; try again.
      }
      waitForServer();
    }, STOPPED_RETRY_MS);
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}

/**
 * The event stream, once per browser: the tab holding the
 * "tv-events" lock opens it and relays every message to the other tabs over
 * a BroadcastChannel; when it closes, another tab takes the lock and opens
 * it. Without locks or channels, each tab opens its own.
 */
function sharedStream(eventsUrl, stateUrl, deliver) {
  const locks = globalThis.navigator?.locks;
  if (
    typeof BroadcastChannel !== "function" ||
    typeof locks?.request !== "function"
  )
    return directStream(eventsUrl, stateUrl, deliver);
  const channel = new BroadcastChannel("tv-events");
  let leading = false;
  let lastStatus = null;
  let stop = null;
  let release = null;
  channel.onmessage = (event) => {
    const message = event.data ?? {};
    if (message.type === "ask") {
      if (leading && lastStatus)
        channel.postMessage({ type: "status", status: lastStatus });
      return;
    }
    deliver(message);
  };
  locks
    .request("tv-events", () => {
      leading = true;
      stop = directStream(eventsUrl, stateUrl, (message) => {
        if (message.type === "status") lastStatus = message.status;
        channel.postMessage(message);
        deliver(message);
      });
      return new Promise((resolve) => {
        release = resolve;
      });
    })
    .catch(() => {});
  channel.postMessage({ type: "ask" });
  return () => {
    stop?.();
    release?.();
    channel.close();
  };
}

/** The live server's viewer API, at /_fake/ui. */
export function liveSource(base = "/_fake/ui") {
  const ref = (value) =>
    encodeURIComponent(String(value)).replace(/%3A/gi, ":");
  return {
    mode: "live",
    state: (params) => fetchJson(`${base}/api/state${queryOf(params)}`),
    page: (chat, params) =>
      fetchJson(`${base}/api/chats/${ref(chat)}${queryOf(params)}`),
    subscribe: (deliver) =>
      sharedStream(`${base}/events`, `${base}/api/state`, deliver),
  };
}

// ── recording source ──────────────────────────────────────────────────

/**
 * A recording's twin as a source: the same answers as the live server,
 * computed from the recorded pages by the same views.js windows and filters,
 * with every image from the twin's one files table. Nothing connects.
 */
export function staticSource(json, viewsApi) {
  const pages = json.pages ?? {};
  const files = json.files ?? {};
  const firstBot = (json.state?.bots ?? []).find((bot) => bot.first);
  const keyOf = (ref) => {
    const text = String(ref);
    if (pages[text]) return text;
    return /^\d+$/.test(text) && firstBot ? `${text}:${firstBot.id}` : text;
  };
  // What a member sees of a recorded chat, by the server's own filter: their
  // state from the recorded members, and the bans that revoked their messages
  // from the recorded calls.
  const viewOf = (page, userId) => {
    const chat = page.chat ?? {};
    if (chat.type === "private") {
      return viewsApi.visibleTo(
        page.items ?? [],
        { user_id: userId, status: null, revoked_by: [] },
        chat,
      );
    }
    const member =
      (page.members ?? []).find((entry) => Number(entry.user_id) === userId)
        ?.member ?? null;
    return viewsApi.visibleTo(
      page.items ?? [],
      {
        user_id: userId,
        status: member?.status ?? "left",
        ...(member?.status === "restricted"
          ? { is_member: member.is_member !== false }
          : {}),
        revoked_by:
          chat.type === "group"
            ? viewsApi.revokedBy(page.calls ?? [], chat.id, userId)
            : [],
      },
      chat,
    );
  };
  return {
    mode: "static",
    recording: { name: json.name, window: json.window },
    async state(params = {}) {
      const state = { ...json.state, files };
      if (params.as == null) return state;
      const userId = Number(params.as);
      // A member's view names whoever posted what they see.
      const users = { ...state.users };
      for (const page of Object.values(pages))
        Object.assign(users, page.users ?? {});
      const chats = (state.chats ?? [])
        .filter((entry) =>
          entry.type === "private"
            ? Number(entry.user_id) === userId
            : entry.type !== "calls" &&
              (pages[entry.key]?.members ?? []).some(
                (row) => Number(row.user_id) === userId,
              ),
        )
        .map((entry) => {
          if (!pages[entry.key]) return entry;
          const seen = viewOf(pages[entry.key], userId);
          return {
            ...entry,
            last: viewsApi.listPreview(seen.items.at(-1)),
            access: seen.as.access,
          };
        });
      return { ...state, chats, users };
    },
    async page(ref, params = {}) {
      const full = pages[keyOf(ref)];
      if (!full) return { missing: true };
      let items = full.items ?? [];
      let as = null;
      if (params.as != null) ({ items, as } = viewOf(full, Number(params.as)));
      let calls = full.calls ?? [];
      if (params.topic != null && full.chat?.is_forum) {
        items = items.filter(
          (item) =>
            item.kind === "scenario" || viewsApi.inTopic(item, params.topic),
        );
        calls = viewsApi.callsInTopic(calls, full.items ?? [], params.topic);
      }
      const callsBefore = params.calls_before ?? null;
      const window =
        callsBefore != null
          ? {
              items: [],
              has_older: false,
              oldest_seq: null,
              latest_seq: null,
              chat_latest_seq: null,
            }
          : viewsApi.pageWindow(items, {
              limit: params.limit ?? PAGE_SIZE,
              before: params.before ?? null,
              from: params.from ?? null,
              to: params.to ?? null,
            });
      const shown = as
        ? { calls: [], calls_truncated: false, calls_oldest_request: null }
        : viewsApi.callWindow(items, calls, window, { callsBefore });
      const limit = params.members_limit ?? MEMBERS_SHOWN;
      return {
        ...full,
        ...window,
        as,
        files,
        members: as || !limit ? [] : (full.members ?? []).slice(0, limit),
        join_requests: as ? [] : (full.join_requests ?? []),
        ...shown,
      };
    },
    subscribe(deliver) {
      deliver({ type: "status", status: "recording" });
      return () => {};
    },
  };
}
