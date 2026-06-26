// intl-tel-input (iti) phone widget driver.
//
// The .iti wrapper holds the real <input type="tel"> plus a flag/country
// selector whose FULL country list (<ul class="iti__country-list"> with
// data-dial-code / data-country-code) lives in the static DOM at all times - so
// unlike react-select, no open is needed to read options. We treat the phone
// field as a national-number text input. When the form has no separate
// country/dial-code control, we also set the flag from a leading "+<cc>".
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, labelForControl, constraintsOf } = AF.dom;

  function telInput(root) {
    if (root.tagName === "INPUT") return root;
    return (
      (root.querySelector && root.querySelector('input.iti__tel-input, input[type="tel"], input[data-intl-tel-input-id]')) ||
      (root.querySelector && root.querySelector("input"))
    );
  }

  // Set the iti country flag by clicking the matching <li data-country-code> in
  // the (already in-DOM) country list. Best effort; safe to skip.
  function setCountryByDialCode(root, dial) {
    const code = String(dial || "").replace(/^\+/, "").trim();
    if (!code) return false;
    const list = root.querySelector(".iti__country-list, [id$='__country-listbox']");
    if (!list) return false;
    const li = [...list.querySelectorAll('li[role="option"], li.iti__country')].find(
      (n) => (n.getAttribute("data-dial-code") || "") === code
    );
    if (!li) return false;
    li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    li.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      li.click();
    } catch {}
    return true;
  }

  AF.registerDriver({
    type: "intl-tel-input",
    priority: 10,
    match(el) {
      if (el.classList && el.classList.contains("iti")) return el;
      if (el.tagName === "INPUT" && el.closest && el.closest(".iti")) return el.closest(".iti");
      return null;
    },
    // The .iti wrapper has no id; identify by the tel input's id (e.g. "phone").
    cidEl(root) {
      return telInput(root) || root;
    },
    extract(root) {
      const inp = telInput(root);
      return {
        kind: "tel",
        label: labelForControl(inp || root),
        required: !!(inp && (inp.required || (inp.getAttribute && inp.getAttribute("aria-required") === "true"))),
        constraints: inp ? constraintsOf(inp) : {},
      };
    },
    isFilled(root) {
      const inp = telInput(root);
      return !!inp && clean(inp.value) !== "";
    },
    async write(root, answer) {
      const inp = telInput(root);
      if (!inp) return false;
      const value = clean(answer.value || answer.option || "");
      if (!value) return false;
      // If the backend handed us a full international number (no separate country
      // control existed), align the iti flag to its dial code first.
      const m = value.match(/^\+\s*(\d{1,4})/);
      if (m) setCountryByDialCode(root, m[1]);
      const ok = AF.native.setTextInput(inp, value);
      if (ok && AF.pinpoint && AF.pinpoint.syncPhoneIso2) AF.pinpoint.syncPhoneIso2(root);
      return ok;
    },
  });
})();
