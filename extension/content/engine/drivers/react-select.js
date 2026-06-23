// react-select (and look-alike custom dropdown) driver.
//
// react-select renders its option list ONLY while the menu is open (the
// .select__menu subtree is mounted on open and unmounted on close), so options
// cannot be read from the static DOM. This driver therefore opens the widget,
// polls until the listbox mounts, harvests the option texts, then closes — and
// at write time opens again to click the chosen option (value-aware: a wrong
// pre-existing selection is replaced, not kept).
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, isVisible, delay, waitUntil, setNativeValue } = AF.dom;

  const COMBO_ROOT_SEL =
    '[class*="select__control"], [class*="select-control"], [class*="Select-control"], [role="combobox"]';
  const OPTION_SEL = '[role="option"], .select__option, [class*="-option"], li[role="option"]';

  function isComboInput(inp) {
    const role = (inp.getAttribute && inp.getAttribute("role")) || "";
    return (
      role === "combobox" ||
      (inp.getAttribute && inp.getAttribute("aria-autocomplete") === "list") ||
      (inp.getAttribute && inp.getAttribute("aria-haspopup") === "listbox")
    );
  }

  // The canonical widget root we own and write against: the .select__control
  // (holds the .select__single-value and the inner input). The menu mounts as
  // its sibling or in a portal — located separately via aria-controls.
  //
  // NOTE: we must NOT return the inner <input> here even though it matches
  // [role="combobox"] (Element.closest tests self first): the single-value node
  // lives in the control container, so an input root makes comboHasSelection /
  // comboSelectionText always report empty and a successful pick looks failed.
  function comboRoot(el) {
    if (el.closest) {
      const ctrl = el.closest('[class*="select__control"], [class*="select-control"], [class*="Select-control"]');
      if (ctrl) return ctrl;
      // Emotion-styled react-select (RecruiterFlow, etc.) ships opaque class
      // names like "css-1wq9ix5-control" with no "select" prefix, so the control
      // container is the nearest *-control ancestor of the combobox input. Without
      // this, the input itself becomes the root: openCombo fires on the input
      // instead of the control (the menu never opens, so option harvesting reads
      // nothing) and comboHasSelection/comboSelectionText always report empty.
      const emo = el.closest('[class*="-control"]');
      if (emo) return emo;
      const cb = el.closest('[role="combobox"]');
      if (cb && cb.tagName !== "INPUT") return cb;
    }
    return el;
  }

  function comboInput(root) {
    return root.tagName === "INPUT" ? root : root.querySelector && root.querySelector("input");
  }

  function isMultiCombo(root, input) {
    try {
      if (root && root.querySelector && root.querySelector('[class*="--is-multi"], [class*="multiValue"], [class*="multi-value"]'))
        return true;
      const el = input || root;
      if (el && el.getAttribute && el.getAttribute("aria-multiselectable") === "true") return true;
      if (root && root.closest) {
        if (root.closest('[class*="--is-multi"]')) return true;
        // RecruiterFlow (and similar emotion-styled react-selects) emit opaque
        // class names with NO --is-multi / aria-multiselectable marker. Their only
        // reliable multi signal is the field wrapper: ".multi-select-input-wrapper"
        // vs ".single-select-input-wrapper". Without this every multi widget is
        // mistaken for a single-select, so the model picks one value (ignoring
        // "select all" / "pick 2") and the writer never enters multi mode.
        if (root.closest(".multi-select-input-wrapper")) return true;
        if (root.closest(".single-select-input-wrapper")) return false;
      }
    } catch {}
    return false;
  }

  // Labels of the currently selected chips in a multi-select control. Used to
  // verify each pick committed and to skip values that are already present.
  // Emotion names the chip parts "...-multiValue", "...-multiValueLabel" and
  // "...-multiValueRemove"; collect the label text and drop the remove "x".
  function chipTexts(root) {
    const out = [];
    try {
      (root.querySelectorAll('[class*="multiValue"], [class*="multi-value"]') || []).forEach((n) => {
        const cls = String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || "");
        if (/multiValueRemove|multiValue__remove|multi-value__remove|multi-value-remove/i.test(cls)) return;
        const t = normText(clean(n.innerText || n.textContent));
        if (t) out.push(t);
      });
    } catch {}
    return [...new Set(out)];
  }

  function chipMatches(root, want) {
    const w = normText(want);
    if (!w) return false;
    return chipTexts(root).some((t) => t === w || t.includes(w) || w.includes(t));
  }

  // react-select's empty-state notice matches our [class*="-option"] selector;
  // treat notice/loading/placeholder nodes as NOT options.
  function isRealOption(o) {
    if (!isVisible(o)) return false;
    const cls = (o.className && o.className.baseVal !== undefined ? o.className.baseVal : o.className) || "";
    if (/notice|no-?options|no-?results|loading|placeholder/i.test(String(cls))) return false;
    if (o.getAttribute && o.getAttribute("role") === "option") return true;
    return /(^|\s|_|-)option(\s|_|-|$)/i.test(String(cls)) || /select__option/.test(String(cls));
  }

  function optionNodes(scope) {
    return [...(scope || document).querySelectorAll(OPTION_SEL)].filter(isRealOption);
  }

  // The listbox belonging to THIS widget: react-select sets the input's
  // aria-controls/aria-owns to its own listbox id, isolating it from other open
  // menus (e.g. a 200-entry country list bleeding into an unrelated control).
  function comboListbox(input, root) {
    try {
      const inp = input || comboInput(root);
      const id = inp && (inp.getAttribute("aria-controls") || inp.getAttribute("aria-owns"));
      if (id) {
        const lb = document.getElementById(id);
        if (lb) return lb;
      }
    } catch {}
    return (root && root.parentElement) || root || document;
  }

  function scopedOptionNodes(input, root) {
    const own = optionNodes(comboListbox(input, root));
    if (own.length) return own;
    return optionNodes(document);
  }

  function collectVisibleOptions(scope) {
    const opts = [];
    (scope || document).querySelectorAll(OPTION_SEL).forEach((o) => {
      if (!isRealOption(o)) return;
      const t = clean(o.innerText || o.textContent);
      if (t) opts.push(t);
    });
    return [...new Set(opts)].slice(0, 200);
  }

  function comboHasSelection(root) {
    const sv =
      root.querySelector &&
      root.querySelector(
        '[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]'
      );
    return !!(sv && clean(sv.innerText || sv.textContent));
  }

  function comboSelectionText(root) {
    const sv = root.querySelector && root.querySelector('[class*="singleValue"], [class*="single-value"]');
    return sv ? clean(sv.innerText || sv.textContent) : "";
  }

  // Open the widget. Libraries disagree on which event opens the menu
  // (react-select v5 -> mousedown; others -> pointer/click), so dispatch the
  // FULL pointer+mouse+click sequence (single press, not a toggle) plus an
  // ArrowDown keyboard fallback that recovers a dropped first "cold" open.
  function openCombo(input, root) {
    (input || root).focus();
    try {
      root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    root.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    try {
      root.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    try {
      root.click();
    } catch {}
    if (input) {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", code: "ArrowDown" }));
    }
  }

  function closeMenu(input, root) {
    const tgt = input || root;
    try {
      tgt.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
    } catch {}
    // react-select dismisses on an outside pointer event; Escape alone is often
    // ignored. Fire a full outside click on <body> so the menu reliably closes.
    try {
      for (const t of ["mousedown", "mouseup", "click"]) {
        document.body.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      }
    } catch {}
    try {
      tgt.blur && tgt.blur();
    } catch {}
  }

  function pickOption(nodes, want) {
    const w = normText(want);
    if (!w) return null;
    for (const o of nodes) {
      if (normText(o.innerText || o.textContent) === w) return o;
    }
    for (const o of nodes) {
      const t = normText(o.innerText || o.textContent);
      if (t && (t.includes(w) || w.includes(t))) return o;
    }
    return null;
  }

  function clickOption(opt) {
    opt.scrollIntoView && opt.scrollIntoView({ block: "nearest" });
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      opt.click();
    } catch {}
  }

  async function harvestOptions(root) {
    const input = comboInput(root);
    let options = [];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        openCombo(input, root);
        const ready = await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 1000, 60);
        if (ready) break;
        await delay(120);
      }
      const lb = comboListbox(input, root);
      const scope = optionNodes(lb).length ? lb : document;
      options = collectVisibleOptions(scope);
    } catch {
      options = [];
    } finally {
      closeMenu(input, root);
    }
    return options;
  }

  function pressEnter(el) {
    const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // The native react-select interaction: open, type the answer (which filters
  // the list and auto-highlights the first match), then press Enter to commit
  // it. One open, no option-node hunting. A single click fallback covers the
  // rare non-searchable widget whose input ignores typing.
  async function typeAndEnter(input, root, value) {
    (input || root).focus();
    openCombo(input, root);
    if (!input) return;
    setNativeValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Wait until the filtered option list has rendered, then commit with Enter.
    await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 800, 50);
    pressEnter(input);
    await delay(80);
  }

  async function writeSingle(root, want) {
    const value = clean(want);
    if (!value) return false;
    const input = comboInput(root);
    // Already showing the desired value -> nothing to do.
    const cur = comboSelectionText(root);
    if (cur && normText(cur) === normText(value)) return true;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await typeAndEnter(input, root, value);
        if (await waitUntil(() => (comboHasSelection(root) ? true : null), 700, 60)) return true;
        // Fallback for a non-searchable list: click the matching open option.
        const opt = pickOption(scopedOptionNodes(input, root), value);
        if (opt) {
          clickOption(opt);
          if (await waitUntil(() => (comboHasSelection(root) ? true : null), 700, 60)) return true;
        }
      } catch {}
      closeMenu(input, root);
      await delay(120);
    }
    return comboHasSelection(root);
  }

  async function writeMulti(root, values) {
    const list = (values || []).map(clean).filter(Boolean);
    if (!list.length) return false;
    const input = comboInput(root);
    for (const value of list) {
      // Already a chip for this value (e.g. retry) -> skip.
      if (chipMatches(root, value)) continue;
      try {
        // type + Enter per value; react-select keeps the menu open in multi mode.
        await typeAndEnter(input, root, value);
      } catch {}
      // Verify the chip actually landed. type+Enter silently no-ops when the
      // typed text doesn't auto-highlight an option, which is exactly how these
      // fields ended up empty. Fall back to opening the menu and clicking the
      // matching option node directly.
      const added = await waitUntil(() => (chipMatches(root, value) ? true : null), 600, 50);
      if (!added) {
        try {
          openCombo(input, root);
          await waitUntil(() => (scopedOptionNodes(input, root).length ? true : null), 700, 50);
          const opt = pickOption(scopedOptionNodes(input, root), value);
          if (opt) clickOption(opt);
          await waitUntil(() => (chipMatches(root, value) ? true : null), 500, 50);
        } catch {}
      }
    }
    closeMenu(input, root);
    return chipTexts(root).length > 0;
  }

  AF.registerDriver({
    type: "react-select",
    priority: 20,
    match(el) {
      if (el.tagName === "INPUT" && isComboInput(el)) return comboRoot(el);
      if (el.getAttribute && el.getAttribute("role") === "combobox" && el.tagName !== "INPUT") {
        // A container-level combobox with no inner input.
        if (el.querySelector && el.querySelector("input")) return null;
        return el;
      }
      return null;
    },
    // The stable cid comes from the inner combobox input's id (e.g. "gender",
    // "question_8820015005"), not the unidentified .select__control container.
    cidEl(root) {
      return comboInput(root) || root;
    },
    // Consume the hidden react-select "requiredInput" validation shim (sibling of
    // the control, inside the container) so the native driver never treats it as
    // a separate always-filled text field.
    consumes(root) {
      const extra = [];
      const shell = (root.closest && (root.closest(".select-shell") || root.closest('[class*="container"]'))) || root.parentElement;
      if (shell && shell.querySelectorAll) {
        shell
          .querySelectorAll('input[class*="requiredInput"], input[aria-hidden="true"], input[type="hidden"]')
          .forEach((n) => extra.push(n));
      }
      return extra;
    },
    extract(root) {
      const input = comboInput(root);
      const req =
        (input && input.required) ||
        (root.getAttribute && root.getAttribute("aria-required") === "true") ||
        (input && input.getAttribute && input.getAttribute("aria-required") === "true");
      return {
        kind: "custom",
        label: AF.dom.labelForControl(input || root),
        required: !!req,
        multi: isMultiCombo(root, input),
        options: [],
      };
    },
    isFilled(root) {
      return comboHasSelection(root);
    },
    async harvestOptions(root) {
      return harvestOptions(root);
    },
    async write(root, answer) {
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
      // Treat as multi when the widget reports it OR the model returned several
      // values: RecruiterFlow's multi widget (css-dktw4y-container) carries no
      // detectable --is-multi marker, so a "select all / pick 2" answer would
      // otherwise commit only its first value.
      const multi = isMultiCombo(root, comboInput(root)) || values.length > 1;
      if (multi) return writeMulti(root, values);
      return writeSingle(root, answer.option || answer.value || "");
    },
  });
})();
