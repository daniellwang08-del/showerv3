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
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], .iti';

  // cid -> { driver, root, spec, handle }
  const controls = new Map();

  function reset() {
    controls.clear();
  }

  function uniqueCid(base) {
    if (!controls.has(base)) return base;
    let i = 2;
    while (controls.has(base + "#" + i)) i++;
    return base + "#" + i;
  }

  // Claim controls within regionEl. `consumed` (a shared WeakSet) prevents a
  // child element of an already-claimed widget — or a control already claimed
  // under another selected block — from being claimed twice.
  function detect(regionEl, consumed) {
    const drivers = AF.orderedDrivers();
    const anchors = [];
    if (regionEl.matches && regionEl.matches(ANCHOR_SEL)) anchors.push(regionEl);
    if (regionEl.querySelectorAll) regionEl.querySelectorAll(ANCHOR_SEL).forEach((n) => anchors.push(n));

    const claims = [];
    for (const anchor of anchors) {
      if (consumed.has(anchor)) continue;
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
          spec.options = await driver.harvestOptions(root);
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
      if (spec.options && spec.options.length) desc.options = spec.options;
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

      // Open custom dropdowns and inline their harvested options into the DOM.
      if (!filled && driver.harvestOptions) {
        let opts = [];
        try {
          opts = await driver.harvestOptions(root);
        } catch {
          opts = [];
        }
        if (opts && opts.length) {
          try {
            const ul = AF.dom.buildOptionList(cid, opts);
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
      controlsMeta.push(meta);
    }

    const html = AF.dom.cleanForLLM(regionEl);
    for (const ul of injected) {
      try {
        ul.remove();
      } catch {}
    }
    diag("extract DOM", JSON.stringify(labelText(regionEl)).slice(0, 60), controlsMeta.length, "controls,", html.length, "chars");
    return { handle, label: labelText(regionEl), controls: controlsMeta, html };
  }

  function relocate(cid) {
    const entry = controls.get(cid);
    if (entry && entry.root && document.contains(entry.root)) return entry.root;
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
      }
    }
    return report;
  }

  AF.engine = { reset, detect, extractRegion, extractRegionDom, relocate, writeControls, controls };
})();
