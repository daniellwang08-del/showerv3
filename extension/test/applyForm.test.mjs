import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { APPLY_ATTR, APPLY_TEXT, MIN_FORM_FIELDS, NOT_APPLY_TEXT, isApplyText, probeApplyPage, reachApplicationForm } from "../src/applyForm.js";
import { CLOSED_UNSUBMITTED, closedWithoutSubmit } from "../src/autoapply/model.js";

const RULES = { applyText: APPLY_TEXT, notApplyText: NOT_APPLY_TEXT, applyAttr: APPLY_ATTR, minFields: MIN_FORM_FIELDS };

test("apply button text", () => {
  for (const t of ["Apply now", "APPLY", "Apply for this job", "Apply to this position", "Start application", "I'm interested"]) {
    assert.ok(isApplyText(t), t);
  }
  for (const t of ["Apply with LinkedIn", "Submit application", "Share job", "Applying tips", "Sign in to apply", ""]) {
    assert.ok(!isApplyText(t), t);
  }
});

// ── a tiny DOM for the in-page probe ────────────────────────────────────────

function el(tag, { text = "", attrs = {}, visible = true, inside = [] } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    value: attrs.value || "",
    name: attrs.name || "",
    id: attrs.id || "",
    placeholder: attrs.placeholder || "",
    className: attrs.class || "",
    disabled: false,
    visible,
    clicks: 0,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getBoundingClientRect: () => (node.visible ? { width: 100, height: 20 } : { width: 0, height: 0 }),
    closest: (sel) => (inside.some((s) => sel.includes(s)) ? {} : null),
    scrollIntoView() {},
    click() {
      node.clicks += 1;
    },
  };
  return node;
}

function page({ fields = [], controls = [], fileInForm = false, href = "https://jobs.workable.com/view/abc/role" } = {}) {
  globalThis.location = { href };
  globalThis.getComputedStyle = (n) => ({ display: n.visible ? "block" : "none", visibility: "visible" });
  globalThis.document = {
    querySelectorAll: (sel) => (sel.startsWith("input:not") ? fields : controls),
    querySelector: (sel) => (sel === "form input[type=file]" && fileInForm ? {} : null),
  };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.getComputedStyle;
});

const inputs = (n) => Array.from({ length: n }, (_, i) => el("input", { attrs: { name: `f${i}` } }));

test("a Workable listing: clicks Apply now", () => {
  const apply = el("button", { text: "Apply now", attrs: { "data-ui": "overview-apply-now" } });
  const share = el("button", { text: "Share job" });
  page({ controls: [share, apply] });
  const out = probeApplyPage(RULES, true);
  assert.deepEqual({ ready: out.ready, clicked: out.clicked, label: out.label }, { ready: false, clicked: true, label: "apply now" });
  assert.equal(apply.clicks, 1);
  assert.equal(share.clicks, 0);
});

test("an application form is ready and nothing is clicked", () => {
  const apply = el("button", { text: "Apply now" });
  page({ fields: inputs(5), controls: [apply] });
  assert.equal(probeApplyPage(RULES, true).ready, true);
  assert.equal(apply.clicks, 0);
});

test("a resume upload with one field counts as a form", () => {
  page({ fields: inputs(1), fileInForm: true });
  assert.equal(probeApplyPage(RULES, false).ready, true);
});

test("search boxes, header fields and hidden inputs do not make a form", () => {
  page({
    fields: [
      el("input", { attrs: { name: "q", placeholder: "Search jobs" } }),
      el("input", { attrs: { name: "email" }, inside: ["footer"] }),
      el("input", { attrs: { name: "x" }, visible: false }),
    ],
  });
  assert.equal(probeApplyPage(RULES, false).ready, false);
});

test("an apply link is returned to load in the same tab", () => {
  const link = el("a", { text: "Apply for this job", attrs: { href: "/acme/j/ABC/apply/", target: "_blank" } });
  page({ controls: [link], href: "https://apply.workable.com/acme/j/ABC/" });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.href, "https://apply.workable.com/acme/j/ABC/apply/");
  assert.equal(link.clicks, 0);
});

test("sign-in and third-party apply buttons are left alone", () => {
  const linkedin = el("button", { text: "Apply with LinkedIn" });
  page({ controls: [linkedin] });
  const out = probeApplyPage(RULES, true);
  assert.equal(out.clicked, undefined);
  assert.equal(linkedin.clicks, 0);
});

test("probe without act never clicks", () => {
  const apply = el("button", { text: "Apply" });
  page({ controls: [apply] });
  probeApplyPage(RULES, false);
  assert.equal(apply.clicks, 0);
});

// ── the tab loop ────────────────────────────────────────────────────────────

function chromeWith(script) {
  const calls = [];
  globalThis.chrome = {
    scripting: {
      async executeScript({ args }) {
        calls.push(args[1] ? "act" : "probe");
        const next = script.shift();
        return next ? [{ result: next }] : [];
      },
    },
    tabs: {
      get: async (id) => ({ id, url: "https://jobs.workable.com/view/abc", status: "complete" }),
      update: async () => {},
      remove: async () => {},
      onCreated: { addListener() {}, removeListener() {} },
    },
  };
  return calls;
}

test("clicks through to the form, then reports it ready", async () => {
  const calls = chromeWith([{ ready: false }, { ready: false, clicked: true, label: "apply now" }, { ready: true }, { ready: true }]);
  const steps = [];
  const out = await reachApplicationForm(1, { onStep: (m) => steps.push(m), waitMs: 3000 });
  assert.equal(out.ready, true);
  assert.deepEqual(out.steps, ["apply now"]);
  assert.deepEqual(calls.slice(0, 3), ["probe", "act", "probe"]);
  assert.match(steps[0], /apply now/);
});

test("a background tab that does not show the form is brought forward once", async () => {
  const notYet = Array.from({ length: 5 }, () => ({ ready: false }));
  chromeWith([{ ready: false }, { ready: false, clicked: true, label: "apply now" }, ...notYet, { ready: true }, { ready: true }]);
  const focused = [];
  const out = await reachApplicationForm(7, { waitMs: 10_000, focus: (id) => focused.push(id) });
  assert.equal(out.ready, true);
  assert.deepEqual(focused, [7]);
});

test("a page that is already a form is left as it is", async () => {
  const calls = chromeWith([{ ready: true }]);
  const out = await reachApplicationForm(1);
  assert.equal(out.ready, true);
  assert.deepEqual(out.steps, []);
  assert.deepEqual(calls, ["probe"]);
});

test("no form and no apply button: not ready, nothing clicked", async () => {
  chromeWith([{ ready: false }, { ready: false }]);
  const out = await reachApplicationForm(1);
  assert.equal(out.ready, false);
  assert.deepEqual(out.steps, []);
});

// ── closing a tab without submitting ────────────────────────────────────────

test("closing a waiting tab moves the job to apply later", () => {
  for (const status of ["needs_you", "filled", "failed"]) {
    const next = closedWithoutSubmit({ status, tabOpen: true, title: "Engineer" }, 5);
    assert.deepEqual(next, { status: "later", tabOpen: false, title: "Engineer", message: CLOSED_UNSUBMITTED, at: 5 });
  }
  for (const status of ["applied", "invalid", "later", "skipped"]) {
    assert.equal(closedWithoutSubmit({ status, tabOpen: true }), null, status);
  }
});
