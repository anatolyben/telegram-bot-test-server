// DOM behavior on the rendered markup: toolbar and panel controls, the chat
// list, resizable columns, the phone's one-pane navigation and highlights.
// No imports and no top-level side effects, so a recording can inline it.

/** Minimum column widths in px. */
export const COLUMN_MINIMUMS = Object.freeze({
  list: 220,
  chat: 360,
  calls: 280,
  events: 280,
  members: 280,
});
// How far the minimums shrink, together, so the columns fit the window
// before it scrolls sideways; a divider may narrow a column as far.
const LEAST_SCALE = 0.75;

const KEY_STEP = 24;
// How long the floating day stays after the reader stops scrolling, and how
// soon after their wheel, touch, key or press a scroll counts as theirs.
const DAY_FLOAT_MS = 1000;
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function panelOfColumn(element) {
  return element?.getAttribute("data-panel") ?? "chat";
}

function minimumOf(element) {
  return element?.tvMinimum ?? COLUMN_MINIMUMS[panelOfColumn(element)] ?? 280;
}

/** The narrowest a divider makes a column. */
function floorOf(element) {
  return Math.floor(
    (COLUMN_MINIMUMS[panelOfColumn(element)] ?? 280) * LEAST_SCALE,
  );
}

function columnsOf(workspace) {
  return [...workspace.querySelectorAll(":scope > [data-column-id]")];
}

/**
 * Lays the columns out as fractions of the workspace: each column a share of
 * the free width, never below its minimum. `weights` maps a column id to its
 * share; dividers are 1 px tracks between them. When the minimums add up to
 * more than the workspace, they shrink in proportion (to LEAST_SCALE at
 * most), so the default columns fit a common window. `widths` maps a column
 * id to the width a divider last gave it: one dragged below its minimum
 * keeps that width as its minimum.
 */
export function layoutColumns(workspace, weights, widths = new Map()) {
  const columns = columnsOf(workspace);
  const base = columns.map(
    (column) => COLUMN_MINIMUMS[panelOfColumn(column)] ?? 280,
  );
  const wanted = base.reduce((sum, width) => sum + width, 0);
  const room = workspace.clientWidth - Math.max(0, columns.length - 1);
  const scale =
    room > 0 && wanted > room ? Math.max(LEAST_SCALE, room / wanted) : 1;
  columns.forEach((column, index) => {
    const chosen = Number(widths.get(column.getAttribute("data-column-id")));
    column.tvMinimum = Math.min(
      Math.floor(base[index] * scale),
      chosen > 0 ? Math.max(floorOf(column), Math.floor(chosen)) : Infinity,
    );
  });
  const shares = columns.map((column) =>
    Math.max(
      0.01,
      Number(weights.get(column.getAttribute("data-column-id"))) || 0.25,
    ),
  );
  // Each factor is at least 1, so the columns still flexible once others
  // sit at their minimums take all the free width (factors summing below 1
  // would leave part of it empty).
  const least = Math.min(...shares);
  const tracks = columns.map((column, index) => {
    const track =
      columns.length === 1
        ? "minmax(0, 1fr)"
        : `minmax(${minimumOf(column)}px, ${(shares[index] / least).toFixed(4)}fr)`;
    return index ? `1px ${track}` : track;
  });
  workspace.style.setProperty("--tv-columns", tracks.join(" "));
  updateDividers(workspace);
}

/** Puts each divider's current width (of the column before it) into its ARIA values. */
export function updateDividers(workspace) {
  for (const divider of workspace.querySelectorAll(
    ":scope > [data-role='divider']",
  )) {
    const left = divider.previousElementSibling;
    const right = divider.nextElementSibling;
    if (!left || !right) continue;
    const leftWidth = left.getBoundingClientRect().width;
    const total = leftWidth + right.getBoundingClientRect().width;
    divider.setAttribute("aria-valuenow", String(Math.round(leftWidth)));
    divider.setAttribute("aria-valuemin", String(floorOf(left)));
    divider.setAttribute(
      "aria-valuemax",
      String(Math.max(floorOf(left), Math.round(total - floorOf(right)))),
    );
  }
}

