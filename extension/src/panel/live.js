// Live updates. One WebSocket carries match, resume and job events; when it
// is down, a slow revision check keeps the lists from going stale.

import * as api from "../api.js";
import { refreshVisible } from "./actions/home.js";
import { onJobEvent } from "./actions/job.js";
import { setState, state } from "./state.js";

const PING_MS = 25_000;
const FALLBACK_POLL_MS = 60_000;
const REFRESH_DEBOUNCE_MS = 1_500;
const MAX_BACKOFF_MS = 30_000;

const LIST_EVENTS = /^(match_|resume_build_|resume_file_|tailored_content_|job_status_changed|job_excluded_for_user|scrape_promoted|extraction_completed|jobs_)/;

class LiveUpdates {
  constructor() {
    this.ws = null;
    this.running = false;
    this.backoff = 2_000;
    this.pingTimer = null;
    this.retryTimer = null;
    this.pollTimer = null;
    this.refreshTimer = null;
    this.revision = null;
  }

  get status() {
    return state.live;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.backoff = 2_000;
    void this.connect();
    this.startFallbackPoll();
  }

  stop() {
    this.running = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    clearTimeout(this.refreshTimer);
    this.pingTimer = this.retryTimer = this.pollTimer = this.refreshTimer = null;
    this.revision = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    setState({ live: "offline" });
  }

  async connect() {
    if (!this.running) return;
    let url;
    try {
      url = await api.liveEventsUrl();
    } catch {
      url = null;
    }
    if (!url || !this.running) return this.scheduleReconnect();
    setState({ live: "connecting" });
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 2_000;
      setState({ live: "online" });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_MS);
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      if (!this.running) return;
      setState({ live: "offline" });
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  onMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const type = event && typeof event.type === "string" ? event.type : "";
    if (!type || !LIST_EVENTS.test(type)) return;
    const jobId = event.valid_job_id || event.job_id;
    if (jobId) onJobEvent(type, jobId);
    this.scheduleRefresh();
  }

  /** Bursts of events (a scrape batch, a build) collapse into one refresh. */
  scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void refreshVisible();
    }, REFRESH_DEBOUNCE_MS);
  }

  startFallbackPoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (!this.running || state.live === "online" || document.hidden) return;
      try {
        const { revision } = await api.getRevision();
        if (this.revision && revision !== this.revision) this.scheduleRefresh();
        this.revision = revision;
      } catch {
        /* server unreachable; retry on the next tick */
      }
    }, FALLBACK_POLL_MS);
  }
}

export const live = new LiveUpdates();
