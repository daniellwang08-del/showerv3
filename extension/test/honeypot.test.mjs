import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../content/engine/dom.js", import.meta.url), "utf8");

function dom() {
  const window = { scrollX: 0, scrollY: 0 };
  const ctx = vm.createContext({ window, console });
  vm.runInContext(SOURCE, ctx);
  return window.__AF.dom;
}

function input({ name = "", id = "", type = "text", rect = { left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30 }, attrs = {}, label = "" } = {}) {
  return {
    nodeType: 1,
    tagName: "INPUT",
    name,
    id,
    type,
    className: "",
    labels: label ? [{ textContent: label, innerText: label }] : [],
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    getBoundingClientRect: () => rect,
    closest: () => null,
  };
}

test("instructions telling humans to leave a field empty mark a bot trap", () => {
  const { honeypotText } = dom();
  for (const t of [
    "Leave this field empty if you are human",
    "If you are a human, do not fill in this field",
    "Humans should leave this blank",
    "Do not fill this field. For bots only.",
    "Spam protection: leave this field blank",
    "If you're human, leave this unchecked",
  ]) {
    assert.ok(honeypotText(t), t);
  }
});

test("ordinary blank-if-none hints and AI policy questions are real fields", () => {
  const { honeypotText } = dom();
  for (const t of [
    "Middle name (leave blank if none)",
    "Do not use AI to answer this question",
    "Please leave empty if not applicable",
    "Are you a human resources professional?",
    "Website",
    "",
  ]) {
    assert.ok(!honeypotText(t), t);
  }
});

test("trap names and off-screen inputs are skipped, normal inputs are not", () => {
  const { isHoneypot } = dom();
  assert.ok(isHoneypot(input({ name: "honeypot" })));
  assert.ok(isHoneypot(input({ name: "website_hp" })));
  assert.ok(isHoneypot(input({ id: "ak_hp_textarea" })));
  assert.ok(isHoneypot(input({ rect: { left: -9999, top: 10, right: -9799, bottom: 40, width: 200, height: 30 } })));
  assert.ok(!isHoneypot(input({ attrs: { "aria-hidden": "true", tabindex: "-1" } })), "react-select's required shim");
  assert.ok(!isHoneypot(input({ name: "first_name" })));
  assert.ok(!isHoneypot(input({ name: "phone" })));
  assert.ok(!isHoneypot(input({ name: "resume", type: "file", rect: { left: -9999, top: 0, right: -9998, bottom: 1, width: 1, height: 1 } })));
});
