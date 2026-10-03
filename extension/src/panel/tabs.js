// Which browser tab the panel acts on. Docked in the side panel, that is the
// active tab of the panel's own window. When the panel page runs in its own
// tab or popup window, it is the active tab of the last focused normal window.

const isWebUrl = (url) => /^https?:\/\//i.test(url || "");

async function panelOwnTab() {
  try {
    return (await chrome.tabs.getCurrent()) || null;
  } catch {
    return null;
  }
}

/** @returns {Promise<chrome.tabs.Tab|null>} */
export async function getWorkTab() {
  const own = await panelOwnTab();
  if (!own) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
    const tab = win && win.id !== own.windowId ? (win.tabs || []).find((t) => t.active) : null;
    if (tab) return tab;
  } catch {
    /* fall through */
  }
  const tabs = await chrome.tabs.query({ active: true, windowType: "normal" });
  return tabs.find((t) => t.id !== own.id) || null;
}

/** Work tab only when it shows a web page the extension can act on. */
export async function getWebWorkTab() {
  const tab = await getWorkTab();
  return tab && tab.id != null && isWebUrl(tab.url) ? tab : null;
}

/** Load `url` in the work tab, or in a new tab when there is no usable one. */
export async function openInWorkTab(url) {
  if (!isWebUrl(url)) return null;
  const tab = await getWorkTab();
  const own = await panelOwnTab();
  if (tab && tab.id != null && (!own || tab.id !== own.id)) {
    await chrome.tabs.update(tab.id, { url, active: true });
    return tab.id;
  }
  const created = await chrome.tabs.create({ url, active: true });
  return created.id;
}

export async function openNewTab(url) {
  if (isWebUrl(url)) await chrome.tabs.create({ url, active: true });
}
