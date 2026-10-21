// Chrome throttles timers in hidden tabs: about one wake-up per second, then
// one per MINUTE once timers chain. Auto-apply fills each job in a background
// tab, so a fill made of many short waits (Workable: prep, write, commit, then
// the resume upload queued behind them) took longer than the run's time limit
// and the resume was never attached. While the page is hidden, this world's
// setTimeout is timed by the extension service worker instead; its port
// replies are not throttled. In a job page only the extension's isolated world
// is affected, never the page's own timers. The auto-apply runner page loads
// it too: it drives every fill from the console tab, which is often hidden.
(() => {
  if (window.__afTimers) return;
  window.__afTimers = true;

  const nativeSet = window.setTimeout.bind(window);
  const nativeClear = window.clearTimeout.bind(window);
  const pending = new Map(); // negative id -> { fn, args, due }
  let seq = 0;
  let port = null;

  function fire(id) {
    const t = pending.get(id);
    if (!t) return;
    pending.delete(id);
    try {
      t.fn(...t.args);
    } catch (err) {
      console.error(err);
    }
  }

  function connect() {
    if (port) return port;
    try {
      if (!chrome.runtime || !chrome.runtime.id) return null;
      port = chrome.runtime.connect({ name: "af-timers" });
    } catch {
      port = null;
      return null;
    }
    port.onMessage.addListener((m) => {
      if (m && typeof m.id === "number") fire(m.id);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      // Service worker restarted or the extension reloaded: finish the waits
      // already in flight on this page's own (throttled) timers.
      for (const [id, t] of pending) nativeSet(() => fire(id), Math.max(0, t.due - performance.now()));
    });
    return port;
  }

  function setTimeoutAF(fn, ms, ...args) {
    const wait = Math.max(0, Number(ms) || 0);
    // Long timeouts (load and run limits) lose little to throttling.
    if (typeof fn !== "function" || document.visibilityState !== "hidden" || wait > 60_000) {
      return nativeSet(fn, ms, ...args);
    }
    const p = connect();
    if (!p) return nativeSet(fn, ms, ...args);
    const id = -++seq;
    pending.set(id, { fn, args, due: performance.now() + wait });
    try {
      p.postMessage({ id, ms: wait });
    } catch {
      pending.delete(id);
      return nativeSet(fn, ms, ...args);
    }
    return id;
  }

  function clearTimeoutAF(id) {
    if (typeof id === "number" && id < 0) pending.delete(id);
    else nativeClear(id);
  }

  window.setTimeout = setTimeoutAF;
  window.clearTimeout = clearTimeoutAF;
})();
