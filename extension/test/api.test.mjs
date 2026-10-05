import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const api = await import("../src/api.js");
const storage = await import("../src/storage.js");
const { readSse } = api;
const { LISTS, listQuery } = await import("../src/panel/lists.js");

/** Replace fetch with a single canned response and record the requests. */
function stubFetch(status, body, headers = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(body == null ? null : JSON.stringify(body), { status, headers });
  };
  return calls;
}

test("a pending-approval 403 signs out and surfaces the server reason", async () => {
  await storage.setToken("tok");
  let reason;
  api.onUnauthorized((r) => (reason = r));
  stubFetch(403, { detail: "Your account is waiting for admin approval." }, { "X-Auth-Status": "pending" });
  await assert.rejects(api.getProfile(), (err) => err.status === 403 && err.kind === "auth");
  assert.equal(reason, "Your account is waiting for admin approval.");
  assert.equal(await storage.getToken(), null);
});

test("an ordinary 403 keeps the session", async () => {
  await storage.setToken("tok");
  let called = false;
  api.onUnauthorized(() => (called = true));
  stubFetch(403, { detail: "Available to applicant accounts only" });
  await assert.rejects(api.getProfile(), (err) => err.status === 403 && err.kind === "http");
  assert.equal(called, false);
  assert.equal(await storage.getToken(), "tok");
});

test("a declined signup 401 passes its reason; a plain 401 does not", async () => {
  await storage.setToken("tok");
  let reason = "unset";
  api.onUnauthorized((r) => (reason = r));
  stubFetch(401, { detail: "Your signup request was declined." }, { "X-Auth-Status": "rejected" });
  await assert.rejects(api.getProfile(), /declined/);
  assert.equal(reason, "Your signup request was declined.");

  await storage.setToken("tok");
  stubFetch(401, { detail: "Invalid token" });
  await assert.rejects(api.getProfile(), /session expired/);
  assert.equal(reason, null);
});

test("logout revokes the token on the server, then forgets it", async () => {
  await storage.setToken("tok-123");
  const calls = stubFetch(200, { message: "Logged out successfully" });
  await api.logout();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/auth\/logout$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok-123");
  assert.equal(await storage.getToken(), null);
});

test("logout still signs out locally when the server is unreachable", async () => {
  await storage.setToken("tok");
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  await api.logout();
  assert.equal(await storage.getToken(), null);
});

function streamOf(chunks) {
  const enc = new TextEncoder();
  return {
    body: new ReadableStream({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(enc.encode(c));
        ctrl.close();
      },
    }),
  };
}

test("readSse parses frames split across chunks", async () => {
  const frames = [];
  await readSse(streamOf(['data: {"delta":"Hel', 'lo"}\n\ndata: {"delta":" world"}\n', '\ndata: not json\n\ndata: {"done":true}']), (f) => frames.push(f));
  assert.deepEqual(frames, [{ delta: "Hello" }, { delta: " world" }, { done: true }]);
});

test("list queries map to server views", () => {
  const q = listQuery("remote", { q: "  react ", sort: "", remoteOnly: false, minScore: 65 }, 2, 25, "UTC");
  assert.equal(q.view, "all");
  assert.equal(q.remote_only, true);
  assert.equal(q.q, "react");
  assert.equal(q.min_match_score, 65);
  assert.equal(q.page, 2);
  assert.equal(q.sort, "created_at");

  const ready = listQuery("ready", { q: "", sort: "", remoteOnly: false, minScore: 0 }, 1, 25, "UTC");
  assert.equal(ready.view, "ready");
  assert.equal(ready.sort, "match_score");
  assert.equal(ready.min_match_score, undefined);
  assert.equal(ready.q, undefined);

  const company = listQuery("all", { q: "", sort: "company", remoteOnly: false, minScore: 0 }, 1, 25, "UTC");
  assert.equal(company.order, "asc");
});

test("every list has copy and a count key", () => {
  for (const [id, def] of Object.entries(LISTS)) {
    assert.ok(def.title && def.hint && def.empty, id);
    assert.ok(def.count, id);
  }
});