/**
 * Moves the boundary at `divider` so the column before it is `proposed` px
 * wide, keeping the pair's total; either column may go below its minimum,
 * to its floor. Reports every column's share of the workspace as it stands,
 * so the other columns keep their widths, and the pair's new widths.
 */
function resizePair(divider, proposed, onResize) {
  const left = divider.previousElementSibling;
  const right = divider.nextElementSibling;
  if (!left || !right) return;
  const columns = columnsOf(divider.parentElement);
  const width = (column) => column.getBoundingClientRect().width;
  const room = columns.reduce((sum, column) => sum + width(column), 0);
  const total = width(left) + width(right);
  if (!(total > 0)) return;
  const leftWidth = Math.min(
    Math.max(proposed, floorOf(left)),
    Math.max(floorOf(left), total - floorOf(right)),
  );
  const widths = new Map([
    [left.getAttribute("data-column-id"), leftWidth],
    [right.getAttribute("data-column-id"), total - leftWidth],
  ]);
  const weights = new Map(
    columns.map((column) => {
      const id = column.getAttribute("data-column-id");
      return [id, (widths.get(id) ?? width(column)) / room];
    }),
  );
  onResize(weights, widths);
}

/**
 * Wires every control by delegation on the root, once: toggles, layout,
 * view-as, topic, theme, hide, the chat list, paging buttons, phone
 * navigation, dividers and message links. `actions` are the page's handlers;
 * `recording` is true in a recording.
 */
