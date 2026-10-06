import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const storage = await import("../src/storage.js");

test("preferences are normalized on save", async () => {
  assert.equal(await storage.savePref("pageSize", 999), storage.PAGE_SIZES[0]);
  assert.equal(await storage.savePref("pageSize", 50), 50);
  assert.equal(await storage.savePref("chatStyle", "loud"), "standard");
  assert.equal(await storage.savePref("dailyApplyTarget", 500), 200);
  const prefs = await storage.loadPrefs();
  assert.equal(prefs.pageSize, 50);
  assert.equal("resumeSource" in prefs, false);
});

test("unknown preferences are rejected", async () => {
  await assert.rejects(() => storage.savePref("nope", 1));
  // Résumé source is an account setting (web Preferences), not a panel pref.
  await assert.rejects(() => storage.savePref("resumeSource", "original"));
});

test("server address normalizes to an origin", () => {
  assert.equal(storage.normalizeBackendUrl("https://nao.it.com/api/v1/"), "https://nao.it.com");
  assert.equal(storage.normalizeBackendUrl("localhost:8000"), "http://localhost:8000");
});

test("a manual server address wins", async () => {
  await storage.setManualBackendUrl("http://127.0.0.1:8000");
  assert.equal(await storage.getBackendUrl(), "http://127.0.0.1:8000");
  assert.equal(await storage.setBackendUrl("https://nao.it.com"), false);
  await storage.setManualBackendUrl(null);
});

test("hotkey formatting has no symbols", () => {
  const label = storage.formatAskHotkey({ ctrl: true, shift: true, alt: false, meta: false, key: "k" });
  assert.match(label, /^[A-Za-z+ ]+$/);
  assert.ok(label.includes("Ctrl"));
  assert.ok(label.endsWith("K"));
});

test("legacy job catalog keys are dropped", async () => {
  await chrome.storage.local.set({ jobsCatalog_u1: [1], jobsCatalogMeta_u1: {}, keep: 1 });
  await storage.dropLegacyCatalog();
  const all = await chrome.storage.local.get(null);
  assert.deepEqual(Object.keys(all).filter((k) => k.startsWith("jobsCatalog")), []);
  assert.equal(all.keep, 1);
});
