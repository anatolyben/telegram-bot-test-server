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

const KEY_STEP = 24;

function panelOfColumn(element) {
  return element?.getAttribute("data-panel") ?? "chat";
}

function minimumOf(element) {
  return COLUMN_MINIMUMS[panelOfColumn(element)] ?? 280;
}

/**
 * Lays the columns out as fractions of the workspace: each column a share of
 * the free width, never below its minimum. `weights` maps a column id to its
 * share; dividers are 1 px tracks between them.
 */
export function layoutColumns(workspace, weights) {
  const columns = [...workspace.querySelectorAll(":scope > [data-column-id]")];
  const shares = columns.map((column) =>
    Math.max(
      0.01,
      Number(weights.get(column.getAttribute("data-column-id"))) || 0.25,
    ),
  );
  // Flex factors summing below 1 would leave part of the width empty.
  const total = shares.reduce((sum, share) => sum + share, 0) || 1;
  const tracks = columns.map((column, index) => {
    const track =
      columns.length === 1
        ? "minmax(0, 1fr)"
        : `minmax(${minimumOf(column)}px, ${(shares[index] / total).toFixed(4)}fr)`;
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
    divider.setAttribute("aria-valuemin", String(minimumOf(left)));
    divider.setAttribute(
      "aria-valuemax",
      String(Math.max(minimumOf(left), Math.round(total - minimumOf(right)))),
    );
  }
}

/**
 * Moves the boundary at `divider` so the column before it is `proposed` px
 * wide, within both columns' minimums, keeping the pair's total; reports the
 * pair's new weights.
 */
function resizePair(divider, proposed, weights, onResize) {
  const left = divider.previousElementSibling;
  const right = divider.nextElementSibling;
  if (!left || !right) return;
  const leftId = left.getAttribute("data-column-id");
  const rightId = right.getAttribute("data-column-id");
  const leftWidth = left.getBoundingClientRect().width;
  const total = leftWidth + right.getBoundingClientRect().width;
  if (!(total > 0)) return;
  const width = Math.min(
    Math.max(proposed, minimumOf(left)),
    Math.max(minimumOf(left), total - minimumOf(right)),
  );
  const pair =
    (Number(weights.get(leftId)) || 0.25) +
    (Number(weights.get(rightId)) || 0.25);
  onResize(
    leftId,
    (pair * width) / total,
    rightId,
    (pair * (total - width)) / total,
  );
}

/**
 * Wires every control by delegation on the root, once: toggles, layout,
 * view-as, topic, theme, hide, the chat list, paging buttons, phone
 * navigation, dividers and message links. `actions` are the page's handlers.
 */
export function bindViewer(root, actions) {
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
      actions.weights(),
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
    resizePair(divider, proposed, actions.weights(), actions.resize);
  });
}

/** On a phone, shows one column (and marks its button in the bottom bar). */
export function showPhonePane(root, columnId) {
  for (const column of root.querySelectorAll(
    "[data-role='workspace'] > [data-column-id]",
  ))
    column.toggleAttribute(
      "data-phone-active",
      column.getAttribute("data-column-id") === columnId,
    );
  for (const button of root.querySelectorAll("[data-role='phone-pane']")) {
    if (button.getAttribute("data-pane") === columnId)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const back = root.querySelector("[data-role='phone-back']");
  if (back)
    back.disabled =
      columnId === "list" ||
      !root.querySelector("[data-role='workspace'] > [data-column-id='list']");
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
  for (const element of root.querySelectorAll("[data-highlighted]"))
    element.removeAttribute("data-highlighted");
  for (const note of root.querySelectorAll("[data-role='pane-note']"))
    note.remove();
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
  callElement.setAttribute("data-highlighted", "true");
  for (const element of found) element.setAttribute("data-highlighted", "true");
  found[0]?.scrollIntoView({ block: "center" });
  const column = callElement.closest("section[data-column-id]");
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