export function bindViewer(root, actions, { recording = false } = {}) {
  let drag = null;
  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const row = target.closest("a.tv-list-item[data-chat-key]");
    if (row) {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      actions.selectChat(row.getAttribute("data-chat-key"));
      return;
    }
    const evidence = target.closest("[data-role='show-evidence']");
    if (evidence) {
      const marker = evidence.closest("[data-kind='scenario']");
      if (marker) highlightEvidence(root, marker, { recording });
      return;
    }
    const call = target.closest("[data-kind='call']");
    if (call) {
      highlightCall(root, call);
      return;
    }
    const link = target.closest("[data-link-message-id]");
    if (link) {
      revealMessage(link, link.getAttribute("data-link-message-id"));
      return;
    }
    const control = target.closest("[data-role]");
    if (!control || control.matches(":disabled")) return;
    const column =
      control
        .closest("section[data-column-id]")
        ?.getAttribute("data-column-id") ?? null;
    switch (control.getAttribute("data-role")) {
      case "toggle-panel":
        actions.togglePanel(control.getAttribute("data-panel"));
        break;
      case "layout":
        actions.setLayout(control.getAttribute("data-layout"));
        break;
      case "hide-panel":
        actions.hidePanel(control.getAttribute("data-panel"));
        break;
      case "load-older":
        actions.loadOlder(column);
        break;
      case "jump-latest":
        actions.jumpLatest(column);
        break;
      case "load-older-calls":
        actions.loadOlderCalls(column);
        break;
      case "phone-pane":
        actions.phonePane(control.getAttribute("data-pane"));
        break;
      case "phone-back":
        actions.phonePane("list");
        break;
      default:
    }
  });
  root.addEventListener("change", (event) => {
    const target = event.target;
    const filter =
      target instanceof HTMLInputElement
        ? target.closest(
            "[data-role='call-filter-bot'], [data-role='call-filter-method']",
          )
        : null;
    if (filter) {
      const boxes = [...filter.querySelectorAll("input[type='checkbox']")];
      const checked = boxes.filter((box) => box.checked);
      // Nothing checked would show nothing; keep the last one.
      if (!checked.length) {
        target.checked = true;
        return;
      }
      const values =
        checked.length === boxes.length
          ? null
          : checked.map((box) => box.value);
      actions.filterCalls(
        filter.getAttribute("data-role") === "call-filter-bot"
          ? "bots"
          : "methods",
        values,
      );
      return;
    }
    if (!(target instanceof HTMLSelectElement)) return;
    const role = target.getAttribute("data-role");
    if (role === "view-as") actions.setAs(target.value);
    else if (role === "topic-filter") actions.setTopic(target.value);
    else if (role === "theme") actions.setTheme(target.value);
    else if (role === "run-filter") actions.setRun(target.value);
  });
  root.addEventListener("input", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement &&
      target.getAttribute("data-role") === "chat-search"
    )
      actions.search(target.value);
  });
  root.addEventListener("pointerdown", (event) => {
    const divider =
      event.target instanceof Element
        ? event.target.closest("[data-role='divider']")
        : null;
    if (!divider || event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture?.(event.pointerId);
    divider.focus({ preventScroll: true });
    const left = divider.previousElementSibling;
    drag = {
      divider,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: left.getBoundingClientRect().width,
    };
    divider
      .closest("[data-role='workspace']")
      ?.setAttribute("data-resizing", "true");
  });
  root.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    resizePair(
      drag.divider,
      drag.startWidth + event.clientX - drag.startX,
      actions.resize,
    );
  });
  const finish = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.divider.releasePointerCapture?.(event.pointerId);
    drag.divider
      .closest("[data-role='workspace']")
      ?.removeAttribute("data-resizing");
    drag = null;
  };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", finish);
  // The day floats only while the reader scrolls: not for a scroll the page
  // makes (a new message, older ones loaded, an image that loaded). Scroll
  // events do not bubble; a chat's scroller is caught on the way down. A
  // press counts only in a chat (its scrollbar): a button elsewhere redraws
  // the chats, and that scroll is the page's.
  let readerAt = -Infinity;
  const reader = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.type === "pointerdown") {
      if (!target?.closest(".tv-wallpaper > [data-slot='scroll']")) return;
    } else if (event.type === "keydown") {
      // Keys typed into a field, and Space pressing a button, do not scroll.
      const field =
        event.key === " "
          ? "input, select, textarea, button"
          : "input, select, textarea";
      if (!SCROLL_KEYS.has(event.key) || target?.closest(field)) return;
    }
    readerAt = Date.now();
  };
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown"])
    root.addEventListener(type, reader, { capture: true, passive: true });
  root.addEventListener(
    "scroll",
    (event) => {
      const scroller = event.target;
      if (
        !(scroller instanceof Element) ||
        !scroller.matches(".tv-wallpaper > [data-slot='scroll']")
      )
        return;
      const floating = scroller.parentElement?.querySelector(
        "[data-role='day-float'][data-visible]",
      );
      // A fling keeps scrolling after the finger lifts.
      if (floating || Date.now() - readerAt < DAY_FLOAT_MS) floatDay(scroller);
    },
    true,
  );
  // A details element's toggle does not bubble.
  root.addEventListener(
    "toggle",
    (event) => {
      if (event.target?.getAttribute?.("data-role") === "call-filters")
        actions.callFiltersOpen(event.target.open);
    },
    true,
  );
  root.addEventListener("keydown", (event) => {
    const call =
      event.target instanceof Element &&
      (event.key === "Enter" || event.key === " ")
        ? event.target.closest("[data-kind='call']")
        : null;
    if (call === event.target) {
      event.preventDefault();
      highlightCall(root, call);
      return;
    }
    const divider =
      event.target instanceof Element
        ? event.target.closest("[data-role='divider']")
        : null;
    if (!divider) return;
    const width =
      divider.previousElementSibling?.getBoundingClientRect().width ?? 0;
    const proposed = {
      ArrowLeft: width - KEY_STEP,
      ArrowRight: width + KEY_STEP,
      Home: 0,
      End: Number.MAX_SAFE_INTEGER,
    }[event.key];
    if (proposed == null) return;
    event.preventDefault();
    resizePair(divider, proposed, actions.resize);
  });
}

