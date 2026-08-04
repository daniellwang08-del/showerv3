// Native HTML control drivers: <input> (text-like), <textarea>, and <select>.
// These are the standard, non-widget controls. Each driver is self-contained:
// it claims the elements it owns (match), reads a spec (extract), reports
// whether the page already holds a value (isFilled), and writes a value.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, setNativeValue, fireInput, setReactTextValue, setReactSelectValue, labelForControl, constraintsOf } =
    AF.dom;

  const SKIP_INPUT_TYPES = ["hidden", "submit", "button", "image", "reset"];

  // Write a value the way a user does: focus → type → blur, via the React-safe
  // setter in dom.js. Ashby (and other controlled React forms) only keep the
  // value in submit state when onChange fires and the field blurs; writing the
  // DOM alone produces the "Missing entry for required field: Email" error
  // while the input still looks filled.
  function setTextInput(el, value) {
    if (typeof setReactTextValue === "function") {
      return setReactTextValue(el, value == null ? "" : String(value));
    }
    // Fallback if an older dom.js is somehow injected without setReactTextValue.
    let focused = false;
    try {
      el.focus({ preventScroll: true });
      focused = document.activeElement === el;
    } catch {}
    const lastValue = el.value;
    setNativeValue(el, value);
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === "function") tracker.setValue(lastValue);
    fireInput(el, value);
    if (focused) {
      try {
        el.blur();
      } catch {}
    } else {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
    return true;
  }

  function inputKind(inp) {
    const t = (inp.type || "text").toLowerCase();
    if (["email", "tel", "url", "number", "date", "password", "search"].includes(t)) {
      return t === "password" || t === "search" ? "text" : t;
    }
    if (["datetime-local", "month", "week", "time"].includes(t)) return "date";
    return "text";
  }

  // A combobox input belongs to react-select et al., not the native driver.
  function isComboInput(inp) {
    const role = (inp.getAttribute && inp.getAttribute("role")) || "";
    const cls = String((inp.className && inp.className.baseVal !== undefined ? inp.className.baseVal : inp.className) || "");
    return (
      role === "combobox" ||
      (inp.getAttribute && inp.getAttribute("aria-autocomplete") === "list") ||
      (inp.getAttribute && inp.getAttribute("aria-haspopup") === "listbox") ||
      /dummyInput/i.test(cls) ||
      (inp.closest && inp.closest(".react-select"))
    );
  }

  // ── <select> ────────────────────────────────────────────────────────────
  // A <select> usually ships a pre-selected placeholder as its first option
  // ("No answer", "-- Select --", ...). Crucially the placeholder often has a
  // NON-empty value (ApplyToJob uses value="0" / "resumator_no_selection"), so a
  // bare value check wrongly reports the control as already filled and we skip
  // it. Detect the placeholder by its option text/value so we still answer it.
  function isPlaceholderSelected(sel) {
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    if (!opt) return true;
    if (!clean(opt.value)) return true; // empty value = nothing chosen
    const t = normText(opt.text);
    if (!t) return true;
    if (/no answer|please select|select one|select an option|choose one/.test(t)) return true;
    if (/^--/.test(t) || /^-+$/.test(t)) return true; // "-- No answer --", "----"
    if (/^(select|choose|none|n\/a)$/.test(t)) return true;
    if (/(^|_)no_?selection$/.test(normText(opt.value))) return true; // ATS sentinel
    return false;
  }

  function selectOption(sel, want) {
    const w = clean(want).toLowerCase();
    if (!w) return false;
    let best = null;
    for (const o of sel.options) {
      if (clean(o.text).toLowerCase() === w || clean(o.value).toLowerCase() === w) {
        best = o;
        break;
      }
    }
    if (!best) {
      for (const o of sel.options) {
        if (clean(o.text).toLowerCase().includes(w) && w) {
          best = o;
          break;
        }
      }
    }
    if (!best) return false;
    setNativeValue(sel, best.value);
    fireInput(sel);
    return true;
  }

  function selectOptionsMulti(sel, wants) {
    const list = (wants || []).map((x) => clean(x).toLowerCase()).filter(Boolean);
    if (!list.length) return false;
    let any = false;
    for (const o of sel.options) {
      const t = clean(o.text).toLowerCase();
      const v = clean(o.value).toLowerCase();
      if (list.some((w) => t === w || v === w || (t && (t.includes(w) || w.includes(t))))) {
        o.selected = true;
        any = true;
      }
    }
    if (any) fireInput(sel);
    return any;
  }

  AF.registerDriver({
    type: "native-select",
    priority: 40,
    match(el) {
      if (el.tagName !== "SELECT") return null;
      // Pinpoint mobile fallback <select> duplicates a react-select on desktop;
      // skip it when a react-select widget is present in the same question block.
      try {
        const block = el.closest && el.closest(".col-md-1-1, .frow, .pad-v-3");
        if (block && block.querySelector(".react-select, [class*='select__control']")) return null;
      } catch {}
      // iCIMS: a select with icimsdropdown-enabled="1" holds no real options
      // (they arrive over AJAX) and is driven through its visible widget by
      // drivers/icims-dropdown.js. Disabled/dependent selects are skipped until
      // their parent field is answered.
      if (AF.icims && AF.icims.dropdownAnchorFor && AF.icims.dropdownAnchorFor(el)) return null;
      if (AF.icims && AF.icims.shouldSkipControl && AF.icims.shouldSkipControl(el)) return null;
      return el;
    },
    extract(root) {
      return {
        kind: "select",
        label: labelForControl(root),
        required:
          !!root.required ||
          (root.getAttribute && root.getAttribute("aria-required") === "true") ||
          !!(AF.manatal && AF.manatal.isRequiredControl && AF.manatal.isRequiredControl(root)) ||
          !!(AF.jobdiva && AF.jobdiva.isRequiredControl && AF.jobdiva.isRequiredControl(root)) ||
          !!(AF.icims && AF.icims.isRequiredControl && AF.icims.isRequiredControl(root)),
        multi: !!root.multiple,
        options: [...root.options].map((o) => clean(o.text)).filter(Boolean),
      };
    },
    isFilled(root) {
      if (root.multiple) return !!(root.selectedOptions && root.selectedOptions.length);
      return !isPlaceholderSelected(root);
    },
    async write(root, answer) {
      const multi = !!root.multiple;
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
      if (!multi && values[0] != null && typeof setReactSelectValue === "function") {
        if (setReactSelectValue(root, values[0])) return true;
      }
      return multi ? selectOptionsMulti(root, values) : selectOption(root, answer.option || answer.value);
    },
  });

  // ── <textarea> ────────────────────────────────────────────────────────────
  AF.registerDriver({
    type: "native-textarea",
    priority: 60,
    match(el) {
      return el.tagName === "TEXTAREA" ? el : null;
    },
    extract(root) {
      return {
        kind: "textarea",
        label: labelForControl(root),
        required:
          !!root.required ||
          !!(AF.manatal && AF.manatal.isRequiredControl && AF.manatal.isRequiredControl(root)) ||
          !!(AF.jobdiva && AF.jobdiva.isRequiredControl && AF.jobdiva.isRequiredControl(root)) ||
          !!(AF.icims && AF.icims.isRequiredControl && AF.icims.isRequiredControl(root)),
        constraints: constraintsOf(root),
      };
    },
    isFilled(root) {
      return clean(root.value) !== "";
    },
    async write(root, answer) {
      return setTextInput(root, answer.value || "");
    },
  });

  // ── text-like <input> (catch-all, lowest priority) ──────────────────────────
  AF.registerDriver({
    type: "native-input",
    priority: 100,
    match(el) {
      if (el.tagName !== "INPUT") return null;
      const t = (el.type || "text").toLowerCase();
      if (SKIP_INPUT_TYPES.includes(t)) return null;
      if (t === "file" || t === "radio" || t === "checkbox") return null;
      if (isComboInput(el)) return null; // react-select inner input
      if (el.closest && el.closest(".react-select, [class*='select__']")) return null;
      if (el.closest && el.closest(".iti")) return null; // intl-tel-input owns it
      if (AF.lever && AF.lever.shouldSkipControl && AF.lever.shouldSkipControl(el)) return null;
      if (AF.workable && AF.workable.shouldSkipControl && AF.workable.shouldSkipControl(el)) return null;
      // iCIMS: login/password (written deterministically by the prep), the
      // dropdown widget's search box, and hidden mirror inputs.
      if (AF.icims && AF.icims.shouldSkipControl && AF.icims.shouldSkipControl(el)) return null;
      if (AF.jobdiva && AF.jobdiva.shouldSkipControl && AF.jobdiva.shouldSkipControl(el)) return null;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return null;
      if (el.className && /requiredInput/i.test(String(el.className))) return null; // react-select shim
      return el;
    },
    extract(root) {
      return {
        kind: inputKind(root),
        label: labelForControl(root),
        required:
          !!root.required ||
          (root.getAttribute && root.getAttribute("aria-required") === "true") ||
          !!(AF.manatal && AF.manatal.isRequiredControl && AF.manatal.isRequiredControl(root)) ||
          !!(AF.jobdiva && AF.jobdiva.isRequiredControl && AF.jobdiva.isRequiredControl(root)) ||
          !!(AF.icims && AF.icims.isRequiredControl && AF.icims.isRequiredControl(root)),
        constraints: constraintsOf(root),
      };
    },
    isFilled(root) {
      return clean(root.value) !== "";
    },
    async write(root, answer) {
      return setTextInput(root, answer.value || "");
    },
  });

  // Exposed for reuse by other drivers (e.g. intl-tel-input writes a text input).
  AF.native = { setTextInput, selectOption, selectOptionsMulti, inputKind, normText };
})();
