// MAIN-world React fill bridge.
//
// Chrome content scripts run in an ISOLATED world: they share the DOM tree with
// the page but NOT JavaScript expandos or the page's patched prototypes
// (https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).
// React's `_valueTracker` and `__reactProps$` live on the PAGE-world wrapper, so
// an isolated-world `_valueTracker` rewind is a no-op on Ashby's real tracker -
// DOM text can look filled while submit still says "Missing entry for required
// field: Name".
//
// This file is injected with world:"MAIN". The isolated autofill engine dispatches
// a bubbling CustomEvent("__af_page_set") on the control; we set the value through
// the page's native setter, rewind the page `_valueTracker`, fire input/change,
// and call React's onChange/onBlur from `__reactProps$` when present.
(() => {
  if (window.__AF_PAGE_BRIDGE__) return;
  window.__AF_PAGE_BRIDGE__ = true;

  function reactProps(el) {
    if (!el) return null;
    try {
      for (const k of Object.keys(el)) {
        if (k.startsWith("__reactProps$")) return el[k];
      }
    } catch {}
    return null;
  }

  function valueSetter(el) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    return desc && typeof desc.set === "function" ? desc.set : null;
  }

  function fakeEvent(el, type) {
    return {
      target: el,
      currentTarget: el,
      type,
      bubbles: true,
      cancelable: true,
      isTrusted: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      persist() {},
      nativeEvent: null,
    };
  }

  function callReactHandlers(el, types) {
    const props = reactProps(el);
    if (!props) return;
    for (const type of types) {
      const fn =
        type === "change"
          ? props.onChange
          : type === "input"
          ? props.onInput || props.onChange
          : type === "blur"
          ? props.onBlur
          : null;
      if (typeof fn !== "function") continue;
      try {
        fn(fakeEvent(el, type));
      } catch {}
    }
  }

  function setTextLike(el, value) {
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
    const v = value == null ? "" : String(value);
    const setter = valueSetter(el);
    const last = el.value;
    try {
      el.focus({ preventScroll: true });
    } catch {}
    if (setter) setter.call(el, v);
    else el.value = v;
    // Page-world tracker (invisible to isolated content scripts).
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") {
        tracker.setValue(last === v ? (v === "" ? "__af__" : "") : last);
      }
    } catch {}
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: v,
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    callReactHandlers(el, ["input", "change", "blur"]);
    try {
      el.blur();
    } catch {}
    try {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: false, cancelable: true }));
    } catch {}
    return el.value === v || String(el.value) === v;
  }

  function setSelect(el, value) {
    if (!el || el.tagName !== "SELECT") return false;
    const want = value == null ? "" : String(value);
    const setter = valueSetter(el);
    const last = el.value;
    let matched = null;
    for (const o of el.options) {
      if (String(o.value) === want || String(o.text).trim() === want.trim()) {
        matched = o;
        break;
      }
    }
    if (!matched && want) {
      const low = want.trim().toLowerCase();
      for (const o of el.options) {
        if (String(o.text).trim().toLowerCase().includes(low)) {
          matched = o;
          break;
        }
      }
    }
    if (!matched) return false;
    try {
      el.focus({ preventScroll: true });
    } catch {}
    if (setter) setter.call(el, matched.value);
    else el.value = matched.value;
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue(last);
    } catch {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    callReactHandlers(el, ["change", "blur"]);
    try {
      el.blur();
    } catch {}
    try {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    } catch {}
    return el.value === matched.value;
  }

  document.addEventListener(
    "__af_page_set",
    (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1 || !e.detail) return;
      const kind = e.detail.kind || "text";
      let ok = false;
      try {
        if (kind === "select") ok = setSelect(el, e.detail.value);
        else ok = setTextLike(el, e.detail.value);
      } catch {
        ok = false;
      }
      try {
        el.setAttribute("data-af-page-set", ok ? "ok" : "fail");
      } catch {}
    },
    true
  );
})();
