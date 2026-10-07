// The viewer page's entry: the one module with imports. It starts the client
// on the live server; a recording inlines the same modules instead.
import * as views from "./views.js";
import * as render from "./render.js";
import * as interact from "./interact.js";
import { liveSource, startViewer } from "./app.js";

startViewer({
  render,
  interact,
  views,
  source: liveSource(),
  root: document.body,
});
