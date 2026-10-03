import { html } from "../../lib/preact.js";
import { goHome, showView } from "../actions/home.js";
import { LISTS } from "../lists.js";
import { setState, useAppState } from "../state.js";
import { dismissToast } from "../toast.js";
import { IconButton, Modal, Spinner, Toast } from "./components.js";
import { HomeView } from "./views/Home.js";
import { InProgressView } from "./views/InProgress.js";
import { JobView } from "./views/Job.js";
import { ListView } from "./views/List.js";
import { LoginView } from "./views/Login.js";
import { SettingsView } from "./views/Settings.js";
import { StatsView } from "./views/Stats.js";
import { TailorView } from "./views/Tailor.js";

const TITLES = {
  tailor: "Tailor a resume",
  stats: "Activity",
  settings: "Settings",
  progress: "In progress",
};

const navigate = (view) => void showView(view);

function LiveDot({ status }) {
  const label = status === "online" ? "Live updates on" : status === "connecting" ? "Connecting" : "Offline, refreshing every minute";
  return html`<span class=${`live-dot live-${status}`} title=${label} aria-label=${label}></span>`;
}

function TopBar({ s }) {
  const onHome = s.view === "home";
  let title = TITLES[s.view] || "";
  let back = () => goHome();
  if (s.view === "list") title = (LISTS[s.listId] || {}).title || "Jobs";
  if (s.view === "job") {
    const ctx = s.applyContext;
    title = ctx ? ctx.title : "Application";
    if (ctx && ctx.listId && LISTS[ctx.listId]) back = () => navigate("list");
    else if (ctx && ctx.listId === "progress") back = () => navigate("progress");
  }
  return html`<header class="topbar">
    ${onHome
      ? html`<span class="brand"><img src="icons/icon32.png" alt="" width="20" height="20" /><span>NAO</span></span>`
      : html`<${IconButton} icon="back" label="Back" onClick=${back} />`}
    ${onHome ? null : html`<h1 class="topbar-title">${title}</h1>`}
    <span class="topbar-spacer"></span>
    <${LiveDot} status=${s.live} />
    ${onHome
      ? html`
          <${IconButton} icon="sparkles" label="Tailor a resume" onClick=${() => navigate("tailor")} />
          <${IconButton} icon="chart" label="Activity" onClick=${() => navigate("stats")} />
          <${IconButton} icon="settings" label="Settings" onClick=${() => navigate("settings")} />
        `
      : null}
  </header>`;
}

function Body({ s }) {
  switch (s.view) {
    case "home":
      return html`<${HomeView} s=${s} />`;
    case "list":
      return html`<${ListView} s=${s} />`;
    case "job":
      return html`<${JobView} s=${s} />`;
    case "progress":
      return html`<${InProgressView} s=${s} />`;
    case "tailor":
      return html`<${TailorView} s=${s} />`;
    case "stats":
      return html`<${StatsView} s=${s} />`;
    case "settings":
      return html`<${SettingsView} s=${s} />`;
    default:
      return html`<div class="center-fill"><${Spinner} size=${22} /></div>`;
  }
}

export function App() {
  const s = useAppState();
  const closeModal = () => {
    const modal = s.modal;
    if (!modal || modal.busy) return;
    setState({ modal: null });
    if (modal.onCancel) modal.onCancel();
  };
  if (s.view === "login") {
    return html`<div class="app app-login"><${LoginView} s=${s} /><${Toast} toast=${s.toast} onDismiss=${dismissToast} /></div>`;
  }
  return html`<div class="app">
    ${s.view === "loading" ? null : html`<${TopBar} s=${s} />`}
    <main class=${`view view-${s.view}`}><${Body} s=${s} /></main>
    <${Toast} toast=${s.toast} onDismiss=${dismissToast} />
    <${Modal} modal=${s.modal} onClose=${closeModal} />
  </div>`;
}
