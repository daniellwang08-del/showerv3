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

  function labelForControl(inp) {
    if (!inp) return "";
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

  function cidFor(el) {
    const id = el.getAttribute && (el.getAttribute("id") || el.getAttribute("name"));
    if (id) return id;
    return "af:" + cssPath(el);
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

  function markFilled(el) {
    if (!el || !el.classList) return;
    el.classList.add("jaf-filled");
    setTimeout(() => el.classList && el.classList.remove("jaf-filled"), 2500);
  }

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