/** On a phone, shows one column (and marks its button in the bottom bar, scrolled into view). */
export function showPhonePane(root, columnId) {
  for (const column of root.querySelectorAll(
    "[data-role='workspace'] > [data-column-id]",
  ))
    column.toggleAttribute(
      "data-phone-active",
      column.getAttribute("data-column-id") === columnId,
    );
  for (const button of root.querySelectorAll("[data-role='phone-pane']")) {
    if (button.getAttribute("data-pane") === columnId) {
      button.setAttribute("aria-current", "page");
      const nav = button.parentElement;
      if (nav && nav.scrollWidth > nav.clientWidth) {
        const left = button.offsetLeft - nav.offsetLeft;
        if (
          left < nav.scrollLeft ||
          left + button.offsetWidth > nav.scrollLeft + nav.clientWidth
        )
          nav.scrollLeft = left - (nav.clientWidth - button.offsetWidth) / 2;
      }
    } else button.removeAttribute("aria-current");
  }
  const back = root.querySelector("[data-role='phone-back']");
  if (back)
    back.disabled =
      columnId === "list" ||
      !root.querySelector("[data-role='workspace'] > [data-column-id='list']");
}

/**
 * While the reader scrolls a chat, shows the day of its top over it, as a
 * chip that leaves a second after they stop; never when that day's own
 * separator is in view.
 */
function floatDay(scroller) {
  const chip = scroller.parentElement?.querySelector("[data-role='day-float']");
  if (!chip) return;
  const top = scroller.getBoundingClientRect().top;
  let day = null;
  let next = null;
  for (const separator of scroller.querySelectorAll("[data-role='day']")) {
    if (separator.getBoundingClientRect().bottom <= top) day = separator;
    else {
      next = separator;
      break;
    }
  }
  const room = chip.getBoundingClientRect().height + 8;
  const shown =
    day !== null &&
    (next === null || next.getBoundingClientRect().top - top > room);
  clearTimeout(scroller.tvDayTimer);
  if (!shown) {
    chip.removeAttribute("data-visible");
    return;
  }
  chip.firstElementChild.textContent = day.textContent;
  chip.setAttribute("data-visible", "true");
  scroller.tvDayTimer = setTimeout(
    () => chip.removeAttribute("data-visible"),
    DAY_FLOAT_MS,
  );
}

/** Scrolls to a message of the same chat and marks it briefly. */
function revealMessage(origin, messageId) {
  const key = origin.closest("[data-chat-key]")?.getAttribute("data-chat-key");
  const root = origin.ownerDocument;
  const scope = key ? `[data-chat-key="${CSS.escape(key)}"]` : "";
  const target = root.querySelector(
    `[data-kind='message']${scope}[data-message-id="${CSS.escape(messageId)}"]`,
  );
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.setAttribute("data-flash", "true");
  setTimeout(() => target.removeAttribute("data-flash"), 1200);
}

/**
 * Marks what a call touched with data-highlighted="true", clearing the last
 * highlight: the messages it names (by chat id and message id, so a forward
 * finds its source chat's message), its ephemeral message and its user in
 * the call's chat, and everything it produced (data-request-id). Scrolls to
 * the first; a named message that is not on the page gets a note in the
 * call's column.
 */
