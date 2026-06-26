// Workday engine - DOM primitives (isolated-world content script).
//
// Workday renders every input with a stable `data-automation-id` and uses
// React-controlled inputs + custom listbox dropdowns. These helpers fill those
// reliably: React-safe text setting, custom-dropdown open+pick-by-text, native
// <select> with option-population wait, checkbox/radio toggle, and CSS/XPath
// query + wait. Namespaced under window.__WD so the engine/steps can share them.
(() => {
  // Always (re)install: executeScript re-runs this file on every Start, and we
  // want a freshly-updated extension to take effect WITHOUT a manual page reload.
  // dom is a pure helper namespace (no listeners/state), so overwriting is safe.
  const WD = (window.__WD = window.__WD || {});

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function xpath(expr, root) {
    try {
      const res = document.evaluate(expr, root || document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return res.singleNodeValue;
    } catch {
      return null;
    }
  }
  function xpathAll(expr, root) {
    const out = [];
    try {
      const res = document.evaluate(expr, root || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
    } catch {}
    return out;
  }

  // A "selector" is CSS unless it starts with // or ( (then it's XPath).
  function isXpath(sel) {
    return typeof sel === "string" && (sel.startsWith("//") || sel.startsWith("(") || sel.startsWith("./"));
  }
  function q(selector, root) {
    root = root || document;
    if (!selector) return null;
    if (isXpath(selector)) return xpath(selector, root);
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }
  function qa(selector, root) {
    root = root || document;
    if (!selector) return [];
    if (isXpath(selector)) return xpathAll(selector, root);
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  }

  async function waitFor(selector, timeout = 4000, root) {
    const end = Date.now() + timeout;
    for (;;) {
      const el = q(selector, root);
      if (el && isVisible(el)) return el;
      if (Date.now() > end) return null;
      await delay(80);
    }
  }

  // React-controlled inputs ignore a plain `el.value = x`; set through the
  // native prototype setter and dispatch input/change so React's onChange fires.
  function nativeSet(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function setText(selector, value, root) {
    if (value == null || value === "") return false;
    const el = await waitFor(selector, 3000, root);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    nativeSet(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    nativeSet(el, String(value));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value) }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  async function click(selector, root) {
    const el = await waitFor(selector, 3000, root);
    if (!el) return false;
    clickEl(el);
    return true;
  }
  function clickEl(el) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      el.click();
    } catch {}
  }

  async function toggle(selector, on, root) {
    const el = await waitFor(selector, 3000, root);
    if (!el) return false;
    const checked = el.checked === true || el.getAttribute("aria-checked") === "true";
    if (!!on !== checked) clickEl(el);
    return true;
  }

  const OPTION_SEL = '[data-automation-id="promptOption"], [role="option"], li[role="option"]';
  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function optionText(o) {
    return norm(o.innerText || o.textContent);
  }

  // Workday custom dropdown: click the base to open the listbox, then click the
  // option whose text matches `value` (exact, then contains). For searchable
  // inputs, type-to-filter if no option matched.
  async function selectDropdown(baseSelector, value, root) {
    if (value == null || value === "") return false;
    const base = await waitFor(baseSelector, 3000, root);
    if (!base) return false;
    clickEl(base);
    const ready = await waitFor(OPTION_SEL, 2500);
    if (!ready) return false;
    await delay(120);
    const want = norm(value);
    const pick = () => {
      const opts = qa(OPTION_SEL).filter(isVisible);
      return (
        opts.find((o) => optionText(o) === want) ||
        opts.find((o) => optionText(o).includes(want)) ||
        opts.find((o) => want.includes(optionText(o)) && optionText(o))
      );
    };
    let match = pick();
    if (!match) {
      const input = base.matches("input") ? base : base.querySelector("input");
      if (input) {
        nativeSet(input, String(value));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await delay(400);
        match = pick();
      }
    }
    if (match) {
      clickEl(match);
      await delay(120);
      return true;
    }
    return false;
  }

  // Native <select>; wait for async-populated options, then select by text.
  async function selectNative(selector, value, root) {
    if (value == null || value === "") return false;
    const el = await waitFor(selector, 3000, root);
    if (!el || el.tagName !== "SELECT") return false;
    for (let i = 0; i < 20 && el.options.length < 2; i++) await delay(100);
    const want = norm(value);
    const opt =
      [...el.options].find((o) => norm(o.text) === want) ||
      [...el.options].find((o) => norm(o.text).includes(want));
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Attach a downloaded file (base64) to an <input type=file> via DataTransfer.
  async function attachFile(selector, file, root) {
    if (!file || !file.base64) {
      try { WD.warn("attachFile: no file/base64 provided"); } catch {}
      return false;
    }
    // A native file <input> is almost ALWAYS visually hidden (a styled dropzone
    // is shown instead), so we must match by PRESENCE - not visibility. The
    // visibility-gated waitFor/exists never return it.
    let el = null;
    const end = Date.now() + 8000;
    for (;;) {
      const cand = q(selector, root);
      if (cand && cand.tagName === "INPUT" && cand.type === "file") {
        el = cand;
        break;
      }
      if (Date.now() > end) break;
      await delay(100);
    }
    if (!el) {
      try { WD.warn("attachFile: file input not found for", selector); } catch {}
      return false;
    }
    try {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const f = new File([bytes], file.filename || "resume.pdf", {
        type: file.mime || "application/octet-stream",
      });
      const dt = new DataTransfer();
      dt.items.add(f);
      el.files = dt.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      try { WD.warn("attachFile: exception", (e && e.message) || e); } catch {}
      return false;
    }
  }

  function exists(selector, root) {
    const el = q(selector, root);
    return !!(el && isVisible(el));
  }
  function headingHas(text) {
    const t = norm(text);
    return [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].some(
      (h) => isVisible(h) && norm(h.textContent).includes(t)
    );
  }

  // Informational traces use console.debug so chrome://extensions → Errors stays
  // clean. Reserve console.warn for attach failures and other real problems.
  function wdLog(...args) {
    try {
      console.debug("[workday]", ...args);
    } catch {}
  }
  function wdWarn(...args) {
    try {
      console.warn("[workday]", ...args);
    } catch {}
  }

  WD.dom = {
    delay, xpath, xpathAll, q, qa, isVisible, waitFor, nativeSet,
    setText, click, clickEl, toggle, selectDropdown, selectNative, attachFile, exists, headingHas, norm,
  };
  WD.log = wdLog;
  WD.warn = wdWarn;
})();
