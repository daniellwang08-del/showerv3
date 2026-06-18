// Native HTML control drivers: <input> (text-like), <textarea>, and <select>.
// These are the standard, non-widget controls. Each driver is self-contained:
// it claims the elements it owns (match), reads a spec (extract), reports
// whether the page already holds a value (isFilled), and writes a value.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, setNativeValue, fireInput, labelForControl, constraintsOf } = AF.dom;

  const SKIP_INPUT_TYPES = ["hidden", "submit", "button", "image", "reset"];

  function setTextInput(el, value) {
    el.focus();
    setNativeValue(el, value);
    fireInput(el);
    el.dispatchEvent(new Event("blur", { bubbles: true }));
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
    return (
      role === "combobox" ||
      (inp.getAttribute && inp.getAttribute("aria-autocomplete") === "list") ||
      (inp.getAttribute && inp.getAttribute("aria-haspopup") === "listbox")
    );
  }

  // ── <select> ────────────────────────────────────────────────────────────
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
      return el.tagName === "SELECT" ? el : null;
    },
    extract(root) {
      return {
        kind: "select",
        label: labelForControl(root),
        required: !!root.required,
        multi: !!root.multiple,
        options: [...root.options].map((o) => clean(o.text)).filter(Boolean),
      };
    },
    isFilled(root) {
      return root.selectedOptions ? root.selectedOptions.length > 0 && clean(root.value) !== "" : clean(root.value) !== "";
    },
    async write(root, answer) {
      const multi = !!root.multiple;
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
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
        required: !!root.required,
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
      if (el.closest && el.closest(".iti")) return null; // intl-tel-input owns it
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return null;
      if (el.className && /requiredInput/i.test(String(el.className))) return null; // react-select shim
      return el;
    },
    extract(root) {
      return {
        kind: inputKind(root),
        label: labelForControl(root),
        required: !!root.required || (root.getAttribute && root.getAttribute("aria-required") === "true"),
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
