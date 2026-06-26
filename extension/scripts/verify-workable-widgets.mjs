/**
 * Verifies Workable screening-widget fixes against DOM patterns from user report.
 * Run: node extension/scripts/verify-workable-widgets.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(__dirname, "..");

function loadEngine() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "https://apply.workable.com/j/test/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.HTMLElement = window.HTMLElement;
  global.MouseEvent = window.MouseEvent;
  global.CSS = window.CSS;

  window.__AF = {
    dom: {
      clean: (s) => String(s || "").replace(/\s+/g, " ").trim(),
      textOfIds: () => "",
    },
    registerDriver: () => {},
  };

  const files = [
    "content/engine/workable.js",
    "content/engine/drivers/group.js",
  ];
  for (const f of files) {
    const code = fs.readFileSync(path.join(extRoot, f), "utf8");
    window.eval(code);
  }
  return window.__AF;
}

function ensureWorkableLocation() {
  try {
    Object.defineProperty(window.location, "hostname", {
      value: "apply.workable.com",
      configurable: true,
    });
  } catch {
    /* jsdom may freeze location */
  }
}

const TIMEZONE_HTML = `
<form data-ui="application-form">
  <div class="styles--3aPac">
    <span><span id="kMVdydwfBkQrbO5c_label"><strong>Which timezones?</strong></span></span>
    <div role="group" data-ui="QA_11653838" aria-labelledby="kMVdydwfBkQrbO5c_label">
      <label><div role="checkbox" aria-checked="false" id="cb1" aria-labelledby="kMVdydwfBkQrbO5c_label checkbox_label_cb1">
        <input aria-hidden="true" type="checkbox" name="6104341" value="us">
        <span id="checkbox_label_cb1">US</span>
      </div></label>
      <label><div role="checkbox" aria-checked="false" id="cb2">
        <input aria-hidden="true" type="checkbox" name="6104342" value="uk">
        <span id="checkbox_label_cb2">UK</span>
      </div></label>
    </div>
  </div>
</form>`;

const YESNO_HTML = `
<form data-ui="application-form">
  <div class="styles--3aPac">
    <span><span id="qYB8pMnpM8VHMDvK_label">LLM APIs?</span></span>
    <fieldset role="radiogroup" data-ui="QA_11653840" aria-labelledby="qYB8pMnpM8VHMDvK_label">
      <div role="radio" aria-checked="false" id="wrapper_yes">
        <label><input aria-hidden="true" type="radio" name="QA_11653840" value="true" id="yes_inp">
          <span id="radio_label_wrapper_yes">YES</span>
        </label>
      </div>
      <div role="radio" aria-checked="false" id="wrapper_no">
        <label><input aria-hidden="true" type="radio" name="QA_11653840" value="false" id="no_inp">
          <span id="radio_label_wrapper_no">NO</span>
        </label>
      </div>
    </fieldset>
  </div>
</form>`;

const DROPDOWN_SYNC_HTML = `
<form data-ui="application-form">
  <div data-ui="QA_11653849" data-input-type="select">
    <input role="combobox" id="input_QA_11653849_input">
    <input name="QA_11653849" aria-hidden="true" value="6104349">
  </div>
</form>`;

function oldShouldSkip(el) {
  if (el.getAttribute("aria-hidden") === "true") return true;
  return false;
}

function oldGroupByName(root, doc) {
  const t = root.type;
  const name = root.name;
  return [...doc.querySelectorAll(`input[type="${t}"]`)].filter((x) => x.name === name);
}

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("PASS:", msg);
}

function mockLayout() {
  for (const el of document.querySelectorAll("[role=checkbox], [role=radio], input")) {
    el.getBoundingClientRect = () => ({
      width: 20,
      height: 20,
      top: 0,
      left: 0,
      right: 20,
      bottom: 20,
    });
  }
}

function runCase(name, html, fn) {
  document.body.innerHTML = html;
  mockLayout();
  console.log("\n=== " + name + " ===");
  fn();
}

const AF = loadEngine();
ensureWorkableLocation();
const wb = AF.workable;

runCase("Timezone checkbox - no longer skipped", TIMEZONE_HTML, () => {
  const inp = document.querySelector('input[name="6104341"]');
  assert(oldShouldSkip(inp), "OLD: aria-hidden input was skipped (root cause #1)");
  assert(!wb.shouldSkipControl(inp), "NEW: application widget input is collected");
  assert(wb.isApplicationWidgetInput(inp), "NEW: isApplicationWidgetInput true");
});

runCase("Timezone checkbox - grouped by data-ui host", TIMEZONE_HTML, () => {
  const inp = document.querySelector('input[name="6104341"]');
  const oldGroup = oldGroupByName(inp, document);
  const newGroup = wb.applicationGroupInputs(inp);
  assert(oldGroup.length === 1, "OLD: one checkbox per unique name (root cause #2)");
  assert(newGroup.length === 2, "NEW: both checkboxes under QA_11653838 host");
  const host = wb.applicationQuestionHost(inp);
  const scope = host.closest(".styles--3aPac");
  const labelEl = scope && scope.querySelector("#kMVdydwfBkQrbO5c_label");
  assert(!!labelEl && /timezone/i.test(labelEl.textContent || ""), "DOM: question label present in scope");
  const title = wb.applicationQuestionTitleFor(inp);
  assert(title.length > 0 && /timezone/i.test(title), "NEW: question title resolved (" + title + ")");
  const opt = wb.optionLabelFor(inp);
  assert(opt === "US", "NEW: option label from checkbox_label_* span (" + opt + ")");
});

runCase("YES/NO radio - widget click updates aria-checked", YESNO_HTML, () => {
  const yesInp = document.getElementById("yes_inp");
  assert(!wb.shouldSkipControl(yesInp), "NEW: YES radio not skipped");
  const wrap = yesInp.closest('[role="radio"]');
  wrap.addEventListener("click", () => {
    wrap.setAttribute("aria-checked", "true");
    yesInp.checked = true;
    document.querySelectorAll('[role="radio"]').forEach((r) => {
      if (r !== wrap) r.setAttribute("aria-checked", "false");
    });
  });
  assert(!yesInp.checked && wrap.getAttribute("aria-checked") === "false", "pre: unchecked");
  assert(wb.activateApplicationOption(yesInp), "NEW: activateApplicationOption succeeds");
  assert(wrap.getAttribute("aria-checked") === "true", "NEW: role=radio aria-checked true (root cause #3)");
  assert(yesInp.checked, "NEW: native input checked");
});

runCase("Dropdown sync input - still skipped", DROPDOWN_SYNC_HTML, () => {
  const sync = document.querySelector('input[name="QA_11653849"]');
  assert(wb.shouldSkipControl(sync), "NEW: hidden select sync input still skipped");
  assert(!wb.isApplicationWidgetInput(sync), "NEW: not a widget input");
});

console.log("\nAll Workable widget verification checks passed.");
