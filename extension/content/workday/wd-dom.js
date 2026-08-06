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

  // Cooperative abort: Stop bumps WD.epoch (+ sets WD.aborted). Each delay captures
  // epoch at call time so in-flight waits exit even if a later WD_RUN clears aborted.
  function delay(ms) {
    const epochAtCall = WD.epoch || 0;
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (WD.aborted || (WD.epoch || 0) !== epochAtCall) {
          const err = new Error("WD_ABORTED");
          err.name = "WDAborted";
          reject(err);
          return;
        }
        const left = ms - (Date.now() - start);
        if (left <= 0) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(80, left));
      };
      tick();
    });
  }

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
    const epochAtCall = WD.epoch || 0;
    for (;;) {
      if (WD.aborted || (WD.epoch || 0) !== epochAtCall) {
        const err = new Error("WD_ABORTED");
        err.name = "WDAborted";
        throw err;
      }
      const el = q(selector, root);
      if (el && isVisible(el)) return el;
      if (Date.now() > end) return null;
      await delay(80);
    }
  }

  // React-controlled inputs ignore a plain `el.value = x`; set through the
  // native prototype setter and dispatch input/change so React's onChange fires.
  function nativeSet(el, value) {
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") desc.set.call(el, value);
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
  //
  // Success must be judged BEFORE Workday's change handlers run (and/or by the
  // caller waiting for a file-upload-item). Proven false-negative: Zillow WD
  // clears input.files synchronously inside the change handler after accepting
  // the File, so reading el.files AFTER dispatch reported "none" while the
  // resume row was already on screen → "1 to check" / missed Resume upload.
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
      const name = file.filename || "resume.pdf";
      const mime =
        file.mime ||
        (/\.pdf$/i.test(name) ? "application/pdf" : "application/octet-stream");
      const f = new File([bytes], name, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(f);
      try {
        el.files = dt.files;
      } catch {}
      // Some hosts reject direct assignment; defineProperty still sticks a FileList.
      if (!(el.files && el.files.length)) {
        try {
          Object.defineProperty(el, "files", { value: dt.files, configurable: true });
        } catch {}
      }
      // Ground truth: assignment stuck BEFORE events (handlers often clear files).
      const assigned = !!(el.files && el.files.length);
      const assignedName = assigned ? el.files[0].name : "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Some Workday tenants only commit after a bubbling InputEvent as well.
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
      } catch {}
      const after = !!(el.files && el.files.length);
      try {
        WD.log(
          "attachFile: set files=",
          assigned ? assignedName : "none",
          "afterEvents=",
          after ? el.files[0].name : "cleared",
          "mime=",
          mime,
          "bytes=",
          bytes.length,
        );
      } catch {}
      return assigned;
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
  // Progress-rail / stepper labels often use role="heading" and still say
  // "My Information" on later pages — that must not win step detection.
  function inProgressChrome(el) {
    return !!(
      el &&
      el.closest &&
      el.closest(
        [
          '[data-automation-id*="progress" i]',
          '[data-automation-id*="stepper" i]',
          '[data-automation-id*="Progress" i]',
          "nav",
          '[role="navigation"]',
          '[aria-label*="progress" i]',
        ].join(",")
      )
    );
  }

  function applyFlowRoot() {
    return (
      q('[data-automation-id="applyFlowPage"]') ||
      q("main") ||
      q('[role="main"]') ||
      document.body
    );
  }

  // Visible page title outside the progress rail (e.g. "Application Questions 2 of 2").
  function pageHeadingText() {
    const root = applyFlowRoot();
    if (!root) return "";
    const pick = (sel) => {
      for (const h of root.querySelectorAll(sel)) {
        if (!isVisible(h) || inProgressChrome(h)) continue;
        const t = (h.textContent || "").replace(/\s+/g, " ").trim();
        if (t) return t;
      }
      return "";
    };
    return pick("h1, h2, h3") || pick('[role="heading"]') || "";
  }

  // Text of the heading that CONTAINS `needle` (not merely the first heading on
  // the page). CrowdStrike puts the job title in an earlier h1/h2; the step title
  // "Application Questions 2 of 2" is a later heading. Using pageHeadingText() for
  // N-of-M parsing therefore collapsed both AQ pages to step id "questions".
  function pageHeadingContaining(needle) {
    const t = norm(needle);
    if (!t) return "";
    const root = applyFlowRoot();
    if (!root) return "";
    const find = (sel) => {
      for (const h of root.querySelectorAll(sel)) {
        if (!isVisible(h) || inProgressChrome(h)) continue;
        const raw = (h.textContent || "").replace(/\s+/g, " ").trim();
        if (raw && norm(raw).includes(t)) return raw;
      }
      return "";
    };
    return find("h1, h2, h3") || find('[role="heading"]') || "";
  }

  function pageHeadingHas(text) {
    return !!pageHeadingContaining(text);
  }

  // Use console.info (not console.debug): Chrome DevTools hides Verbose/Debug by
  // default. WD.aa() is the auto-advance step tracer — always stringified + mirrored
  // to the Atomspace Debug log so investigation does not depend on page DevTools.
  let aaSeq = 0;
  let lastDetectLog = { step: null, at: 0 };

  function safeJson(v) {
    try {
      return JSON.stringify(v);
    } catch {
      try {
        return String(v);
      } catch {
        return "[unserializable]";
      }
    }
  }

  function mirrorAaLine(line) {
    try {
      chrome.runtime.sendMessage({ type: "WD_AA_LOG", line: String(line || "").slice(0, 1200), t: Date.now() });
    } catch {}
  }

  /** Auto-advance / fill step tracer. Always visible in console + side-panel Debug log. */
  function aa(tag, data) {
    aaSeq += 1;
    const payload = data === undefined ? undefined : data;
    const line =
      `[AA] #${aaSeq} ${tag}` + (payload !== undefined ? " " + safeJson(payload) : "");
    try {
      console.info("[workday]", line);
    } catch {}
    mirrorAaLine(line);
    return aaSeq;
  }

  function wdLog(...args) {
    try {
      const line = args
        .map((a) => (typeof a === "string" ? a : safeJson(a)))
        .join(" ");
      console.info("[workday]", line);
      // Mirror anything tagged [AA] (legacy call sites) into the panel Debug log.
      if (typeof args[0] === "string" && args[0].indexOf("[AA]") !== -1) {
        mirrorAaLine(line);
      }
    } catch {}
  }
  function wdWarn(...args) {
    try {
      const line = args
        .map((a) => (typeof a === "string" ? a : safeJson(a)))
        .join(" ");
      console.warn("[workday]", line);
      mirrorAaLine("[WARN] " + line);
    } catch {}
  }

  WD.dom = {
    delay, xpath, xpathAll, q, qa, isVisible, waitFor, nativeSet,
    setText, click, clickEl, toggle, selectDropdown, selectNative, attachFile,
    exists, headingHas, pageHeadingHas, pageHeadingText, pageHeadingContaining, norm,
  };
  WD.log = wdLog;
  WD.warn = wdWarn;
  WD.aa = aa;
  WD._aaSeq = () => aaSeq;
  WD._aaLastDetectLog = lastDetectLog;
})();
