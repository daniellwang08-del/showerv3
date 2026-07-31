const BRIDGE_BASES = [
  "http://127.0.0.1:8765",
  "http://localhost:8765",
];

const PLATFORM_DOMAINS = {
  rrs: ["remoterocketship.com"],
  jobright: ["jobright.ai"],
};

let pollTimer = null;

async function bridgeGet(path) {
  for (const base of BRIDGE_BASES) {
    try {
      const resp = await fetch(`${base}${path}`, { method: "GET" });
      if (!resp.ok) continue;
      return await resp.json();
    } catch (_) {
      // try next base
    }
  }
  return null;
}

async function bridgePost(path, body) {
  for (const base of BRIDGE_BASES) {
    try {
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) continue;
      return await resp.json();
    } catch (_) {
      // try next base
    }
  }
  return null;
}

async function collectCookies(domains) {
  const all = [];
  for (const domain of domains) {
    const batch = await chrome.cookies.getAll({ domain });
    all.push(...batch);
  }
  const seen = new Set();
  const unique = [];
  for (const c of all) {
    const key = `${c.name}|${c.domain}|${c.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: c.session ? -1 : c.expirationDate || -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite:
        c.sameSite === "no_restriction"
          ? "None"
          : c.sameSite === "strict"
            ? "Strict"
            : "Lax",
    });
  }
  return unique;
}

async function exportPlatform(platform) {
  const domains = PLATFORM_DOMAINS[platform];
  if (!domains) return { ok: false, error: "unknown_platform" };
  const cookies = await collectCookies(domains);
  if (!cookies.length) {
    return { ok: false, error: "no_cookies_for_domain" };
  }
  const result = await bridgePost("/export", { platform, cookies });
  return result || { ok: false, error: "bridge_unreachable" };
}

async function pollPending() {
  const pending = await bridgeGet("/pending");
  if (!pending || !pending.platform || pending.done) return false;
  const result = await exportPlatform(pending.platform);
  return !!(result && result.ok);
}

function startFastPoll() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const done = await pollPending();
      if (done) {
        stopFastPoll();
        return;
      }
    } catch (_) {
      // keep polling
    }
    pollTimer = setTimeout(tick, 2000);
  };
  tick();
}

function stopFastPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("scraper_session_poll", { periodInMinutes: 1 });
  startFastPoll();
});

chrome.runtime.onStartup.addListener(() => {
  startFastPoll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "scraper_session_poll") {
    startFastPoll();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "export") {
    startFastPoll();
    exportPlatform(msg.platform).then(sendResponse);
    return true;
  }
  return false;
});

// Kick once when the worker wakes.
startFastPoll();
