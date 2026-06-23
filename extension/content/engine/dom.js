// Autofill engine — shared DOM utilities + driver registry.
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
  // Set a control's value via the native prototype setter so React's onChange
  // (which tracks the value descriptor) actually fires.
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Force a controlled-React input to register its CURRENT DOM value, exactly as
  // a user clicking into the field and back out (focus → blur) would.
  //
  // Two things break browser-autofilled / draft-restored values on a controlled
  // React form (e.g. Ashby):
  //   1) The value was set WITHOUT React's onChange, so its render state is empty.
  //      We reset React's value tracker and re-fire input/change so onChange runs.
  //   2) The form only COMMITS a field into its *validated* state on blur. React
  //      delegates `onBlur` from the native **focusout** event (blur doesn't
  //      bubble, so React 17+ never listens to "blur"). A synthetic `blur` Event
  //      therefore never triggers the onBlur commit, and the field stays "missing"
  //      on submit even though it shows a value. A genuine focus()+blur() fires a
  //      native, bubbling `focusout` — the same gesture the user does by hand to
  //      clear the error. We dispatch `focusout` explicitly as a fallback for
  //      inputs that can't take focus (disabled/readonly/off-screen).
  // No-ops when the value is empty. Returns true if it committed a value.
  function commitReactValue(el) {
    try {
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
      const v = el.value;
      if (v == null || v === "") return false;
      let focused = false;
      try {
        el.focus({ preventScroll: true });
        focused = document.activeElement === el;
      } catch {}
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
      setNativeValue(el, v); // prototype setter: leaves the tracker stale -> change detected
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (focused) {
        el.blur(); // native blur fires the bubbling "focusout" React's onBlur needs
      } else {
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      }
      return true;
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
    if (inp.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
        // Skip visually-hidden helper labels ("Attach") in favor of richer sources.
        if (l && clean(l.innerText) && !/visually-hidden/.test(l.className || "")) {
          return clean(l.innerText).slice(0, 200);
        }
      } catch {}
    }
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
    ".iti__dropdown-content", ".iti__flag", ".iti__arrow", ".iti__selected-country",
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