export function highlightCall(root, callElement) {
  clearHighlights(root);
  const read = (name) => callElement.getAttribute(name);
  const all = (selector) => [...root.querySelectorAll(selector)];
  const key = read("data-chat-key");
  const inChat = key ? `[data-chat-key="${CSS.escape(key)}"]` : "";
  const found = [];
  const notes = [];
  for (const target of (read("data-target-messages") ?? "")
    .split(" ")
    .filter(Boolean)) {
    const [chatId, messageId] = target.split(":");
    const messages = all(
      `[data-kind='message'][data-chat-id="${CSS.escape(chatId)}"][data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (messages.length) found.push(...messages);
    else notes.push(missingNote(root, chatId, messageId));
  }
  const ephemeral = read("data-target-ephemeral-id");
  if (ephemeral && inChat)
    found.push(
      ...all(
        `[data-kind='message']${inChat}[data-ephemeral-id="${CSS.escape(ephemeral)}"]`,
      ),
    );
  const user = read("data-target-user-id");
  if (user && inChat)
    found.push(...all(`[data-member-id="${CSS.escape(user)}"]${inChat}`));
  const request = read("data-request-id");
  if (request)
    found.push(
      ...all(
        `[data-request-id="${CSS.escape(request)}"]:not([data-kind='call'])`,
      ),
    );
  showHighlights(root, callElement, found, notes);
}

function clearHighlights(root) {
  for (const element of root.querySelectorAll("[data-highlighted]"))
    element.removeAttribute("data-highlighted");
  for (const note of root.querySelectorAll("[data-role='pane-note']"))
    note.remove();
}

/**
 * Marks `origin` and what it points at (`found`) with
 * data-highlighted="true", scrolls to the first, and puts the `notes` on
 * what is not on the page at the top of origin's column.
 */
function showHighlights(root, origin, found, notes) {
  origin.setAttribute("data-highlighted", "true");
  for (const element of found) element.setAttribute("data-highlighted", "true");
  found[0]?.scrollIntoView({ block: "center" });
  const column = origin.closest("section[data-column-id]");
  const body = column?.querySelector(".tv-pane-body");
  if (notes.length && body) {
    const note = root.ownerDocument.createElement("p");
    note.className = "tv-pane-note";
    note.setAttribute("data-role", "pane-note");
    note.setAttribute("role", "status");
    note.textContent = notes.join("; ");
    body.prepend(note);
  }
}

/**
 * Marks the evidence a failed scenario's runner named, as highlightCall
 * marks a call's targets: messages and events by seq (one sequence across
 * every chat), calls by request id. Evidence not on the page gets a note,
 * which points to Activity unless this is a recording (which has none).
 */
export function highlightEvidence(root, marker, { recording = false } = {}) {
  clearHighlights(root);
  const all = (selector) => [...root.querySelectorAll(selector)];
  const found = [];
  let missing = 0;
  for (const seq of (marker.getAttribute("data-evidence-seqs") ?? "")
    .split(" ")
    .filter(Boolean)) {
    const items = all(
      `[data-kind='message'][data-seq="${CSS.escape(seq)}"], [data-kind='event'][data-seq="${CSS.escape(seq)}"]`,
    );
    if (items.length) found.push(...items);
    else missing += 1;
  }
  for (const request of (marker.getAttribute("data-evidence-requests") ?? "")
    .split(" ")
    .filter(Boolean)) {
    const calls = all(
      `[data-kind='call'][data-request-id="${CSS.escape(request)}"]`,
    );
    if (calls.length) found.push(...calls);
    else missing += 1;
  }
  showHighlights(
    root,
    marker,
    found,
    missing
      ? [
          `${missing} ${missing === 1 ? "piece of evidence is" : "pieces of evidence are"} not on this page: open ${missing === 1 ? "its chat" : "their chats"}${recording ? "" : " or Activity"}`,
        ]
      : [],
  );
}

/** Why a message a call names is not on the page. */
function missingNote(root, chatId, messageId) {
  const column = root.querySelector(
    `section[data-panel='chat'][data-chat-id="${CSS.escape(chatId)}"]`,
  );
  if (!column)
    return `message ${messageId} is in chat ${chatId}, which is not open`;
  const loaded = [
    ...column.querySelectorAll("[data-kind='message'][data-message-id]"),
  ].map((element) => Number(element.getAttribute("data-message-id")));
  return loaded.length && Number(messageId) < Math.min(...loaded)
    ? `message ${messageId} is older than the loaded history`
    : `message ${messageId} is not in the loaded history`;
}
