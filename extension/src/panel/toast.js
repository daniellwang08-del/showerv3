import { setState } from "./state.js";

let timer = null;

/** Short status message at the bottom of the panel. */
export function toast(message, tone = "info") {
  const text = String(message || "").trim();
  if (!text) return;
  setState({ toast: { text, tone, id: Date.now() } });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    setState({ toast: null });
  }, tone === "danger" ? 6000 : 3800);
}

export function dismissToast() {
  if (timer) clearTimeout(timer);
  timer = null;
  setState({ toast: null });
}
