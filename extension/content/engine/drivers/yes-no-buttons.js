// Yes / No button-group driver (RecruiterFlow and look-alikes).
//
// Some ATSs render a binary question not as a <select> or radio group but as two
// plain <button> elements ("Yes" / "No") inside a `.yes-no-inputs` wrapper:
//
//   <div class="yes-no-input-wrapper">
//     <p class="form-label">Are you legally authorized to work…?</p>
//     <div class="common-input-wrapper">
//       <div class="yes-no-inputs">
//         <button class="input-styles yes-input">Yes</button>
//         <button class="input-styles no-input">No</button>
//       </div>
//     </div>
//   </div>
//
// Buttons aren't standard form controls, so the native/group drivers ignore them
// and the engine never even anchors on them. This driver anchors on the
// `.yes-no-inputs` container, exposes ["Yes","No"] as options, and clicks the
// matching button on write. The selected state has no reliable class in the DOM,
// so `isFilled` is best-effort; the side panel's per-pass dedup (attemptedKeys)
// prevents a control from being answered twice regardless.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, labelForControl } = AF.dom;

  function buttonsOf(root) {
    if (!root || !root.querySelectorAll) return [];
    return [...root.querySelectorAll("button")];
  }

  // The question text lives in a sibling <p class="form-label"> in an enclosing
  // *-input-wrapper. Reuse labelForControl's RecruiterFlow climb by handing it a
  // button (it resolves the wrapper's .form-label), falling back to the buttons'
  // own Yes/No text only as a last resort.
  function groupLabel(root) {
    const btn = buttonsOf(root)[0];
    const l = labelForControl(btn || root);
    if (l && !/^(yes|no)$/i.test(l)) return l;
    return l || "";
  }

  // A button is "affirmative" if its text is Yes / its class marks it yes-input;
  // negative for No / no-input. Used so an answer of "Yes"/"No" (or a yes/no-ish
  // value) maps to the right button even when the visible text differs slightly.
  function classifyButton(btn) {
    const txt = normText(btn.textContent);
    const cls = String((btn.className && btn.className.baseVal) || btn.className || "");
    if (/\byes-input\b/.test(cls) || txt === "yes") return "yes";
    if (/\bno-input\b/.test(cls) || txt === "no") return "no";
    return "";
  }

  function wantPolarity(want) {
    const w = normText(want);
    if (!w) return "";
    if (/^(yes|y|true|i (do|am|will)|authorized)/.test(w)) return "yes";
    if (/^(no|n|false|i (do not|don't|am not|will not))/.test(w)) return "no";
    return "";
  }

  function clickButton(btn) {
    try {
      btn.focus && btn.focus();
    } catch {}
    try {
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    try {
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    } catch {}
    try {
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    try {
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    } catch {}
    try {
      btn.click();
    } catch {}
  }

  AF.registerDriver({
    type: "yes-no-buttons",
    priority: 35,
    match(el) {
      if (el.classList && el.classList.contains("yes-no-inputs")) return el;
      if (el.tagName === "BUTTON" && el.closest && el.closest(".yes-no-inputs")) {
        return el.closest(".yes-no-inputs");
      }
      // Ashby renders a binary question as a <div class="_yesno_… _container_…">
      // holding two <button>Yes</button><button>No</button> plus a hidden
      // <input type="checkbox" name=…> that mirrors the choice. The CSS-module
      // hash varies per build, so match the stable "_yesno_" class fragment. We
      // claim the container (the engine then consumes the hidden checkbox so the
      // radio/checkbox driver doesn't also grab it).
      const isAshbyYesNo = (n) => {
        try {
          return !!(n && n.className && /(^|\s|_)yesno_/.test(String(n.className.baseVal || n.className)));
        } catch {
          return false;
        }
      };
      if (isAshbyYesNo(el)) return el;
      if (el.closest) {
        const box = el.closest('[class*="_yesno_"]');
        if (box && isAshbyYesNo(box)) return box;
      }
      return null;
    },
    extract(root) {
      const btns = buttonsOf(root);
      return {
        kind: "select",
        label: groupLabel(root),
        required: false,
        options: btns.map((b) => clean(b.textContent)).filter(Boolean),
      };
    },
    // These button groups expose no dependable selected-state class, so we mark
    // the group once WE click it. Without this, isFilled would always be false
    // and a SECOND write (cached-answer replay BEFORE extraction, then the LLM
    // pass) clicks the already-selected button again — and Ashby's buttons
    // toggle, so the second click DESELECTS it. That is the intermittent
    // "sometimes didn't select" bug. The marker makes the LLM pass skip a group
    // the replay already answered (and vice-versa).
    isFilled(root) {
      try {
        return root.getAttribute("data-af-yesno-answered") === "1";
      } catch {
        return false;
      }
    },
    async write(root, answer) {
      const btns = buttonsOf(root);
      if (!btns.length) return false;
      const want = answer.option || answer.value || "";
      // 1) Exact / substring text match against a button's visible label.
      const w = normText(want);
      let target = btns.find((b) => normText(b.textContent) === w);
      // 2) Polarity match (Yes/No) by text or yes-input/no-input class.
      if (!target) {
        const pol = wantPolarity(want);
        if (pol) target = btns.find((b) => classifyButton(b) === pol);
      }
      if (!target && w) target = btns.find((b) => normText(b.textContent).includes(w));
      if (!target) return false;
      clickButton(target);
      try {
        root.setAttribute("data-af-yesno-answered", "1");
      } catch {}
      // Commit-on-blur: a controlled form (Ashby) registers the choice into its
      // validated state on focusout, but our click leaves the button focused, so
      // the group is never committed and reads as a missing required field on
      // submit. Blur the button (fires the native, bubbling focusout React's
      // onBlur needs) and dispatch a focusout on the group as a fallback.
      try {
        target.blur();
      } catch {}
      try {
        root.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      } catch {}
      return true;
    },
  });
})();
