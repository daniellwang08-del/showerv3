// Frame-aware chrome.tabs.sendMessage helpers for embedded ATS iframes
// (e.g. Greenhouse job_app on a company career page).

export async function getTabFrames(tabId) {
  if (tabId == null) return [];
  try {
    if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return Array.isArray(frames) ? frames : [];
    }
  } catch {
    /* ignore */
  }
  return [{ frameId: 0, url: "", parentFrameId: -1 }];
}

function sendOne(tabId, frameId, msg) {
  return new Promise((resolve) => {
    try {
      const opts = frameId != null ? { frameId } : {};
      chrome.tabs.sendMessage(tabId, msg, opts, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp != null ? resp : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Send to one frame, or the main frame when frameId is null/undefined. */
export function sendTabMessage(tabId, msg, frameId) {
  return sendOne(tabId, frameId == null ? 0 : frameId, msg);
}

/** Send to every frame in the tab (deduped frame ids). */
export async function broadcastTabMessage(tabId, msg) {
  const frames = await getTabFrames(tabId);
  const ids = [...new Set(frames.map((f) => f.frameId).filter((id) => id != null))];
  if (!ids.length) ids.push(0);
  const out = [];
  for (const frameId of ids) {
    out.push(await sendOne(tabId, frameId, msg));
  }
  return out;
}

/** Pick the Greenhouse application iframe when present. */
export function pickGreenhouseFrame(frames) {
  let best = null;
  let bestScore = -1;
  for (const f of frames || []) {
    const url = (f.url || "").toLowerCase();
    if (!url || url.startsWith("about:")) continue;
    let score = 0;
    if (/greenhouse\.io/.test(url) && /embed\/job_app/.test(url)) score = 1000;
    else if (/greenhouse\.io/.test(url) && /\/jobs\//.test(url)) score = 900;
    else if (/greenhouse\.io/.test(url)) score = 500;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}
