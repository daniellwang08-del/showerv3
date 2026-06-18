// Autofill content script — region picker + thin engine bridge.
//
// This file owns ONLY the on-page UX (hover overlay, click-to-select blocks)
// and chrome.runtime messaging. All detection/extraction/writing is delegated to
// the modular engine (window.__AF.engine), which dispatches to per-component
// drivers. Injected into every frame; idempotent via the guard below.
(() => {
  try {
    console.log("[autofill] picker.js build 2026-06-18g (modular per-component engine)");
  } catch {}
  if (window.__JOB_AUTOFILL__) return;
  window.__JOB_AUTOFILL__ = true;

  const AF = window.__AF || {};
  const dom = AF.dom || {};
  const clean = dom.clean || ((s) => (s || "").replace(/\s+/g, " ").trim());
  const isVisible =
    dom.isVisible ||
    ((el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  const labelText = dom.labelText || ((el) => clean((el && (el.innerText || el.textContent)) || "").slice(0, 200));

  // handle -> selected block element
  const state = { picking: false, hoverEl: null, selected: new Map() };
  let box = null;
  let badge = null;

  // ── overlay ────────────────────────────────────────────────────────────
  function ensureOverlay() {
    if (box) return;
    box = document.createElement("div");
    box.className = "jaf-overlay-box";
    badge = document.createElement("div");
    badge.className = "jaf-overlay-badge";
    (document.documentElement || document.body).appendChild(box);
    (document.documentElement || document.body).appendChild(badge);
  }
  function hideOverlay() {
    if (box) box.style.display = "none";
    if (badge) badge.style.display = "none";
  }
  function removeOverlay() {
    if (box) box.remove();
    if (badge) badge.remove();
    box = null;
    badge = null;
  }

  // ── hover classification (badge UX only) ────────────────────────────────
  function scan(el) {
    const controls = [];
    let file = false;
    let custom = false;
    const nodes = [];
    if (el.matches && el.matches("input, textarea, select")) nodes.push(el);
    if (el.querySelectorAll) {
      el.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]').forEach((n) =>
        nodes.push(n)
      );
      if (el.querySelector('[role="combobox"], [role="listbox"], [role="radiogroup"]')) custom = true;
    }
    for (const n of nodes) {
      if (n.tagName === "INPUT") {
        const t = (n.type || "text").toLowerCase();
        if (["hidden", "submit", "button", "image", "reset"].includes(t)) continue;
        if (t === "file") {
          file = true;
          continue;
        }
      }
      controls.push(n);
    }
    return { controls, file, custom };
  }

  function hasShadow(el) {
    if (el.shadowRoot) return true;
    if (!el.querySelectorAll) return false;
    const nodes = el.querySelectorAll("*");
    for (let i = 0; i < nodes.length && i < 400; i++) {
      if (nodes[i].shadowRoot) return true;
    }
    return false;
  }

  function validity(el) {
    const s = scan(el);
    const n = s.controls.length;
    let level;
    if (n === 0) {
      if (s.file) level = "file";
      else if (hasShadow(el)) level = "shadow";
      else if (s.custom) level = "custom";
      else level = "invalid";
    } else if (n === 1) {
      level = "valid";
    } else {
      level = "group";
    }
    const count = n + (s.file ? 1 : 0);
    return { level, n, count, file: s.file };
  }

  function badgeText(v) {
    switch (v.level) {
      case "invalid":
        return "No input - include the field";
      case "file":
        return "File upload (resume / cover letter)";
      case "custom":
        return "Custom control (best effort)";
      case "shadow":
        return "Shadow DOM (not supported)";
      case "group":
        return v.count + " fields in block";
      default:
        return v.file ? "Field + file" : "Selectable";
    }
  }

  function positionOverlay(el, level, text) {
    ensureOverlay();
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    box.setAttribute("data-level", level);
    badge.style.display = "block";
    badge.style.left = r.left + "px";
    badge.style.top = Math.max(0, r.top - 22) + "px";
    badge.setAttribute("data-level", level);
    badge.textContent = text;
  }

  // ── selection ──────────────────────────────────────────────────────────
  function onMove(e) {
    if (!state.picking) return;
    const el = e.target;
    if (!el || el === box || el === badge) return;
    state.hoverEl = el;
    const v = validity(el);
    positionOverlay(el, v.level, badgeText(v));
  }

  function onClick(e) {
    if (!state.picking) return;
    const el = state.hoverEl || e.target;
    if (!el || el === box || el === badge) return;
    e.preventDefault();
    e.stopPropagation();
    const v = validity(el);
    if (v.level === "invalid") {
      positionOverlay(el, "invalid", "No input here - select the field area");
      return;
    }
    if (v.level === "shadow") {
      positionOverlay(el, "shadow", "Shadow DOM control - fill this one manually");
      return;
    }
    const handle = Math.floor(Math.random() * 2000000000);
    el.setAttribute("data-autofill-id", String(handle));
    el.classList.add("jaf-selected");
    state.selected.set(handle, el);
    chrome.runtime.sendMessage({
      type: "AF_FIELD_ADDED",
      handle,
      label: labelText(el),
      level: v.level,
      controlCount: v.count,
    });
  }

  function onKey(e) {
    if (e.key === "Escape" && state.picking) stopPicking(true);
  }

  function startPicking() {
    if (state.picking) return;
    state.picking = true;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  function stopPicking(notify) {
    if (!state.picking) return;
    state.picking = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    hideOverlay();
    if (notify) {
      try {
        chrome.runtime.sendMessage({ type: "AF_PICKING_STOPPED" });
      } catch {}
    }
  }

  function removeSelection(handle) {
    const el = state.selected.get(handle);
    if (el) {
      el.classList.remove("jaf-selected");
      el.removeAttribute("data-autofill-id");
    }
    state.selected.delete(handle);
  }

  function clearAll() {
    for (const handle of Array.from(state.selected.keys())) removeSelection(handle);
    if (AF.engine) AF.engine.reset();
    removeOverlay();
  }

  // Drop the selection outlines (and hover overlay) but KEEP data-autofill-id /
  // data-autofill-cid so the engine can still find each control while filling.
  function hideMarks() {
    hideOverlay();
    for (const el of state.selected.values()) {
      if (el && el.classList) el.classList.remove("jaf-selected");
    }
  }

  function relocate(handle) {
    let el = state.selected.get(handle);
    if (el && document.contains(el)) return el;
    try {
      el = document.querySelector('[data-autofill-id="' + CSS.escape(String(handle)) + '"]');
    } catch {
      el = null;
    }
    if (el) state.selected.set(handle, el);
    return el || null;
  }

  // ── engine bridge ────────────────────────────────────────────────────────
  async function handleExtract() {
    if (!AF.engine) {
      chrome.runtime.sendMessage({ type: "AF_FIELDS", fields: [] });
      return;
    }
    AF.engine.reset();
    const consumed = new WeakSet();
    const fields = [];
    for (const [handle] of state.selected) {
      const el = relocate(handle);
      if (!el) continue;
      try {
        // DOM mode: open the selects, inline their options, and snapshot the
        // region's cleaned HTML (with options) for the LLM. controls is lite
        // metadata (cid/kind/filled/label/is_file) used for write + file fetch.
        fields.push(await AF.engine.extractRegionDom(el, consumed, handle));
      } catch {
        fields.push({ handle, label: "", controls: [], html: "" });
      }
    }
    chrome.runtime.sendMessage({ type: "AF_FIELDS", fields });
  }

  async function handleWrite(results, files, passId) {
    try {
      console.groupCollapsed("[autofill] LLM payload (autofill-ready)");
      const flat = [];
      for (const r of results || []) {
        for (const c of r.controls || []) {
          flat.push({
            handle: r.handle,
            cid: c.cid,
            kind: c.kind,
            value: c.value,
            option: c.option,
            option_values: (c.option_values || []).join(" | "),
            file_role: c.file_role || "",
            needs_user: !!c.needs_user,
            reason: c.reason || "",
          });
        }
      }
      console.table(flat);
      console.groupEnd();
    } catch {}

    if (!AF.engine) return;
    const report = await AF.engine.writeControls(results, files);
    try {
      console.log("[autofill] write report:", report);
    } catch {}
    // Only the frame that actually wrote controls reports completion, tagged
    // with passId so the side panel waits for the RIGHT pass before re-scanning.
    if (report.length) chrome.runtime.sendMessage({ type: "AF_WRITE_RESULT", passId, report });
  }

  // ── serialize extract/write ───────────────────────────────────────────────
  // Extraction rebuilds the control registry and opens dropdowns to harvest
  // options; writing reads that registry and drives the same dropdowns. They
  // MUST NOT overlap, or a re-extract would wipe state and close a menu mid-write.
  let opChain = Promise.resolve();
  function runExclusive(fn) {
    const run = opChain.then(() => fn());
    opChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "AF_START":
        startPicking();
        break;
      case "AF_STOP":
        stopPicking();
        break;
      case "AF_HIDE_MARKS":
        hideMarks();
        break;
      case "AF_REMOVE":
        removeSelection(msg.handle);
        break;
      case "AF_CLEAR":
        stopPicking();
        clearAll();
        break;
      case "AF_EXTRACT":
        runExclusive(handleExtract);
        break;
      case "AF_WRITE":
        runExclusive(() => handleWrite(msg.results, msg.files, msg.passId));
        break;
      default:
        break;
    }
  });
})();
