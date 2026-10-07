/**
 * Recordings: what happened in some chats between record/start and
 * record/stop, as a JSON twin in the viewer's own shapes (state.js) and one
 * HTML file that draws it with the viewer's client, offline: the client's
 * scripts, its stylesheet, the twin and every image are inside the file, and
 * its policy lets it load nothing else.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { escapeHtml } from "./render.js";
import { createUiState } from "./state.js";

// The viewer's modules a recording inlines, in the order they are defined.
const MODULES = ["views", "render", "interact", "app"];
const START = `app.startViewer({
  render,
  interact,
  views,
  source: app.staticSource(
    JSON.parse(document.getElementById("tv-data").textContent),
    views,
  ),
  root: document.body,
});`;

/** The base64 SHA-256 of a text, as a content security policy names it. */
function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

/**
 * One of the viewer's modules as a classic script that defines `name`: its
 * source in a function of its own, returning what it exports. Each module
 * imports nothing and exports only with `export function name(` and
 * `export const name =` at the start of a line, so this is all it takes.
 */
function inlined(name, source) {
  if (/^import\b/m.test(source)) {
    throw new Error(`${name}.js cannot be inlined: it imports`);
  }
  const exported = [
    ...source.matchAll(/^export (?:function|const) ([A-Za-z_$][\w$]*)/gm),
  ].map((match) => match[1]);
  const body = source.replace(/^export (?=function |const )/gm, "");
  if (/^export\b/m.test(body)) {
    throw new Error(
      `${name}.js cannot be inlined: an export is not a declaration`,
    );
  }
  return `const ${name} = (() => {\n${body}\nreturn { ${exported.join(", ")} };\n})();`;
}

/**
 * The recorder of a server's `model` (index.js uiModel): build() draws up a
 * stopped recording's twin and the file that shows it. Reads the viewer's
 * sources once.
 */
export async function createRecorder(model) {
  const ui = createUiState(model);
  const here = (file) => new URL(file, import.meta.url);
  const [sources, style] = await Promise.all([
    Promise.all(MODULES.map((name) => readFile(here(`${name}.js`), "utf8"))),
    readFile(here("style.css"), "utf8"),
  ]);
  const script = [
    ...MODULES.map((name, index) => inlined(name, sources[index])),
    START,
  ].join("\n");
  // The HTML parser would end the element there, whatever the script or
  // stylesheet means.
  if (/<\/script|<!--/i.test(script)) {
    throw new Error(
      "the viewer's scripts cannot be inlined: they hold </script or <!--",
    );
  }
  if (/<\/style/i.test(style)) {
    throw new Error(
      "the viewer's stylesheet cannot be inlined: it holds </style",
    );
  }
  const policy = [
    "default-src 'none'",
    "img-src data:",
    `style-src 'sha256-${digest(style)}'`,
    `script-src 'sha256-${digest(script)}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  /**
   * The twin of a recording `{ name, chats, epoch, startSeq, startRequest,
   * startedAt }` stopped at `{ stopSeq, stopRequest, stoppedAt }`: the chat
   * list and one full page per recorded chat, with every image once, as a
   * data: URI, in the top-level files table.
   */
  function twin(recording, stop) {
    const { state, pages, files, missing } = ui.recorded({
      refs: recording.chats,
      startSeq: recording.startSeq,
      startRequest: recording.startRequest,
    });
    const inline = {};
    for (const [fileId, info] of Object.entries(files)) {
      const { bytes, mime_type } = ui.file(fileId);
      inline[fileId] = {
        ...info,
        url: `data:${mime_type};base64,${bytes.toString("base64")}`,
      };
    }
    return {
      format: "telegram-bot-test-server-recording",
      format_version: 1,
      name: recording.name,
      chats_filter: recording.chats,
      window: {
        epoch: recording.epoch,
        start_seq: recording.startSeq,
        stop_seq: stop.stopSeq,
        start_request: recording.startRequest,
        stop_request: stop.stopRequest,
        started_at: recording.startedAt,
        stopped_at: stop.stoppedAt,
      },
      state,
      pages,
      files: inline,
      missing_chats: missing,
    };
  }

  /**
   * The recording's file around its twin's JSON `text`. The policy comes
   * first, since a policy in a meta element covers only what follows it; the
   * twin is a JSON block with every "<" escaped, so no text in it can end
   * the element.
   */
  function page(name, text) {
    return [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="color-scheme" content="light dark">',
      '<meta name="referrer" content="no-referrer">',
      `<title>${escapeHtml(name)} · recording · local test server</title>`,
      `<style>${style}</style>`,
      "</head>",
      '<body data-role="app">',
      "<noscript>This recording needs JavaScript to show its chats.</noscript>",
      `<script type="application/json" id="tv-data">${text.replace(/</g, "\\u003c")}</script>`,
      `<script>${script}</script>`,
      "</body>",
      "</html>",
      "",
    ].join("\n");
  }

  /**
   * A stopped recording: its twin (`json`, a copy that shares nothing with
   * the server's state) and the file that shows it (`html`).
   */
  function build(recording, stop) {
    const text = JSON.stringify(twin(recording, stop));
    return { json: JSON.parse(text), html: page(recording.name, text) };
  }

  /**
   * Writes a stopped recording into `dir` (made when missing) as
   * `<name>.html` and `<name>.json`, replacing earlier files of that name.
   * The name is a recording's (letters, digits, ".", "_" and "-", starting
   * with a letter or digit), so it names a file in `dir` and nothing else.
   */
  async function save(dir, name, { html, json }) {
    const files = {
      html: join(resolve(dir), `${name}.html`),
      json: join(resolve(dir), `${name}.json`),
    };
    await mkdir(resolve(dir), { recursive: true });
    await Promise.all([
      writeFile(files.html, html),
      writeFile(files.json, `${JSON.stringify(json, null, 2)}\n`),
    ]);
    return files;
  }

  return { build, save };
}
