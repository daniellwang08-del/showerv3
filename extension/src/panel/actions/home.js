// Home summary and the server-paged job lists.

import * as api from "../../api.js";
import { teardownAutofill } from "../autofill/index.js";
import { localTimezone, messageOf } from "../format.js";
import { LISTS, listQuery, queryKey } from "../lists.js";
import { emptyList, setState, state } from "../state.js";
import { openFromList, stopStreaming } from "./job.js";

let homeRequest = 0;

/** Leave any job and show Home. */
export async function goHome() {
  if (state.view === "job") await leaveJob();
  setState({ view: "home", listId: null, jobError: null });
  await loadHome();
}

/** Switch to another top-level view, leaving any open job cleanly. */
export async function showView(view) {
  if (state.view === "job") await leaveJob();
  setState({ view });
  if (view === "list") void loadList(state.list.page || 1, { quiet: true });
}

async function leaveJob() {
  stopStreaming();
  await teardownAutofill().catch(() => {});
  chrome.runtime.sendMessage({ type: "ASK_HOTKEY_DISARM" }).catch(() => {});
  chrome.storage.session.remove("activeApplyJobId").catch(() => {});
  setState({ job: null, applyContext: null, reportNotice: null, chat: { messages: [], streaming: false } });
}

export async function loadHome({ quiet = false } = {}) {
  if (!state.user) return;
  const id = ++homeRequest;
  if (!quiet || !state.home.data) setState({ home: { ...state.home, loading: true, error: null } });
  try {
    const data = await api.getHome(localTimezone());
    if (id !== homeRequest) return;
    setState({ home: { data, loading: false, error: null, loadedAt: Date.now() } });
  } catch (err) {
    if (id !== homeRequest) return;
    setState({ home: { ...state.home, loading: false, error: messageOf(err, "Could not load your jobs.") } });
  }
}

/** Open a list from Home with its default filters. */
export async function openList(listId) {
  if (state.view === "job") await leaveJob();
  const def = LISTS[listId] || LISTS.all;
  setState({
    view: "list",
    listId,
    filters: { q: "", sort: def.sort || "created_at", remoteOnly: false, minScore: 0 },
    list: emptyList(),
  });
  await loadList(1);
}

let listAbort = null;

export async function loadList(page = state.list.page || 1, { quiet = false } = {}) {
  const listId = state.listId;
  if (!listId) return;
  const query = listQuery(listId, state.filters, page, state.pageSize, localTimezone());
  const key = queryKey(query);
  if (listAbort) listAbort.abort();
  const ctrl = new AbortController();
  listAbort = ctrl;
  setState({ list: { ...state.list, page, key, loading: !quiet || state.list.key !== key, error: null } });
  try {
    const data = await api.getJobs(query, { signal: ctrl.signal });
    if (ctrl.signal.aborted || state.list.key !== key) return;
    const total = data.total || 0;
    setState({
      list: {
        items: data.items || [],
        total,
        page: data.page || page,
        pages: Math.max(1, Math.ceil(total / (data.per_page || state.pageSize))),
        loading: false,
        error: null,
        key,
        loadedAt: Date.now(),
      },
    });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    setState({ list: { ...state.list, loading: false, error: messageOf(err, "Could not load jobs.") } });
  } finally {
    if (listAbort === ctrl) listAbort = null;
  }
}

/** "Start applying": open the list and its first job that is not applied. */
export async function startApplying(listId = "ready") {
  await openList(listId);
  const first = (state.list.items || []).find((j) => !j.applied_at);
  if (first) await openFromList(first.id);
}

let filterTimer = null;

/** Update list filters; text search is debounced, other filters apply at once. */
export function setFilters(patch) {
  setState({ filters: { ...state.filters, ...patch } });
  if (filterTimer) clearTimeout(filterTimer);
  const debounce = Object.prototype.hasOwnProperty.call(patch, "q") ? 350 : 0;
  filterTimer = setTimeout(() => {
    filterTimer = null;
    void loadList(1);
  }, debounce);
}

/** Live update: refresh whatever is on screen without spinners. */
export async function refreshVisible() {
  if (!state.user) return;
  const tasks = [];
  if (state.view === "home" || state.view === "list") tasks.push(loadHome({ quiet: true }));
  if (state.view === "list" && !state.list.loading) tasks.push(loadList(state.list.page, { quiet: true }));
  await Promise.all(tasks);
}
