// Autofill engine - shared DOM utilities + driver registry.
//
// This is the FIRST engine file injected into every frame. It bootstraps the
// `window.__AF` namespace that all driver modules and the engine core register
// into. Classic content scripts injected via chrome.scripting share one
// ISOLATED world, so this namespace is how the modular pieces find each other.
//
// Idempotent: re-injection re-runs every file, so this guard keeps the existing
// namespace (and any in-flight control registry) intact.
(() => {
  if (window.__AF && window.__AF.dom) return;
  const AF = (window.__AF = window.__AF || {});

  // ── driver registry ──────────────────────────────────────────────────────
  // Drivers self-register here. Registration is idempotent (dedup by `type`) so
  // a re-injected driver file replaces rather than duplicates its entry.
  AF.drivers = AF.drivers || [];
  AF.registerDriver = function registerDriver(driver) {
    if (!driver || !driver.type) return;
    const i = AF.drivers.findIndex((d) => d.type === driver.type);
    if (i >= 0) AF.drivers[i] = driver;
    else AF.drivers.push(driver);
  };
  // Drivers ordered most-specific first (lower priority number wins a match).
  AF.orderedDrivers = function orderedDrivers() {
    return AF.drivers.slice().sort((a, b) => (a.priority || 100) - (b.priority || 100));
  };

  // ── text helpers ───────────────────────────────────────────────────────────
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // Normalize text for option matching: fold "smart" punctuation (curly quotes,
  // en/em dashes, NBSP, ellipsis) to ASCII so a live option like
  // "I haven’t used it" matches the plain-ASCII value coming back from the LLM.
  function normText(s) {
    return (s || "")
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2012\u2212]/g, "-")
      .replace(/[\u2026]/g, "...")
      .replace(/[\u00A0\u2007\u202F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Poll until fn() returns truthy or the timeout elapses. Custom widgets render
  // asynchronously, so fixed delays are unreliable.
  async function waitUntil(fn, timeout = 1200, step = 60) {
    const start = Date.now();
    for (;;) {
      let r = null;
      try {
        r = fn();
      } catch {}
      if (r) return r;
      if (Date.now() - start >= timeout) return null;
      await delay(step);
    }
  }

  // ── value setters (React-safe) ─────────────────────────────────────────────
  // React 15.6+ installs an instance value setter + `_valueTracker` so it can
  // de-dupe input/change events (facebook/react#10135, #11488). Setting
  // `el.value = x` (or only firing Event("input")) often updates the DOM while
  // leaving React state empty - Ashby then shows "Missing entry for required
  // field: Email" on submit even though the input still displays the address.
  // Proven fix used by Workday/Workable in this repo and by the React issue
  // workarounds: write via the native prototype setter, rewind `_valueTracker`
  // to the previous value, dispatch InputEvent("input") + change, then blur /
  // focusout so commit-on-blur forms record the field.
  function valueProto(el) {
    if (!el) return null;
    if (el.tagName === "TEXTAREA") return window.HTMLTextAreaElement.prototype;
    if (el.tagName === "SELECT") return window.HTMLSelectElement.prototype;
    return window.HTMLInputElement.prototype;
  }

  function setNativeValue(el, value) {
    const valueStr = value == null ? "" : String(value);
    const proto = valueProto(el);
    let protoSetter = null;
    let ownSetter = null;
    try {
      const own = Object.getOwnPropertyDescriptor(el, "value");
      if (own && typeof own.set === "function") ownSetter = own.set;
    } catch {}
    try {
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && typeof desc.set === "function") protoSetter = desc.set;
    } catch {}
    // Prefer the prototype setter when React overrode the instance descriptor
    // (stackoverflow.com/questions/40894637 / react#10135).
    if (protoSetter && ownSetter && ownSetter !== protoSetter) {
      protoSetter.call(el, valueStr);
    } else if (protoSetter) {
      protoSetter.call(el, valueStr);
    } else if (ownSetter) {
      ownSetter.call(el, valueStr);
    } else {
      el.value = valueStr;
    }
  }

  function fireInput(el, data) {
    const v = data != null ? String(data) : el && el.value;
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: v == null ? "" : String(v),
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Write a text/textarea value so a controlled React form (Ashby, etc.) updates
  // its state - not just the visible DOM. Prefers the MAIN-world page bridge
  // (page-bridge.js) so `_valueTracker` / `__reactProps$` are the page's real
  // React objects; falls back to the isolated-world path when the bridge is
  // absent. Returns true when a write was attempted.
  function setReactTextValue(el, value) {
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
    const v = value == null ? "" : String(value);

    // 1) MAIN-world bridge (synchronous listener during dispatchEvent).
    try {
      el.removeAttribute("data-af-page-set");
      el.dispatchEvent(
        new CustomEvent("__af_page_set", {
          bubbles: true,
          cancelable: true,
          detail: { value: v, kind: "text" },
        })
      );
      const bridged = el.getAttribute("data-af-page-set");
      el.removeAttribute("data-af-page-set");
      if (bridged === "ok") return true;
    } catch {}

    // 2) Isolated-world fallback (still better than a bare el.value write).
    let focused = false;
    try {
      el.focus({ preventScroll: true });
      focused = document.activeElement === el;
    } catch {}
    const lastValue = el.value;
    setNativeValue(el, v);
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === "function") {
      tracker.setValue(lastValue === v ? (v === "" ? "__af__" : "") : lastValue);
    }
    fireInput(el, v);
    if (focused) {
      try {
        el.blur();
      } catch {}
    } else {
      try {
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new FocusEvent("blur", { bubbles: false, cancelable: true }));
      } catch {}
    }
    return true;
  }

  // SELECT via MAIN-world bridge when available (Ashby EEO / custom selects).
  function setReactSelectValue(el, value) {
    if (!el || el.tagName !== "SELECT") return false;
    const v = value == null ? "" : String(value);
    try {
      el.removeAttribute("data-af-page-set");
      el.dispatchEvent(
        new CustomEvent("__af_page_set", {
          bubbles: true,
          cancelable: true,
          detail: { value: v, kind: "select" },
        })
      );
      const bridged = el.getAttribute("data-af-page-set");
      el.removeAttribute("data-af-page-set");
      if (bridged === "ok") return true;
    } catch {}
    return false;
  }

  // Force a controlled-React input to register its CURRENT DOM value (or an
  // explicit forcedValue snapshot). Used after browser autofill and as an
  // Ashby safety net: committing field A can re-render and wipe sibling DOMs
  // that were only visually filled, so callers should snapshot first.
  // No-ops when the effective value is empty. Returns true if it committed.
  function commitReactValue(el, forcedValue) {
    try {
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
      const v = forcedValue != null ? String(forcedValue) : el.value;
      if (v == null || v === "") return false;
      return setReactTextValue(el, v);
    } catch {
      return false;
    }
  }

  // ── label resolution ───────────────────────────────────────────────────────
  function textOfIds(ids) {
    if (!ids) return "";
    try {
      const parts = ids
        .split(/\s+/)
        .map((id) => {
          const ref = id && document.getElementById(id);
          return ref ? clean(ref.innerText) : "";
        })
        .filter(Boolean);
      return parts.join(" ");
    } catch {
      return "";
    }
  }

  // True when a shadow-piercing platform (SmartRecruiters) is active. Set by the
  // picker once its form is detected; absent/false for every other engine, so
  // the SmartRecruiters-specific branches below are inert elsewhere.
  function deepActive() {
    try {
      return typeof AF.deepCollect === "function" && AF.deepCollect();
    } catch {
      return false;
    }
  }

  // Climb out of nested shadow roots to find the nearest ancestor element for
  // which test() is truthy. A control's real host chain (SmartRecruiters' spl-*
  // and oc-* wrappers) lives in light DOM OUTSIDE the shadow root the control
  // sits in; normal parentElement stops at the shadow boundary, so we hop across
  // it via each ShadowRoot's .host.
  function climbHosts(el, test, max) {
    let node = el;
    for (let i = 0; node && i < (max || 16); i++) {
      if (node.nodeType === 1) {
        try {
          if (test(node)) return node;
        } catch {}
      }
      const parent = node.parentNode;
      if (parent && parent.nodeType === 11 && parent.host) node = parent.host;
      else node = node.parentNode;
    }
    return null;
  }

  // SmartRecruiters: the human label is a `label="First name"` attribute on the
  // spl-* shadow host wrapping the control (spl-input / spl-textarea /
  // spl-date-field / spl-autocomplete). Climb across shadow boundaries to it.
  function srLabel(inp) {
    const host = climbHosts(inp, (n) => n.hasAttribute && n.hasAttribute("label") && clean(n.getAttribute("label")));
    return host ? clean(host.getAttribute("label")) : "";
  }

  function labelForControl(inp) {
    if (!inp) return "";
    if (deepActive()) {
      const sr = srLabel(inp);
      if (sr) return sr.slice(0, 200);
    }
    // iCIMS: label[for] resolves on its own, but repeating collections reuse
    // plain names - BOTH the Phones and Addresses groups ship a required "Type"
    // dropdown - so the label must be qualified with its collection to stay
    // unambiguous. Runs before the generic label[for] lookup for that reason.
    try {
      if (AF.icims && AF.icims.isIcimsPage && AF.icims.isIcimsPage()) {
        const q = AF.icims.questionTitleFor && AF.icims.questionTitleFor(inp);
        if (q) return q.slice(0, 200);
      }
    } catch {}
    if (inp.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
        // Skip visually-hidden helper labels ("Attach") in favor of richer sources.
        if (l && clean(l.innerText) && !/visually-hidden/.test(l.className || "")) {
          return clean(l.innerText).slice(0, 200);
        }
      } catch {}
    }
    // Pinpoint: boolean option text lives in a sibling .checkable-input__label (no
    // label[for]); the question title is resolved separately via groupLabel /
    // questionTitleFor.
    try {
      const ci = inp.closest && inp.closest(".checkable-input");
      if (ci) {
        const ol = ci.querySelector(".checkable-input__label");
        if (ol && clean(ol.textContent)) return clean(ol.textContent).slice(0, 200);
      }
    } catch {}
    // Pinpoint: react-select / text questions use .external-form__label--title or a
    // hidden [title] metadata field inside the question block.
    try {
      if (AF.pinpoint && AF.pinpoint.questionTitleFor) {
        const q = AF.pinpoint.questionTitleFor(inp);
        if (q) return q.slice(0, 200);
      }
    } catch {}
    // Lever: question text lives in .application-label (no label[for]); checkbox
    // option text is in .application-answer-alternative (handled below for inputs
    // inside checkable labels, and via optionLabelFor in the group driver).
    try {
      if (AF.lever && AF.lever.isLeverPage && AF.lever.isLeverPage()) {
        if (inp.type === "checkbox" || inp.type === "radio") {
          const opt = AF.lever.optionLabelFor && AF.lever.optionLabelFor(inp);
          if (opt) return opt.slice(0, 200);
        }
        const q = AF.lever.questionLabelFor && AF.lever.questionLabelFor(inp);
        if (q) return q.slice(0, 200);
      }
    } catch {}
    // Workable: duplicate ids inside edu/exp editors - resolve labels in-scope.
    try {
      if (AF.workable && AF.workable.isWorkablePage && AF.workable.isWorkablePage()) {
        const wb = AF.workable.labelForControl && AF.workable.labelForControl(inp);
        if (wb) return wb.slice(0, 200);
      }
    } catch {}
    // Breezy: question text lives in a preceding <h3> (no label[for]).
    try {
      if (AF.breezy && AF.breezy.isBreezyPage && AF.breezy.isBreezyPage()) {
        const t = (inp.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") {
          const opt = AF.breezy.optionLabelFor && AF.breezy.optionLabelFor(inp);
          if (opt && !inp.closest("li.question")) return opt.slice(0, 200);
        }
        const q = AF.breezy.questionTitleFor && AF.breezy.questionTitleFor(inp);
        if (q) return q.slice(0, 200);
      }
    } catch {}
    // Manatal (careers-page.com): labels use empty for=""; question text is the
    // sibling .form-group > label (or a sibling <span> for the terms checkbox).
    try {
      if (AF.manatal && AF.manatal.isManatalPage && AF.manatal.isManatalPage()) {
        const q = AF.manatal.questionTitleFor && AF.manatal.questionTitleFor(inp);
        if (q) return q.slice(0, 200);
      }
    } catch {}
    const wrap = inp.closest && inp.closest("label");
    if (wrap && clean(wrap.innerText)) return clean(wrap.innerText).slice(0, 200);
    const labelledby = inp.getAttribute && inp.getAttribute("aria-labelledby");
    const byId = textOfIds(labelledby);
    if (byId) return byId.slice(0, 200);
    if (inp.getAttribute && inp.getAttribute("aria-label")) {
      return clean(inp.getAttribute("aria-label")).slice(0, 200);
    }
    // A control inside a <fieldset> is described by its <legend>.
    const fs = inp.closest && inp.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg && clean(lg.innerText)) return clean(lg.innerText).slice(0, 200);
    }
    // Last resort: any plain label[for] (including visually-hidden ones).
    if (inp.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
        if (l && clean(l.innerText)) return clean(l.innerText).slice(0, 200);
      } catch {}
    }
    // Ashby: each field's question lives in a <label class="ashby-application-form-
    // question-title"> inside the enclosing .ashby-application-form-field-entry.
    // Controls like the Location combobox (its input has no id, so label[for]
    // never matches) and the Yes/No buttons have no directly resolvable label.
    // Checked BEFORE placeholder so Location resolves to "Location", not its
    // "Start typing..." placeholder.
    try {
      const entry =
        inp.closest && inp.closest(".ashby-application-form-field-entry, [data-field-path]");
      if (entry && entry.querySelector) {
        const q = entry.querySelector(".ashby-application-form-question-title");
        if (q && clean(q.innerText)) return clean(q.innerText).slice(0, 200);
      }
    } catch {}
    // Placeholder is a reliable field identity when there's no label at all
    // (e.g. ApplyToJob's City / State/Province / Postal inputs).
    if (inp.getAttribute && clean(inp.getAttribute("placeholder"))) {
      return clean(inp.getAttribute("placeholder")).slice(0, 200);
    }
    // RecruiterFlow: every field's question lives in a sibling <p class="form-label">
    // inside the field's wrapper (there is NO <label for> and react-selects /
    // file / yes-no buttons have no placeholder). Strictly scoped to RecruiterFlow's
    // form container so other platforms are unaffected. Climb to the nearest
    // enclosing wrapper that owns a direct-child .form-label and use its text.
    try {
      if (inp.closest && inp.closest(".apply-to-job-form-inputs-container")) {
        let node = inp.parentElement;
        for (let depth = 0; node && depth < 8; depth++) {
          let fl = null;
          try {
            fl = node.querySelector(":scope > .form-label");
          } catch {}
          if (fl && clean(fl.innerText)) return clean(fl.innerText).slice(0, 200);
          node = node.parentElement;
        }
      }
    } catch {}
    if (inp.parentElement) return clean(inp.parentElement.innerText).slice(0, 200);
    return "";
  }

  function labelText(el) {
    if (!el) return "";
    const lbl = el.querySelector && el.querySelector("label");
    if (lbl && clean(lbl.innerText)) return clean(lbl.innerText).slice(0, 200);
    if (el.getAttribute && el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label")).slice(0, 200);
    return clean(el.innerText || el.textContent || "").slice(0, 200);
  }

  // ── stable control identity ──────────────────────────────────────────────
  // A control's cid is its own stable id (or name), which Greenhouse/Lever/etc.
  // keep constant across renders. Falls back to a structural path when neither
  // exists, so conditionally re-rendered controls keep one identity per pass.
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let sel = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(sel + "#" + node.id);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(">");
  }

  // Short, stable hash (djb2 -> base36) for collapsing a long structural path
  // into a compact token. cids are opaque echo keys (element identity is carried
  // by the data-af-cid attribute we stamp), so the backend caps cid length; a
  // raw css-path easily exceeds that, so we hash it.
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function cidFor(el) {
    // SmartRecruiters: the control's own id is duplicated/auto-generated and the
    // element lives inside a shadow root (so document.getElementById can't find
    // it). Its stable identity is on the enclosing oc-* Angular host:
    // data-test ("personal-info-email-input") or formcontrolname ("email"). Climb
    // across shadow boundaries to that host and key off it.
    if (deepActive()) {
      const host = climbHosts(el, (n) => {
        const dt = n.getAttribute && n.getAttribute("data-test");
        const fc = n.getAttribute && n.getAttribute("formcontrolname");
        const id = n.getAttribute && (n.getAttribute("id") || n.getAttribute("name"));
        // Screening questions carry a unique id="question_<uuid>" but no data-test;
        // the question element is the nearest match so its own id wins (otherwise a
        // shared section data-test would collapse every question onto one cid).
        return (dt && dt.trim()) || (fc && fc.trim()) || (id && /^question_/.test(id.trim()) && id.trim());
      });
      if (host) {
        const dt = (host.getAttribute("data-test") || "").trim();
        const fc = (host.getAttribute("formcontrolname") || "").trim();
        const qid = (host.getAttribute("id") || host.getAttribute("name") || "").trim();
        const key = dt || fc || (/^question_/.test(qid) ? qid : "");
        if (key) return key.length <= 56 ? "sr:" + key : "af:" + hashStr(key);
      }
    }
    if (AF.workable && AF.workable.isWorkablePage && AF.workable.isWorkablePage()) {
      const wb = AF.workable.cidFor && AF.workable.cidFor(el);
      if (wb) return wb.length <= 60 ? wb : "af:" + hashStr(wb);
    }
    const id = el.getAttribute && (el.getAttribute("id") || el.getAttribute("name"));
    // Keep short real ids/names verbatim (readable + usable by getElementById on
    // relocate); hash anything long or path-based so the cid stays well within
    // the backend's length cap.
    if (id && id.length <= 60) return id;
    return "af:" + hashStr((id || "") + "|" + cssPath(el));
  }

  function constraintsOf(n) {
    const c = {};
    const t = (n.getAttribute && n.getAttribute("type")) || "";
    if (t) c.type = t;
    for (const a of ["min", "max", "step", "pattern", "placeholder"]) {
      const v = n.getAttribute && n.getAttribute(a);
      if (v) c[a] = v;
    }
    const ml = n.getAttribute && n.getAttribute("maxlength");
    if (ml && /^\d+$/.test(ml)) c.maxlength = parseInt(ml, 10);
    return c;
  }

  // Intentionally a no-op: we used to flash a green outline on each filled field,
  // but that "robot filled this" indicator hurts the real-user feel during
  // autofill. Kept (and still called) so callers don't need to change.
  function markFilled(_el) {}

  const AF_DEBUG = true;
  function diag(...a) {
    if (!AF_DEBUG) return;
    try {
      console.log("[autofill]", ...a);
    } catch {}
  }

  // Serialize a region to a compact HTML string for the LLM. Drops decorative /
  // non-decision nodes (scripts, styles, svgs, the iti country dropdown, hidden
  // shims, a11y live regions) and strips noisy attributes (emotion class soup,
  // inline styles), keeping only what identifies a control and its choices:
  // id / data-af-cid / role / type / name / value / label text / inlined option
  // lists (<ul data-af-options-for>). This is the DOM-with-options payload.
  const _CLEAN_REMOVE_SEL = [
    "script", "style", "svg", "noscript", "link", "iframe", "img", "path", "br", "hr", "button",
    '[aria-hidden="true"]', '[class*="a11yText"]', '[class*="requiredInput"]',
    ".iti__dropdown-content", ".iti__country-list", ".iti__flag", ".iti__arrow", ".iti__selected-country",
    ".apply-field-extra", ".apply-buttons",
  ].join(",");
  const _CLEAN_KEEP_ATTR = new Set([
    "id", "data-af-cid", "data-af-options-for", "role", "type", "name", "value",
    "placeholder", "aria-label", "aria-labelledby", "aria-required", "for",
    "checked", "selected", "multiple", "accept", "contenteditable", "rows", "maxlength",
  ]);
  function cleanForLLM(node, maxLen = 60000) {
    let html = "";
    try {
      const clone = node.cloneNode(true);
      clone.querySelectorAll(_CLEAN_REMOVE_SEL).forEach((e) => e.remove());
      const nodes = [clone, ...clone.querySelectorAll("*")];
      for (const el of nodes) {
        if (!el.attributes) continue;
        for (const a of Array.from(el.attributes)) {
          if (!_CLEAN_KEEP_ATTR.has(a.name)) el.removeAttribute(a.name);
        }
      }
      html = clone.outerHTML || "";
    } catch {
      html = "";
    }
    html = html.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
    if (html.length > maxLen) html = html.slice(0, maxLen);
    return html;
  }

  // Build a hidden <ul data-af-options-for="cid"> of harvested option texts to
  // splice next to a custom-dropdown control so the serialized DOM carries its
  // choices. Returns the element (caller removes it after serializing).
  function buildOptionList(cid, options) {
    const ul = document.createElement("ul");
    ul.setAttribute("data-af-options-for", cid);
    for (const o of options || []) {
      const li = document.createElement("li");
      li.textContent = o;
      ul.appendChild(li);
    }
    return ul;
  }

  AF.dom = {
    clean,
    normText,
    isVisible,
    delay,
    waitUntil,
    setNativeValue,
    fireInput,
    commitReactValue,
    setReactTextValue,
    setReactSelectValue,
    textOfIds,
    labelForControl,
    labelText,
    cssPath,
    cidFor,
    constraintsOf,
    markFilled,
    diag,
    cleanForLLM,
    buildOptionList,
  };
})();
