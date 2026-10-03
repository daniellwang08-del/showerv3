import { html, render } from "../lib/preact.js";
import { loadHome } from "./actions/home.js";
import { checkProfileChanged, init } from "./actions/session.js";
import { installMessageRouter } from "./messages.js";
import { state } from "./state.js";
import { App } from "./ui/App.js";

const STALE_MS = 60_000;

installMessageRouter();
render(html`<${App} />`, document.getElementById("app"));
void init();

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.user) return;
  void checkProfileChanged();
  if (state.view === "home" && Date.now() - state.home.loadedAt > STALE_MS) void loadHome({ quiet: true });
});
