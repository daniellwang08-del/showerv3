import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../content/engine/timers.js", import.meta.url), "utf8");

function event() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), fire: (...args) => listeners.forEach((fn) => fn(...args)) };
}

// A content-script world with fake page timers and a fake service-worker port.
function world({ hidden }) {
  const native = [];
  const posted = [];
  let port = null;
  const win = {
    setTimeout(fn, ms, ...args) {
      native.push({ fn, ms, args });
      return native.length;
    },
    clearTimeout(id) {
      if (native[id - 1]) native[id - 1].cleared = true;
    },
  };
  const chrome = {
    runtime: {
      id: "ext",
      lastError: undefined,
      connect({ name }) {
        port = { name, onMessage: event(), onDisconnect: event(), postMessage: (m) => posted.push(m) };
        return port;
      },
    },
  };
  const document = { visibilityState: hidden ? "hidden" : "visible" };
  const ctx = vm.createContext({ window: win, document, chrome, console, performance });
  vm.runInContext(SOURCE, ctx);
  return { win, native, posted, port: () => port, document };
}

test("visible pages keep the page's own timers", () => {
  const w = world({ hidden: false });
  let ran = 0;
  const id = w.win.setTimeout(() => ran++, 50);
  assert.equal(w.native.length, 1);
  assert.equal(w.native[0].ms, 50);
  assert.ok(id > 0);
  assert.equal(w.port(), null);
  w.native[0].fn();
  assert.equal(ran, 1);
});

test("hidden pages are timed by the service worker", () => {
  const w = world({ hidden: true });
  const got = [];
  const id = w.win.setTimeout((a, b) => got.push(a + b), 16, 2, 3);
  assert.ok(id < 0);
  assert.equal(w.native.length, 0);
  assert.equal(w.port().name, "af-timers");
  assert.equal(JSON.stringify(w.posted), JSON.stringify([{ id, ms: 16 }]));
  w.port().onMessage.fire({ id });
  assert.deepEqual(got, [5]);
  w.port().onMessage.fire({ id });
  assert.deepEqual(got, [5], "a timer fires once");
});

test("long timeouts stay on page timers even when hidden", () => {
  const w = world({ hidden: true });
  const id = w.win.setTimeout(() => {}, 45_000);
  assert.ok(id < 0);
  w.win.setTimeout(() => {}, 120_000);
  assert.equal(w.native.length, 1);
  assert.equal(w.native[0].ms, 120_000);
});

test("clearTimeout cancels a service-worker timer", () => {
  const w = world({ hidden: true });
  let ran = 0;
  const id = w.win.setTimeout(() => ran++, 100);
  w.win.clearTimeout(id);
  w.port().onMessage.fire({ id });
  assert.equal(ran, 0);
});

test("a dropped port finishes in-flight waits on page timers", () => {
  const w = world({ hidden: true });
  let ran = 0;
  w.win.setTimeout(() => ran++, 0);
  w.port().onDisconnect.fire();
  assert.equal(w.native.length, 1);
  w.native[0].fn();
  assert.equal(ran, 1);
  // The next hidden wait reconnects.
  w.win.setTimeout(() => ran++, 0);
  assert.equal(w.posted.length, 2);
});
