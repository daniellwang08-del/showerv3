import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { readSse } = await import("../src/api.js");
const { LISTS, listQuery } = await import("../src/panel/lists.js");

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
