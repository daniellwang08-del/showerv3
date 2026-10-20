import assert from "node:assert/strict";
import { test } from "node:test";

function area() {
  let data = {};
  return {
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return out;
    },
    async set(patch) {
      data = { ...data, ...JSON.parse(JSON.stringify(patch)) };
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

function event() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), fire: (...args) => listeners.forEach((fn) => fn(...args)) };
}

const jars = { 0: [], 1: [] };
const stores = [{ id: "0", tabIds: [] }, { id: "1", tabIds: [] }];
const sent = [];
let hostAccess = true;
let cookiesApiBlocked = false;
let tabCookieHeader = "";
let lastTabId = null;
let nextTab = 100;
let tabStore = "1";

globalThis.chrome = {
  storage: { local: area(), session: area() },
  runtime: { getManifest: () => ({ version: "t" }), id: "t", onMessage: event() },
  permissions: { contains: async () => hostAccess },
  tabs: {
    onUpdated: event(),
    onRemoved: event(),
    async create({ url, windowId }) {
      const id = nextTab++;
      lastTabId = id;
      stores.find((s) => s.id === tabStore).tabIds.push(id);
      return { id, windowId: windowId ?? 1, url };
    },
    async update() {},
    async remove() {},
    sendMessage(_tabId, msg, cb) {
      sent.push(msg);
      if (cb) cb();
    },
  },
  webNavigation: {
    onCommitted: event(),
    onCompleted: event(),
    onHistoryStateUpdated: event(),
    onReferenceFragmentUpdated: event(),
  },
  cookies: {
    onChanged: event(),
    async getAllCookieStores() {
      return stores;
    },
    async getAll({ domain, storeId }) {
      if (!hostAccess || cookiesApiBlocked) return [];
      return jars[storeId || "0"].filter((c) => c.domain.replace(/^\./, "").endsWith(domain));
    },
  },
  scripting: {
    async registerContentScripts() {},
    async unregisterContentScripts() {},
    async executeScript() {
      // Any script run in the board tab makes it send a request carrying its cookies.
      if (tabCookieHeader) sendTabRequest(tabCookieHeader);
      return [{ result: { localStorage: {}, sessionStorage: {}, href: "x" } }];
    },
  },
  webRequest: { onSendHeaders: event() },
};

function sendTabRequest(cookie) {
  chrome.webRequest.onSendHeaders.fire({
    tabId: lastTabId,
    url: "https://jobright.ai/swan/user/info",
    requestHeaders: [{ name: "Cookie", value: cookie }],
  });
}

console.log = () => {};
console.warn = () => {};
const mod = await import("../src/jobSiteConnect.js");
mod.attachMessageHandlers();

const SESSION = {
  slug: "jobright",
  startUrl: "https://jobright.ai/",
  verifyUrl: "https://jobright.ai/jobs/recommend",
  cookieDomains: ["jobright.ai"],
  signedInUrlPatterns: ["jobright.ai/jobs/recommend"],
  loggedOutUrlPatterns: ["/login", "/auth"],
  sessionCookieNames: ["SESSION_ID"],
};
const RECOMMEND = "https://jobright.ai/jobs/recommend?from=homepage";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = () => sent.filter((m) => m.type === "JOB_SITE_SESSION");
const session = (value) => ({ name: "SESSION_ID", value, domain: ".jobright.ai", path: "/", httpOnly: true });

function land(tabId, url) {
  chrome.tabs.onUpdated.fire(tabId, { url }, { url });
  chrome.tabs.onUpdated.fire(tabId, { status: "complete" }, { url });
}

test("a signed-in tab in a non-default cookie store (Incognito) is captured from that store", async () => {
  jars["1"].push(session("incognito"));
  const { tabId } = await mod.startConnect(SESSION, { tab: { id: 7, windowId: 9 } });
  land(tabId, RECOMMEND);
  await sleep(2100);
  assert.equal(sessions().length, 1);
  assert.deepEqual(sessions()[0].cookies.map((c) => c.value), ["incognito"]);
});

test("when chrome.cookies returns nothing, the session comes from the board tab's own Cookie header", async () => {
  sent.length = 0;
  cookiesApiBlocked = true;
  tabCookieHeader = "_ga=GA1.1; SESSION_ID=from-header";
  const { tabId } = await mod.startConnect(SESSION, { tab: { id: 7, windowId: 9 } });
  land(tabId, RECOMMEND);
  await sleep(2600);
  assert.equal(sessions().length, 1);
  const cookie = sessions()[0].cookies.find((c) => c.name === "SESSION_ID");
  assert.equal(cookie.value, "from-header");
  assert.equal(cookie.domain, ".jobright.ai");
  assert.equal(cookie.httpOnly, true);
  cookiesApiBlocked = false;
  tabCookieHeader = "";
});

test("missing host access is reported instead of asking the user to sign in again", async () => {
  sent.length = 0;
  hostAccess = false;
  const { tabId } = await mod.startConnect(SESSION, { tab: { id: 7, windowId: 9 } });
  land(tabId, RECOMMEND);
  await sleep(2900);
  assert.equal(sessions().length, 0);
  assert.ok(sent.some((m) => m.type === "JOB_SITE_CONNECT_STATUS" && m.state === "no_site_access"));
  await assert.rejects(mod.captureNow(), /Site access/);
  hostAccess = true;
});

test("a new sign-in after a captured session was rejected is captured again", async () => {
  sent.length = 0;
  jars["1"].length = 0;
  jars["1"].push(session("stale"));
  const { tabId } = await mod.startConnect(SESSION, { tab: { id: 7, windowId: 9 } });
  land(tabId, RECOMMEND);
  await sleep(2100);
  assert.equal(sessions().length, 1);

  jars["1"].length = 0;
  const fresh = session("fresh");
  jars["1"].push(fresh);
  chrome.cookies.onChanged.fire({ cookie: { ...fresh, storeId: "1" }, removed: false, cause: "explicit" });
  await sleep(2100);
  assert.equal(sessions().length, 2);
  assert.deepEqual(sessions()[1].cookies.map((c) => c.value), ["fresh"]);
  await mod.stopConnect({ silent: true, focusDashboard: false });
});
