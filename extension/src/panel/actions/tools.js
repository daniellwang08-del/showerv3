// Stats, adding jobs by URL, and the in-progress list.

import * as api from "../../api.js";
import { extractHttpUrls, localTimezone, messageOf } from "../format.js";
import { setState, state } from "../state.js";
import { toast } from "../toast.js";
import { loadHome } from "./home.js";

export const STAT_PERIODS = { day: 1, week: 7, month: 30 };

export async function loadStats(period = state.stats.period) {
  const key = STAT_PERIODS[period] ? period : "week";
  setState({ stats: { ...state.stats, period: key, loading: true } });
  const timezone = localTimezone();
  const [progress, scraper] = await Promise.all([
    api.getWeeklyProgress({ days: STAT_PERIODS[key], timezone }).catch(() => null),
    state.stats.scraper ? Promise.resolve(state.stats.scraper) : api.getScraperStats(timezone).catch(() => null),
  ]);
  setState({ stats: { ...state.stats, period: key, progress, scraper, loading: false } });
  if (!progress) toast("Could not load your activity.", "danger");
}

const ADD_CONCURRENCY = 6;

/** Submit job links; duplicates are reported, not re-added. */
export async function addJobs(text) {
  const urls = extractHttpUrls(text);
  if (!urls.length) {
    toast("Paste at least one job link that starts with http.", "warn");
    return false;
  }
  const result = { total: urls.length, done: 0, added: 0, duplicate: 0, failed: [], running: true };
  setState({ addJobs: { ...result } });
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const res = await api.submitJobUrl(url);
        if (res && (res.is_duplicate || res.status === "duplicate")) result.duplicate++;
        else if (res && res.success === false) result.failed.push({ url, reason: res.message || "Rejected" });
        else result.added++;
      } catch (err) {
        result.failed.push({ url, reason: messageOf(err, "Failed") });
      }
      result.done++;
      setState({ addJobs: { ...result, failed: result.failed.slice() } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(ADD_CONCURRENCY, urls.length) }, worker));
  result.running = false;
  setState({ addJobs: { ...result, failed: result.failed.slice() } });
  void loadHome({ quiet: true });
  return true;
}

export function clearAddJobs() {
  setState({ addJobs: null });
}

export async function loadInProgress() {
  setState({ inProgress: { ...(state.inProgress || {}), loading: true, error: null } });
  try {
    const rows = await api.listSessions("in_progress", 100);
    setState({ inProgress: { items: rows || [], loading: false, error: null } });
  } catch (err) {
    setState({ inProgress: { items: [], loading: false, error: messageOf(err, "Could not load your applications.") } });
  }
}
