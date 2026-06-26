// Autofill engine core: detection, extraction, and writing.
//
// Walks a selected region, lets each registered component driver claim the
// elements it owns (most-specific first), and produces one structured spec per
// control with a STABLE cid (the element's own id/name). At write time it
// dispatches each value back to the owning driver. Drivers are the only place
// that knows how a given widget family works; the engine only orchestrates.
(() => {
  const AF = window.__AF;
  if (!AF || AF.engine) return;
  const { clean, labelText, cidFor, diag } = AF.dom;

  const ANCHOR_SEL =
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], .iti, .yes-no-inputs, [class*="_yesno_"], spl-radio-group';

  // cid -> { driver, root, spec, handle }
  const controls = new Map();
  const MAX_OPTIONS_PER_CONTROL = 120;

  function clampOptions(opts) {
    if (!opts || !opts.length) return opts;
    return opts.length > MAX_OPTIONS_PER_CONTROL ? opts.slice(0, MAX_OPTIONS_PER_CONTROL) : opts;
  }

  function reset() {
    controls.clear();
  }

  // Skip controls that aren't actually rendered (display:none / inside a hidden
  // wrapper). Some forms ship hidden helper inputs alongside the real ones (e.g.
  // ApplyToJob's hidden "paste resume" textarea and its pre-reveal file input);
  // filling those would conflict with the visible fields. offsetParent is null
  // for display:none subtrees; position:fixed elements legitimately have a null
  // offsetParent, so they're kept.
  function isRendered(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    try {
      // offsetParent is null for display:none subtrees, position:fixed elements,
      // AND (in some engines) controls inside a shadow root. A non-zero layout
      // rect means the element is actually laid out and visible - true for fixed
      // and shadow-hosted controls (SmartRecruiters' spl-* inputs), still false
      // for display:none helpers (which collapse to a 0x0 rect).
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return true;
      const s = getComputedStyle(el);
      return s.position === "fixed" && s.display !== "none" && s.visibility !== "hidden";
    } catch {
      return true;
    }
  }

  function uniqueCid(base) {
    if (!controls.has(base)) return base;
    let i = 2;
    while (controls.has(base + "#" + i)) i++;
    return base + "#" + i;
  }

  // Shadow-piercing platforms (SmartRecruiters) build every field from custom
  // elements whose real <input>/<textarea> sits in a declarative shadow root, so
  // querySelectorAll (which never crosses shadow boundaries) finds nothing. When
  // such a platform is active, walk into every open shadowRoot. Gated off for
  // every other engine, which treat shadow DOM as unsupported, so their detection
  // path is byte-for-byte unchanged.
  function deepCollectActive() {
    try {
      return typeof AF.deepCollect === "function" && AF.deepCollect();
    } catch {
      return false;
    }
  }

  // Subtrees the generic LLM pass must NOT claim on a deep-collect platform:
  //  - oc-experience / oc-education : repeating rows owned by the deterministic
  //    prep (Add -> fill -> Save); harvesting their autocompletes here would
  //    fight the prep.
  //  - oc-location-autocomplete(-wrapper) : optional free-text location pickers
  //    (no custom values) we intentionally skip.
  //  - oc-easy-apply : the "Easy Apply" resume drop zone (a second file input).
  //  - spl-autocomplete (NON-question) / spl-select / spl-dropdown-search : the
  //    geocoded location & country pickers, whose inner role="combobox" box would
  //    otherwise be mistaken for a react-select and harvest a 240-entry list.
  //    Screening-question dropdowns (spl-autocomplete[id^="question_"]) are the
  //    ONE exception - the sr-select driver owns those, so they're NOT excluded.
  //    NOTE: do NOT exclude spl-dropdown itself - on screening questions the
  //    combobox <input> lives INSIDE <spl-dropdown class="c-spl-autocomplete-dropdown">
  //    (ancestor of the input, NOT the portaled overlay menu). Excluding spl-dropdown
  //    skips the entire subtree and yields comboboxes: 0 on the screening step.
  //    The portaled option list is a <div class="c-spl-dropdown-menu-wrapper">.
  //  - spl-select-option : an option's deep nested shadow (truncate/tooltip/...)
  //    has no fillable control; the sr-select driver harvests labels itself.
  const DEEP_EXCLUDE_SEL =
    "oc-experience, oc-education, oc-location-autocomplete, oc-location-autocomplete-wrapper, oc-easy-apply, spl-autocomplete:not([id^='question_']), spl-select, spl-dropdown-search, spl-select-option";

  function collectAnchors(regionEl) {
    if (!deepCollectActive()) {
      const anchors = [];
      if (regionEl.matches && regionEl.matches(ANCHOR_SEL)) anchors.push(regionEl);
      if (regionEl.querySelectorAll) {
        regionEl.querySelectorAll(ANCHOR_SEL).forEach((n) => {
          try {
            if (AF.lever && AF.lever.shouldSkipControl && AF.lever.shouldSkipControl(n)) return;
            if (n.closest && AF.lever && AF.lever.shouldSkipSubtree && n.closest(".awli-application-row")) return;
            if (AF.workable && AF.workable.shouldSkipControl && AF.workable.shouldSkipControl(n)) return;
            if (AF.breezy && AF.breezy.shouldSkipControl && AF.breezy.shouldSkipControl(n)) return;
            if (n.closest && AF.workable && AF.workable.shouldSkipSubtree && n.closest('[data-ui="education"], [data-ui="experience"], [data-ui="autofill-button"]')) return;
          } catch {}
          anchors.push(n);
        });
      }
      return anchors;
    }
    const out = [];
    const visit = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (el.matches && el.matches(DEEP_EXCLUDE_SEL)) return; // skip the whole subtree
      try {
        if (AF.lever && AF.lever.shouldSkipSubtree && AF.lever.shouldSkipSubtree(el)) return;
      } catch {}
      if (el.matches && el.matches(ANCHOR_SEL)) out.push(el);
      if (el.shadowRoot) {
        for (const c of el.shadowRoot.children) visit(c);
      }
      const kids = el.children;
      if (kids) for (const c of kids) visit(c);
    };
    if (regionEl.nodeType === 1) visit(regionEl);
    else if (regionEl.children) for (const c of regionEl.children) visit(c);
    return out;
  }

  // Claim controls within regionEl. `consumed` (a shared WeakSet) prevents a
  // child element of an already-claimed widget - or a control already claimed
  // under another selected block - from being claimed twice.
  function detect(regionEl, consumed) {
    const drivers = AF.orderedDrivers();
    const anchors = collectAnchors(regionEl);

    const claims = [];
    for (const anchor of anchors) {
      if (consumed.has(anchor)) continue;
      try {
        if (AF.lever && AF.lever.shouldSkipControl && AF.lever.shouldSkipControl(anchor)) continue;
        if (AF.workable && AF.workable.shouldSkipControl && AF.workable.shouldSkipControl(anchor)) continue;
        if (AF.breezy && AF.breezy.shouldSkipControl && AF.breezy.shouldSkipControl(anchor)) continue;
        if (anchor.closest && AF.workable && anchor.closest('[data-ui="education"], [data-ui="experience"], [data-ui="autofill-button"]')) continue;
      } catch {}
      // Skip hidden helper inputs - EXCEPT file inputs, which are almost always
      // hidden behind a styled drop zone (RecruiterFlow's #fileInput is permanently
      // display:none) yet must still be claimed so the resume can be attached.
      const isFileInput = anchor.tagName === "INPUT" && (anchor.type || "").toLowerCase() === "file";
      const wbSurveyRadio =
        AF.workable && AF.workable.isSurveyRadioInput && AF.workable.isSurveyRadioInput(anchor);
      const wbAppWidget =
        AF.workable && AF.workable.isApplicationWidgetInput && AF.workable.isApplicationWidgetInput(anchor);
      if (!isFileInput && !wbSurveyRadio && !wbAppWidget && !isRendered(anchor)) continue;
      for (const driver of drivers) {
        let root = null;
        try {
          root = driver.match(anchor);
        } catch {
          root = null;
        }
        if (!root) continue;
        if (consumed.has(root)) break;
        consumed.add(root);
        if (root.querySelectorAll) {
          root
            .querySelectorAll('input, textarea, select, [role="combobox"], [contenteditable=""], [contenteditable="true"]')
            .forEach((n) => consumed.add(n));
        }
        if (driver.consumes) {
          try {
            driver.consumes(root).forEach((n) => consumed.add(n));
          } catch {}
        }
        claims.push({ driver, root });
        break;
      }
    }
    return claims;
  }

  async function extractRegion(regionEl, consumed, handle) {
    const claims = detect(regionEl, consumed);
    const out = [];
    for (const { driver, root } of claims) {
      let spec;
      try {
        spec = driver.extract(root);
      } catch {
        continue;
      }
      // Derive the cid from the driver's identity element (e.g. the inner input
      // of a react-select / iti widget) so it stays the element's own stable id,
      // while we still relocate/write against the widget root.
      const idEl = driver.cidEl ? driver.cidEl(root) : root;
      const cid = uniqueCid(cidFor(idEl || root));
      try {
        root.setAttribute("data-autofill-cid", cid);
      } catch {}
      let filled = false;
      try {
        filled = driver.isFilled(root);
      } catch {}
      // Harvest lazy options only when not already filled (avoids re-opening a
      // settled dropdown and re-sending finished controls).
      if (!filled && driver.harvestOptions && (!spec.options || !spec.options.length)) {
        try {
          spec.options = clampOptions(await driver.harvestOptions(root));
        } catch {
          spec.options = [];
        }
      }
      controls.set(cid, { driver, root, spec, handle });

      const desc = {
        cid,
        key: cid,
        filled: !!filled,
        kind: spec.kind,
        label: spec.label || "",
        required: !!spec.required,
      };
      if (spec.multi) desc.multi = true;
      if (spec.options && spec.options.length) desc.options = clampOptions(spec.options);
      if (spec.constraints && Object.keys(spec.constraints).length) desc.constraints = spec.constraints;
      if (spec.is_file) desc.is_file = true;
      if (spec.accept) desc.accept = spec.accept;
      out.push(desc);
    }
    diag(
      "extract region",
      JSON.stringify(labelText(regionEl)).slice(0, 60),
      out.map((c) => ({ cid: c.cid, kind: c.kind, driver: (controls.get(c.cid) || {}).driver && controls.get(c.cid).driver.type, filled: c.filled, opts: (c.options || []).length }))
    );
    return out;
  }

  // DOM-mode extraction: detect controls, OPEN each custom dropdown to harvest
  // its options and splice them inline as <ul data-af-options-for>, then take ONE
  // cleaned snapshot of the region (the "DOM with options" the LLM reads). Returns
  // lightweight control metadata (no options - those live in the html) plus html.
  async function extractRegionDom(regionEl, consumed, handle) {
    const claims = detect(regionEl, consumed);
    const controlsMeta = [];
    const injected = [];
    for (const { driver, root } of claims) {
      let spec;
      try {
        spec = driver.extract(root);
      } catch {
        continue;
      }
      const idEl = driver.cidEl ? driver.cidEl(root) : root;
      const cid = uniqueCid(cidFor(idEl || root));
      try {
        root.setAttribute("data-autofill-cid", cid);
        if (idEl && idEl.setAttribute) idEl.setAttribute("data-af-cid", cid);
      } catch {}
      let filled = false;
      try {
        filled = driver.isFilled(root);
      } catch {}
      controls.set(cid, { driver, root, spec, handle });

      // Open each custom dropdown (Greenhouse-style), harvest its options, inject
      // them as <ul data-af-options-for> for the LLM html snapshot, and carry the
      // same list in meta.options for backend clamping / EEO defaults.
      let harvested = [];
      if (!filled && driver.harvestOptions) {
        try {
          harvested = await driver.harvestOptions(root);
        } catch {
          harvested = [];
        }
        if (harvested.length) {
          harvested = clampOptions(harvested);
          try {
            const ul = AF.dom.buildOptionList(cid, harvested);
            root.appendChild(ul);
            injected.push(ul);
          } catch {}
        }
      }

      const meta = {
        cid,
        key: cid,
        filled: !!filled,
        kind: spec.kind,
        label: spec.label || "",
        required: !!spec.required,
      };
      if (spec.multi) meta.multi = true;
      if (spec.is_file) meta.is_file = true;
      if (spec.accept) meta.accept = spec.accept;
      const opts = clampOptions(harvested.length ? harvested : spec.options || []);
      if (opts.length) meta.options = opts;
      if (spec.constraints && Object.keys(spec.constraints).length) meta.constraints = spec.constraints;
      controlsMeta.push(meta);
    }

    const html = AF.dom.cleanForLLM(regionEl);
    for (const ul of injected) {
      try {
        ul.remove();
      } catch {}
    }
    try {
      if (AF.closeReactSelectMenus) AF.closeReactSelectMenus(regionEl);
    } catch {}
    diag(
      "extract DOM",
      JSON.stringify(labelText(regionEl)).slice(0, 60),
      controlsMeta.length,
      "controls,",
      html.length,
      "chars",
      controlsMeta.map((c) => ({ cid: c.cid, kind: c.kind, opts: (c.options || []).length }))
    );
    return { handle, label: labelText(regionEl), controls: controlsMeta, html };
  }

  function relocate(cid) {
    const entry = controls.get(cid);
    // isConnected (not document.contains) so a control living in a shadow root -
    // SmartRecruiters' inner inputs - is recognized as still on the page; a
    // shadow node is connected to the document but is NOT a document descendant,
    // so document.contains() returns false for it and would discard a live root.
    if (entry && entry.root && entry.root.isConnected) return entry.root;
    let el = null;
    try {
      el = document.querySelector('[data-autofill-cid="' + CSS.escape(String(cid)) + '"]');
    } catch {}
    if (!el) {
      try {
        el = document.getElementById(cid);
      } catch {}
    }
    if (el && entry) entry.root = el;
    return el || (entry && entry.root) || null;
  }

  async function writeOne(c, files) {
    const entry = controls.get(c.cid);
    if (!entry) return null; // belongs to another frame
    const root = relocate(c.cid);
    if (!root) {
      diag("write", c.cid, "-> not_found");
      return { cid: c.cid, status: "not_found" };
    }
    diag("write", c.cid, {
      driver: entry.driver.type,
      value: c.value,
      option: c.option,
      needs_user: !!c.needs_user,
      file_role: c.file_role,
    });

    if (entry.spec && entry.spec.is_file) {
      const fd = files && files[c.cid];
      if (!fd) return { cid: c.cid, status: "needs_user" };
      const ok = await entry.driver.write(root, c, { file: fd });
      return { cid: c.cid, status: ok ? "attached" : "skipped" };
    }
    if (c.needs_user) return { cid: c.cid, status: "needs_user" };

    let ok = false;
    try {
      ok = await entry.driver.write(root, c, { files });
    } catch (err) {
      diag("write", c.cid, "threw", err && err.message);
      ok = false;
    }
    if (ok) AF.dom.markFilled(root);
    diag("write", c.cid, "->", ok ? "filled" : "skipped");
    return { cid: c.cid, status: ok ? "filled" : "skipped" };
  }

  async function writeControls(results, files) {
    const report = [];
    for (const r of results || []) {
      for (const c of r.controls || []) {
        const res = await writeOne(c, files);
        if (res) report.push(res);
        // Yield a macrotask between controls. Each write ends in a blur that
        // commits the field into the form's (Apollo/React) state asynchronously;
        // writing many controls in one synchronous burst lets React batch those
        // commits into a single render where shared form-state merges clobber each
        // other, leaving some just-written fields reading as "missing required
        // field". A real gap flushes each commit before the next write.
        await new Promise((r2) => setTimeout(r2, 12));
      }
    }
    return report;
  }

  AF.engine = { reset, detect, extractRegion, extractRegionDom, relocate, writeControls, controls };
})();
