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
  root.addEventListener("keydown", (event) => {
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

/** Hides the calls the bots and methods filters leave out (calls are not drawn yet). */
export function applyCallFilters(root, view) {}

/** Highlights what a call affected (calls are not drawn yet). */
export function highlightCall(root, callElement) {}
