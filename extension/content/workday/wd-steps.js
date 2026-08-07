// Workday engine - field discovery + control-aware writing + value resolution.
//
// Grounded in the REAL Workday application DOM: every field is a wrapper
//   <div data-automation-id="formField-<key>"> … </div>
// whose <key> is stable and semantic (e.g. legalName--firstName, city,
// countryRegion, phoneType, countryPhoneCode, phoneNumber, source, country).
// Inside the wrapper the control is one of:
//   - text/textarea input            (class css-18gjn2b, NOT the css-77hcv shadow input)
//   - button[aria-haspopup=listbox]  single-select dropdown (opens a promptOption listbox)
//   - [data-automation-id=multiSelectContainer]  multiselect with a search input
//   - radio group (fieldset > input[type=radio] + <label>Yes/No</label>)
//   - checkbox
//   - Workday date group (dateSectionMonth-input / dateSectionYear-input)
//
// Strategy (batch harvest → LLM → apply): discover every formField on the step,
// harvest option lists into memory, resolve nearly all answers in one WD_RESOLVE
// (plus source L2 follow-up when hierarchical), then apply DOM writes quickly.
// Namespaced under window.__WD.steps.
(() => {
  // Always (re)install so an updated extension takes effect on the next Start
  // without a manual page reload (executeScript re-runs this file each Start).
  // The deferred-commit state lives on the shared WD object below so reinstalling
  // never leaks focus listeners or drops queued commits.
  const WD = (window.__WD = window.__WD || {});
  const D = WD.dom;
  const AID = (id) => `[data-automation-id='${id}']`;
  const OPTION_SEL = '[data-automation-id="promptOption"], [role="option"], ul[role="listbox"] li';

  function mark(rep, label, ok) {
    (ok ? rep.filled : rep.missed).push(label);
    return ok;
  }
  function record(rep, label, result) {
    if (result === null || result === undefined) return;
    mark(rep, label, result === true);
  }

  function throwIfAborted() {
    if (WD.isAborted && WD.isAborted()) {
      const err = new Error("WD_ABORTED");
      err.name = "WDAborted";
      throw err;
    }
  }

  // Fields that failed during this autofill attempt (until newAttempt clears).
  // Proven retry loop: recovery onlyInvalid re-invoked writeField/LLM on the same
  // How Did You Hear / State fields after the first failure, which made later
  // passes worse. Once failed, leave them for the user until Again / new run.
  function failedFieldSet() {
    return (WD._failedFields = WD._failedFields || new Set());
  }
  function fieldFailKey(key, label) {
    const k = String(key || "")
      .toLowerCase()
      .trim();
    if (k) return "k:" + k;
    const l = String(label || "")
      .toLowerCase()
      .trim();
    return l ? "l:" + l : "";
  }
  function rememberFailedField(key, label) {
    const set = failedFieldSet();
    const primary = fieldFailKey(key, label);
    if (primary) set.add(primary);
    const l = String(label || "")
      .toLowerCase()
      .trim();
    if (l) set.add("l:" + l);
  }
  function shouldSkipFailedField(key, label) {
    const set = WD._failedFields;
    if (!set || !set.size) return false;
    const primary = fieldFailKey(key, label);
    if (primary && set.has(primary)) return true;
    const labelNorm = String(label || "")
      .toLowerCase()
      .trim();
    if (!labelNorm) return false;
    if (set.has("l:" + labelNorm)) return true;
    for (const entry of set) {
      if (!entry.startsWith("l:")) continue;
      const want = entry.slice(2);
      if (!want) continue;
      if (labelNorm === want || labelNorm.includes(want) || want.includes(labelNorm)) return true;
    }
    return false;
  }

  // ── label / value helpers ──────────────────────────────────────────────────
  function fieldLabel(container) {
    const clean = (s) => (s || "").replace(/\*/g, "").replace(/\brequired\b/gi, "").replace(/\s+/g, " ").trim();
    const l = container.querySelector("label, legend");
    let t = l ? l.innerText || l.textContent || "" : "";
    // Radio/checkbox groups often carry the question via aria-labelledby on a
    // fieldset (or aria-label) instead of a <label>/<legend>.
    if (!clean(t)) {
      const ref = container.getAttribute("aria-labelledby");
      if (ref) {
        t = ref
          .split(/\s+/)
          .map((id) => {
            const e = id && document.getElementById(id);
            return e ? e.innerText || e.textContent || "" : "";
          })
          .join(" ");
      }
    }
    if (!clean(t)) {
      const ctrl = container.querySelector("input[id], select[id], button[id]");
      if (ctrl && ctrl.id) {
        try {
          const ext = document.querySelector(`label[for="${CSS.escape(ctrl.id)}"]`);
          if (ext) t = ext.innerText || ext.textContent || "";
        } catch {}
      }
    }
    // Application Questions often label the Canvas Select combobox via aria-label
    // on the input (full question text + " Required") with no inner <label>.
    if (!clean(t)) {
      const trigger = listboxTrigger(container);
      if (trigger) t = trigger.getAttribute("aria-label") || trigger.getAttribute("title") || "";
    }
    if (!clean(t)) t = container.getAttribute("aria-label") || "";
    return clean(t);
  }

  // Workday Canvas Select (Application Questions) uses input[role=combobox]
  // aria-haspopup=listbox - NOT button[aria-haspopup=listbox] (My Information era).
  // Prefer a visible INPUT combobox first so we never drive Canvas Select via a
  // sibling/ancestor button (which cannot take setReactValue).
  function listboxTrigger(container) {
    const inputCombo =
      container.querySelector('input[role="combobox"][aria-haspopup="listbox"]') ||
      container.querySelector('input[aria-haspopup="listbox"]');
    if (inputCombo && D.isVisible(inputCombo)) return inputCombo;
    return (
      container.querySelector('button[aria-haspopup="listbox"]') ||
      container.querySelector('[role="combobox"][aria-haspopup="listbox"]') ||
      container.querySelector('input[aria-haspopup="listbox"]')
    );
  }

  function triggerCurrentValue(trigger) {
    if (!trigger) return "";
    if (trigger.tagName === "INPUT" || trigger.tagName === "SELECT") {
      return trigger.value || "";
    }
    return trigger.textContent || "";
  }

  // Canvas Select (Application Questions) often keeps a blank input.value after a
  // successful option click — the visible choice lives in a sibling / aria state.
  // Reading only .value made openAndPick report failure on every Yes/No commit.
  function selectDisplayValue(trigger) {
    if (!trigger) return "";
    const raw = triggerCurrentValue(trigger);
    const cleaned = String(raw || "").replace(/\s+/g, " ").trim();
    if (cleaned && !/^select(\s+one)?\.?\.?\.?$/i.test(cleaned)) return cleaned;
    const root =
      trigger.closest('[data-automation-id^="formField-"]') ||
      trigger.closest('[data-automation-id*="formField"]') ||
      trigger.parentElement;
    if (root) {
      const nodes = root.querySelectorAll(
        '[data-automation-id="selectSelectedOption"], [data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"], [aria-selected="true"]',
      );
      for (const n of nodes) {
        if (!D.isVisible(n)) continue;
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !/^select(\s+one)?\.?\.?\.?$/i.test(t)) return t;
      }
    }
    return "";
  }

  function triggerShowsPlaceholder(trigger) {
    const t = D.norm(selectDisplayValue(trigger) || triggerCurrentValue(trigger));
    // Workday Voluntary EEO defaults to "No Response" (Review screenshot) — that is
    // NOT a real filled answer; treat as empty so harvest→LLM still runs.
    return !t || /^select(\s+one)?\.?\.?\.?$/.test(t) || /^no response\.?$/.test(t);
  }

  function valueMatchesWant(got, want) {
    const g = D.norm(got);
    const w = D.norm(want);
    if (!g || !w) return false;
    return g === w || g.includes(w) || w.includes(g);
  }

  // True when a multiselect/prompt already has a committed chip/selection.
  // MUST be checked before listboxTrigger(): Canvas MultiSelect uses
  // input[role=combobox][aria-haspopup=listbox] whose .value is the empty search
  // box even when a chip (e.g. How Did You Hear → LinkedIn) is selected. Treating
  // that combobox as the listbox trigger made fieldIsFilled always false, so every
  // full fill / recovery pass re-opened the prompt and broke the prior selection.
  // Live DOM (Siemens Healthineers / myworkdayjobs): a filled prompt has
  //   <ul data-automation-id="selectedItemList">…<div data-automation-id="selectedItem">…</div>
  //   and aria "1 item selected, Computer Engineering".
  // An EMPTY prompt STILL has <div data-automation-id="promptSelectionLabel"></div>
  // BEFORE selectedItem in document order. querySelector with a comma list returns
  // the first match in DOCUMENT order, so selecting promptSelectionLabel first
  // always returned "" even when selectedItem was present — that is the proven
  // root cause of "Field of Study already filled but engine refills it" and of
  // fieldHasCommittedValue treating filled prompts as empty on recovery.
  function promptSelectionNodes(multi) {
    if (!multi) return [];
    return [
      ...multi.querySelectorAll(
        '[data-automation-id="selectedItem"], [data-automation-id="pill"]',
      ),
    ];
  }

  function multiSelectedText(container) {
    const multi = container.querySelector('[data-automation-id="multiSelectContainer"]');
    if (!multi) return "";
    for (const sel of promptSelectionNodes(multi)) {
      const t = (sel.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    const aria = multi.querySelector('[data-automation-id="promptAriaInstruction"]');
    const at = (aria && aria.textContent) || "";
    // "1 item selected, Computer Engineering" / "0 items selected" / "Minimized"
    if (/^\s*\d+\s+items?\s+selected/i.test(at) && !/^\s*0\s+items?\s+selected/i.test(at)) {
      return at.replace(/\s+/g, " ").trim();
    }
    return "";
  }

  // Has this prompt/multiselect committed a selection matching `want`?
  // Empty want => any committed selection counts (used to skip already-filled).
  function promptChosen(multi, want) {
    if (!multi) return false;
    const w = D.norm(want);
    for (const sel of promptSelectionNodes(multi)) {
      const t = D.norm(sel.textContent);
      if (!t) continue;
      if (!w) return true;
      if (t.includes(w) || (w.length > 3 && w.includes(t))) return true;
    }
    const aria = multi.querySelector('[data-automation-id="promptAriaInstruction"]');
    const at = D.norm(aria && aria.textContent);
    if (!at || /^0 items? selected/.test(at) || at === "minimized") return false;
    if (!w) return /\d+\s+items?\s+selected/.test(at);
    return at.includes(w);
  }

  // Committed value present (ignores aria-invalid). Used to avoid re-opening
  // widgets during onlyInvalid recovery while Workday still shows stale errors.
  function fieldHasCommittedValue(container) {
    if (multiSelectedText(container)) return true;
    const trigger = listboxTrigger(container);
    if (trigger && container.querySelector('[data-automation-id="multiSelectContainer"]')) {
      // Combobox inside multiselect already handled via chips above.
      return false;
    }
    if (trigger) return !triggerShowsPlaceholder(trigger);
    const nativeSel = container.querySelector("select");
    if (nativeSel) {
      const t = (nativeSel.options[nativeSel.selectedIndex]?.text || "").trim();
      return !!t && !/^select(\s+one)?\.?\.?\.?$/i.test(t);
    }
    const radios = container.querySelectorAll('input[type="radio"]');
    if (radios.length && container.querySelector('input[type="radio"]:checked')) return true;
    const checks = [...container.querySelectorAll('input[type="checkbox"]')];
    if (checks.length === 1) return checks[0].checked;
    if (checks.length > 1 && checks.some((c) => c.checked)) return true;
    const text = container.querySelector(
      'input[type="text"], textarea, input[type="tel"], input[type="number"], input[type="email"], input[type="url"], input:not([type])',
    );
    if (text && text.type !== "hidden" && text.getAttribute("role") !== "combobox") {
      return !!(text.value || "").trim();
    }
    return false;
  }

  // True when the control already holds a committed, valid-looking value.
  function fieldIsFilled(container) {
    if (container.querySelector('[aria-invalid="true"]') && D.isVisible(container.querySelector('[aria-invalid="true"]'))) {
      return false;
    }
    return fieldHasCommittedValue(container);
  }

  // Harvested options must resemble the question - stale open listboxes attach
  // the wrong popup (e.g. SMS opt-in options harvested for "Highest degree").
  function optionsPlausibleForLabel(label, options) {
    if (!options || !options.length) return true;
    const opts = options.join(" ").toLowerCase();
    const low = (label || "").toLowerCase();
    if (/highest degree|degree attained/.test(low)) {
      return /bachelor|master|doctor|associate|diploma|ged|ph\.?d|juris|vocational|coursework/.test(opts);
    }
    if (/protected veteran|veteran.*categor|belong to any of the categories|confirm your veteran|veteran status|\bveteran\b/i.test(low)) {
      return /veteran|not a veteran|self-identify|self-disclose|protected|military/.test(opts) && !/asian|african american|hispanic|native hawaiian|two or more races/.test(opts);
    }
    if (/what is your (sex|gender)|please select your gender|\bgender\b|\bsex\b/.test(low)) {
      // Classic EEO: Male/Female; DraftKings AQ: Man/Woman/Non-binary.
      return /male|female|\bman\b|\bwoman\b|non-binary|prefer not|do not wish/.test(opts) &&
        !/bachelor|master|veteran/.test(opts);
    }
    if (/race|ethnicity/.test(low) && !/veteran/.test(low)) {
      return /asian|african|hispanic|white|native|two or more|do not wish/.test(opts);
    }
    if (/salary|compensation expectation|cash compensation/.test(low)) {
      return /\d/.test(opts);
    }
    if (/text message|sms|opt-in to receive/.test(low)) {
      return /sms|text message|opt-in|opt-out|wish to receive|do not wish/.test(opts);
    }
    return true;
  }

  async function closeAllListboxes(exceptMulti, opts) {
    // soft: Escape only — never focusSinkOutside body-clicks (those jump the page;
    // proven GDIT harvest stack: focusSinkOutside ← closeListbox ← closeAllListboxes
    // ← harvestPortalOptions, with uxInsights clickListener firing on each close).
    const soft = !!(opts && opts.soft);
    for (let pass = 0; pass < (soft ? 2 : 3); pass++) {
      let anyOpen = false;
      const triggers = D.qa(
        '[data-automation-id^="formField-"] button[aria-haspopup="listbox"], [data-automation-id^="formField-"] [role="combobox"][aria-haspopup="listbox"], [data-automation-id^="formField-"] input[aria-haspopup="listbox"], [data-automation-id="applyFlowPage"] button[aria-haspopup="listbox"]',
      ).filter(D.isVisible);
      for (const btn of triggers) {
        if (exceptMulti && exceptMulti.contains(btn)) continue;
        if (btn.getAttribute("aria-expanded") === "true" || openedListbox(btn)) {
          anyOpen = true;
          await closeListbox(btn, { soft: true });
        }
      }
      const popups = D.qa(
        '[data-behavior-click-outside-close] [role="listbox"], [data-popper-placement] [role="listbox"], [data-automation-id="activeListContainer"], [role="listbox"]',
      ).filter(D.isVisible);
      const foreign = popups.filter((p) => !listRootBelongsToMulti(p, exceptMulti));
      if (foreign.length) {
        anyOpen = true;
        pressKey(document.body, "Escape", "Escape", 27);
        await D.delay(50);
        if (!soft && !(exceptMulti && isMultiListOpen(exceptMulti))) {
          focusSinkOutside(document, { noBodyClick: true });
        }
      }
      if (!anyOpen) break;
      await D.delay(40);
    }
  }

  // True when any form listbox / portal is open (skip closeAll when already clean).
  function anyFormListboxOpen(exceptBtn) {
    const triggers = D.qa(
      '[data-automation-id^="formField-"] button[aria-haspopup="listbox"], [data-automation-id^="formField-"] [role="combobox"][aria-haspopup="listbox"], [data-automation-id^="formField-"] input[aria-haspopup="listbox"], [data-automation-id="applyFlowPage"] button[aria-haspopup="listbox"]',
    ).filter(D.isVisible);
    for (const btn of triggers) {
      if (exceptBtn && (btn === exceptBtn || (exceptBtn.contains && exceptBtn.contains(btn)))) continue;
      if (btn.getAttribute("aria-expanded") === "true" || openedListbox(btn)) return true;
    }
    return D.qa(
      '[data-behavior-click-outside-close] [role="listbox"], [data-popper-placement] [role="listbox"], [data-automation-id="activeListContainer"]',
    ).some(D.isVisible);
  }
  function labelForInput(input) {
    if (input.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (l) return l.innerText || l.textContent || "";
      } catch {}
    }
    const sib = input.parentElement && input.parentElement.querySelector("label");
    return (sib && (sib.innerText || sib.textContent)) || input.getAttribute("aria-label") || "";
  }

  // Phone country code: full option label (LLM + apply). +1 is shared by many
  // NANP territories — prompts must prefer United States of America (+1).
  const PHONE_CC_LABEL = { "1": "United States of America (+1)" };
  const USA_PHONE_CC = "United States of America (+1)";

  // Thin digit cleanup after LLM (prompt asks for exactly 10 national digits).
  function nationalPhoneDigits(phone) {
    let d = String(phone || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.length === 10) return d;
    if (d.length === 11 && d.charAt(0) === "1") return d.slice(1);
    if (d.charAt(0) === "1" && d.length > 11) return d.slice(1, 11);
    if (d.length > 10) return d.slice(0, 10);
    return d;
  }

  function isPhoneNumberField(key, label) {
    return /^phoneNumber$/i.test(key || "") || /^phone number$/i.test(String(label || "").trim());
  }

  function isCountryPhoneCodeField(key, label) {
    return /^countryPhoneCode$/i.test(key || "") || /country phone code/i.test(label || "");
  }

  // Exact USA (+1) row from a harvested option list (no soft +1 → Anguilla).
  function exactUsaPhoneCcOption(optionTexts) {
    const texts = (optionTexts || []).filter((t) => t && !isPlaceholderOption(t));
    return (
      texts.find((t) => D.norm(t) === D.norm(USA_PHONE_CC)) ||
      texts.find((t) => /united states of america/i.test(t) && /\(\+\s*1\s*\)/.test(t)) ||
      null
    );
  }

  // LLM prompts — primary way we get correct phone CC / phone number values.
  function phoneCountryCodeLlmHint(want) {
    const pref = String(want || USA_PHONE_CC).replace(/\s+/g, " ").trim() || USA_PHONE_CC;
    return (
      `Country Phone Code. Reply with ONE exact option text from the harvested list. ` +
      `Preferred: "${pref}". If the candidate uses +1 / US, you MUST pick ` +
      `"United States of America (+1)" (or the closest United States (+1) wording) — ` +
      `NEVER Anguilla, Jamaica, Barbados, Canada, or any other +1 territory when ` +
      `United States of America (+1) is in the list.`
    );
  }

  function phoneNumberLlmHint(want) {
    const digits = nationalPhoneDigits(want);
    return (
      `Phone Number field ONLY (Country Phone Code is a separate control). ` +
      `Reply with exactly 10 digits for a US number` +
      (digits ? ` (candidate: ${digits})` : "") +
      `. Do NOT include +, country code, spaces, dashes, or parentheses. Example: 8143133369.`
    );
  }

  // Put preferred dial-code first so it survives options[] caps (~120). This only
  // affects what the LLM *sees* in the truncated options array — not the answer.
  function prioritizeUsaPhoneCcTexts(texts) {
    const list = (texts || []).filter((t) => t && !isPlaceholderOption(t));
    const usa = exactUsaPhoneCcOption(list);
    if (!usa) return list;
    return [usa].concat(list.filter((t) => D.norm(t) !== D.norm(usa)));
  }

  function prioritizeUsaPhoneCcPortals(portalOptions) {
    const list = portalOptions || [];
    const usa = exactUsaPhoneCcOption(list.map((o) => o && o.text));
    if (!usa) return list;
    const hit = list.find((o) => o && D.norm(o.text) === D.norm(usa));
    if (!hit) return list;
    return [hit].concat(list.filter((o) => o && D.norm(o.text) !== D.norm(usa)));
  }

  // Exact snap of LLM/profile answer onto harvested phone-CC options.
  // NO override to USA — if the model returned an exact list row, use it.
  // Soft "+1" / substring matches are rejected (they falsely hit Anguilla).
  function snapExactPhoneCcAnswer(answer, options, portalOptions) {
    const texts = options && options.length
      ? options
      : (portalOptions || []).map((o) => o && o.text).filter(Boolean);
    const raw = typeof answer === "object" && answer
      ? String(answer.text || answer.value || answer.id || "")
      : String(answer || "");
    const n = D.norm(raw);
    if (!n || n === "1" || n === "+1") return null;
    if (portalOptions && portalOptions.length) {
      const exact =
        portalOptions.find((o) => D.norm(o.text) === n) ||
        portalOptions.find((o) => D.norm(o.value) === n) ||
        portalOptions.find((o) => D.norm(o.id) === n);
      if (exact && exact.text) return exact.text;
    }
    return exactOption(raw, texts) || null;
  }

  function portalChoiceExact(answer, portalOptions) {
    if (answer == null || answer === "" || !portalOptions || !portalOptions.length) return null;
    if (typeof answer === "object" && !Array.isArray(answer)) {
      const byId =
        answer.id && portalOptions.find((o) => D.norm(o.id) === D.norm(answer.id));
      if (byId) return byId;
      const byVal =
        answer.value && portalOptions.find((o) => D.norm(o.value) === D.norm(answer.value));
      if (byVal) return byVal;
      const byText =
        answer.text && portalOptions.find((o) => D.norm(o.text) === D.norm(answer.text));
      if (byText) return byText;
      return portalChoiceExact(answer.value || answer.id || answer.text || "", portalOptions);
    }
    const raw = String(answer).replace(/\s+/g, " ").trim();
    const n = D.norm(raw);
    if (!n || isPlaceholderOption(raw)) return null;
    return (
      portalOptions.find((o) => D.norm(o.text) === n) ||
      portalOptions.find((o) => D.norm(o.value) === n) ||
      portalOptions.find((o) => D.norm(o.id) === n) ||
      null
    );
  }

  // Workday's State/Province dropdown lists full names ("California"), but the
  // profile stores the postal abbreviation ("CA"). Expand known US codes so the
  // option text matches; pass anything else (full names, non-US regions) through.
  const US_STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
    FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
    IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
    ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
    NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
    WY: "Wyoming", PR: "Puerto Rico",
  };
  function expandState(s) {
    if (!s) return s;
    const key = String(s).trim().toUpperCase();
    return US_STATES[key] || s;
  }

  // Country dropdowns list "United States of America" but also the easily-confused
  // "United States Minor Outlying Islands" right above it. Profiles often store a
  // short variant ("United States" / "USA" / "US"); canonicalize so the exact
  // option is matched instead of the first one that merely contains "united states".
  function canonCountry(s) {
    if (!s) return s;
    const k = D.norm(s).replace(/[.\s]/g, "");
    if (["us", "usa", "unitedstates", "unitedstatesofamerica", "america", "unitedstatesamerica"].includes(k)) {
      return "United States of America";
    }
    return s;
  }

  // Workday's Social Network URL fields validate as full URLs. Profiles often
  // store a bare handle/host ("linkedin.com/in/x"), so prepend https:// when no
  // scheme is present. Returns "" for empty input.
  function canonUrl(s) {
    const v = String(s || "").trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    return "https://" + v.replace(/^\/+/, "");
  }

  // Workday's LinkedIn field (validation code A1647) rejects bare-host URLs like
  // "https://linkedin.com/in/x" - it requires the canonical "www.linkedin.com"
  // host. Normalize any stored form (bare handle, host w/ or w/o scheme/www) to
  // "https://www.linkedin.com/in/<handle>".
  function canonLinkedIn(s) {
    let v = String(s || "").trim();
    if (!v) return "";
    v = v.replace(/^https?:\/\//i, "").replace(/^\/+/, "");
    if (/^(www\.)?linkedin\.com\//i.test(v)) {
      v = v.replace(/^www\./i, "");
      return "https://www." + v;
    }
    // Bare handle (e.g. "kzwang" or "in/kzwang") - build the profile URL.
    v = v.replace(/^@/, "").replace(/^in\//i, "");
    return "https://www.linkedin.com/in/" + v;
  }

  // Strip Markdown so a plain-text form field (Workday Role Description) never
  // shows readme markup like **bold**. Mirrors the backend sanitizer and is
  // applied client-side too, so the field is clean regardless of the profile
  // source. Keeps line breaks and "- " bullets; preserves lone */_ (e.g. the
  // identifier feature_store) - only PAIRED **/__/` are removed.
  function stripMarkdown(text) {
    let s = String(text == null ? "" : text);
    if (!s) return "";
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links
    s = s.replace(/\*\*([\s\S]+?)\*\*/g, "$1"); // **bold**
    s = s.replace(/__([\s\S]+?)__/g, "$1"); // __bold__
    s = s.replace(/`([^`]+)`/g, "$1"); // `code`
    s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, ""); // headings
    s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, ""); // blockquotes
    s = s.replace(/^(\s*)[*+][ \t]+/gm, "$1- "); // *,+ bullets -> "- "
    s = s.replace(/\*\*/g, ""); // any stray/unbalanced bold markers
    return s
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Today's date as MM/DD/YYYY. The Self-Identify (CC-305) signature date must be
  // "today" on every fill, so it is generated fresh rather than stored.
  function todayDate() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  // Best label match among a set of grouped inputs (radio OR a one-of checkbox
  // group). Same precedence as pickOption: exact > option-contains-want (shortest)
  // > want-contains-option (longest). Returns the matching input or null.
  function pickByLabel(inputs, value) {
    const w = D.norm(value);
    const scored = inputs.map((el) => ({ el, t: D.norm(labelForInput(el)) })).filter((x) => x.t);
    const exact = scored.find((x) => x.t === w);
    if (exact) return exact.el;
    const contains = scored.filter((x) => x.t.includes(w)).sort((a, b) => a.t.length - b.t.length);
    if (contains.length) return contains[0].el;
    const within = scored.filter((x) => w.includes(x.t)).sort((a, b) => b.t.length - a.t.length);
    if (within.length) return within[0].el;
    return null;
  }

  function buildValueMap(p) {
    const name = p.name || {};
    const c = p.contact || {};
    const a = p.address || {};
    const w = p.websites || {};
    const cc = String(c.phoneCountryCode || "").replace(/\D/g, "") || "1";
    const map = {
      source: p.howDidYouHear,
      country: canonCountry(a.country),
      // Social Network URLs (My Experience page) - keyed by the formField id.
      // Workday validates these as full URLs, so ensure an https:// scheme.
      linkedInAccount: canonLinkedIn(w.linkedin),
      facebookAccount: canonUrl(w.facebook),
      twitterAccount: canonUrl(w.twitter),
      "legalName--firstName": name.first,
      "legalName--middleName": name.middle,
      "legalName--lastName": name.last,
      addressLine1: a.line1,
      addressLine2: a.line2,
      city: a.city,
      countryRegion: expandState(a.state),
      postalCode: a.postalCode,
      phoneType: c.phoneDeviceType,
      // Prefer full USA label — never a bare "+1" that snaps to Anguilla.
      countryPhoneCode: PHONE_CC_LABEL[cc] || (cc === "1" ? USA_PHONE_CC : undefined),
      // National digits only (no country code) — Workday validates format separately.
      phoneNumber: nationalPhoneDigits(c.phone),
      // Workday My Information often uses formField-emailAddress (DraftKings proof:
      // v12 skipped LLM for free-text without want → Email APPLY no-value).
      emailAddress: c.email,
      // Stable Workday key for "Have you been employed by <Company> previously?".
      // A fresh applicant has not worked there before → default No (independent of
      // the company name in the label, so it never relies on label keyword rules).
      candidateIsPreviousWorker: "No",
    };
    return map;
  }

  // Known company / EEO / screening labels → profile facts as HINTS only.
  // Option-bearing Workday controls must NOT apply these strings via writeField;
  // fillStep routes those to harvest → LLM → snapToHarvestedOption. This helper
  // remains for free-text labels (cover letter, name) and emergency local snap.
  function resolveByLabel(label, p) {
    if (!label) return undefined;
    const e = p.eeo || {};
    const nm = p.name || {};
    const fullName = [nm.first, nm.last].filter(Boolean).join(" ").trim();
    const low = label.toLowerCase();
    // CrowdStrike / similar: long "Acknowledgment" Canvas Select about generative AI
    // in interviews. MUST resolve before the disability EEO rule — the same label
    // contains "disability or other condition" and bare /disability/ would return
    // the CC-305 EEO string, which is NOT an option (live probe).
    if (isAcknowledgmentSelectLabel(low)) return "Yes";
    // CrowdStrike AQ "Do you need a reasonable accommodation due to a disability…"
    // also contains "disability". Bare /disability/ previously returned the CC-305
    // string; pickOption then fuzzy-matched option "No" via w.includes("no") so the
    // UI showed No while resolve/recovery stayed unstable (panel: Couldn't resolve).
    if (isReasonableAccommodationLabel(low)) return "No";
    if (/highest degree|degree attained/.test(low) && Array.isArray(p.education)) {
      for (let i = p.education.length - 1; i >= 0; i--) {
        const deg = p.education[i] && p.education[i].degree;
        if (deg) return deg;
      }
    }
    if (/accept these terms|yes i accept/i.test(low)) return "Yes";
    if (/cover\s*letter/i.test(low) && p.coverLetter) return p.coverLetter;
    // Email — buildValueMap keys emailAddress; label-only "Email" still needs this.
    const contactEmail = (p.contact && p.contact.email) || p.email;
    if (/^e-?mail(\s*address)?$/i.test(low.trim()) && contactEmail) return contactEmail;
    if (/\bemail\b/i.test(low) && !/employee|employer|manager|referr/i.test(low) && contactEmail) {
      return contactEmail;
    }
    // CC-305 / OFCCP disability self-ID ONLY — never bare /disability/ (hits
    // Acknowledgment + reasonable-accommodation Application Questions).
    if (isDisabilitySelfIdLabel(low)) {
      return e.disability
        ? "Yes, I have a disability"
        : "No, I do not have a disability and have not had one in the past";
    }
    const RULES = [
      // Self-Identify (CC-305) "Name" - a standalone full-name field. The keyed
      // legalName--first/last fields are resolved by buildValueMap and never reach
      // here, and "Preferred/Legal Name" labels won't match the strict ^name$.
      [/^name$/i, fullName],
      // Order-independent: catches "previously been employed", "been employed by
      // <Company> previously", "ever worked for", "worked here before", etc. Note:
      // no \b after employ/work - "employ" must match the stem in "employed".
      [/(previously|formerly|prior|before|ever)[\s\S]{0,40}?(employ|work)/i, "No"],
      [/(employ|work)[\s\S]{0,40}?(previously|formerly|prior|before)/i, "No"],
      [/legally (eligible|authorized) to work|authorized to work|legal right to work/i, "Yes"],
      [/relatives employed|relative.*employed by/i, "No"],
      [/contractual restrictions|restrict your employment|non-compete|non-disclosure/i, "No"],
      [/non-solicitation|prospect for business/i, "No"],
      [/outside activities.*competitive|competition with|in competition with/i, "No"],
      [/required years of relevant experience|years of relevant experience needed/i, "Yes"],
      [/software language|network technologies needed/i, "Yes"],
      [/employed by a federal.*government|government entity \(excluding military/i, "No"],
      [/award or administration of any contracts.*defense|department of defense/i, "No"],
      [/projects.*contracts.*procurements.*involved/i, "No"],
      [/agree to receive text messages|receive text messages from/i, "Yes"],
      // "relocating" must match — `\brelocate\b` does NOT (word boundary fails on -ing).
      [/relocat/i, "No"],
      // Workday: "Do you now or in the future require any immigration filing or visa sponsorship…"
      // Old patterns required adjacent "require sponsorship" and missed this wording.
      [
        /sponsorship|immigration filing|work visa|visa sponsorship|open work permit|permanent residency/i,
        e.sponsorship ? "Yes" : "No",
      ],
      [/do you now or in the future require|will you now or in the future require|might you in the future require/i, e.sponsorship ? "Yes" : "No"],
      [/use or work on the workday|work on the workday system|workday system/i, "No"],
      [/current or former employee of the united states government|u\.?\s*s\.?\s*government employee|employee of the united states government/i, "No"],
      // Export-control restricted countries/regions question (keep anchored to that topic).
      [/export control|citizen, national or resident of any of the following countries|iran,\s*cuba,\s*north korea|donetsk|luhansk/i, "No"],
      [/related to a current .+ employee|related to.*workday employee|related to a current workday/i, "No"],
      [/related to an employee of a customer|government official.*business interactions|direct business interactions with/i, "No"],
      // Long acknowledgement Canvas Select — must choose Yes (Workday rejects No).
      [
        /please enter ["']?yes["']? if you acknowledge|acknowledge that i have read|answered them truthfully and accurately|acknowledgment|i acknowledge that i|generative ai platforms|unauthorized assistance during the interview|agree to comply with these terms/i,
        "Yes",
      ],
      [/accept these terms|yes i accept/i, "Yes"],
      [/at least 18|18 years of age/i, "Yes"],
      [/non-disclosure|non-compete|non-competitive|restrict your employment/i, "No"],
      [/hispanic or latino/i, e.hispanicLatino ? "Yes" : "No"],
      [/gender/i, e.gender],
      [/sexual orientation|lgbtq/i, e.sexualOrientation || "I don't wish to answer"],
      [/what is your race|race\/ethnicity|ethnicity|\brace\b/i, e.ethnicity],
      // Sentinel resolved against the tenant's live options in writeField —
      // UPS/OFCCP wording varies ("I AM NOT A VETERAN", decline-to-disclose, …).
      [/veteran/i, e.veteran === true ? "__EEO_VETERAN_TRUE__" : "__EEO_VETERAN_FALSE__"],
      // EEO disability ONLY — never match interview Acknowledgment (contains "disability").
      // Never match Voluntary "Self-Identification of Ethnicity/Gender/Veteran" (no disability).
      [
        /(?:do you have a disability|i have a disability|no,? i do not have a disability|cc-305|disability status)|(?:self.identif.*disability|disability.*self.identif)/i,
        e.disability ? "Yes" : "No, I do not have a disability",
      ],
    ];
    for (const [re, val] of RULES) {
      if (re.test(label) && val != null && val !== "") return val;
    }
    return undefined;
  }

  // Interview / generative-AI Acknowledgment selects (CrowdStrike Application Questions).
  function isAcknowledgmentSelectLabel(labelOrLow) {
    const low = String(labelOrLow || "").toLowerCase();
    if (!low) return false;
    return (
      /acknowledgment/.test(low) ||
      /i acknowledge that i/.test(low) ||
      /generative ai platforms/.test(low) ||
      /unauthorized assistance during the interview/.test(low) ||
      /personally participate in all interviews/.test(low)
    );
  }

  // Application-process accommodation asks (not CC-305 disability self-ID).
  function isReasonableAccommodationLabel(labelOrLow) {
    const low = String(labelOrLow || "").toLowerCase();
    if (!low) return false;
    return (
      /reasonable accommodation/.test(low) ||
      /accommodation due to/.test(low) ||
      /medical need for applying/.test(low) ||
      /need an accommodation/.test(low) ||
      /request.*accommodation/.test(low)
    );
  }

  // True CC-305 / EEO disability self-identification wording only.
  // CRITICAL: Zillow Voluntary Disclosures uses labels
  //   "Self-Identification of Ethnicity / Gender / Veteran…"
  // Bare /self.identif/ matched those and (via isDisabilityContainer) diverted them
  // OUT of harvest→LLM→apply into fillDisabilitySelfId, which only clicks CC-305
  // disability checkboxes — so Ethnicity/Gender/Veteran never reached the LLM and
  // Review kept "No Response".
  function isDisabilitySelfIdLabel(labelOrLow) {
    const low = String(labelOrLow || "").toLowerCase();
    if (!low) return false;
    if (isAcknowledgmentSelectLabel(low) || isReasonableAccommodationLabel(low)) return false;
    // "Self-Identification of Ethnicity/Gender/Veteran" ≠ CC-305 disability.
    if (/self.identif/i.test(low) && !/disability/i.test(low)) return false;
    if (/self.identif/i.test(low) && /disability/i.test(low)) return true;
    return /please check one of the boxes|cc-305|do you have a disability|i have a disability|no,? i do not have a disability|disability status|had one in the past|without a disability/i.test(
      low,
    );
  }

  // Pick the live "Yes, I acknowledge…" option text (proven on CrowdStrike).
  function acknowledgmentYesOption(options) {
    const real = (options || []).map((o) => String(o || "").replace(/\s+/g, " ").trim()).filter((t) => t && !isPlaceholderOption(t));
    return (
      real.find((t) => /^yes\b/i.test(t) && /acknowledge/i.test(t)) ||
      real.find((t) => /^yes\b/i.test(t) && /agree/i.test(t)) ||
      real.find((t) => /^yes\b/i.test(t)) ||
      null
    );
  }

  // ── control-aware writers ───────────────────────────────────────────────────
  // ROOT CAUSE (proven on live Workday + side panel): autofill is started from the
  // extension side panel, so document.hasFocus() === false on the application tab.
  // setReactValue + input makes the value VISIBLE in the input, but Workday commits
  // its React model on blur/focusout - and browsers suppress those events when the
  // document lacks OS focus. focusPageAndFlush() activates the tab but Chrome keeps
  // focus in the side panel, so flushCommits()'s hasFocus gate never runs and
  // "Save and Continue" validates against an empty model → red "required" errors
  // on fields that already show text (First Name, City, Phone, …). Dropdowns/radios
  // work because they commit via click, not blur.
  function setReactValue(el, value) {
    // Must only run on real text controls. Calling HTMLInputElement's value
    // setter on a <button aria-haspopup=listbox> throws "Illegal invocation"
    // (exactly the error that aborted Application Questions autofill).
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const prev = el.value;
    if (desc && typeof desc.set === "function") desc.set.call(el, String(value));
    else el.value = String(value);
    // Rewind React's value tracker so the input event registers as a real change
    // and Workday's onInput updates the model (it binds onInput, not onChange).
    if (el._valueTracker) el._valueTracker.setValue(prev);
  }

  function makeSink(doc) {
    const sink = doc.createElement("button");
    sink.type = "button";
    sink.tabIndex = -1;
    sink.setAttribute("aria-hidden", "true");
    sink.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
    (doc.body || doc.documentElement).appendChild(sink);
    return sink;
  }

  function fireKey(el, key, code, keyCode) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, keyCode, which: keyCode }),
      );
    }
  }

  function keyMetaForChar(ch) {
    if (/[0-9]/.test(ch)) return { code: "Digit" + ch, keyCode: 48 + Number(ch) };
    if (ch === " ") return { code: "Space", keyCode: 32 };
    if (ch === "-") return { code: "Minus", keyCode: 189 };
    if (ch === ".") return { code: "Period", keyCode: 190 };
    const upper = ch.toUpperCase();
    return { code: "Key" + upper, keyCode: upper.charCodeAt(0) };
  }

  // Explicit focusout/blur - browsers won't auto-fire these without OS focus, but
  // Workday's React handlers still receive manually dispatched FocusEvents.
  function dispatchBlurCommit(el, sink) {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: true, relatedTarget: sink }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true, cancelable: true, relatedTarget: sink }));
  }

  function fieldStillInvalid(el) {
    if (!el || !el.isConnected) return false;
    if (el.getAttribute("aria-invalid") === "true") return true;
    const ff = el.closest('[data-automation-id^="formField-"]');
    return !!(ff && ff.querySelector('[aria-invalid="true"]'));
  }

  function typeIntoInput(el, value) {
    const str = String(value);
    try {
      el.focus({ preventScroll: true });
    } catch {}
    setReactValue(el, "");
    fireKey(el, "Backspace", "Backspace", 8);
    for (const ch of str) {
      const { code, keyCode } = keyMetaForChar(ch);
      fireKey(el, ch, code, keyCode);
    }
    setReactValue(el, str);
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: str }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Legacy queue - kept so WD_FLUSH can drain anything queued by an older build.
  const pendingCommits = (WD._pendingCommits = WD._pendingCommits || []);

  function commitControlledInputs(applyValue, els) {
    applyValue();
    const doc = (els.find((el) => el && el.isConnected) || {}).ownerDocument || document;
    const sink = makeSink(doc);
    for (const el of els) {
      if (!el || !el.isConnected) continue;
      try {
        el.focus({ preventScroll: true });
      } catch {}
      dispatchBlurCommit(el, sink);
    }
    try {
      sink.focus({ preventScroll: true });
    } catch {}
    sink.remove();
  }

  function flushCommits() {
    if (!pendingCommits.length) return;
    for (const item of pendingCommits.splice(0)) {
      try {
        commitControlledInputs(item.applyValue, item.els);
      } catch {}
    }
  }

  function armFocusFlush() {
    if (WD._focusFlushArmed) return;
    WD._focusFlushArmed = true;
    window.addEventListener("focus", flushCommits, true);
    document.addEventListener("pointerdown", flushCommits, true);
  }

  // Commit controlled text/date inputs without requiring OS focus on the tab.
  async function deferOrCommit(applyValue, els, retryValues) {
    commitControlledInputs(applyValue, els);
    await D.delay(80);
    const retry = els.filter((el) => el && el.isConnected && fieldStillInvalid(el));
    if (retry.length) {
      for (const el of retry) {
        const v = (retryValues && retryValues.get(el)) ?? el.value;
        if (v != null && v !== "") typeIntoInput(el, v);
      }
      commitControlledInputs(() => {}, retry);
      await D.delay(50);
    }
  }

  async function writeTextEl(el, value) {
    // Do not center the page on every text field — that recreated harvest scroll thrash on APPLY.
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    } catch {}
    const str = String(value);
    const retryValues = new Map([[el, str]]);
    const applyValue = () => {
      setReactValue(el, str);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: str }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await deferOrCommit(applyValue, [el], retryValues);
    return true;
  }

  function visibleOptions(root) {
    return D.qa(OPTION_SEL, root).filter((o) => {
      if (!D.isVisible(o)) return false;
      // CrowdStrike portal: placeholder row is aria-disabled + aria-selected.
      if (o.getAttribute("aria-disabled") === "true" || o.hasAttribute("disabled")) return false;
      return true;
    });
  }

  function optionTextClean(el) {
    return ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  }

  // True empty-state rows — including "No Items." with trailing punct.
  function isEmptyPromptRow(text) {
    const t = D.norm(text);
    return !t || /^(no items|no results)\.?$/.test(t);
  }

  // Option nodes inside a formField's committed display (selected LinkedIn chip,
  // etc.) must NEVER be harvested as another field's open-list options.
  // Live proof: Country Phone Code harvest returned [{"text":"LinkedIn"}].
  function isCommittedFieldOption(el) {
    if (!el) return false;
    if (el.closest('[data-automation-id="selectedItem"], [data-automation-id="pill"]')) return true;
    const inOpenList = el.closest(
      '[data-automation-id="activeListContainer"], [data-automation-id="promptOptionList"], .ReactVirtualized__List, [data-behavior-click-outside-close], [data-popper-placement]',
    );
    if (inOpenList) return false;
    if (el.closest('[data-automation-id^="formField-"]')) return true;
    return false;
  }

  // Open multi-select list portal. NEVER fall back to document (cross-field leak).
  function activeMultiListRoot(ownerMulti) {
    if (ownerMulti) {
      const input = ownerMulti.querySelector("input");
      const controls = (input && input.getAttribute("aria-controls")) || "";
      for (const id of controls.split(/\s+/).filter(Boolean)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const root =
          el.closest('[data-automation-id="activeListContainer"]') ||
          el.closest('[data-automation-id="promptOptionList"]') ||
          el.closest(".ReactVirtualized__List") ||
          el.closest("[data-behavior-click-outside-close]") ||
          el;
        if (root && D.isVisible(root)) return root;
      }
    }
    const portals = D.qa(
      '[data-automation-id="activeListContainer"], [data-automation-id="promptOptionList"], .ReactVirtualized__List, [data-behavior-click-outside-close] [role="listbox"]',
    ).filter((p) => D.isVisible(p) && !p.closest('[data-automation-id^="formField-"]'));
    return portals.length ? portals[portals.length - 1] : null;
  }

  // Folder vs leaf in hierarchical How-Did-You-Hear prompts (Allstate DOM).
  function isHierarchicalMultiOption(el) {
    if (!el) return false;
    const type = el.getAttribute("data-uxi-multiselectlistitem-type") || "";
    if (type === "2") return true;
    if ((el.getAttribute("hassidecharm") || "").toLowerCase() === "true") return true;
    if (el.querySelector('[data-automation-id="promptOptionChevron"], [data-automation-id="chevron"]')) return true;
    return false;
  }

  function looksLikeSourceCategory(text) {
    return /job\s*boards?|referral|career\s*site|company\s*(web)?site|social\s*media|recruiter|agency|staffing|advertisement|campus|event|job\s*fair|\bother\b|internal/i.test(
      text || "",
    );
  }

  // Read currently-visible multi/prompt option rows with hierarchy metadata.
  // Pass the open list portal as `root`; never use document.
  function readMultiOptionRows(root) {
    const scope = root || activeMultiListRoot();
    if (!scope) return [];
    const nodes = D.qa(
      '[data-automation-id="menuItem"], [role="option"], [data-automation-id="promptOption"]',
      scope,
    ).filter((o) => {
      if (!D.isVisible(o)) return false;
      if (isCommittedFieldOption(o)) return false;
      if (o.getAttribute("aria-disabled") === "true" || o.hasAttribute("disabled")) return false;
      return true;
    });
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const row =
        el.closest('[data-automation-id="menuItem"]') ||
        el.closest('[role="option"]') ||
        el;
      const text = optionTextClean(
        row.querySelector('[data-automation-id="promptOption"]') || row,
      );
      if (!text || isPlaceholderOption(text) || isEmptyPromptRow(text)) continue;
      const k = D.norm(text);
      if (seen.has(k)) continue;
      seen.add(k);
      const id = (row.id || "").trim();
      const value = (row.getAttribute("data-value") || row.getAttribute("value") || id || text).trim();
      out.push({
        el: row,
        id: id || value || text,
        value: value || id || text,
        text,
        hierarchical: isHierarchicalMultiOption(row),
      });
    }
    return out;
  }

  // Options appear hundreds of ms after open/select. Wait until the visible
  // count is stable (not just the first matching OPTION_SEL node).
  async function waitForOptionsSettled(opts) {
    const timeout = (opts && opts.timeout) || 4000;
    const settleMs = (opts && opts.settleMs) || 280;
    const root = opts && opts.root;
    const ownerMulti = opts && opts.ownerMulti;
    const minCount = (opts && opts.minCount) || 1;
    const end = Date.now() + timeout;
    let lastCount = -1;
    let stableSince = 0;
    while (Date.now() < end) {
      throwIfAborted();
      const listRoot = root || activeMultiListRoot(ownerMulti);
      const rows = listRoot ? readMultiOptionRows(listRoot) : [];
      const n = rows.length;
      if (n >= minCount) {
        if (n === lastCount) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= settleMs) return rows;
        } else {
          lastCount = n;
          stableSince = Date.now();
        }
      } else {
        lastCount = n;
        stableSince = 0;
      }
      await D.delay(80);
    }
    const listRoot = root || activeMultiListRoot(ownerMulti);
    return listRoot ? readMultiOptionRows(listRoot) : [];
  }

  // After clicking an L1 category, wait for drill-down UI (header/back) or a
  // leaf-only list — prompt must stay open.
  async function waitForSourceDrillDown(ms, ownerMulti) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) {
      throwIfAborted();
      if (
        D.q('[data-automation-id="multiSelectHeader"]') ||
        D.q('[data-automation-id="promptTitle"]') ||
        D.q('[data-automation-id="backButton"]')
      ) {
        await waitForOptionsSettled({ timeout: 2500, settleMs: 220, ownerMulti });
        return true;
      }
      const rows = readMultiOptionRows(activeMultiListRoot(ownerMulti));
      if (rows.length && rows.every((r) => !r.hierarchical)) {
        await D.delay(180);
        return true;
      }
      await D.delay(100);
    }
    return false;
  }

  function multiListScroller(ownerMulti) {
    const root0 = activeMultiListRoot(ownerMulti);
    return (
      (root0 &&
        (root0.querySelector(".ReactVirtualized__List") ||
          (root0.classList && root0.classList.contains("ReactVirtualized__List") && root0) ||
          root0)) ||
      D.q('[data-automation-id="activeListContainer"]') ||
      D.q(".ReactVirtualized__List") ||
      null
    );
  }

  function multiListNeedsScroll(ownerMulti) {
    const scroller = multiListScroller(ownerMulti);
    if (!scroller) return false;
    return (scroller.scrollHeight || 0) > (scroller.clientHeight || 0) + 40;
  }

  function isMultiListOpen(ownerMulti) {
    return !!(ownerMulti && activeMultiListRoot(ownerMulti));
  }

  // Scroll a virtualized multi list so off-DOM rows enter the harvest set.
  // resetToTop:false keeps the viewport at the bottom (USA dial codes live near
  // the end) so a keep-open APPLY can click without scrolling the list again.
  async function scrollCollectMultiOptions(ownerMulti, opts) {
    const resetToTop = !(opts && opts.resetToTop === false);
    const seen = new Map();
    const ingest = () => {
      const root = activeMultiListRoot(ownerMulti);
      if (!root) return;
      for (const row of readMultiOptionRows(root)) {
        const k = D.norm(row.text);
        if (!seen.has(k)) seen.set(k, { id: row.id, value: row.value, text: row.text, hierarchical: row.hierarchical });
      }
    };
    ingest();
    const scroller = multiListScroller(ownerMulti);
    if (scroller) {
      let lastSize = seen.size;
      let stable = 0;
      for (let i = 0; i < 90; i++) {
        throwIfAborted();
        const maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
        const next = Math.min((scroller.scrollTop || 0) + Math.max(40, (scroller.clientHeight || 120) * 0.85), maxScroll);
        scroller.scrollTop = next;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await D.delay(80);
        ingest();
        if (seen.size === lastSize) {
          stable++;
          if (stable >= 4) break;
        } else {
          stable = 0;
          lastSize = seen.size;
        }
        if (next >= maxScroll - 1) {
          await D.delay(100);
          ingest();
          break;
        }
      }
      if (resetToTop) {
        try {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        } catch {}
        await D.delay(80);
        ingest();
      }
    }
    return [...seen.values()];
  }

  function listRootBelongsToMulti(listEl, multi) {
    if (!listEl || !multi) return false;
    const exceptRoot = activeMultiListRoot(multi);
    if (!exceptRoot) return false;
    return listEl === exceptRoot || exceptRoot.contains(listEl) || listEl.contains(exceptRoot);
  }

  async function closeForeignPrompts(exceptMulti) {
    const openList = D.q(
      '[data-automation-id="activeListContainer"], [data-behavior-click-outside-close] [role="listbox"]',
    );
    if (openList && D.isVisible(openList) && !listRootBelongsToMulti(openList, exceptMulti)) {
      pressKey(document.body, "Escape", "Escape", 27);
      await D.delay(120);
    }
    for (const multi of D.qa('[data-automation-id="multiSelectContainer"]')) {
      if (exceptMulti && multi === exceptMulti) continue;
      const input = multi.querySelector("input");
      if (!input) continue;
      const ae = document.activeElement;
      if (ae === input || (ae && multi.contains(ae))) {
        await closePrompt(multi, input);
      }
    }
    // focusSinkOutside closes keep-open lists via outside click — skip when protecting one.
    if (!(exceptMulti && isMultiListOpen(exceptMulti))) {
      focusSinkOutside(document);
      await D.delay(80);
    }
  }

  async function openMultiPrompt(multi) {
    if (!multi) return null;
    await closeForeignPrompts(multi);
    const input = multi.querySelector("input");
    if (!input) return null;
    const opener = multi.querySelector('[data-automation-id="multiselectInputContainer"]') || input;
    D.clickEl(opener);
    input.focus();
    await D.delay(150);
    return input;
  }

  function findMultiOptionByText(want, ownerMulti) {
    const w = D.norm(want);
    if (!w) return null;
    const rows = readMultiOptionRows(activeMultiListRoot(ownerMulti));
    const exact = rows.find((r) => D.norm(r.text) === w);
    if (exact) return exact.el;
    const contains = rows
      .filter((r) => D.norm(r.text).includes(w) || w.includes(D.norm(r.text)))
      .sort((a, b) => a.text.length - b.text.length);
    return contains.length ? contains[0].el : null;
  }

  // Canvas multi/prompt rows often ignore a plain row click — same defect as School.
  // Proven fix: pointer-click the row, then promptOption text, then any checkbox/radio.
  async function clickMultiOptionRow(el) {
    if (!el) return false;
    const row =
      el.closest('[data-automation-id="menuItem"]') ||
      el.closest('[role="option"]') ||
      el;
    // Allstate Country Phone Code: promptLeafNode (no native checkbox inputs).
    const leaf = row.querySelector('[data-automation-id="promptLeafNode"]');
    const promptOpt = row.querySelector('[data-automation-id="promptOption"]') || row;
    if (leaf) {
      firePointerClick(leaf);
      await D.delay(120);
    }
    firePointerClick(row);
    await D.delay(120);
    if (promptOpt && promptOpt !== row && promptOpt !== leaf) {
      firePointerClick(promptOpt);
      await D.delay(120);
    }
    const box = row.querySelector('input[type="checkbox"], input[type="radio"]');
    if (box) {
      firePointerClick(box);
      await D.delay(150);
    }
    return true;
  }

  // Poll until this multi shows a committed selection (chip / aria count).
  async function waitUntilMultiCommitted(multi, want, ms) {
    const end = Date.now() + (ms || 1500);
    while (Date.now() < end) {
      if (promptChosen(multi, want) || promptChosen(multi, "")) return true;
      await D.delay(100);
    }
    return promptChosen(multi, want) || promptChosen(multi, "");
  }

  // Type queries for virtualized Country Phone Code (full label often filters poorly).
  // Never lead with bare "+1" — that surfaces Anguilla before United States.
  function multiTypeQueries(value) {
    const v = String(value || "").replace(/\s+/g, " ").trim();
    const out = [];
    const push = (s) => {
      const t = String(s || "").replace(/\s+/g, " ").trim();
      if (t && !out.some((x) => D.norm(x) === D.norm(t))) out.push(t);
    };
    push(v);
    if (/united states|\(\+\s*1\s*\)/i.test(v) || D.norm(v) === "+1" || D.norm(v) === "1") {
      push(USA_PHONE_CC);
      push("United States of America");
      push("United States");
    }
    push(v.replace(/\s*\(\+\d+\)\s*$/, "").trim());
    const cc = v.match(/\(\+(\d+)\)/);
    // Digits-only filter last (many +1 territories); click path prefers USA.
    if (cc) push("+" + cc[1]);
    return out;
  }

  // Real, selectable result rows of an OPEN prompt.
  //
  // Two DOM facts (from the live Siemens Healthineers page) make a naive
  // visibleOptions() scan wrong:
  //   1. A COMMITTED pill contains its own
  //      <p data-automation-id="promptOption">Computer Engineering</p>, so the
  //      global scan "finds" an option for a field that has no list open at all.
  //   2. While a server search is in flight the list renders a literal
  //      "No Items" row.
  // Exclude both so we only ever Enter/click against genuine search results.
  function promptResultOptions(root) {
    return visibleOptions(root).filter((o) => {
      if (o.closest('[data-automation-id="selectedItem"], [data-automation-id="pill"]')) return false;
      // Use isEmptyPromptRow — plain "no items" miss rejects "No Items." (period),
      // which Zillow skills typeahead shows while search is in flight.
      return !isEmptyPromptRow(o.textContent);
    });
  }

  function pickResultOption(want, root) {
    const w = D.norm(want);
    const scored = promptResultOptions(root)
      .map((o) => ({ o, t: D.norm(o.textContent) }))
      .filter((x) => x.t);
    const exact = scored.find((x) => x.t === w);
    if (exact) return exact.o;
    const contains = scored.filter((x) => x.t.includes(w)).sort((a, b) => a.t.length - b.t.length);
    if (contains.length) return contains[0].o;
    return null;
  }

  // Workday Canvas prompt rows select on POINTER events. D.clickEl only fires
  // mousedown/mouseup/click - no pointerdown - which is why clicking a highlighted
  // search-result row silently did nothing and the School prompt stayed empty.
  // Fire the full pointer+mouse sequence a real user generates.
  //
  // NEVER scroll the page to center the trigger (block:"center") — that caused
  // the GDIT My Info harvest thrash (open source → scroll, open suffix → scroll,
  // open state → scroll, …). Portals float; triggers do not need to be centered.
  // Options inside an open list may use scroll:"nearest" only.
  function firePointerClick(el, opts) {
    if (!el) return;
    const mode = opts && opts.scroll;
    if (mode === "center" || mode === true) {
      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      } catch {}
    } else if (mode === "nearest") {
      try {
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      } catch {}
    }
    // mode falsy / "none": no scroll — open dropdowns in place.
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
    };
    for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        const Ctor = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, init));
      } catch {}
    }
  }

  // Some Workday builds do NOT honor a fully-synthetic option click — React only
  // commits on a trusted click. This is the SAME class of failure already proven
  // in this repo for checkboxes (the fix there was a native input.click()). So
  // fire the synthetic pointer/mouse sequence (drives hover/focus state) AND a
  // native .click() as a backstop. The isConnected guard makes the native click a
  // no-op when the first click already committed and Workday detached the option
  // from its portal — so this never double-toggles a working tenant.
  function pointerClickWithNativeBackstop(el, opts) {
    firePointerClick(el, opts);
    try {
      if (el && el.isConnected && typeof el.click === "function") el.click();
    } catch {}
  }

  // ARIA listbox contract: the committed option carries aria-selected="true"
  // (Workday sets this on the <li role="option">, NOT on hover — the highlighted
  // option is tracked via the input's aria-activedescendant instead). This is the
  // authoritative commit signal and does NOT depend on the trigger button's text
  // finalizing, which some tenants only do AFTER the popup closes.
  function portalOptionLooksSelected(match, popup, choice, want) {
    try {
      if (match && match.getAttribute && match.getAttribute("aria-selected") === "true") return true;
      const root = popup && popup.querySelectorAll ? popup : document;
      const sels = D.qa('[role="option"][aria-selected="true"]', root);
      for (const el of sels) {
        const id = (el.id || "").trim();
        const val = (el.getAttribute("data-value") || el.getAttribute("value") || "").trim();
        const t = D.norm(el.textContent);
        if ((choice && choice.id && id === choice.id) || (choice && choice.value && val === choice.value)) return true;
        if (want && t && (t === want || t.includes(want) || want.includes(t))) return true;
      }
    } catch {}
    return false;
  }

  function pickOption(want, root) {
    const w = D.norm(want);
    const scored = visibleOptions(root)
      .map((o) => ({
        o,
        t: D.norm(o.textContent),
        id: (o.id || "").trim(),
        val: (o.getAttribute("data-value") || o.getAttribute("value") || "").trim(),
      }))
      .filter((x) => x.t && !isCommittedFieldOption(x.o) && !isEmptyPromptRow(x.t));
    // 0. Match by option element id or data-value (CrowdStrike portal proof).
    if (w) {
      const byId = scored.find((x) => D.norm(x.id) === w || D.norm(x.val) === w);
      if (byId) return byId.o;
    }
    // 1. Exact text match always wins.
    const exact = scored.find((x) => x.t === w);
    if (exact) return exact.o;
    // 2. Options whose text CONTAINS the wanted value - pick the SHORTEST so a
    //    prefix like "united states" resolves to "united states of america", not
    //    the longer "united states minor outlying islands" that happens to sort
    //    first in the list.
    const contains = scored.filter((x) => x.t.includes(w)).sort((a, b) => a.t.length - b.t.length);
    if (contains.length) return contains[0].o;
    // 3. Wanted value contains the option text - pick the LONGEST (most specific).
    const within = scored.filter((x) => w.includes(x.t)).sort((a, b) => b.t.length - a.t.length);
    if (within.length) return within[0].o;
    return null;
  }

  // Read live portal option rows (proven CrowdStrike AQ DOM). Each row has
  // stable Workday data-value / id plus visible text.
  function readPortalOptionRows(popup) {
    if (!popup) return [];
    const lis = D.qa('[role="option"]', popup).filter((o) => D.isVisible(o));
    const out = [];
    for (const li of lis) {
      const text = (li.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || isPlaceholderOption(text)) continue;
      if (li.getAttribute("aria-disabled") === "true") continue;
      const id = (li.id || "").trim();
      const value = (li.getAttribute("data-value") || li.getAttribute("value") || id || "").trim();
      out.push({
        id: id || value || text,
        value: value || id || text,
        text,
        html: li.outerHTML.slice(0, 400),
      });
    }
    return out;
  }

  // Build the DOM-with-options payload the backend autofill prompt expects
  // (<ul data-af-options-for="cid">…), including option id / data-value.
  function buildPortalOptionsHtml(cid, label, portalOptions, portalHtmlHead) {
    const esc = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const lis = (portalOptions || [])
      .map((o) => {
        const id = esc(o.id || o.value || "");
        const val = esc(o.value || o.id || "");
        const text = esc(o.text || "");
        return `<li id="${id}" data-value="${val}" data-af-option-id="${id}" data-af-option-value="${val}">${text}</li>`;
      })
      .join("");
    const head = portalHtmlHead ? `<!-- portal:${esc(portalHtmlHead).slice(0, 1200)} -->` : "";
    return `${head}<div data-af-wd-field><label>${esc(label || "")}</label><ul data-af-options-for="${esc(cid)}">${lis}</ul></div>`;
  }

  // Profile/LLM wording → alternate strings that may appear on tenant option lists.
  // DraftKings AQ proof (2026-08-06): want "Male" vs live ["Man","Woman","Non-binary",…];
  // resolvePortalChoice includes() cannot bridge Male↔Man (neither substring).
  function optionAnswerAliases(raw) {
    const s = String(raw || "").replace(/\s+/g, " ").trim();
    if (!s || isPlaceholderOption(s)) return [];
    const n = D.norm(s);
    const out = [s];
    const add = (x) => {
      const t = String(x || "").trim();
      if (t && !out.some((o) => D.norm(o) === D.norm(t))) out.push(t);
    };
    if (n === "male" || n === "m") {
      add("Man");
      add("Male");
    } else if (n === "female" || n === "f") {
      add("Woman");
      add("Female");
    } else if (n === "man") {
      add("Male");
    } else if (n === "woman") {
      add("Female");
    }
    if (/prefer not|do not wish|decline to|not disclose|no response|not to say/.test(n)) {
      add("I prefer not to disclose");
      add("I do not wish to answer");
      add("Prefer not to say");
      add("Decline to self-identify");
    }
    return out;
  }

  // Map an LLM answer (option id, data-value, exact text, or cached choice
  // object) onto a harvested portal row.
  function resolvePortalChoice(answer, portalOptions) {
    if (answer == null || answer === "" || !portalOptions || !portalOptions.length) return null;
    if (typeof answer === "object" && !Array.isArray(answer)) {
      const byId =
        answer.id &&
        portalOptions.find((o) => D.norm(o.id) === D.norm(answer.id));
      if (byId) return byId;
      const byVal =
        answer.value &&
        portalOptions.find((o) => D.norm(o.value) === D.norm(answer.value));
      if (byVal) return byVal;
      const byText =
        answer.text &&
        portalOptions.find((o) => D.norm(o.text) === D.norm(answer.text));
      if (byText) return byText;
      return resolvePortalChoice(answer.value || answer.id || answer.text || "", portalOptions);
    }
    const raw = String(answer).replace(/\s+/g, " ").trim();
    if (!raw || isPlaceholderOption(raw)) return null;
    // Encoded forms: "No (value=…)" / "value=…" / "id=…" — try once on original.
    const mVal = raw.match(/(?:data-)?value\s*[=:]\s*([^\s)|,]+)/i);
    if (mVal) {
      const hit = portalOptions.find((o) => D.norm(o.value) === D.norm(mVal[1]));
      if (hit) return hit;
    }
    const mId = raw.match(/(?:data-af-option-)?id\s*[=:]\s*([^\s)|,]+)/i);
    if (mId) {
      const hit = portalOptions.find((o) => D.norm(o.id) === D.norm(mId[1]));
      if (hit) return hit;
    }
    // Exact id/value/text for every alias first (Male→Man), then includes fuzzy.
    // Includes must not run early: "man" ⊂ "woman" would mis-snap Male→Woman.
    for (const cand of optionAnswerAliases(raw)) {
      const n = D.norm(cand);
      if (!n) continue;
      const hit =
        portalOptions.find((o) => D.norm(o.value) === n) ||
        portalOptions.find((o) => D.norm(o.id) === n) ||
        portalOptions.find((o) => D.norm(o.text) === n);
      if (hit) return hit;
    }
    for (const cand of optionAnswerAliases(raw)) {
      const n = D.norm(cand);
      if (!n || n.length < 3) continue;
      const hit = portalOptions.find((o) => {
        const t = D.norm(o.text);
        if (!t) return false;
        // Require the shorter side to be a whole-token-ish match (≥3 chars) to
        // avoid man⊂woman.
        if (t === n) return true;
        if (t.includes(n) && n.length >= 4) return true;
        if (n.includes(t) && t.length >= 4) return true;
        return false;
      });
      if (hit) return hit;
    }
    return null;
  }

  // Wait until a single-select portal has stable [role=option] rows.
  // waitForOptionsSettled uses multi-select row readers and can miss listbox portals.
  // Small AQ lists (Yes/No, Man/Woman, …) settle in tens of ms — keep settle/poll short.
  async function waitForPortalOptionRows(popup, opts) {
    const timeout = (opts && opts.timeout) || 1600;
    const settleMs = opts && opts.settleMs != null ? opts.settleMs : 60;
    const minCount = (opts && opts.minCount) || 1;
    const poll = (opts && opts.poll) || 40;
    const end = Date.now() + timeout;
    let lastCount = -1;
    let stableSince = 0;
    while (Date.now() < end) {
      throwIfAborted();
      const rows = readPortalOptionRows(popup);
      const n = rows.length;
      if (n >= minCount) {
        if (n === lastCount) {
          if (!stableSince) stableSince = Date.now();
          // Large remote lists (phone CC / long source) need a bit more stability.
          const need = n > 40 ? Math.max(settleMs, 120) : settleMs;
          if (Date.now() - stableSince >= need) return rows;
        } else {
          lastCount = n;
          stableSince = Date.now();
        }
      } else {
        lastCount = n;
        stableSince = 0;
      }
      await D.delay(poll);
    }
    return readPortalOptionRows(popup);
  }

  // Find a harvested choice's live DOM node inside an open portal.
  function findPortalOptionEl(popup, choice) {
    if (!popup || !choice) return null;
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
    let match = null;
    // Prefer stable data-value (proven CrowdStrike); option element ids can remount.
    if (choice.value) {
      match =
        popup.querySelector(`[role="option"][data-value="${esc(choice.value)}"]`) ||
        popup.querySelector(`[role="option"][id="${esc(choice.value)}"]`);
    }
    if ((!match || !popup.contains(match)) && choice.id) {
      const byId = document.getElementById(choice.id);
      if (byId && popup.contains(byId)) match = byId;
      else match = popup.querySelector(`[role="option"][id="${esc(choice.id)}"]`) || match;
    }
    if (!match) match = pickOption(choice.value || choice.id || choice.text, popup);
    if (!match) match = pickOption(choice.text, popup);
    return match && popup.contains(match) ? match : match || null;
  }

  // Universal Workday single-select path (ALL Canvas listbox dropdowns):
  // ONE open → read/snap → pointer-click → close.
  // Never invent Yes/No / acknowledgment expansions here — callers must pass
  // an LLM (or profile) answer that snaps onto harvested options.
  //
  // CRITICAL: do NOT harvestPortalOptions (open→close) then openAndPickPortal
  // (open again). GDIT source proof 2026-08-06: harvest saw 70 options, immediate
  // reopen read [] ("option not found") because aria-expanded/stale empty portal
  // short-circuited openListboxForOptions. Capture once, pick in the same open.
  async function applyListboxPortal(trigger, answer, prePortalOptions) {
    if (!trigger || answer == null || answer === "") return false;

    // Already a snapped {id,value,text} from phase-2 harvest — open once and click.
    if (typeof answer === "object" && !Array.isArray(answer) && (answer.id || answer.value || answer.text)) {
      return await openAndPickPortal(trigger, answer);
    }

    const pre = Array.isArray(prePortalOptions) ? prePortalOptions : [];
    let choice = pre.length ? resolvePortalChoice(answer, pre) : null;

    // Prefer open-once when we still need to read the live portal.
    if (anyFormListboxOpen(trigger)) {
      await closeAllListboxes();
      await D.delay(30);
    }
    const popup = await openListboxForOptions(trigger, { fast: true });
    if (!popup) {
      try {
        WD.warn("applyListboxPortal: portal did not open", answer);
      } catch {}
      return false;
    }
    // openListboxForOptions already settled — only re-read if snap still missing.
    let liveRows = readPortalOptionRows(popup);
    if (!choice) choice = resolvePortalChoice(answer, liveRows);
    if (!choice && pre.length) choice = resolvePortalChoice(answer, pre);
    if (!choice) {
      liveRows = await waitForPortalOptionRows(popup, { timeout: 900, settleMs: 50, poll: 40 });
      choice = resolvePortalChoice(answer, liveRows) || (pre.length ? resolvePortalChoice(answer, pre) : null);
    }
    if (!choice) {
      try {
        WD.warn("applyListboxPortal: no portal snap (legacy text pick removed)", answer, liveRows.slice(0, 12));
      } catch {}
      await closeListbox(trigger);
      return false;
    }

    let match = findPortalOptionEl(popup, choice);
    // Long lists / remount: type-filter then re-query (same open session).
    if (!match && (choice.text || choice.value)) {
      const filter = String(choice.text || choice.value || "").trim();
      if (filter) {
        await typeAheadFilterPortal(trigger, popup, filter);
        match = findPortalOptionEl(popup, choice) || pickOption(filter, popup);
      }
    }
    if (!match) {
      try {
        WD.warn("applyListboxPortal: option not found in open portal", choice, readPortalOptionRows(popup).slice(0, 8));
      } catch {}
      await closeListbox(trigger);
      return false;
    }

    const wantText = (choice.text || choice.value || choice.id || "").trim();
    const want = D.norm(wantText);
    const chosen = (match.textContent || "").replace(/\s+/g, " ").trim();
    pointerClickWithNativeBackstop(match, { scroll: "nearest" });
    let sawSelected = false;
    const committed = () => {
      if (!sawSelected && portalOptionLooksSelected(match, popup, choice, want)) sawSelected = true;
      if (sawSelected) return true;
      const got = selectDisplayValue(trigger) || triggerCurrentValue(trigger);
      return valueMatchesWant(got, want) || valueMatchesWant(got, chosen) || valueMatchesWant(got, choice.text);
    };
    for (let i = 0; i < 8 && !committed(); i++) await D.delay(40);
    if (!committed()) await typeAheadCommit(trigger, chosen, committed);
    await closeListbox(trigger);
    for (let i = 0; i < 4 && !committed(); i++) await D.delay(60);
    if (committed()) return true;
    const ff2 = trigger.closest && trigger.closest('[data-automation-id^="formField-"]');
    try {
      WD.warn("applyListboxPortal did not commit", choice, {
        display: selectDisplayValue(trigger),
        triggerValue: triggerCurrentValue(trigger),
        ariaSelectedSeen: sawSelected,
        triggerHtml: String((trigger && trigger.outerHTML) || "").slice(0, 220),
        fieldInvalid: !!(ff2 && ff2.querySelector('[aria-invalid="true"]')),
      });
    } catch {}
    return false;
  }

  // Type into the open listbox search/typeahead so remote options mount.
  async function typeAheadFilterPortal(trigger, popup, text) {
    const str = String(text || "").trim();
    if (!str) return;
    const root = popup || openedListbox(trigger);
    const input =
      (root && root.querySelector("input:not([type='hidden'])")) ||
      (trigger && trigger.tagName === "INPUT" ? trigger : null) ||
      (trigger && trigger.querySelector && trigger.querySelector("input"));
    if (!input) return;
    try {
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {}
    }
    setReactValue(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setReactValue(input, str.slice(0, 48));
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: str.slice(0, 48) }),
    );
    await D.delay(120);
    if (root) await waitForPortalOptionRows(root, { timeout: 900, settleMs: 50, poll: 40, minCount: 1 });
  }

  // Pointer-open portal → click the option by id / data-value / text → verify.
  async function openAndPickPortal(trigger, choice) {
    if (!trigger || !choice) return false;
    const wantText = (choice.text || choice.value || choice.id || "").trim();
    const want = D.norm(wantText);
    if (!want || isPlaceholderOption(want)) return false;

    const ff = trigger.closest && trigger.closest('[data-automation-id^="formField-"]');
    const markedInvalid =
      trigger.getAttribute("aria-invalid") === "true" || !!(ff && ff.querySelector('[aria-invalid="true"]'));
    const cur = D.norm(selectDisplayValue(trigger) || triggerCurrentValue(trigger));
    if (cur && valueMatchesWant(cur, want) && !markedInvalid) return true;

    // Force a clean open — stale aria-expanded + empty portal was the GDIT miss.
    if (listboxIsOpen(trigger) || openedListbox(trigger)) {
      await closeListbox(trigger, { soft: true });
      await D.delay(40);
    }
    const popup = await openListboxForOptions(trigger, { fast: true });
    if (!popup) {
      try {
        WD.warn("openAndPickPortal: portal did not open");
      } catch {}
      return false;
    }
    // openListboxForOptions already settled — find immediately; brief poll on remount.
    let match = findPortalOptionEl(popup, choice);
    for (let i = 0; !match && i < 6; i++) {
      await D.delay(40);
      match = findPortalOptionEl(popup, choice);
    }
    if (!match) {
      await typeAheadFilterPortal(trigger, popup, choice.text || choice.value || "");
      match = findPortalOptionEl(popup, choice);
    }
    if (!match) {
      try {
        WD.warn("openAndPickPortal: option not found", choice, readPortalOptionRows(popup));
      } catch {}
      await closeListbox(trigger);
      return false;
    }

    const chosen = (match.textContent || "").replace(/\s+/g, " ").trim();
    pointerClickWithNativeBackstop(match, { scroll: "nearest" });
    // Latch the ARIA commit signal: once the option reads aria-selected="true"
    // (checked while the portal is still open) the value IS set, even if this
    // tenant only paints the trigger text after the popup closes / never at all.
    let sawSelected = false;
    const committed = () => {
      if (!sawSelected && portalOptionLooksSelected(match, popup, choice, want)) sawSelected = true;
      if (sawSelected) return true;
      const got = selectDisplayValue(trigger) || triggerCurrentValue(trigger);
      return valueMatchesWant(got, want) || valueMatchesWant(got, chosen) || valueMatchesWant(got, choice.text);
    };
    for (let i = 0; i < 8 && !committed(); i++) await D.delay(40);
    if (!committed()) await typeAheadCommit(trigger, chosen, committed);
    await closeListbox(trigger);
    // Some builds finalize the trigger text only after the popup closes — settle
    // then re-check before declaring failure.
    for (let i = 0; i < 4 && !committed(); i++) await D.delay(60);
    if (committed()) return true;
    try {
      WD.warn("openAndPickPortal did not commit", choice, {
        display: selectDisplayValue(trigger),
        triggerValue: triggerCurrentValue(trigger),
        ariaSelectedSeen: sawSelected,
        triggerHtml: String((trigger && trigger.outerHTML) || "").slice(0, 220),
        fieldInvalid: !!(ff && ff.querySelector('[aria-invalid="true"]')),
      });
    } catch {}
    return false;
  }

  // Pick the best Workday/OFCCP veteran-status option for the candidate's EEO flag.
  // Tenants disagree on wording; UPS uses decline-to-disclose + protected/non-protected
  // veteran options and often has NO literal "I am not a protected veteran".
  function pickVeteranOptionText(isVeteran, options) {
    const norms = (options || [])
      .map((raw) => ({ raw: String(raw || "").replace(/\s+/g, " ").trim(), t: D.norm(raw) }))
      .filter((x) => x.t && !/^select(\s+one)?\.?\.?\.?$/.test(x.t));
    if (!norms.length) return null;

    const isDecline = (t) =>
      /choose not|decline|do not wish|do not want|prefer not|voluntarily self-disclose|self-disclose whether/.test(t);
    const isProtectedYes = (t) =>
      (/identify as one or more|classifications of protected veteran|protected veterans listed/.test(t) ||
        (/protected veteran/.test(t) && /identify|belong|one or more/.test(t))) &&
      !/not a protected|but not a protected|non-veteran|not a veteran/.test(t) &&
      !isDecline(t);
    const isNotProtectedButVeteran = (t) =>
      /military veteran.*not a protected|not a protected veteran listed|veteran, but not a protected/.test(t);
    const isExplicitNotVeteran = (t) =>
      (/i am not a (protected )?veteran|not a protected veteran|i am not a veteran|non-veteran|i am not a u\.?\s*s\.?\s*military veteran/.test(t) ||
        (/^no\b/.test(t) && /veteran/.test(t))) &&
      !isDecline(t) &&
      !isNotProtectedButVeteran(t) &&
      !isProtectedYes(t);

    if (isVeteran) {
      const hit = norms.find((x) => isProtectedYes(x.t)) || norms.find((x) => isNotProtectedButVeteran(x.t));
      return hit ? hit.raw : null;
    }
    const notVet =
      norms.find((x) => isExplicitNotVeteran(x.t)) ||
      norms.find((x) => isDecline(x.t)) ||
      norms.find((x) => isNotProtectedButVeteran(x.t));
    return notVet ? notVet.raw : null;
  }

  async function harvestNativeSelectOptions(sel) {
    for (let i = 0; i < 20 && sel.options.length < 2; i++) await D.delay(100);
    return [...sel.options]
      .map((o) => (o.text || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && !/^select(\s+one)?\.?\.?\.?$/i.test(t));
  }

  async function fillVeteranField(container, isVeteran) {
    const nativeSel = container.querySelector("select");
    if (nativeSel) {
      const opts = await harvestNativeSelectOptions(nativeSel);
      const pick = pickVeteranOptionText(isVeteran, opts);
      if (!pick) return false;
      return await selectNativeEl(nativeSel, pick);
    }
    const listbox = listboxTrigger(container);
    if (listbox) {
      const harvested = await harvestPortalOptions(listbox);
      const texts = (harvested.options || []).map((o) => o.text);
      const pick = pickVeteranOptionText(isVeteran, texts);
      if (!pick) return false;
      return await applyListboxPortal(listbox, resolvePortalChoice(pick, harvested.options) || pick);
    }
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    if (radios.length) {
      const opts = radios.map((r) => labelForInput(r));
      const pick = pickVeteranOptionText(isVeteran, opts);
      if (!pick) return false;
      return pickRadio(radios, pick);
    }
    const checks = [...container.querySelectorAll('input[type="checkbox"]')];
    if (checks.length) {
      const opts = checks.map((c) => labelForInput(c));
      const pick = pickVeteranOptionText(isVeteran, opts);
      if (!pick) return false;
      return await applyCheckboxGroup(checks, pick);
    }
    return false;
  }

  // Workday Canvas Select (CrowdStrike Application Questions 2 of 2, proven DOM):
  // Closed: <button aria-haspopup=listbox>Select One</button> — NO options in DOM.
  // Open:   button gets aria-expanded=true aria-controls="<id>", and options render
  // in a body-level Popper portal OUTSIDE #root / formField:
  //   <div data-behavior-click-outside-close data-popper-placement>
  //     <ul role="listbox" id="<id>"><li role="option">Yes|No|…</li></ul>
  //   </div>
  // D.clickEl (mouse only) often fails to open / select these; pointer events do.
  function listboxIsOpen(btn) {
    return !!(btn && btn.getAttribute("aria-expanded") === "true");
  }

  function openedListbox(btn) {
    if (!btn) return null;
    let el = null;
    const id = btn.getAttribute("aria-controls") || btn.getAttribute("aria-owns");
    if (id) {
      for (const part of id.split(/\s+/)) {
        const cand = part && document.getElementById(part);
        if (cand && D.isVisible(cand)) {
          el = cand;
          break;
        }
      }
    }
    // Popper portal (CrowdStrike): listbox is not under formField; prefer the
    // portal that this trigger controls, else the topmost open popper list.
    if (!el) {
      const portals = D.qa(
        '[data-behavior-click-outside-close] [role="listbox"], [data-popper-placement] [role="listbox"], [data-automation-id="activeListContainer"], [role="listbox"]',
      ).filter(D.isVisible);
      if (portals.length === 1) el = portals[0];
      else if (portals.length > 1 && id) {
        el = portals.find((p) => p.id && id.split(/\s+/).includes(p.id)) || portals[portals.length - 1];
      } else if (portals.length > 1) {
        // Do NOT attribute a random open listbox to a trigger that has no
        // aria-controls yet (header Language/Settings also use listbox buttons).
        el = null;
      }
    }
    if (!el) return null;
    return (
      el.closest("[data-behavior-click-outside-close]") ||
      el.closest("[data-popper-placement]") ||
      el.closest('[data-automation-id="activeListContainer"]') ||
      el
    );
  }

  // Open a Canvas / Workday listbox and wait until the portal options exist.
  // Returns the popup root (portal or listbox) or null.
  // opts.fast: shorter open/settle for typical small AQ lists (Yes/No, gender, …).
  // Callers must NOT re-settle after this returns — options are already stable.
  async function openListboxForOptions(btn, opts) {
    if (!btn) return null;
    opts = opts || {};
    const fast = !!opts.fast;
    const openDelay = opts.openDelay != null ? opts.openDelay : fast ? 80 : 120;
    const settle = {
      timeout: opts.timeout != null ? opts.timeout : fast ? 1000 : 1800,
      settleMs: opts.settleMs != null ? opts.settleMs : fast ? 40 : 70,
      poll: opts.poll != null ? opts.poll : 40,
      minCount: opts.minCount != null ? opts.minCount : 1,
    };
    // Already open with real options — do not pointer-click again (toggles closed).
    // GDIT proof: after harvest Escape, aria-expanded can stay true while the
    // portal is EMPTY. Returning that empty root made openAndPickPortal miss.
    if (listboxIsOpen(btn)) {
      const existing = openedListbox(btn);
      if (existing) {
        const rows = await waitForPortalOptionRows(existing, {
          timeout: fast ? 500 : 900,
          settleMs: settle.settleMs,
          poll: settle.poll,
          minCount: 1,
        });
        if (rows.length) return existing;
        await closeListbox(btn, { soft: true });
        await D.delay(40);
      }
    }
    firePointerClick(btn);
    await D.delay(openDelay);
    let popup = openedListbox(btn);
    for (let i = 0; i < (fast ? 12 : 18) && !popup; i++) {
      await D.delay(40);
      popup = openedListbox(btn);
    }
    if (!popup && listboxIsOpen(btn)) {
      const id = btn.getAttribute("aria-controls");
      if (id) {
        const cand = document.getElementById(id.split(/\s+/)[0]);
        if (cand) popup = cand.closest("[data-behavior-click-outside-close]") || cand;
      }
    }
    if (!popup) {
      const portals = D.qa(
        '[data-behavior-click-outside-close] [role="listbox"], [data-popper-placement] [role="listbox"]',
      ).filter(D.isVisible);
      popup = portals.length ? portals[portals.length - 1] : null;
    }
    if (popup) {
      // Single settle only (was: waitFor OPTION_SEL + waitForPortalOptionRows).
      await waitForPortalOptionRows(popup, settle);
    }
    return popup;
  }

  // The overlay a single-select button just opened. Workday renders the popup in
  // a portal (not inside the field wrapper), so we locate it via the ARIA contract
  // (aria-controls / aria-owns) and fall back to the visible list container. This
  // is the anchor that scopes the search box + option lookups - without it, a
  // document-wide input query grabs the always-present, page-top "How Did You Hear
  // About Us?" multiselect and types THIS field's value into it.
  // (Implementation: openedListbox / openListboxForOptions above.)

  // Close a single-select listbox opened by `btn` and keep it closed. Leaving a
  // popup open corrupts later interactions (a subsequent open-toggle would CLOSE
  // it, and option harvesting would read nothing).
  // soft: Escape + preventScroll focus only — no body clicks (harvest path).
  async function closeListbox(btn, opts) {
    if (!btn) return;
    const soft = !!(opts && opts.soft);
    if (!openedListbox(btn) && btn.getAttribute("aria-expanded") !== "true") return;
    pressKey(btn, "Escape", "Escape", 27);
    await D.delay(40);
    if (openedListbox(btn) || btn.getAttribute("aria-expanded") === "true") {
      if (soft) {
        pressKey(btn, "Escape", "Escape", 27);
        await D.delay(40);
      } else {
        focusSinkOutside(btn.ownerDocument || document, { noBodyClick: false });
        await D.delay(50);
      }
    }
  }

  // Legacy openAndPick (type+Enter / typeahead spam) REMOVED for all Workday
  // tenants. Public alias routes to the design path: harvest → snap → pointer.
  async function openAndPick(trigger, value) {
    return await applyListboxPortal(trigger, value);
  }

  // ARIA listbox type-ahead: used only AFTER a portal option click failed to
  // commit (openAndPickPortal). Not a primary fill strategy.
  async function typeAheadCommit(trigger, text, isCommitted) {
    const str = String(text || "").trim();
    if (!str) return;
    const want = D.norm(str);

    let popup = openedListbox(trigger);
    if (!popup) {
      D.clickEl(trigger);
      await D.delay(220);
      popup = openedListbox(trigger);
    }
    const listbox = popup
      ? popup.matches('[role="listbox"]')
        ? popup
        : popup.querySelector('[role="listbox"]')
      : null;

    const targets = listbox && listbox !== trigger ? [listbox, trigger] : [trigger];
    for (const target of targets) {
      if (!openedListbox(trigger)) {
        D.clickEl(trigger);
        await D.delay(220);
      }
      try {
        target.focus({ preventScroll: true });
      } catch {}
      for (const ch of str.slice(0, 30)) {
        const meta = keyMetaForChar(ch);
        fireKey(target, ch, meta.code, meta.keyCode);
        await D.delay(50);
      }
      await D.delay(250);

      // Only press Enter when the highlighted option is the one we want.
      const activeId =
        (target.getAttribute && target.getAttribute("aria-activedescendant")) ||
        (listbox && listbox.getAttribute("aria-activedescendant")) ||
        "";
      const active = activeId ? document.getElementById(activeId) : null;
      const activeText = D.norm(active && active.textContent);
      if (activeText && !(activeText === want || activeText.includes(want) || want.includes(activeText))) {
        try {
          WD.warn(`type-ahead highlighted ${JSON.stringify(activeText)} - skipping Enter`);
        } catch {}
        continue;
      }
      pressEnter(target);
      await D.delay(320);
      if (isCommitted()) return;
    }
  }

  // Dispatch a full key sequence on a (re)focused element. Workday commits a
  // hierarchical-prompt search only when Enter fires while the search input holds
  // focus, so focus is asserted before the keys are sent.
  //
  // ALWAYS preventScroll — focus() without it scrolled each harvest field into
  // view on Escape close (source top → state mid → phone bottom = up/down thrash).
  function pressKey(el, key, code, keyCode) {
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {}
    }
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, keyCode, which: keyCode }),
      );
    }
  }
  const pressEnter = (el) => pressKey(el, "Enter", "Enter", 13);

  // Move focus to a throwaway off-screen sink so a genuine focusout (with a
  // non-null relatedTarget) fires - a bare input.blur() (relatedTarget=null) is
  // ignored by the widget.
  //
  // Body pointer/click events are OPTIONAL. Harvest must NOT fire them — GDIT
  // console proved: focusSinkOutside body click → uxInsights clickListener →
  // visible page jump on every listbox close during HARVEST.
  function focusSinkOutside(doc, opts) {
    const noBodyClick = !!(opts && opts.noBodyClick);
    try {
      const sink = doc.createElement("button");
      sink.type = "button";
      sink.tabIndex = -1;
      sink.setAttribute("aria-hidden", "true");
      sink.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
      (doc.body || doc.documentElement).appendChild(sink);
      sink.focus({ preventScroll: true });
      sink.blur();
      sink.remove();
    } catch {}
    if (noBodyClick) return;
    const outside = doc.body || doc.documentElement;
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      try {
        outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
  }

  // Close an open Workday prompt and KEEP it closed. For these widgets focus on
  // the search input == open. A TRUE multiselect (e.g. Country Phone Code)
  // re-focuses its search input after every pick so you can add more values, so a
  // single blur loses the race: the late post-selection refocus re-opens the list
  // right after we close it. The single-select prompt has no such refocus. So move
  // focus out, then VERIFY focus did not return to the widget; if it did, close
  // again. Bounded retries so this can never hang.
  async function closePrompt(multi, input) {
    const doc = (multi && multi.ownerDocument) || document;
    const reopened = () => {
      const ae = doc.activeElement;
      return ae === input || !!(multi && ae && multi.contains(ae));
    };
    for (let i = 0; i < 5; i++) {
      focusSinkOutside(doc);
      await D.delay(150);
      if (!reopened()) {
        // Wait out any late post-selection refocus, then confirm it stayed shut.
        await D.delay(180);
        if (!reopened()) return;
      }
    }
  }

  // Universal Workday multiSelect fill (Country Phone Code and similar).
  //
  // Allstate Country Phone Code evidence (open portal DOM):
  //   - ReactVirtualized list, aria-setsize=249, ~15 rows mounted
  //   - Top viewport = Afghanistan…Azerbaijan (USA not mounted)
  //   - No data-value attrs; no <input type=checkbox>; promptLeafNode + promptOption
  //   - Search input has enterkeyhint="search"
  // So APPLY must type-filter (or scroll-until-found and click WITHOUT resetting
  // scrollTop). Full scrollCollect→scrollTop=0 before click cannot see USA.
  async function fillMultiselect(multi, value, opts) {
    const alreadyOpen = !!(opts && opts.alreadyOpen && isMultiListOpen(multi));
    const preferUsaCc =
      /united states|\(\+\s*1\s*\)/i.test(String(value || "")) ||
      D.norm(value) === "+1" ||
      D.norm(value) === "1";
    const effectiveValue = preferUsaCc ? USA_PHONE_CC : value;
    const want = D.norm(effectiveValue);
    const usaAlreadyChosen = () =>
      preferUsaCc &&
      (promptChosen(multi, USA_PHONE_CC) ||
        promptChosen(multi, "United States of America") ||
        promptChosen(multi, "United States"));
    const isChosen = () => promptChosen(multi, want) || usaAlreadyChosen() || promptChosen(multi, "");
    if (promptChosen(multi, want) || usaAlreadyChosen()) {
      return true;
    }

    // Keep-open path: list already scrolled near USA — click without reopen/reset.
    let input = alreadyOpen ? multi.querySelector("input") : null;
    if (!input) {
      input = await openMultiPrompt(multi);
    }
    if (!input) {
      try {
        if (WD.aa) WD.aa("fillMultiselect FAIL", { reason: "no-input", want: String(effectiveValue).slice(0, 60) });
      } catch {}
      return false;
    }

    if (!alreadyOpen) {
      await waitForOptionsSettled({ timeout: 3000, settleMs: 220, ownerMulti: multi, minCount: 0 });
    }

    const findUsaRow = () => {
      const rows = readMultiOptionRows(activeMultiListRoot(multi));
      const hit =
        rows.find((r) => /united states of america/i.test(r.text) && /\(\+\s*1\s*\)/.test(r.text)) ||
        rows.find((r) => /^united states\b/i.test(r.text) && !/minor outlying/i.test(r.text) && /\(\+\s*1\s*\)/.test(r.text));
      return hit ? hit.el : null;
    };

    const findWantRow = (query) => {
      const listRoot = activeMultiListRoot(multi);
      let match =
        (preferUsaCc ? findUsaRow() : null) ||
        findMultiOptionByText(effectiveValue, multi) ||
        findMultiOptionByText(value, multi) ||
        (query && query !== "+1" && query !== "1" ? findMultiOptionByText(query, multi) : null) ||
        (listRoot ? pickOption(effectiveValue, listRoot) || pickOption(value, listRoot) : null);
      if (!match && preferUsaCc) match = findUsaRow();
      if (!match || isCommittedFieldOption(match)) return null;
      return match;
    };

    const tryClickWant = async (query, via) => {
      const match = findWantRow(query);
      if (!match) {
        try {
          if (WD.aa) {
            WD.aa("fillMultiselect no-row", {
              via: via || "click",
              query: String(query || "").slice(0, 40),
              mounted: readMultiOptionRows(activeMultiListRoot(multi))
                .slice(0, 8)
                .map((r) => String(r.text || "").slice(0, 40)),
            });
          }
        } catch {}
        return false;
      }
      // Prefer promptLeafNode (Allstate phone CC has no checkbox inputs).
      const leaf = match.querySelector('[data-automation-id="promptLeafNode"]');
      if (leaf) {
        firePointerClick(leaf);
        await D.delay(150);
      }
      await clickMultiOptionRow(match);
      const ok =
        (await waitUntilMultiCommitted(multi, want, 1800)) ||
        (preferUsaCc && promptChosen(multi, "United States"));
      try {
        if (WD.aa) {
          WD.aa("fillMultiselect click", {
            via: via || "click",
            ok,
            aria: String(
              (multi.querySelector('[data-automation-id="promptAriaInstruction"]') || {}).textContent || "",
            ).slice(0, 80),
          });
        }
      } catch {}
      return ok;
    };

    // Keep-open harvest left the viewport near the bottom — try click first
    // before any type/scroll that would remount from the top.
    if (alreadyOpen && (await tryClickWant(null, "keep-open-mounted"))) {
      await closePrompt(multi, input);
      return true;
    }

    // Allstate Country Phone Code: type-filter is proven broken in AA logs —
    // typing "United States…" leaves Afghanistan…Anguilla mounted, then Enter
    // clears the list (mounted:[]). Skip that waste; scroll-until-found works.
    // Other multiselects still try a short type path first.
    const isPhoneCcMulti = preferUsaCc || /\(\+\s*\d+\s*\)/.test(String(effectiveValue || ""));
    if (!isPhoneCcMulti && !alreadyOpen) {
      const typeFilter = async (query) => {
        const q = String(query || "");
        if (!q) return;
        input.focus();
        D.nativeSet(input, "");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        await D.delay(40);
        D.nativeSet(input, q);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: q, inputType: "insertText" }));
        const last = q.slice(-1) || "a";
        pressKey(input, last, "Key" + (/[a-z]/i.test(last) ? last.toUpperCase() : "A"), last.charCodeAt(0) || 65);
        await waitForOptionsSettled({ timeout: 2500, settleMs: 200, ownerMulti: multi, minCount: 0 });
      };
      for (const query of multiTypeQueries(effectiveValue).slice(0, 2)) {
        await typeFilter(query);
        if (await tryClickWant(query, "type:" + String(query).slice(0, 30))) {
          await closePrompt(multi, input);
          return true;
        }
      }
    }

    // Scroll until the target row mounts, then click immediately (do NOT
    // reset scrollTop to 0 first — that unmounts USA on a 249-row list).
    // Keep-open path: do not clear the search input (would jump the list).
    if (!alreadyOpen) {
      try {
        D.nativeSet(input, "");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      } catch {}
      await waitForOptionsSettled({ timeout: 2000, settleMs: 180, ownerMulti: multi, minCount: 0 });
    }
    if (await tryClickWant(null, alreadyOpen ? "keep-open-retry" : "mounted")) {
      await closePrompt(multi, input);
      return true;
    }
    const scroller = multiListScroller(multi);
    if (scroller) {
      // Keep-open at bottom: USA may be just above the fold — scroll up a little first.
      if (alreadyOpen && (scroller.scrollTop || 0) > 0) {
        for (let i = 0; i < 12; i++) {
          throwIfAborted();
          if (await tryClickWant(null, "keep-open-up:" + i)) {
            await closePrompt(multi, input);
            return true;
          }
          const prev = Math.max(0, (scroller.scrollTop || 0) - Math.max(40, (scroller.clientHeight || 120) * 0.7));
          if (prev === (scroller.scrollTop || 0)) break;
          scroller.scrollTop = prev;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          await D.delay(70);
        }
      }
      for (let i = 0; i < 100; i++) {
        throwIfAborted();
        if (await tryClickWant(null, "scroll:" + i)) {
          await closePrompt(multi, input);
          return true;
        }
        const maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
        const next = Math.min((scroller.scrollTop || 0) + Math.max(40, (scroller.clientHeight || 120) * 0.85), maxScroll);
        scroller.scrollTop = next;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await D.delay(70);
        if (next >= maxScroll - 1) break;
      }
    } else if (await tryClickWant(null, "no-scroller")) {
      await closePrompt(multi, input);
      return true;
    }

    try {
      if (WD.aa) {
        WD.aa("fillMultiselect FAIL", {
          want: String(effectiveValue).slice(0, 60),
          chosen: isChosen(),
          aria: String(
            (multi.querySelector('[data-automation-id="promptAriaInstruction"]') || {}).textContent || "",
          ).slice(0, 80),
        });
      }
    } catch {}
    await closePrompt(multi, input);
    return isChosen();
  }

  // ── "How Did You Hear About Us?" (source) ─────────────────────────────────
  //
  // ALL Workday tenants — design path only:
  //   open → harvest visible options → LLM returns exact option text → select it.
  // Hierarchical (2-step):
  //   L1 harvest → LLM picks category (e.g. Job Boards for LinkedIn) → KEEP OPEN
  //   → L2 harvest → LLM picks leaf → select → verify no referral follow-up.
  // Never hardcode Job Boards / Indeed / Website / random first leaves.

  function isSourceField(container, label) {
    try {
      const id = (container.getAttribute && container.getAttribute("data-automation-id")) || "";
      if (/formField-source\b/i.test(id)) return true;
    } catch {}
    return /how did you hear|how.*hear about/i.test(label || "");
  }

  // The stable ids of every visible formField wrapper - the baseline a source
  // pick's conditional follow-up is detected against. Keyed by data-automation-id
  // (persists across Workday re-renders) so the diff survives a section re-mount.
  function visibleFormFieldKeys() {
    const keys = [];
    for (const ff of D.qa('[data-automation-id^="formField-"]')) {
      if (!D.isVisible(ff)) continue;
      keys.push(ff.getAttribute("data-automation-id") || "");
    }
    return keys;
  }

  // formField keys that appeared AFTER a source pick and are required + still
  // empty - i.e. an unfillable referral follow-up spawned by the selection.
  function newRequiredEmptyFollowups(beforeKeys) {
    const before = new Set(beforeKeys);
    const seen = new Set();
    const out = [];
    for (const ff of D.qa('[data-automation-id^="formField-"]')) {
      if (!D.isVisible(ff)) continue;
      const key = ff.getAttribute("data-automation-id") || "";
      if (!key || before.has(key) || seen.has(key)) continue;
      seen.add(key);
      if (!isRequired(ff)) continue;
      if (fieldIsFilled(ff)) continue;
      out.push(key);
    }
    return out;
  }

  // Peer professional job boards / career sites. Preferred profile channel first,
  // then nearest peer present in the harvested L2/flat list (not LinkedIn-only).
  const SOURCE_JOB_BOARD_PEERS = [
    "linkedin",
    "indeed",
    "glassdoor",
    "ziprecruiter",
    "monster",
    "dice",
    "careerbuilder",
    "simplyhired",
    "wellfound",
    "angellist",
    "otta",
    "builtin",
    "handshake",
    "hired",
    "flexjobs",
    "remote ok",
    "we work remotely",
  ];

  function sourcePreferredChannel(want) {
    const w = String(want || "").replace(/\s+/g, " ").trim();
    return w || "LinkedIn";
  }

  function sourceL1CategoryHint(want) {
    const pref = sourcePreferredChannel(want);
    const linkedIn = /linkedin/i.test(pref);
    return (
      `Step 1/2: CATEGORIES (folders) only. Preferred channel "${pref}". ` +
      (linkedIn
        ? `For LinkedIn, prefer "Social Media" when that folder exists (LinkedIn is often NOT under Job Boards). `
        : "") +
      `Otherwise pick the folder that would contain professional job boards / career platforms ` +
      `(Indeed, Glassdoor, ZipRecruiter, Monster, Dice, LinkedIn, etc.) — often ` +
      `"Job Boards", "Job Platforms", or "Social Media". Return exact category text from the list.`
    );
  }

  function sourceL2LeafHint(want) {
    const pref = sourcePreferredChannel(want);
    return (
      `Step 2/2: pick ONE leaf from THIS list. Preferred exact match: "${pref}". ` +
      `If "${pref}" is not listed, you MUST pick a real named board that IS listed ` +
      `(Indeed, Glassdoor, ZipRecruiter/Zip Recruiter, Monster, Dice, CareerBuilder, LinkedIn, etc.). ` +
      `NEVER pick "Job Board Not Listed", "Other", "None", or similar catch-alls when any named ` +
      `professional board is in the list. Return the exact option text from the list.`
    );
  }

  function isSourceCatchAllLeaf(text) {
    return /not listed|none of the|prefer not|decline|other\b|n\/?a\b|not applicable|unlisted/i.test(
      String(text || ""),
    );
  }

  // L1 folder when profile channel is LinkedIn: Social Media before Job Boards.
  function pickSourceCategoryLocal(want, categories) {
    const real = (categories || []).filter((o) => o && !isPlaceholderOption(o));
    if (!real.length) return null;
    const pref = sourcePreferredChannel(want);
    const exact = exactOption(pref, real) || snapToHarvestedOption(pref, real);
    if (exact && !isSourceCatchAllLeaf(exact)) return exact;
    if (/linkedin|facebook|twitter|instagram|social/i.test(pref)) {
      const social = real.find((o) => /social\s*media/i.test(o));
      if (social) return social;
    }
    const boards = real.find((o) => /job\s*boards?|job\s*platforms?/i.test(o));
    if (boards) return boards;
    return null;
  }

  function sourceFlatHint(want) {
    const pref = sourcePreferredChannel(want);
    return (
      `Pick ONE option from THIS list. Preferred: "${pref}". ` +
      `If missing, pick the closest major professional job board present ` +
      `(LinkedIn, Indeed, Glassdoor, ZipRecruiter, Monster, Dice, etc.). ` +
      `Avoid referral variants when a direct board exists. Return exact option text.`
    );
  }

  // Local safety after LLM: preferred channel, then peer job boards in priority order.
  // Never returns catch-alls like "Job Board Not Listed" when a named peer exists.
  function pickSourceLeafLocal(want, options) {
    const real = (options || []).filter((o) => o && !isPlaceholderOption(o) && !isEmptyPromptRow(o));
    if (!real.length) return null;
    const named = real.filter((o) => !isSourceCatchAllLeaf(o));
    const pool = named.length ? named : real;
    const pref = sourcePreferredChannel(want);
    const exact = exactOption(pref, pool) || snapToHarvestedOption(pref, pool);
    if (exact && !isSourceCatchAllLeaf(exact)) return exact;
    const ranked = [];
    const prefNorm = D.norm(pref);
    if (prefNorm && !SOURCE_JOB_BOARD_PEERS.includes(prefNorm)) ranked.push(prefNorm);
    for (const p of SOURCE_JOB_BOARD_PEERS) {
      if (!ranked.includes(p)) ranked.push(p);
    }
    // Also match "Zip Recruiter" ↔ ziprecruiter
    const normPeer = (s) => D.norm(s).replace(/\s+/g, "");
    for (const peer of ranked) {
      const hit = pool.find((o) => {
        const t = D.norm(o);
        const tn = normPeer(o);
        const pn = normPeer(peer);
        return (
          t === peer ||
          t.includes(peer) ||
          peer.includes(t) ||
          tn === pn ||
          tn.includes(pn) ||
          pn.includes(tn)
        );
      });
      if (hit && !/referr|employee name|who referred/i.test(hit) && !isSourceCatchAllLeaf(hit)) {
        return hit;
      }
    }
    return null;
  }

  // LLM answer first (exact snap onto harvested list). Local peers only if LLM empty.
  function chooseSourceLeaf(want, options, llmRaw) {
    const fromLlm = snapToHarvestedOption(valueText(llmRaw) || llmRaw, options);
    if (fromLlm) return fromLlm;
    return pickSourceLeafLocal(want, options);
  }

  // Ask the options LLM for one pick snapped onto the live harvested list.
  // `hint` steers category vs leaf selection; the model must return exact list text.
  async function askLlmForOptionPick(label, want, options, portalOptions, hint) {
    const texts = (options || []).filter((o) => o && !isPlaceholderOption(o) && !isEmptyPromptRow(o));
    if (!texts.length) return null;
    const portals =
      portalOptions && portalOptions.length
        ? portalOptions
        : texts.map((t) => ({ id: t, value: t, text: t }));
    const cid = "srcpick_" + Date.now() + "_" + Math.floor(Math.random() * 1e4);
    const portalHtml = buildPortalOptionsHtml(cid, label, portals, "");
    // Hint already carries preferred + peer guidance; do not force LinkedIn-only wording.
    const fullLabel = hint
      ? `${label} — ${hint} Reply with ONE exact option text from the list.`
      : label;
    try {
      WD.log(`source LLM ask: want='${want}' options=${texts.length}`, texts.slice(0, 15));
    } catch {}
    try {
      const part = await requestOptionMatches([
        {
          cid,
          label: fullLabel,
          want: want || undefined,
          kind: "select",
          required: true,
          options: texts,
          portalOptions: portals,
          portalHtml,
        },
      ]);
      const raw = part && part[cid];
      if (raw == null || raw === "") {
        try {
          WD.warn("source LLM returned empty", fullLabel.slice(0, 80));
        } catch {}
        return null;
      }
      let picked = null;
      if (portals.length) {
        const choice = resolvePortalChoice(raw, portals);
        if (choice) picked = choice.text || choice.value || null;
      }
      if (!picked) picked = snapToHarvestedOption(raw, texts);
      try {
        WD.log(`source LLM pick: raw=${JSON.stringify(raw)} → '${picked}'`);
      } catch {}
      return picked;
    } catch (e) {
      if (e && e.name === "WDAborted") throw e;
      return null;
    }
  }

  // Click a SOURCE list row. Prefer promptOption text — checkbox click can fail
  // to commit single-select source leaves (log: Website / Direct Source no commit).
  async function clickSourceListOption(el) {
    if (!el) return false;
    const row =
      el.closest('[data-automation-id="menuItem"]') ||
      el.closest('[role="option"]') ||
      el;
    const promptOpt = row.querySelector('[data-automation-id="promptOption"]') || row;
    try {
      promptOpt.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    } catch {}
    firePointerClick(promptOpt);
    await D.delay(220);
    // If still not selected, try the outer menuItem once (no checkbox).
    firePointerClick(row);
    await D.delay(180);
    return true;
  }

  // Drill into an L1/L2 folder (chevron category) — never checkbox.
  async function clickSourceFolder(el) {
    if (!el) return false;
    const row =
      el.closest('[data-automation-id="menuItem"]') ||
      el.closest('[role="option"]') ||
      el;
    const promptOpt = row.querySelector('[data-automation-id="promptOption"]') || row;
    firePointerClick(promptOpt);
    await D.delay(150);
    const chevron = row.querySelector(
      '[data-automation-id="promptOptionChevron"], [data-automation-id="chevron"]',
    );
    if (chevron) {
      firePointerClick(chevron);
      await D.delay(120);
    }
    return true;
  }

  // Source helpers for batch harvest → LLM → apply (and thin recovery fallback).
  // NO hardcoded Job Boards / Indeed / random Website clicks.

  async function harvestSourceLiveRows(multi) {
    await waitForOptionsSettled({ timeout: 3500, settleMs: 280, ownerMulti: multi });
    // Short lists (Allstate L1=4 folders, Social Media L2=7) fit the viewport —
    // skip scrollCollect. Long virtualized L2 still needs a full scroll pass.
    if (!multiListNeedsScroll(multi)) {
      return readMultiOptionRows(activeMultiListRoot(multi));
    }
    const collected = await scrollCollectMultiOptions(multi, { resetToTop: true });
    if (collected && collected.length) {
      return collected.map((o) => ({
        el: null,
        id: o.id,
        value: o.value,
        text: o.text,
        hierarchical: !!o.hierarchical,
      }));
    }
    return readMultiOptionRows(activeMultiListRoot(multi));
  }

  function sourceFolderRows(live) {
    let folders = (live || []).filter((r) => r.hierarchical);
    if (!folders.length) {
      const guessed = (live || []).filter((r) => looksLikeSourceCategory(r.text));
      if (guessed.length >= 2) folders = guessed;
    }
    return folders;
  }

  function rowsToPortals(rows) {
    return (rows || [])
      .filter((r) => r && r.text && !isPlaceholderOption(r.text) && !isEmptyPromptRow(r.text))
      .map((r) => ({
        id: r.id || r.text,
        value: r.value || r.id || r.text,
        text: r.text,
        hierarchical: !!r.hierarchical,
      }));
  }

  // Open → harvest L1 (categories or flat list) → close. Does not select.
  async function harvestSourceL1(multi) {
    const input = multi && multi.querySelector("input");
    if (!input) return { hierarchical: false, texts: [], portals: [], rows: [] };
    await openMultiPrompt(multi);
    const live = await harvestSourceLiveRows(multi);
    if (!live.length) {
      await closePrompt(multi, input);
      return { hierarchical: false, texts: [], portals: [], rows: [] };
    }
    const folders = sourceFolderRows(live);
    const hierarchical = folders.length > 0;
    const rows = hierarchical ? folders : live;
    const portals = rowsToPortals(rows);
    const texts = portals.map((p) => p.text);
    try {
      WD.log(
        hierarchical ? "source L1 harvest (categories)" : "source flat harvest",
        texts.slice(0, 20),
      );
    } catch {}
    await closePrompt(multi, input);
    return { hierarchical, texts, portals, rows };
  }

  // Re-open, select L1 category, keep prompt open for L2 harvest.
  // L1 is usually a short non-virtualized folder list (Allstate: 4 categories) —
  // do NOT full scrollCollect again (that re-did HARVEST work every run).
  async function applySourceL1KeepOpen(multi, category) {
    const input = multi && multi.querySelector("input");
    if (!input || !category) return false;
    await openMultiPrompt(multi);
    await waitForOptionsSettled({ timeout: 3000, settleMs: 220, ownerMulti: multi, minCount: 1 });
    let folderEl = findMultiOptionByText(category, multi);
    if (!folderEl) {
      // Rare: long L1 list — only then scroll-hunt.
      await harvestSourceLiveRows(multi);
      folderEl = findMultiOptionByText(category, multi);
    }
    if (!folderEl) {
      try {
        WD.warn(`source: L1 category '${category}' not in DOM`);
      } catch {}
      await closePrompt(multi, input);
      return false;
    }
    try {
      WD.log(`source: selecting L1 category '${category}' (keep-open)`);
    } catch {}
    await clickSourceFolder(folderEl);
    await waitForSourceDrillDown(4500, multi);
    return true;
  }

  // Prompt must already be drilled to L2. Returns leaf rows (non-folders).
  async function harvestSourceL2(multi) {
    const live = await harvestSourceLiveRows(multi);
    const l2 = live.filter((r) => !r.hierarchical);
    const portals = rowsToPortals(l2);
    try {
      WD.log(
        `source L2 harvest count=${portals.length}`,
        portals.map((r) => r.text).slice(0, 20),
      );
    } catch {}
    return { texts: portals.map((p) => p.text), portals, rows: l2 };
  }

  async function applySourceLeaf(multi, leafText, baselineKeys) {
    const input = multi && multi.querySelector("input");
    if (!input || !leafText) return false;
    let leafEl = findMultiOptionByText(leafText, multi);
    if (!leafEl) {
      const listRoot = activeMultiListRoot(multi);
      leafEl = listRoot ? pickOption(leafText, listRoot) : null;
    }
    // Virtualized L2: leaf may be below the fold after harvest scrollTop reset.
    if (!leafEl) {
      const root0 = activeMultiListRoot(multi);
      const scroller =
        (root0 &&
          (root0.querySelector(".ReactVirtualized__List") ||
            (root0.classList && root0.classList.contains("ReactVirtualized__List") && root0) ||
            root0)) ||
        null;
      if (scroller) {
        for (let i = 0; i < 80 && !leafEl; i++) {
          throwIfAborted();
          leafEl = findMultiOptionByText(leafText, multi);
          if (leafEl) break;
          const maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
          const next = Math.min(
            (scroller.scrollTop || 0) + Math.max(40, (scroller.clientHeight || 120) * 0.85),
            maxScroll,
          );
          scroller.scrollTop = next;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          await D.delay(70);
          if (next >= maxScroll - 1) break;
        }
      }
    }
    if (!leafEl) {
      try {
        WD.warn(`source: leaf '${leafText}' not in DOM`);
      } catch {}
      await closePrompt(multi, input);
      return false;
    }
    try {
      WD.log(`source: selecting leaf '${leafText}'`);
    } catch {}
    await clickSourceListOption(leafEl);
    const committed = await waitUntilMultiCommitted(multi, leafText, 2000);
    if (!committed) {
      const after = readMultiOptionRows(activeMultiListRoot(multi));
      try {
        WD.warn(
          `source leaf '${leafText}' did not commit`,
          after.slice(0, 8).map((r) => r.text),
        );
      } catch {}
      await closePrompt(multi, input);
      return false;
    }
    await closePrompt(multi, input);
    await D.delay(250);
    const followups = newRequiredEmptyFollowups(baselineKeys);
    if (followups.length) {
      try {
        WD.log(`source: '${leafText}' triggered follow-up ${JSON.stringify(followups)}`);
      } catch {}
      return false;
    }
    return true;
  }

  // Fallback for recovery/recheck when batch path did not pre-resolve source.
  async function fillSourceHierarchical(multi, want, container, baselineKeys) {
    const input = multi.querySelector("input");
    if (!input) return false;
    if (promptChosen(multi, want) && !newRequiredEmptyFollowups(baselineKeys).length) {
      return true;
    }
    const l1 = await harvestSourceL1(multi);
    if (!l1.texts.length) return false;

    if (!l1.hierarchical) {
      let pick = exactOption(want, l1.texts);
      if (!pick) {
        pick = await askLlmForOptionPick(
          "How Did You Hear About Us?",
          want,
          l1.texts,
          l1.portals,
          sourceFlatHint(want),
        );
      }
      pick = snapToHarvestedOption(pick, l1.texts) || pickSourceLeafLocal(want, l1.texts);
      if (!pick) return false;
      await openMultiPrompt(multi);
      await harvestSourceLiveRows(multi);
      return applySourceLeaf(multi, pick, baselineKeys);
    }

    let category = await askLlmForOptionPick(
      "How Did You Hear About Us? (category)",
      want,
      l1.texts,
      l1.portals,
      sourceL1CategoryHint(want),
    );
    category =
      snapToHarvestedOption(category, l1.texts) ||
      pickSourceCategoryLocal(want, l1.texts);
    if (!category) {
      try {
        WD.warn("source: LLM/exact did not pick an L1 category from harvested list");
      } catch {}
      return false;
    }
    if (!(await applySourceL1KeepOpen(multi, category))) return false;
    const l2 = await harvestSourceL2(multi);
    if (!l2.texts.length) {
      await closePrompt(multi, input);
      return false;
    }
    let leaf = await askLlmForOptionPick(
      "How Did You Hear About Us? (specific source)",
      want,
      l2.texts,
      l2.portals,
      sourceL2LeafHint(want),
    );
    leaf = chooseSourceLeaf(want, l2.texts, leaf);
    if (!leaf) {
      try {
        WD.warn("source: LLM/peer did not pick an L2 leaf from harvested list");
      } catch {}
      await closePrompt(multi, input);
      return false;
    }
    return applySourceLeaf(multi, leaf, baselineKeys);
  }

  async function fillSourcePrompt(multi, primaryValue, container) {
    // Recovery: skip rewrite when already committed with no referral follow-up.
    if (multiSelectedText(container)) {
      const hasReferralFollowup = D.qa('[data-automation-id^="formField-"]').some((ff) => {
        if (!D.isVisible(ff)) return false;
        if (!isRequired(ff)) return false;
        if (fieldIsFilled(ff)) return false;
        const lab = (fieldLabel(ff) || "").toLowerCase();
        return /referr|who referred|employee name|referrer/.test(lab);
      });
      if (!hasReferralFollowup) return true;
    }

    const baselineKeys = visibleFormFieldKeys();
    const want = String(primaryValue || "").trim();
    if (!want) return false;
    try {
      const ok = await fillSourceHierarchical(multi, want, container, baselineKeys);
      if (ok) {
        try {
          WD.log(`source: '${want}' filled via harvest→LLM→select`);
        } catch {}
        return true;
      }
    } catch (e) {
      if (e && e.name === "WDAborted") throw e;
      try {
        WD.warn("fillSourceHierarchical error", e && e.message);
      } catch {}
      const input = multi.querySelector("input");
      if (input) await closePrompt(multi, input);
    }
    return false;
  }

  // True once a currently-visible option's text matches `want` (either direction),
  // i.e. the server-backed list has FINISHED filtering to our query. Polls so we
  // never press Enter against a stale, unfiltered list. Ignores the empty-state
  // "No Items" row (seen on School prompts while the server search is in flight).
  async function waitForFilteredOption(want, ms) {
    const w = D.norm(want);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // promptResultOptions excludes committed pills (which embed their own
      // promptOption node) and the transient "No Items" row.
      const hit = promptResultOptions().some((o) => {
        const t = D.norm(o.textContent);
        return t === w || t.includes(w) || w.includes(t);
      });
      if (hit) return true;
      await D.delay(120);
    }
    return false;
  }

  // School / Field of Study / other LARGE server-backed search prompts.
  //
  // Proven on-tenant (School "University of Wollongong", live screenshots):
  //   1. Type the school name and KEEP it in the input.
  //   2. WAIT until "Search Results (N)" appears (list may briefly show "No Items").
  //   3. Press Enter WHILE the typed text is still present — that commits a unique
  //      match, or highlights the best of N>1 matches.
  //   4. If still not committed (N>1), press Enter AGAIN with the text still there.
  //   5. Last resort: click the EXACT option (pickOption prefers exact text so
  //      "University of Wollongong" wins over "… in Dubai").
  //
  // Anti-pattern that FAILED on this tenant: Enter before matches appear, or
  // clearing the input after matches appear then pressing Enter on an empty
  // "Search" placeholder — leaves Search Results open with no selection (and
  // that open prompt then poisons Degree openAndPick for the same panel).
  async function fillSearchPrompt(multi, value) {
    const want = D.norm(value);
    const isChosen = () => promptChosen(multi, want);
    if (isChosen()) return true;
    const input = multi.querySelector("input");
    if (!input) return false;
    const opener = multi.querySelector('[data-automation-id="multiselectInputContainer"]') || input;

    for (let attempt = 0; attempt < 2; attempt++) {
      // 1. Open ONCE. Never click the opener/input again after this — a click on
      //    an already-open prompt re-runs it and drops the highlighted row (that
      //    is what produced the "input cleared, Search Results still open" state).
      D.clickEl(opener);
      await D.delay(220);
      input.focus();
      await D.delay(120);

      // 2. Type the value ONCE. This is the ONLY place the search box is written.
      D.nativeSet(input, "");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      await D.delay(60);
      D.nativeSet(input, String(value));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
      const last = String(value).slice(-1) || "a";
      pressKey(input, last, "Key" + last.toUpperCase(), last.toUpperCase().charCodeAt(0));

      // 3. WAIT for genuine server results (skips "No Items" and committed pills)
      //    with the typed text untouched. Never Enter against a stale list.
      await waitForFilteredOption(value, 5000);
      await D.delay(220);

      // 4. Enter, then Enter again — focus PINNED to the input the whole time.
      //    pressKey re-focuses the input itself, and nothing between the two
      //    presses clicks, blurs, clears or retypes. Enter #1 commits a unique
      //    match / highlights the best of N; Enter #2 confirms the highlight.
      for (let i = 0; i < 2 && !isChosen(); i++) {
        input.focus();
        pressEnter(input);
        await D.delay(500);
      }
      if (isChosen()) {
        await closePrompt(multi, input);
        return true;
      }

      // 5. Fallback: pointer-click the exact result row (full pointer sequence —
      //    plain click events are ignored by Canvas prompt rows).
      const match = pickResultOption(value);
      if (match) {
        firePointerClick(match);
        await D.delay(320);
        if (!isChosen()) {
          const box = match.querySelector('input[type="radio"], input[type="checkbox"]');
          if (box) {
            firePointerClick(box);
            await D.delay(320);
          }
        }
      }
      if (isChosen()) {
        await closePrompt(multi, input);
        return true;
      }
      await closePrompt(multi, input);
      await D.delay(250);
    }
    return isChosen();
  }

  // ── Skills ("Type to Add Skills") — multi typeahead, empty until you type ──
  //
  // Proven failure (Zillow 2026-08-06 eeo-llm-v4 logs): fillMultiselect typed
  // "Python" then looked for mounted rows (mounted:[]) — skills search does NOT
  // populate until Enter is pressed IN the search input. Closed-list harvest also
  // returns options:0 (nothing to list before typing).
  //
  // Fiserv 2026-08-06 AA: search mounted related rows but EVERY token ok:false
  // chips:0. Root cause: focus input + firePointerClick only — Canvas multi needs
  // clickMultiOptionRow. LLM prompt asked for ALL skills; cap was 40.
  // Workflow: type → related results → clickMultiOptionRow(best) → verify chip.
  const SKILLS_MAX = 10;

  function isSkillsField(key, label) {
    const k = String(key || "");
    const low = String(label || "").toLowerCase();
    if (/^skills$/i.test(k)) return true;
    return /type to add skills|add skills|^skills$|skills\s*:/.test(low);
  }

  function parseSkillTokens(raw, maxCount) {
    const cap = maxCount != null ? maxCount : SKILLS_MAX;
    if (raw == null || raw === "") return [];
    if (Array.isArray(raw)) {
      return raw
        .flatMap((x) => parseSkillTokens(x, cap))
        .filter(Boolean)
        .slice(0, cap);
    }
    if (typeof raw === "object") {
      const t = valueText(raw);
      return t ? parseSkillTokens(t, cap) : [];
    }
    const s = String(raw).replace(/\s+/g, " ").trim();
    if (!s) return [];
    // Prefer comma / semicolon / newline splits; keep "Node.js" / "C++" intact.
    const parts = s.split(/[,;\n|/]+/).map((p) => p.trim()).filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const p of parts.length > 1 ? parts : [s]) {
      const n = D.norm(p);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(p);
    }
    return out.slice(0, cap);
  }

  function multiChipCount(multi) {
    return promptSelectionNodes(multi).length;
  }

  // Relatedness — NEVER bare w.includes(t) (Fiserv: "fastapi".includes("fasta"),
  // "go"→Go-Carts). Exact / prefix / token-boundary only.
  function skillTextRelated(rowText, token) {
    const t = D.norm(rowText);
    const w = D.norm(token);
    if (!t || !w) return false;
    if (t === w) return true;
    if (w === "c#" || w === "c sharp") return /c\s*sharp|\bc#\b|unity c#/.test(t);
    if (w === "c++" || w === "cpp") return /c\+\+|cpp|c plus plus/.test(t);
    if (w.length <= 3) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (
        t === w ||
        t.startsWith(w + " (") ||
        t.startsWith(w + " programming") ||
        new RegExp("(^|[^a-z0-9])" + esc + "(\\s|\\(|$)").test(t)
      );
    }
    if (t.startsWith(w + " ") || t.startsWith(w + "(") || t.startsWith(w + " -")) return true;
    if (t.includes(w)) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("(^|[^a-z0-9.])" + esc + "([^a-z0-9.]|$)").test(t);
    }
    return false;
  }

  function pickBestSkillOption(token, root) {
    const w = D.norm(token);
    if (!w || !root) return null;
    const scored = promptResultOptions(root)
      .map((o) => ({ o, t: D.norm(o.textContent) }))
      .filter((x) => x.t && skillTextRelated(x.t, w));
    if (!scored.length) return null;
    const exact = scored.find((x) => x.t === w);
    if (exact) return exact.o;
    const prefixed = scored
      .filter((x) => x.t.startsWith(w + " ") || x.t.startsWith(w + "("))
      .sort((a, b) => a.t.length - b.t.length);
    if (prefixed.length) return prefixed[0].o;
    return scored.sort((a, b) => a.t.length - b.t.length)[0].o;
  }

  // True only when the open list shows a row related to the typed skill.
  async function waitForSkillsSearchResults(ownerMulti, typed, ms) {
    const w = D.norm(typed);
    if (!w) return false;
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) {
      throwIfAborted();
      const root = activeMultiListRoot(ownerMulti);
      const rows = promptResultOptions(root);
      if (rows.some((o) => skillTextRelated(o.textContent, typed))) return true;
      await D.delay(100);
    }
    return false;
  }

  async function clearSkillsSearchInput(input) {
    if (!input) return;
    try {
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {}
    }
    D.nativeSet(input, "");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    await D.delay(50);
  }

  // Select a skill row IDEMPOTENTLY.
  //
  // US LBM 2026-08-07 skills-diag-v21 proof: the skills typeahead commits the
  // pill from the search itself (chips=1 BEFORE any click), and its result rows
  // are TOGGLES — so clickMultiOptionRow's extra clicks (row + promptOption +
  // checkbox) re-clicked the already-selected row and fired PILL-REMOVED twice,
  // ending at chips=0. Fix: if the skill is already committed, DO NOT click; if
  // not, click ONE target and stop the instant a chip appears (never a 2nd click
  // on a selected row). "Committed" = chip count grew past chipsBefore or the
  // exact token/row text is chosen — never promptChosen(multi,"") (that is true
  // whenever ANY earlier skill is present and would false-positive later tokens).
  async function commitSkillRow(multi, match, token, chipsBefore) {
    const added = () =>
      multiChipCount(multi) > chipsBefore ||
      promptChosen(multi, token) ||
      (match && match.textContent && promptChosen(multi, match.textContent));
    if (added()) return true;
    const row =
      (match.closest &&
        (match.closest('[data-automation-id="menuItem"]') || match.closest('[role="option"]'))) ||
      match;
    const targets = [
      row.querySelector && row.querySelector('[data-automation-id="promptLeafNode"]'),
      row.querySelector && row.querySelector('[data-automation-id="promptOption"]'),
      row,
    ].filter(Boolean);
    for (const t of targets) {
      firePointerClick(t, { scroll: "nearest" });
      // Verify with a real wait so a slow async commit is seen BEFORE we would
      // click another target — a 2nd click on a now-selected row toggles it off.
      const end = Date.now() + 700;
      while (Date.now() < end) {
        if (added()) return true;
        await D.delay(80);
      }
    }
    return added();
  }

  async function fillOneSkillToken(multi, input, skill) {
    const token = String(skill || "").replace(/\s+/g, " ").trim();
    if (!token) return false;
    if (promptChosen(multi, token)) return true;

    const chipsBefore = multiChipCount(multi);
    // DIAG (v21): tag every risky sub-step so the pill-removal observer in
    // fillSkillsPrompt reports WHICH action deleted a committed chip.
    WD._skillsStage = "clear-before:" + token.slice(0, 24) + " chips=" + chipsBefore;
    try {
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {}
    }
    await clearSkillsSearchInput(input);
    WD._skillsStage = "type:" + token.slice(0, 24) + " chips=" + multiChipCount(multi);
    D.nativeSet(input, token);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: token, inputType: "insertText" }));
    const last = token.slice(-1) || "a";
    pressKey(input, last, "Key" + (/[a-z]/i.test(last) ? last.toUpperCase() : "A"), last.charCodeAt(0) || 65);
    await D.delay(60);

    let gotResults = await waitForSkillsSearchResults(multi, token, 1000);
    if (!gotResults) {
      WD._skillsStage = "enter-for-results:" + token.slice(0, 24);
      try {
        input.focus({ preventScroll: true });
      } catch {}
      pressEnter(input);
      gotResults = await waitForSkillsSearchResults(multi, token, 4500);
    }
    let root = activeMultiListRoot(multi);
    const mounted = promptResultOptions(root)
      .slice(0, 6)
      .map((o) => String(o.textContent || "").replace(/\s+/g, " ").trim().slice(0, 48));
    try {
      if (WD.aa) {
        WD.aa("fillSkills search", {
          skill: token.slice(0, 40),
          gotResults,
          mounted,
        });
      }
    } catch {}

    if (!gotResults) {
      await clearSkillsSearchInput(input);
      return false;
    }

    // Pointer-select best RELATED row. Do NOT focus input first (Fiserv chips:0).
    // Do NOT rely on Enter#2 alone (often re-submits search).
    root = activeMultiListRoot(multi);
    let match = pickBestSkillOption(token, root);
    if (!match) {
      await D.delay(150);
      root = activeMultiListRoot(multi);
      match = pickBestSkillOption(token, root);
    }
    if (!match) {
      try {
        if (WD.aa) WD.aa("fillSkills no-row", { skill: token.slice(0, 40), mounted });
      } catch {}
      await clearSkillsSearchInput(input);
      return false;
    }

    WD._skillsStage = "click-row:" + token.slice(0, 24) + " chips=" + multiChipCount(multi);
    // Idempotent select — never re-click a selected (toggle) row.
    let ok = await commitSkillRow(multi, match, token, chipsBefore);
    WD._skillsStage = "post-click-verify:" + token.slice(0, 24) + " chips=" + multiChipCount(multi);

    if (!ok) {
      WD._skillsStage = "arrowdown-enter:" + token.slice(0, 24);
      try {
        input.focus({ preventScroll: true });
      } catch {}
      pressKey(input, "ArrowDown", "ArrowDown", 40);
      await D.delay(80);
      pressEnter(input);
      ok = multiChipCount(multi) > chipsBefore || promptChosen(multi, token);
    }

    WD._skillsStage = "clear-after:" + token.slice(0, 24) + " chips=" + multiChipCount(multi);
    await clearSkillsSearchInput(input);
    WD._skillsStage = "token-done:" + token.slice(0, 24) + " chips=" + multiChipCount(multi);
    return !!ok;
  }

  async function fillSkillsPrompt(multi, skillsRaw) {
    const tokens = parseSkillTokens(skillsRaw, SKILLS_MAX);
    if (!multi || !tokens.length) return false;
    const input = await openMultiPrompt(multi);
    if (!input) {
      try {
        if (WD.aa) WD.aa("fillSkills FAIL", { reason: "no-input", count: tokens.length });
      } catch {}
      return false;
    }
    // DIAG (v21): the reported bug is "chip is added then automatically
    // deselected". Watch the multiselect subtree for pill REMOVALS and log the
    // current WD._skillsStage marker (set in fillOneSkillToken) so the console
    // proves EXACTLY which sub-step deletes a committed chip — no guessing.
    const chipTexts = () =>
      promptSelectionNodes(multi).map((n) => (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 32));
    const isPill = (n) =>
      n &&
      n.nodeType === 1 &&
      ((n.matches && n.matches('[data-automation-id="selectedItem"],[data-automation-id="pill"]')) ||
        (n.querySelector && !!n.querySelector('[data-automation-id="selectedItem"],[data-automation-id="pill"]')));
    let pillObserver = null;
    try {
      pillObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          const removed = [...m.removedNodes].filter(isPill);
          if (!removed.length) continue;
          const removedText = removed
            .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 32))
            .filter(Boolean);
          try {
            if (WD.aa) {
              WD.aa("fillSkills PILL-REMOVED", {
                stage: WD._skillsStage || "unknown",
                removed: removedText,
                chipsNow: multiChipCount(multi),
                chips: chipTexts(),
              });
            }
          } catch {}
        }
      });
      pillObserver.observe(multi, { childList: true, subtree: true });
    } catch {}
    WD._skillsStage = "prompt-open";
    let added = 0;
    const misses = [];
    for (const skill of tokens) {
      throwIfAborted();
      let ok = false;
      try {
        ok = await fillOneSkillToken(multi, input, skill);
      } catch (e) {
        if (e && e.name === "WDAborted") throw e;
      }
      if (ok) added += 1;
      else misses.push(String(skill).slice(0, 40));
      try {
        if (WD.aa) {
          WD.aa("fillSkills token", {
            skill: String(skill).slice(0, 40),
            ok,
            chips: multiChipCount(multi),
          });
        }
      } catch {}
      WD._skillsStage = "between-tokens chips=" + multiChipCount(multi);
      if (added >= SKILLS_MAX) break;
    }
    WD._skillsStage = "close-prompt chips=" + multiChipCount(multi);
    await closePrompt(multi, input);
    WD._skillsStage = "closed chips=" + multiChipCount(multi);
    try {
      if (pillObserver) pillObserver.disconnect();
    } catch {}
    try {
      if (WD.aa) {
        WD.aa("fillSkills DONE", {
          added,
          total: tokens.length,
          misses: misses.slice(0, 12),
          chips: multiChipCount(multi),
        });
      }
    } catch {}
    return added > 0 || multiChipCount(multi) > 0;
  }

  function labelElForInput(input) {
    if (!input) return null;
    let lbl = null;
    if (input.id) {
      try {
        lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      } catch {}
    }
    if (!lbl) lbl = input.closest("label");
    if (!lbl && input.parentElement) {
      lbl = input.parentElement.querySelector("label");
    }
    return lbl;
  }

  function clickInputOrLabel(input) {
    if (!input) return;
    // Prefer native HTMLElement.click on the input so React's delegated
    // onChange sees the event (label pointer-only can flip .checked without
    // updating Workday's model — Fiserv military group proof).
    try {
      input.focus({ preventScroll: true });
    } catch {}
    try {
      input.click();
    } catch {
      const lbl = labelElForInput(input);
      firePointerClick(lbl || input, { scroll: "nearest" });
    }
  }

  // Set native checked via the prototype setter (same idea as setReactValue for
  // text), then fire the events Workday/React bind for checkbox groups.
  function setNativeChecked(input, on) {
    if (!input) return;
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
    const prev = !!input.checked;
    if (desc && typeof desc.set === "function") desc.set.call(input, !!on);
    else input.checked = !!on;
    try {
      if (input._valueTracker) input._valueTracker.setValue(prev ? "true" : "false");
    } catch {}
  }

  function notifyCheckboxReact(input, opts) {
    if (!input) return;
    // Do NOT dispatch a bubbling click here after setNativeChecked — the
    // checkbox's default click action toggles .checked and undoes the setter.
    if (opts && opts.withClick) {
      try {
        input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
    try {
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }

  // Commit a checkbox/radio into Workday's React model.
  //
  // Proven Fiserv chain:
  //   v17: APPLY ok:true with zero boxes checked (unverified click)
  //   v18: applyCheckboxGroup checked:true ok:true, then Save still required
  // Root cause: label pointer-click flips native .checked WITHOUT React's
  // onChange (React maps checkbox onChange → click). Returning on .checked
  // alone is a phantom success — same class as text "visible but model empty".
  //
  // Fix: rising-edge native input.click() so React hears click with checked=true.
  async function commitCheckable(input, wantChecked) {
    if (!input) return false;
    const desired = wantChecked !== false;
    const before = !!input.checked;
    let method = "none";

    const matches = () => !!input.checked === desired;

    const nativeClick = () => {
      try {
        input.focus({ preventScroll: true });
      } catch {}
      try {
        input.click();
        return true;
      } catch {
        return false;
      }
    };

    if (desired) {
      // Ensure we start unchecked (silently), then click → checked=true + React.
      if (input.checked) {
        setNativeChecked(input, false);
        await D.delay(20);
      }
      if (nativeClick()) {
        method = "rising-edge-click";
        await D.delay(50);
      }
      // If still unchecked, label pointer then re-assert with rising-edge click.
      if (!matches()) {
        const lbl = labelElForInput(input);
        firePointerClick(lbl || input, { scroll: "nearest" });
        method = "label-then-rising";
        await D.delay(50);
        // Label may have phantom-checked without React — force rising edge.
        if (input.checked) {
          setNativeChecked(input, false);
          await D.delay(20);
          nativeClick();
          await D.delay(50);
        } else {
          nativeClick();
          await D.delay(50);
        }
      }
      // Last resort: setter + synthetic click (testing-library style).
      if (!matches()) {
        setNativeChecked(input, false);
        setNativeChecked(input, true);
        notifyCheckboxReact(input, { withClick: true });
        method = "setter+synth-click";
        await D.delay(50);
      }
    } else {
      // Uncheck path.
      if (input.checked && nativeClick()) {
        method = "uncheck-click";
        await D.delay(50);
      }
      if (matches() === false && input.checked) {
        const lbl = labelElForInput(input);
        firePointerClick(lbl || input, { scroll: "nearest" });
        method = "uncheck-label";
        await D.delay(50);
      }
      if (input.checked) {
        setNativeChecked(input, false);
        notifyCheckboxReact(input, { withClick: true });
        method = "uncheck-setter";
        await D.delay(40);
      }
    }

    // Settle: React re-render must keep the desired state.
    await D.delay(150);
    if (desired && !input.checked) {
      setNativeChecked(input, false);
      nativeClick();
      await D.delay(80);
      if (!input.checked) {
        setNativeChecked(input, true);
        notifyCheckboxReact(input, { withClick: true });
      }
    }

    const ok = matches();
    try {
      if (WD.aa) {
        WD.aa("commitCheckable", {
          labelHead: String(labelForInput(input) || "").slice(0, 50),
          desired,
          before,
          afterSettle: !!input.checked,
          method,
          reactCleared: desired && !input.checked,
          ok,
        });
      }
    } catch {}
    return ok;
  }

  function pickRadio(radios, value) {
    const want = D.norm(value);
    for (const r of radios) {
      const lt = D.norm(labelForInput(r));
      if (lt && (lt === want || (want === "yes" && lt === "yes") || (want === "no" && lt === "no"))) {
        clickInputOrLabel(r);
        return true;
      }
    }
    for (const r of radios) {
      if (D.norm(r.value) === want) {
        clickInputOrLabel(r);
        return true;
      }
    }
    // "I am not a protected veteran" / "No, I do not have a disability" style.
    for (const r of radios) {
      const lt = D.norm(labelForInput(r));
      if ((want.startsWith("no") && lt.startsWith("no")) || (want.startsWith("i am not") && lt.includes("not"))) {
        clickInputOrLabel(r);
        return true;
      }
    }
    const hit = pickByLabel(radios, value);
    if (hit) {
      clickInputOrLabel(hit);
      return true;
    }
    return false;
  }

  // Snapshot a checkbox-group formField for console / AA diagnosis.
  function probeCheckboxGroup(container, value) {
    const checks = [...(container || document).querySelectorAll('input[type="checkbox"]')];
    return {
      wantHead: value != null ? String(value).slice(0, 60) : null,
      count: checks.length,
      boxes: checks.map((c) => ({
        id: c.id || "",
        name: c.name || "",
        value: c.value || "",
        checked: !!c.checked,
        disabled: !!c.disabled,
        labelHead: String(labelForInput(c) || "").slice(0, 60),
        ariaChecked: c.getAttribute("aria-checked"),
        roleParent: (c.closest('[role="checkbox"], [role="group"], fieldset') || {}).tagName || null,
      })),
      anyChecked: checks.some((c) => c.checked),
    };
  }

  // One-of / "select all that apply" checkbox group: pick by LLM option text,
  // clear other checked boxes, verify the target stays checked after React settle.
  async function applyCheckboxGroup(checks, value) {
    if (!checks || !checks.length) return false;
    if (checks.length === 1 && /^(yes|no|true|false|on|off|1|0)$/i.test(String(value))) {
      const on = value === true || /^(yes|true|on|1)$/i.test(String(value));
      return await commitCheckable(checks[0], on);
    }
    const target = pickByLabel(checks, value);
    if (!target) {
      try {
        if (WD.aa) {
          WD.aa("applyCheckboxGroup", {
            wantHead: String(value).slice(0, 60),
            ok: false,
            reason: "no-pick",
            probe: {
              count: checks.length,
              labels: checks.map((c) => String(labelForInput(c) || "").slice(0, 40)),
            },
          });
        }
      } catch {}
      return false;
    }
    for (const c of checks) {
      if (c !== target && c.checked) {
        const cleared = await commitCheckable(c, false);
        if (!cleared) {
          try {
            WD.warn("checkbox group: failed to clear sibling", labelForInput(c));
          } catch {}
        }
      }
    }
    const ok = await commitCheckable(target, true);
    // Final model check: at least one box in the group must remain checked.
    const groupOk = ok && checks.some((c) => c.checked);
    try {
      if (WD.aa) {
        WD.aa("applyCheckboxGroup", {
          wantHead: String(value).slice(0, 60),
          pickedHead: String(labelForInput(target) || "").slice(0, 60),
          checked: !!target.checked,
          groupAnyChecked: checks.some((c) => c.checked),
          ok: groupOk,
          probe: probeCheckboxGroup(target.closest('[data-automation-id^="formField-"]') || target.parentElement, value),
        });
      }
    } catch {}
    return groupOk;
  }

  async function applyRadioGroup(radios, value) {
    if (!radios || !radios.length) return false;
    const hit = pickByLabel(radios, value);
    if (!hit) {
      // Heuristic match (yes/no / "I am not…"), then verify something is checked.
      pickRadio(radios, value);
      await D.delay(80);
      return !!radios.find((r) => r.checked);
    }
    return await commitCheckable(hit, true);
  }

  async function selectNativeEl(sel, value) {
    for (let i = 0; i < 20 && sel.options.length < 2; i++) await D.delay(100);
    const want = D.norm(value);
    const scored = [...sel.options]
      .map((o, i) => ({ o, t: D.norm(o.text), i }))
      .filter((x) => x.t && !/^select(\s+one)?\.?\.?\.?$/.test(x.t));
    const contains = scored.filter((x) => x.t.includes(want)).sort((a, b) => a.t.length - b.t.length);
    let hit = scored.find((x) => x.t === want) || contains[0];
    // Token-overlap fallback for long OFCCP sentences that share key phrases
    // with a shorter deterministic want string.
    if (!hit && want) {
      const wantTokens = want.split(/\s+/).filter((t) => t.length > 2);
      let best = null;
      let bestScore = 0;
      for (const x of scored) {
        const ot = x.t.split(/\s+/).filter(Boolean);
        if (!ot.length) continue;
        const overlap = wantTokens.filter((t) => ot.some((o) => o === t || o.includes(t) || t.includes(o))).length;
        const score = overlap / Math.max(wantTokens.length, 1);
        if (score > bestScore) {
          bestScore = score;
          best = x;
        }
      }
      if (best && bestScore >= 0.45) hit = best;
    }
    if (!hit) return false;
    try {
      sel.focus({ preventScroll: true });
    } catch {}
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    if (setter) setter.call(sel, hit.o.value);
    else sel.value = hit.o.value;
    if (sel._valueTracker) sel._valueTracker.setValue("");
    sel.selectedIndex = hit.i;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    sel.dispatchEvent(new Event("blur", { bubbles: true }));
    return sel.selectedIndex > 0 && D.norm(hit.o.text).length > 0;
  }

  // Workday MM/YYYY (or YYYY-only) date group inside a formField. The month/year
  // spin-inputs are React-controlled and validate on blur exactly like the text
  // fields, so they MUST go through deferOrCommit or "Save and Continue" reports
  // the date empty even though the digits show (the SpeedyApply failure mode).
  async function fillDateContainer(container, dateStr) {
    if (!dateStr) return null;
    // Accept both MM/YYYY (work/education history) and MM/DD/YYYY (Self-Identify
    // signature date). A "day" section only exists on the full-date widget.
    const parts = String(dateStr).split("/");
    let mm, dd, yyyy;
    if (parts.length >= 3) [mm, dd, yyyy] = parts;
    else [mm, yyyy] = parts;
    const month =
      container.querySelector(AID("dateSectionMonth-input")) || container.querySelector("input[aria-label*='Month' i]");
    const day =
      container.querySelector(AID("dateSectionDay-input")) || container.querySelector("input[aria-label*='Day' i]");
    const year =
      container.querySelector(AID("dateSectionYear-input")) || container.querySelector("input[aria-label*='Year' i]");
    // PROVEN (console probe): these date sections are <input role="spinbutton">.
    // Workday commits them via the onKeyDown digit handler, NOT onInput/onChange -
    // which is why setReactValue alone showed the digits but left the model empty
    // ("Date is required"). So TYPE the digits via key events (these fire even
    // while the page lacks OS focus), then mirror the value for any input-based
    // handler. Must stay synchronous: deferOrCommit calls applyValue() without await.
    const fireKey = (el, key, code, keyCode) => {
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, keyCode, which: keyCode }));
      }
    };
    const setSection = (el, raw) => {
      const v = String(raw);
      try {
        el.focus({ preventScroll: true });
      } catch {}
      // Clear any stale/partial value, then type each digit.
      setReactValue(el, "");
      fireKey(el, "Backspace", "Backspace", 8);
      for (const ch of v) fireKey(el, ch, "Digit" + ch, 48 + Number(ch));
      // Mirror to .value for controlled-input handlers (harmless if unused).
      setReactValue(el, v);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: v }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const els = [];
    if (month && mm) els.push(month);
    if (day && dd) els.push(day);
    if (year && yyyy) els.push(year);
    if (!els.length) return false;
    const applyValue = () => {
      if (month && mm) setSection(month, parseInt(mm, 10));
      if (day && dd) setSection(day, parseInt(dd, 10));
      if (year && yyyy) setSection(year, yyyy);
    };
    await deferOrCommit(applyValue, els);
    return true;
  }

  // Detect the control inside a formField wrapper and write the value.
  async function writeField(container, value, label) {
    if (value == null || value === "") return null;
    let raw = String(value);
    // Phone Number: national digits only — never write "+1…" into this field.
    try {
      const aid = (container.getAttribute && container.getAttribute("data-automation-id")) || "";
      if (/formField-phoneNumber\b/i.test(aid) || isPhoneNumberField("", label)) {
        raw = nationalPhoneDigits(raw);
        if (!raw) return null;
      }
    } catch {}
    // Veteran EEO tokens must be resolved against THIS tenant's live options.
    if (raw === "__EEO_VETERAN_TRUE__" || raw === "__EEO_VETERAN_FALSE__") {
      return await fillVeteranField(container, raw === "__EEO_VETERAN_TRUE__");
    }
    // Legacy deterministic veteran strings that no longer match modern UPS wording.
    if (/veteran/i.test(label || "") || /veteran/i.test(raw)) {
      if (/__EEO_VETERAN_TRUE|i am a veteran|identify as.*protected veteran/i.test(raw) && !/not a|non-veteran|decline|choose not/i.test(raw)) {
        const ok = await fillVeteranField(container, true);
        if (ok) return true;
      }
      if (/__EEO_VETERAN_FALSE|i am not a|not a protected veteran|not a veteran|non-veteran|choose not|decline/i.test(raw)) {
        const ok = await fillVeteranField(container, false);
        if (ok) return true;
      }
    }
    const multi = container.querySelector('[data-automation-id="multiSelectContainer"]');
    if (multi) {
      // "How Did You Hear About Us?" needs the select-and-verify loop so a
      // referral leaf (which spawns an unfillable required "name/email" field)
      // is skipped in favor of a follow-up-free source. Other multiselects
      // (e.g. Country Phone Code) keep the plain path.
      if (isSourceField(container, label)) return await fillSourcePrompt(multi, value, container);
      if (isSkillsField("", label) || isSkillsField(
        (container.getAttribute("data-automation-id") || "").replace(/^formField-/, ""),
        label,
      )) {
        return await fillSkillsPrompt(multi, value);
      }
      return await fillMultiselect(multi, value);
    }
    const listbox = listboxTrigger(container);
    if (listbox) {
      // ALL Workday Canvas listbox dropdowns: portal harvest → snap → pointer pick.
      // Do not expand Yes/No / acknowledgment / EEO strings here — that raced the
      // LLM portal path and false-matched (e.g. disability sentence → "No").
      const ok = await applyListboxPortal(listbox, value);
      try {
        if (isAcknowledgmentSelectLabel(label) || isReasonableAccommodationLabel(label || "")) {
          WD.log("ACK TRACE write portal", {
            value,
            ok,
            shown: selectDisplayValue(listbox) || triggerCurrentValue(listbox),
            placeholder: triggerShowsPlaceholder(listbox),
          });
        }
      } catch {}
      return ok;
    }
    const nativeSel = container.querySelector("select");
    if (nativeSel) return await selectNativeEl(nativeSel, value);
    // Radio / checkbox BEFORE text: formFields can embed hidden/ancillary inputs;
    // writing the option sentence into a text node returned ok:true while the
    // real checkboxes stayed empty (Fiserv military status).
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    if (radios.length) return await applyRadioGroup(radios, value);
    const checks = [...container.querySelectorAll('input[type="checkbox"]')];
    if (checks.length) return await applyCheckboxGroup(checks, value);
    if (isDateContainer(container)) {
      return await fillDateContainer(container, value);
    }
    const text = container.querySelector(
      'input[type="text"]:not(.css-77hcv):not([role="combobox"]), textarea, input[type="tel"], input[type="number"], input:not([type]):not([role="combobox"]):not([aria-haspopup="listbox"])',
    );
    if (text) {
      // A <textarea> is a plain-text field: never let Markdown (**bold**, `code`,
      // [links]) through, no matter the source (deterministic value, the LLM
      // fallback echoing résumé text, or anything else). This is the single choke
      // point every text write passes through, so stripping here is authoritative.
      const v = text.tagName === "TEXTAREA" ? stripMarkdown(value) : value;
      return writeTextEl(text, v);
    }
    return false;
  }

  function isDateContainer(container) {
    return !!(
      container.querySelector(AID("dateSectionMonth-input")) ||
      container.querySelector(AID("dateSectionDay-input")) ||
      container.querySelector(AID("dateSectionYear-input"))
    );
  }

  // Workday marks required fields in several ways depending on the control: the
  // standard aria-required="true", a red "*" asterisk in the label, a required
  // indicator node, OR (for listbox buttons like veteran/gender) by appending
  // "Required" to the control's own aria-label with NO aria-required attribute.
  // Checking only aria-required missed those buttons, so their failed/unmatched
  // values never reached the LLM fallback.
  function isRequired(container) {
    if (container.querySelector('[aria-required="true"]')) return true;
    if (container.querySelector('abbr[title="required" i], [data-automation-id="requiredIndicator"]')) return true;
    const labeled = container.querySelector("[aria-label]");
    if (labeled && /\brequired\b/i.test(labeled.getAttribute("aria-label") || "")) return true;
    const lbl = container.querySelector("label, legend");
    if (lbl && /\*/.test(lbl.textContent || "")) return true;
    return false;
  }

  // Disability Self-Identification (CC-305). PROVEN failure mode: this one-of
  // group is NOT inside a standard formField wrapper (its question is plain page
  // text + a fieldset of checkboxes), and the real <input type="checkbox"> is
  // visually hidden behind a styled box - so the generic formField pass never
  // touches it and clicking the input does nothing. We locate the three options
  // anywhere on the page by their distinctive label text and click the LABEL of
  // the correct one (unchecking any other so exactly one stays selected).
  async function fillDisabilitySelfId(profile, rep) {
    const e = (profile && profile.eeo) || {};
    // norm() only collapses whitespace; strip punctuation too so "No, I do not…"
    // compares cleanly.
    const strip = (s) => D.norm(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const rows = D.qa('input[type="checkbox"], input[type="radio"]')
      .map((el) => {
        let lbl = null;
        if (el.id) {
          try {
            lbl = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          } catch {}
        }
        if (!lbl) lbl = el.closest("label") || (el.parentElement && el.parentElement.querySelector("label"));
        return { el, lbl, t: strip(lbl ? lbl.textContent : labelForInput(el)) };
      })
      .filter((x) => x.t);
    const isYes = (t) => /have a disability/.test(t) && !/do not have/.test(t);
    const isNo = (t) => /do not have a disability/.test(t);
    const isDecline = (t) => /do not want to answer/.test(t);
    const group = rows.filter((x) => isYes(x.t) || isNo(x.t) || isDecline(x.t));
    if (group.length < 2) return; // not the CC-305 group on this page
    const target = (e.disability ? group.find((x) => isYes(x.t)) : group.find((x) => isNo(x.t))) || group.find((x) => isNo(x.t));
    if (!target) return;
    // Single-select: clear any other option first.
    for (const x of group) {
      if (x !== target && x.el.checked) {
        D.clickEl(x.lbl || x.el);
        await D.delay(60);
      }
    }
    if (!target.el.checked) {
      D.clickEl(target.lbl || target.el);
      await D.delay(120);
      if (!target.el.checked) {
        D.clickEl(target.el); // fallback: click the input directly
        await D.delay(80);
      }
    }
    try {
      WD.log(`disability self-ID -> '${target.t}' checked=${target.el.checked}`);
    } catch {}
    record(rep, "Disability self-identification", !!target.el.checked);
  }

  function isDisabilityContainer(container, label) {
    const low = (label || "").toLowerCase();
    // CrowdStrike Application Questions "Acknowledgment" embeds
    // "If I have a disability or other condition…" — that is a listbox about
    // generative-AI interview rules, NOT the CC-305 disability self-ID.
    // Matching /disability/ here made fillStep `continue` before resolveByLabel
    // AND before LLM (proven: field stayed Select One; raw pointer-click worked).
    if (isAcknowledgmentSelectLabel(low) || isReasonableAccommodationLabel(low)) return false;
    // Demographics "Self-Identification of Ethnicity/Gender/Veteran" must go through
    // harvest → LLM → apply — never the hardcoded disability checkbox path.
    if (/self.identif/i.test(low) && !/disability/i.test(low)) return false;
    if (/please check one of the boxes|cc-305/i.test(low)) return true;
    if (/self.identif/i.test(low) && /disability/i.test(low)) return true;
    // Require disability self-ID phrasing — bare "disability" alone is too broad.
    if (isDisabilitySelfIdLabel(low)) return true;
    const inputs = [...container.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    if (inputs.length < 2 || inputs.length > 5) return false;
    const blob = inputs.map((el) => labelForInput(el)).join(" ").toLowerCase();
    return /disability|do not want to answer/.test(blob) && /disability/.test(blob);
  }

  function isTermsAcceptField(label) {
    return /accept these terms|yes i accept/i.test((label || "").toLowerCase());
  }

  function onSelfIdOrVoluntaryPage() {
    return (
      D.headingHas("Self Identify") ||
      D.headingHas("Self-Identify") ||
      D.headingHas("Voluntary Disclosure")
    );
  }

  // ── generic step filler (My Information, Voluntary, Questions) ───────────────
  // Work Experience / Education fields live inside a repeating panel group
  // ("Work-Experience-<n>-panel" / "Education-<n>-panel"). Those panels are owned
  // EXCLUSIVELY by fillExperienceExtras, which drives School / Field of Study via
  // the correct server-search-prompt sequence (open→wait→type→wait→Enter) and the
  // Degree listbox via harvested options. The generic fillStep pass must NOT also
  // touch them: it has no value for school/fieldOfStudy in buildValueMap /
  // resolveByLabel, so it routes them through the fillMultiselect/LLM path. That
  // (a) DOUBLE-fills Field of Study (fillStep + fillExperienceExtras both open it)
  // and (b) drives School through fillMultiselect, which never commits the prompt
  // and leaves it empty+required — the two exact symptoms reported.
  function inExperiencePanel(container) {
    const g = container.closest('[role="group"][aria-labelledby$="-panel"]');
    if (!g) return false;
    return /^(Work-Experience|Education)-/.test(g.getAttribute("aria-labelledby") || "");
  }

  function matchesOnlyInvalid(container, key, label, onlyInvalid) {
    if (!onlyInvalid || !onlyInvalid.length) return true;
    const labelNorm = (label || fieldLabel(container) || "").toLowerCase().trim();
    for (const f of onlyInvalid) {
      if (f.key && f.key === key) return true;
      const want = (f.label || "").toLowerCase().trim();
      if (!want) continue;
      if (labelNorm === want || labelNorm.includes(want) || want.includes(labelNorm)) return true;
    }
    return false;
  }

  // True when the formField is a choice control with a finite option list.
  // These MUST go harvest → LLM → exact option text. Never apply resolveByLabel
  // Yes/No/EEO strings directly (CrowdStrike Acknowledgment / accommodation proved
  // that predefined answers are not tenant option text).
  function isOptionBearingContainer(container) {
    if (!container) return false;
    if (container.querySelector('[data-automation-id="multiSelectContainer"]')) return true;
    if (listboxTrigger(container)) return true;
    if (container.querySelector("select")) return true;
    if (container.querySelectorAll('input[type="radio"]').length) return true;
    const checks = container.querySelectorAll('input[type="checkbox"]');
    return checks.length >= 1;
  }

  // Snap an LLM (or fallback) answer onto the harvested option list. Prefer exact
  // tenant text; never return a value that is not in the list.
  function snapToHarvestedOption(value, options) {
    if (value == null || value === "" || !options || !options.length) return null;
    const raw = String(value).replace(/\s+/g, " ").trim();
    if (!raw || isPlaceholderOption(raw)) return null;
    for (const cand of optionAnswerAliases(raw)) {
      const exact = exactOption(cand, options);
      if (exact) return exact;
      const listed = matchOptionFromList(cand, options);
      if (listed) return listed;
      const soft = (options || []).find((o) => !isPlaceholderOption(o) && valueMatchesWant(o, cand));
      if (soft) return soft;
    }
    return null;
  }

  // Profile fact to hint the LLM (country, phone type, how-did-you-hear, …).
  // Screening Yes/No is NOT invented here — the model picks from live options.
  function profileWantForField(key, label, profile, valueByKey) {
    if (key && Object.prototype.hasOwnProperty.call(valueByKey, key) && valueByKey[key] != null && valueByKey[key] !== "") {
      return String(valueByKey[key]);
    }
    const e = (profile && profile.eeo) || {};
    const low = (label || "").toLowerCase();
    if (/how did you hear|how.*hear about/.test(low) && profile && profile.howDidYouHear) {
      return String(profile.howDidYouHear);
    }
    if (/^e-?mail(\s*address)?$|\bemail\b/.test(low) && !/employee|employer|manager|referr/i.test(low)) {
      const em = (profile && profile.contact && profile.contact.email) || (profile && profile.email);
      if (em) return String(em);
    }
    if (/hispanic or latino/.test(low) && e.hispanicLatino != null) return e.hispanicLatino ? "Yes" : "No";
    if (/\bgender\b|\bsex\b/.test(low) && e.gender) return String(e.gender);
    if (/sexual orientation|lgbtq/.test(low)) return String(e.sexualOrientation || "I don't wish to answer");
    if (/what is your race|race\/ethnicity|ethnicity|\brace\b/.test(low) && e.ethnicity) return String(e.ethnicity);
    if (/\bveteran\b/.test(low) && e.veteran != null) return e.veteran ? "veteran" : "not a veteran";
    if (isSkillsField(key, label) && Array.isArray(profile && profile.skills) && profile.skills.length) {
      return profile.skills.slice(0, 40).join(", ");
    }
    if (isDisabilitySelfIdLabel(low) && e.disability != null) {
      return e.disability ? "I have a disability" : "I do not have a disability";
    }
    if (/sponsorship|immigration filing|visa sponsorship|open work permit|permanent residency|do you now or in the future require|will you now or in the future require/.test(low) && e.sponsorship != null) {
      return e.sponsorship ? "Yes" : "No";
    }
    if (/highest degree|degree attained/.test(low) && Array.isArray(profile && profile.education)) {
      for (let i = profile.education.length - 1; i >= 0; i--) {
        const deg = profile.education[i] && profile.education[i].degree;
        if (deg) return String(deg);
      }
    }
    return undefined;
  }

  // A REQUIRED, binary Yes/No control asking the candidate to OPT IN to being
  // contacted (marketing/telemarketing calls, texts, SMS, email). The candidate
  // is never required to consent — only required to answer — so when the model
  // abstains this is the one class of dropped option we can safely default to
  // "No" (decline). Scoped tightly to explicit consent-to-contact wording so we
  // never invent answers to qualification / eligibility questions.
  function isContactConsentLabel(label) {
    const s = String(label || "").toLowerCase();
    if (!/\bconsent\b|opt[-\s]?in|authoriz|permission to|agree to receive|wish to receive/.test(s)) {
      return false;
    }
    return /call|text message|texts?\b|\bsms\b|phone|dialing|prerecorded|autodial|marketing|contact me/.test(s);
  }

  // Batch resolve: one (chunked) WD_RESOLVE for pre-harvested items. Does not write DOM.
  async function resolveItemsWithLLM(items, profile) {
    const values = {};
    if (!items || !items.length) return values;
    WD._resolveCache = WD._resolveCache || {};
    const needLlm = [];
    for (const item of items) {
      throwIfAborted();
      const phoneCc = isCountryPhoneCodeField(item.key, item.label) || /country phone code/i.test(item.label || "");
      const phoneNum = isPhoneNumberField(item.key, item.label) || (/^phone number$/i.test(String(item.label || "").trim()) && !(item.options && item.options.length));
      const cacheKey = (item.label || "").toLowerCase().trim().slice(0, 120);
      if (cacheKey && WD._resolveCache[cacheKey] && !phoneCc && !phoneNum && !item.isSkills && !isSkillsField(item.key, item.label)) {
        const cached = WD._resolveCache[cacheKey];
        if (item.portalOptions && item.portalOptions.length) {
          const choice = resolvePortalChoice(
            cached && (cached.value || cached.id || cached.text || cached),
            item.portalOptions,
          );
          if (choice) {
            values[item.cid] = choice;
            continue;
          }
        } else {
          const snapped = snapToHarvestedOption(cached, item.options);
          if (snapped) {
            values[item.cid] = snapped;
            continue;
          }
        }
      }
      // Phone CC: always ask LLM when options were harvested (exact option text).
      // Phone Number: use profile digits when present — no LLM round-trip needed
      // (DraftKings proof: LLM batch was ~5.4s for mostly profile text fields).
      if (phoneNum) {
        const digits = nationalPhoneDigits(item.want);
        if (digits && digits.length >= 10) {
          values[item.cid] = digits;
          continue;
        }
        needLlm.push(item);
        continue;
      }
      if (phoneCc) {
        needLlm.push(item);
        continue;
      }
      // Free-text / email / tel with a profile value and no option list: use want
      // locally. Sending First Name/City/Email through WD_RESOLVE only added wait.
      const kind = String(item.kind || "text").toLowerCase();
      const hasOpts = !!(item.options && item.options.length) || !!(item.portalOptions && item.portalOptions.length);
      const isChoice =
        hasOpts ||
        item.isSource ||
        item.isSkills ||
        kind === "select" ||
        kind === "radio" ||
        kind === "checkbox" ||
        kind === "multiselect";
      if (!isChoice) {
        if (item.want != null && String(item.want).trim() !== "") {
          values[item.cid] = item.want;
          continue;
        }
        // Required free-text with no profile want: still ask LLM (DraftKings Email
        // was required + want missing before emailAddress was mapped → no-value).
        if (item.required) {
          needLlm.push(item);
          continue;
        }
        // Empty optional free-text — do not spend an LLM slot.
        continue;
      }
      if (item.want && item.portalOptions && item.portalOptions.length) {
        // Exact match only for pre-LLM want snap — soft resolvePortalChoice can
        // mis-pick (e.g. bare "+1" → Anguilla). Hierarchical source L1 never snaps want.
        if (item.sourceHierarchical) {
          if (exactOption(item.want, item.options)) {
            const fromWant = portalChoiceExact(item.want, item.portalOptions);
            if (fromWant) {
              values[item.cid] = fromWant;
              continue;
            }
          }
        } else {
          const fromWant = portalChoiceExact(item.want, item.portalOptions);
          if (fromWant) {
            values[item.cid] = fromWant;
            continue;
          }
        }
      }
      if (item.want && item.options && item.options.length && !item.sourceHierarchical) {
        const fromWant = exactOption(item.want, item.options);
        if (fromWant) {
          values[item.cid] = fromWant;
          continue;
        }
      }
      needLlm.push(item);
    }
    try {
      if (WD.aa) {
        WD.aa("LLM resolve queue", {
          needLlm: needLlm.length,
          local: Object.keys(values).length,
          total: items.length,
        });
      }
    } catch {}
    try {
      const BATCH = 8;
      const totalChunks = Math.max(1, Math.ceil(needLlm.length / BATCH) || 1);
      for (let b = 0; b < needLlm.length; b += BATCH) {
        throwIfAborted();
        const chunk = needLlm.slice(b, b + BATCH);
        const chunkIdx = Math.floor(b / BATCH) + 1;
        try {
          if (WD.reportPhase) {
            WD.reportPhase(`Asking AI for answers (${chunkIdx}/${totalChunks})…`);
          }
        } catch {}
        const part = await requestOptionMatches(chunk);
        for (const item of chunk) {
          const raw = part && part[item.cid];
          if (raw == null || raw === "") continue;
          const phoneCc = isCountryPhoneCodeField(item.key, item.label) || /country phone code/i.test(item.label || "");
          const phoneNum = isPhoneNumberField(item.key, item.label) || (/phone number/i.test(item.label || "") && !(item.options && item.options.length));
          if (phoneCc) {
            // Exact LLM option text only — never force USA over the model.
            const text = snapExactPhoneCcAnswer(raw, item.options, item.portalOptions);
            if (text) {
              const hit =
                (item.portalOptions || []).find((o) => D.norm(o.text) === D.norm(text)) ||
                { id: text, value: text, text };
              values[item.cid] = hit;
            }
            continue;
          }
          if (phoneNum) {
            // Format cleanup only (strip +1 / punctuation) — not a different answer.
            values[item.cid] = nationalPhoneDigits(raw) || nationalPhoneDigits(item.want);
            continue;
          }
          if (item.isSkills || isSkillsField(item.key, item.label)) {
            const tokens = parseSkillTokens(raw);
            if (tokens.length) values[item.cid] = tokens;
            continue;
          }
          if (item.portalOptions && item.portalOptions.length) {
            const choice = portalChoiceExact(raw, item.portalOptions) || resolvePortalChoice(raw, item.portalOptions);
            if (choice) values[item.cid] = choice;
            else {
              const snapped = snapToHarvestedOption(raw, item.options);
              if (snapped) values[item.cid] = snapped;
            }
          } else if (item.options && item.options.length) {
            const snapped = snapToHarvestedOption(raw, item.options);
            if (snapped) values[item.cid] = snapped;
          } else {
            values[item.cid] = raw;
          }
        }
      }
    } catch (e) {
      if (e && e.name === "WDAborted") throw e;
    }
    for (const item of items) {
      if (values[item.cid]) continue;
      const phoneCc = isCountryPhoneCodeField(item.key, item.label) || /country phone code/i.test(item.label || "");
      const phoneNum = isPhoneNumberField(item.key, item.label) || (/phone number/i.test(item.label || "") && !(item.options && item.options.length));
      if (phoneCc) {
        // LLM empty only: exact snap of profile want onto harvested list.
        const text = snapExactPhoneCcAnswer(item.want, item.options, item.portalOptions);
        if (text) {
          values[item.cid] =
            (item.portalOptions || []).find((o) => D.norm(o.text) === D.norm(text)) ||
            { id: text, value: text, text };
        }
        continue;
      }
      if (phoneNum) {
        const digits = nationalPhoneDigits(item.want);
        if (digits) values[item.cid] = digits;
        continue;
      }
      if ((item.isSkills || isSkillsField(item.key, item.label)) && item.want) {
        const tokens = parseSkillTokens(item.want);
        if (tokens.length) values[item.cid] = tokens;
        continue;
      }
      if (item.want && item.portalOptions && item.portalOptions.length && !item.sourceHierarchical) {
        const fromWant = resolvePortalChoice(item.want, item.portalOptions);
        if (fromWant) {
          values[item.cid] = fromWant;
          continue;
        }
      }
      if (item.want && !item.sourceHierarchical) {
        const fromWant = snapToHarvestedOption(item.want, item.options);
        if (fromWant) {
          values[item.cid] = fromWant;
          continue;
        }
      }
      // How Did You Hear (flat or any source with a harvested list): if the
      // model left this cid empty, pick LinkedIn / peer board from the SAME
      // list that was sent to the LLM — one-pass fill, no second WD_RUN.
      if (
        !values[item.cid] &&
        item.isSource &&
        item.options &&
        item.options.length &&
        !item.sourceHierarchical
      ) {
        const local = pickSourceLeafLocal(item.want, item.options);
        if (local) {
          values[item.cid] = local;
          try {
            WD.log(`source batch fallback local pick → ${local}`);
          } catch {}
          continue;
        }
      }
      if (item.options && item.options.length) {
        const local = localScreeningPick(item.label, profile, item.options);
        if (local) {
          if (item.portalOptions && item.portalOptions.length) {
            const snapped = resolvePortalChoice(local, item.portalOptions);
            if (snapped) values[item.cid] = snapped;
          } else {
            values[item.cid] = local;
          }
        }
      }
      // Text fields: fall back to profile want when LLM returned empty.
      if (!values[item.cid] && item.want && !(item.options && item.options.length)) {
        values[item.cid] = item.want;
      }
    }

    // Retry pass: the batch LLM response is non-deterministic and can OMIT a
    // control (Fiserv 2026-08-07 v19: "Do you have any relatives currently
    // employed at Fiserv?" came back with no value → APPLY no-value → Save
    // rejected, even though the identical question was answered "No" the run
    // before). There is no profile `want` for these Yes/No screeners, so none of
    // the want/local fallbacks above can fill them. Re-ask ONLY the required
    // option controls the model dropped, once, before giving up.
    const missingRequired = items.filter(
      (it) =>
        !values[it.cid] &&
        it.required &&
        !it.isSkills &&
        !isSkillsField(it.key, it.label) &&
        ((it.options && it.options.length) || (it.portalOptions && it.portalOptions.length)),
    );
    if (missingRequired.length) {
      try {
        if (WD.aa) {
          WD.aa("LLM resolve retry", {
            count: missingRequired.length,
            labels: missingRequired.map((it) => String(it.label || "").slice(0, 50)),
          });
        }
      } catch {}
      try {
        const retry = await requestOptionMatches(missingRequired);
        for (const item of missingRequired) {
          const raw = retry && retry[item.cid];
          if (raw == null || raw === "") continue;
          if (item.portalOptions && item.portalOptions.length) {
            const choice =
              portalChoiceExact(raw, item.portalOptions) || resolvePortalChoice(raw, item.portalOptions);
            if (choice) values[item.cid] = choice;
            else {
              const snapped = snapToHarvestedOption(raw, item.options);
              if (snapped) values[item.cid] = snapped;
            }
          } else if (item.options && item.options.length) {
            const snapped = snapToHarvestedOption(raw, item.options);
            if (snapped) values[item.cid] = snapped;
          } else {
            values[item.cid] = raw;
          }
        }
      } catch (e) {
        if (e && e.name === "WDAborted") throw e;
      }
      try {
        if (WD.aa) {
          const still = missingRequired.filter((it) => !values[it.cid]);
          WD.aa("LLM resolve retry DONE", {
            recovered: missingRequired.length - still.length,
            stillMissing: still.map((it) => String(it.label || "").slice(0, 50)),
          });
        }
      } catch {}
    }

    // Final deterministic fallback for a REQUIRED contact-consent Yes/No the model
    // still would not answer. Proven GDIT 2026-08-07: "I consent to receive
    // telephone calls and/or text messages from GDIT…" came back answered:0 on the
    // batch AND on the retry (recovered:0) → APPLY no-value → Save rejected the
    // whole step every attempt. There is no profile `want` for a consent, so pick
    // the privacy-safe, application-neutral option ("No" = decline). This ONLY
    // fires for a clean binary Yes/No whose label is explicit consent-to-contact
    // wording, so qualification questions are never auto-answered.
    for (const item of items) {
      if (values[item.cid]) continue;
      if (!item.required) continue;
      if (item.isSkills || isSkillsField(item.key, item.label)) continue;
      const opts = item.portalOptions && item.portalOptions.length ? item.portalOptions : null;
      if (!opts || opts.length !== 2) continue;
      if (!isContactConsentLabel(item.label)) continue;
      const normed = opts.map((o) => ({ o, t: D.norm(o && o.text) }));
      const hasYes = normed.some((x) => /^yes\b/.test(x.t));
      const decline = normed.find((x) => /^no\b/.test(x.t));
      if (!hasYes || !decline) continue;
      values[item.cid] = decline.o;
      try {
        if (WD.aa) {
          WD.aa("LLM consent default", {
            label: String(item.label || "").slice(0, 60),
            pick: decline.o && decline.o.text,
          });
        }
      } catch {}
    }

    return values;
  }

  function valueText(value) {
    if (value == null) return "";
    if (typeof value === "object") return String(value.text || value.value || value.id || "").trim();
    return String(value).trim();
  }

  // Shared by every flat Workday step (My Information, Application Questions,
  // Voluntary Disclosures, Self Identify, …): collect → harvest → one LLM batch
  // → apply. The ONLY extra round-trip is How Did You Hear L2 when that field is
  // hierarchical (category folders). Experience work/edu panels stay in
  // fillExperienceExtras (search prompts + resume), not this path.
  async function waitForStepFormFieldsReady() {
    // 1) Wait until ANY formField / checkbox / radio is present (nav transition).
    for (
      let i = 0;
      i < 16 &&
      D.qa('[data-automation-id^="formField-"]').filter(D.isVisible).length === 0 &&
      D.qa('input[type="checkbox"], input[type="radio"]').filter(D.isVisible).length === 0;
      i++
    ) {
      await D.delay(150);
    }
    // 2) Stabilize count. Proven Zillow Voluntary Disclosures failure
    // (2026-08-06 listbox-source-v2 logs): fillStep START saw containerCount:1
    // (only acceptTermsAndAgreements / Acknowledged), then ~3s later pre-save
    // detectStep reported fieldCount:4 — Ethnicity / Gender / Veteran had mounted
    // AFTER the collect snapshot, so Review kept "No Response". Exiting on the
    // first formField was too early.
    let last = -1;
    let stableHits = 0;
    let finalCount = 0;
    for (let i = 0; i < 20; i++) {
      finalCount = D.qa('[data-automation-id^="formField-"]').filter(D.isVisible).length;
      if (finalCount === last && finalCount > 0) {
        stableHits += 1;
        // 2×150ms ≈ 300ms unchanged (was 3×250ms ≈ 750ms).
        if (stableHits >= 2) break;
      } else {
        stableHits = 0;
        last = finalCount;
      }
      await D.delay(150);
    }
    try {
      if (WD.aa) {
        WD.aa("fillStep waitFormFields", {
          fieldCount: finalCount,
          stableHits,
          voluntaryLike: onSelfIdOrVoluntaryPage(),
        });
      }
    } catch {}
    return finalCount;
  }

  async function fillStep(profile, options, rep) {
    options = options || {};
    const onlyInvalid = Array.isArray(options.onlyInvalid) ? options.onlyInvalid : null;
    throwIfAborted();
    // Wait for the step to finish mounting controls (not merely the first one).
    await waitForStepFormFieldsReady();
    const valueByKey = buildValueMap(profile);
    const containers = D.qa('[data-automation-id^="formField-"]').filter(D.isVisible);
    const decisions = { skip: 0, collect: 0, harvest: 0, write: 0, experience: 0 };
    const targets = [];
    try {
      if (WD.aa) {
        const inventory = containers.slice(0, 40).map((c) => {
          const aid = c.getAttribute("data-automation-id") || "";
          const key = aid.replace(/^formField-/, "");
          const label = fieldLabel(c);
          const trig = listboxTrigger(c);
          return {
            key: key.slice(0, 40),
            labelHead: String(label || "").slice(0, 70),
            filled: fieldIsFilled(c),
            committed: fieldHasCommittedValue(c),
            invalid: !!c.querySelector('[aria-invalid="true"]'),
            required: isRequired(c),
            kind: c.querySelector('[data-automation-id="multiSelectContainer"]')
              ? "multi"
              : trig
                ? "listbox"
                : c.querySelector("select")
                  ? "native"
                  : c.querySelector('input[type="radio"]')
                    ? "radio"
                    : c.querySelectorAll('input[type="checkbox"]').length > 1
                      ? "checkbox-group"
                      : c.querySelector('input[type="checkbox"]')
                        ? "checkbox"
                        : c.querySelector("textarea")
                          ? "textarea"
                          : "text",
            shown: trig
              ? String(selectDisplayValue(trig) || triggerCurrentValue(trig) || "").slice(0, 40)
              : null,
            inExp: inExperiencePanel(c),
          };
        });
        WD.aa("fillStep START", {
          containerCount: containers.length,
          onlyInvalid: onlyInvalid
            ? onlyInvalid.map((f) => ({ key: f.key, labelHead: String(f.label || "").slice(0, 80) }))
            : null,
          heading: D.pageHeadingContaining
            ? D.pageHeadingContaining("Application Question") || (D.pageHeadingText && D.pageHeadingText()) || ""
            : D.pageHeadingText
              ? D.pageHeadingText()
              : "",
          inventory,
        });
      }
    } catch {}

    // ── Phase 1: COLLECT (no DOM writes, no per-field LLM) ──
    for (const c of containers) {
      throwIfAborted();
      const aid = c.getAttribute("data-automation-id") || "";
      const key = aid.replace(/^formField-/, "");
      const label = fieldLabel(c);
      const labelHead = String(label || "").slice(0, 100);
      const skipLog = (reason, extra) => {
        decisions.skip += 1;
        try {
          if (WD.aa) WD.aa("fillStep SKIP", { reason, key: key.slice(0, 40), labelHead, ...(extra || {}) });
        } catch {}
      };
      if (
        c.querySelector('input[type="file"]') ||
        /upload a file|attach.*resume|drop files here/i.test(label || "")
      ) {
        skipLog("file-upload-delegated");
        continue;
      }
      if (inExperiencePanel(c)) {
        decisions.experience += 1;
        skipLog("inExperiencePanel");
        continue;
      }
      if (onlyInvalid) {
        if (!matchesOnlyInvalid(c, key, label, onlyInvalid)) {
          skipLog("onlyInvalid-mismatch");
          continue;
        }
      } else if (fieldIsFilled(c)) {
        skipLog("fieldIsFilled", {
          committed: fieldHasCommittedValue(c),
          ariaInvalid: !!c.querySelector('[aria-invalid="true"]'),
          shown: (() => {
            const t = listboxTrigger(c);
            return t ? String(selectDisplayValue(t) || triggerCurrentValue(t) || "").slice(0, 40) : null;
          })(),
        });
        continue;
      }
      if (shouldSkipFailedField(key, label)) {
        const stillInvalid = !!(onlyInvalid && c.querySelector('[aria-invalid="true"]'));
        if (!stillInvalid) {
          if (!fieldHasCommittedValue(c)) {
            rep.unmatched.push({ key, label: label || key });
          }
          skipLog("shouldSkipFailedField", { stillInvalid, committed: fieldHasCommittedValue(c) });
          continue;
        }
        try {
          if (WD.aa) WD.aa("fillStep bypass-failed-skip", { key: key.slice(0, 40), labelHead });
        } catch {}
      }
      if (isDisabilityContainer(c, label)) {
        skipLog("isDisabilityContainer");
        continue;
      }
      if (onlyInvalid && fieldHasCommittedValue(c)) {
        const stillInvalid = !!c.querySelector('[aria-invalid="true"]');
        const simpleList =
          !!listboxTrigger(c) && !c.querySelector('[data-automation-id="multiSelectContainer"]');
        // A committed value that Workday STILL flags aria-invalid must be
        // RE-COMMITTED, not skipped. Proven GDIT 2026-08-07: the "By typing your
        // name…certify" textarea held "Zeyu Wang" (committed:true) yet went
        // aria-invalid after Save; recovery hit this branch with simpleList=false
        // (a <textarea>, not a listbox), matched !(stillInvalid && simpleList),
        // recorded it as filled and skipped it forever → the step could never
        // advance. Re-writing a plain text/textarea re-fires input+change+blur
        // (writeTextEl→deferOrCommit, incl. a keystroke retry) which re-registers
        // the value in React and clears aria-invalid. So: only skip when the field
        // is NOT invalid; if it is invalid, let listboxes AND free-text fall
        // through to writeField for a real re-commit.
        const plainTextInvalid =
          stillInvalid &&
          !simpleList &&
          !c.querySelector('[data-automation-id="multiSelectContainer"]') &&
          !!c.querySelector(
            'textarea, input[type="text"], input[type="tel"], input[type="email"], input[type="url"], input[type="number"], input:not([type])',
          );
        if (!(stillInvalid && (simpleList || plainTextInvalid))) {
          record(rep, label || key, true);
          skipLog("onlyInvalid+committed-skip-rewrite", { stillInvalid, simpleList, plainTextInvalid });
          continue;
        }
      }

      const want = profileWantForField(key, label, profile, valueByKey);
      const isOption = isOptionBearingContainer(c);
      const isSource = isSourceField(c, label);
      const isSkills = isSkillsField(key, label);
      const multi = c.querySelector('[data-automation-id="multiSelectContainer"]');

      if (isOption) {
        // Always collect option-bearing controls (required or optional). The
        // shared autofill LLM fills answerable optional checkboxes / skills /
        // dropdowns; do not pre-filter on required.
        decisions.collect += 1;
        let optionWant = want || undefined;
        // Country Phone Code: prefer full USA label as candidate hint for the LLM.
        if (isCountryPhoneCodeField(key, label)) {
          optionWant = USA_PHONE_CC;
        }
        // Skills: prefer profile.skills list as candidate hint (comma-joined).
        if (isSkills && Array.isArray(profile && profile.skills) && profile.skills.length) {
          optionWant = profile.skills.slice(0, 40).join(", ");
        }
        targets.push({
          container: c,
          key,
          label: label || key,
          required: isRequired(c),
          want: optionWant,
          isOption: true,
          isSource,
          isSkills,
          multi,
          localOnly: false,
        });
        continue;
      }

      // Text / date / textarea
      let value = key in valueByKey ? valueByKey[key] : undefined;
      if (value === undefined) value = resolveByLabel(label, profile);
      // Phone Number: candidate digits for the LLM prompt (exact 10-digit reply).
      if (isPhoneNumberField(key, label)) {
        value = nationalPhoneDigits(value != null ? value : want);
      }
      if ((value === undefined || value === null || value === "") && isDateContainer(c)) {
        value = todayDate();
      }
      // Collect every text field (required or optional). The LLM leaves value
      // empty only when unanswerable or a negative conditional follow-up.
      // Dates stay local (no LLM); everything else joins the batch.
      if (isDateContainer(c) && value != null && value !== "") {
        decisions.collect += 1;
        targets.push({
          container: c,
          key,
          label: label || key,
          required: isRequired(c),
          want: String(value),
          isOption: false,
          isSource: false,
          localOnly: true,
          kind: "date",
          options: [],
          portalOptions: [],
        });
        continue;
      }
      decisions.collect += 1;
      targets.push({
        container: c,
        key,
        label: label || key,
        required: isRequired(c),
        want: value != null && value !== "" ? String(value) : want || undefined,
        isOption: false,
        isSource: false,
        localOnly: false,
      });
    }

    try {
      if (WD.aa) {
        WD.aa("fillStep COLLECT", {
          count: targets.length,
          labels: targets.map((t) => String(t.label || t.key || "").slice(0, 60)),
          decisions,
        });
      }
    } catch {}

    if (onSelfIdOrVoluntaryPage()) {
      await fillDisabilitySelfId(profile, rep);
    }

    // ── Phase 2: HARVEST option lists ──
    // Non-phone-CC first (each prompt closed). Phone CC last: scroll-harvest,
    // leave list OPEN near the bottom across the LLM wait, apply immediately after.
    try {
      if (WD.reportPhase) WD.reportPhase("Scanning fields…");
    } catch {}
    let cidSeq = 0;
    const harvestSummary = [];
    let keepOpenPhoneTarget = null;

    const assignCid = (t) => {
      t.cid = ((t.key || "field").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "f") + "_" + cidSeq++;
    };

    const harvestOneTarget = async (t, phoneKeepOpen) => {
      throwIfAborted();
      if (t.localOnly) {
        assignCid(t);
        return;
      }
      assignCid(t);
      try {
        if (WD.aa) {
          WD.aa("fillStep HARVEST field", {
            key: t.key,
            labelHead: String(t.label || "").slice(0, 50),
            isOption: !!t.isOption,
            isSource: !!t.isSource,
            hasListbox: !!listboxTrigger(t.container),
            hasMulti: !!t.multi,
          });
        }
      } catch {}
      if (t.isSkills || isSkillsField(t.key, t.label)) {
        // Type-to-add skills: no options until you type+Enter. Skip empty harvest
        // (proven options:0) and ask the LLM for ALL skill tokens via multi.
        t.isSkills = true;
        t.hierarchical = false;
        t.kind = "select";
        t.options = [];
        t.portalOptions = [];
        t.portalHtml = "";
        t.llmLabel =
          `${t.label} — Type-to-add skills multi-select. There is NO pre-harvested option list. ` +
          `Return ONLY the 7–10 skills MOST relevant to THIS job from the candidate profile ` +
          `(languages/frameworks named in the job first). Do NOT dump the full skill inventory. ` +
          `Put each skill in option_values (one per entry) and a comma-separated copy in value.`;
        if (!t.want && Array.isArray(profile && profile.skills) && profile.skills.length) {
          t.want = profile.skills.slice(0, 24).join(", ");
        }
        decisions.harvest += 1;
        harvestSummary.push({
          key: t.key,
          labelHead: String(t.label).slice(0, 50),
          options: 0,
          kind: "skills-typeahead",
          widget: "multi",
        });
        return;
      }
      if (t.isSource && t.multi) {
        try {
          if (WD.reportPhase) WD.reportPhase("Reading “How Did You Hear” categories…");
        } catch {}
        const l1 = await harvestSourceL1(t.multi);
        t.hierarchical = l1.hierarchical;
        t.options = l1.texts;
        t.portalOptions = l1.portals;
        t.kind = "select";
        t.llmLabel = t.hierarchical
          ? `${t.label} (category) — ${sourceL1CategoryHint(t.want)}`
          : `${t.label} — ${sourceFlatHint(t.want)}`;
        decisions.harvest += 1;
        harvestSummary.push({
          key: t.key,
          labelHead: String(t.label).slice(0, 50),
          options: t.options.length,
          hierarchical: !!t.hierarchical,
          widget: "multi",
        });
        await closeAllListboxes();
        return;
      }
      if (t.isOption) {
        if (phoneKeepOpen && t.multi) {
          // Full 249-list harvest; stay at bottom for post-LLM click.
          let harvested = { options: [], portalOptions: [] };
          try {
            harvested = await harvestMultiOptions(t.multi, { keepOpen: true, resetToTop: false });
          } catch (e) {
            if (e && e.name === "WDAborted") throw e;
          }
          t.kind = "select";
          t.options = harvested.options || [];
          t.portalOptions = harvested.portalOptions || [];
          t.keepOpenMulti = true;
          keepOpenPhoneTarget = t;
          const usa = exactUsaPhoneCcOption(t.options || []);
          if (usa) t.want = usa;
          else if (!t.want) t.want = USA_PHONE_CC;
          t.options = prioritizeUsaPhoneCcTexts(t.options || []);
          t.portalOptions = prioritizeUsaPhoneCcPortals(t.portalOptions || []);
          t.llmLabel = phoneCountryCodeLlmHint(t.want);
          t.portalHtml = buildPortalOptionsHtml(t.cid, t.llmLabel, t.portalOptions, "");
          decisions.harvest += 1;
          harvestSummary.push({
            key: t.key,
            labelHead: String(t.label).slice(0, 50),
            options: (t.options || []).length,
            kind: t.kind,
            keepOpen: true,
          });
          // Do NOT closeAllListboxes — phone list must stay open for APPLY.
          return;
        }

        // ── Flat Canvas listbox (State / gender / race / Yes-No / Source listbox) ──
        // Ideal pattern (required): harvest live options → send list to LLM →
        // LLM returns exact option text → APPLY opens once and picks that option.
        // Do NOT skip harvest (deferred empty options caused Male≠Man on DraftKings).
        const listTrigger = listboxTrigger(t.container);
        if (listTrigger && !t.multi) {
          try {
            if (WD.reportPhase) {
              WD.reportPhase(`Reading options for “${String(t.label || t.key || "field").slice(0, 42)}”…`);
            }
          } catch {}
          let harvested = { options: [], portalHtml: "", listboxId: null };
          try {
            harvested = await harvestPortalOptions(listTrigger);
          } catch (e) {
            if (e && e.name === "WDAborted") throw e;
          }
          if (!(harvested.options && harvested.options.length)) {
            try {
              WD.warn("flat listbox harvest: 0 options — retrying", t.label || t.key);
            } catch {}
            await D.delay(80);
            try {
              harvested = await harvestPortalOptions(listTrigger);
            } catch (e) {
              if (e && e.name === "WDAborted") throw e;
            }
          }
          t.kind = "select";
          t.portalOptions = harvested.options || [];
          t.options = (t.portalOptions || [])
            .map((o) => (o && o.text) || "")
            .filter((x) => x && !isPlaceholderOption(x));
          t.listboxId = harvested.listboxId || null;
          t.hierarchical = false;
          if (t.isSource) {
            t.llmLabel = `${t.label} — ${sourceFlatHint(t.want)} Return the exact option text from the list.`;
          } else {
            t.llmLabel = t.label;
          }
          t.portalHtml = buildPortalOptionsHtml(t.cid, t.llmLabel, t.portalOptions, "");
          if (!optionsPlausibleForLabel(t.label, t.options) && t.options.length) {
            try {
              WD.warn("implausible options for", t.label, "- keeping harvest", t.options.slice(0, 8));
            } catch {}
          }
          decisions.harvest += 1;
          harvestSummary.push({
            key: t.key,
            labelHead: String(t.label).slice(0, 50),
            options: (t.options || []).length,
            kind: "select",
            widget: "listbox",
          });
          try {
            if (WD.aa) {
              WD.aa("fillStep HARVEST listbox", {
                key: t.key,
                labelHead: String(t.label).slice(0, 50),
                options: (t.options || []).length,
                sample: (t.options || []).slice(0, 8),
              });
            }
          } catch {}
          return;
        }

        // Checkbox / radio / multi — classifyControl harvests those widgets.
        let info = null;
        try {
          info = await classifyControl(t.container);
        } catch (e) {
          if (e && e.name === "WDAborted") throw e;
        }
        if (!info) {
          t.kind = "select";
          t.options = [];
          t.portalOptions = [];
        } else {
          t.kind = info.kind || "select";
          t.options = info.options || [];
          t.portalOptions = info.portalOptions || [];
          t.portalHtml = info.portalHtml || "";
        }
        t.llmLabel = t.label;
        if (isCountryPhoneCodeField(t.key, t.label)) {
          const usa = exactUsaPhoneCcOption(t.options || []);
          if (usa) t.want = usa;
          else if (!t.want) t.want = USA_PHONE_CC;
          t.options = prioritizeUsaPhoneCcTexts(t.options || []);
          t.portalOptions = prioritizeUsaPhoneCcPortals(t.portalOptions || []);
          t.llmLabel = phoneCountryCodeLlmHint(t.want);
          t.portalHtml = buildPortalOptionsHtml(t.cid, t.llmLabel, t.portalOptions, "");
        }
        decisions.harvest += 1;
        harvestSummary.push({
          key: t.key,
          labelHead: String(t.label).slice(0, 50),
          options: (t.options || []).length,
          kind: t.kind,
        });
        return;
      }
      // Text / textarea / tel / email — NEVER open a dropdown. classifyControl can
      // hit listboxTrigger on mis-scoped containers; keep this path DOM-only.
      const ta = t.container.querySelector("textarea");
      const text = t.container.querySelector(
        'input[type="text"], input[type="tel"], input[type="number"], input[type="email"], input[type="url"], input:not([type])',
      );
      if (ta) {
        t.kind = "textarea";
      } else if (text) {
        const typ = (text.getAttribute("type") || "text").toLowerCase();
        t.kind = ["tel", "number", "email", "url"].includes(typ) ? typ : "text";
      } else {
        t.kind = "text";
      }
      t.options = [];
      t.portalOptions = [];
      t.llmLabel = isPhoneNumberField(t.key, t.label)
        ? phoneNumberLlmHint(t.want)
        : t.label;
    };

    const phoneCcTargets = [];
    const otherTargets = [];
    for (const t of targets) {
      if (t.isOption && !t.isSource && isCountryPhoneCodeField(t.key, t.label) && t.multi) {
        phoneCcTargets.push(t);
      } else {
        otherTargets.push(t);
      }
    }
    for (const t of otherTargets) await harvestOneTarget(t, false);
    for (const t of phoneCcTargets) await harvestOneTarget(t, true);

    try {
      if (WD.aa) {
        WD.aa("fillStep HARVEST", {
          count: harvestSummary.length,
          fields: harvestSummary,
          keepOpenPhone: !!(keepOpenPhoneTarget && isMultiListOpen(keepOpenPhoneTarget.multi)),
        });
      }
    } catch {}

    // ── Phase 3: one LLM batch for all non-local targets ──
    // Phone CC list stays open (keepOpen) during this wait when harvest succeeded.
    const batchItems = [];
    for (const t of targets) {
      if (t.localOnly) continue;
      const portals = t.portalOptions || [];
      const opts = t.options || portals.map((o) => o.text);
      const portalHtml =
        t.portalHtml ||
        (portals.length ? buildPortalOptionsHtml(t.cid, t.llmLabel || t.label, portals, "") : "");
      batchItems.push({
        cid: t.cid,
        key: t.key,
        label: t.llmLabel || t.label,
        kind: t.kind || "text",
        required: t.required,
        options: opts,
        portalOptions: portals,
        portalHtml,
        want: t.want || undefined,
        isSource: !!t.isSource,
        isSkills: !!t.isSkills,
        multi: !!t.isSkills,
        sourceHierarchical: !!t.hierarchical,
      });
    }
    try {
      if (WD.aa) {
        WD.aa("fillStep → LLM batch", {
          count: batchItems.length,
          labels: batchItems.map((it) => String(it.label || "").slice(0, 70)),
          keepOpenPhone: !!(keepOpenPhoneTarget && isMultiListOpen(keepOpenPhoneTarget.multi)),
        });
      }
    } catch {}
    try {
      if (WD.reportPhase) WD.reportPhase("Asking AI for answers…");
    } catch {}
    // Side-panel messaging can steal focus and dismiss the keep-open phone list.
    // Soft-refocus the search input while we wait on WD_RESOLVE.
    let phoneKeepAlive = null;
    if (keepOpenPhoneTarget && keepOpenPhoneTarget.multi) {
      const holdMulti = keepOpenPhoneTarget.multi;
      phoneKeepAlive = setInterval(() => {
        try {
          if (!isMultiListOpen(holdMulti)) return;
          const inp = holdMulti.querySelector("input");
          if (inp && document.activeElement !== inp) inp.focus({ preventScroll: true });
        } catch {}
      }, 700);
    }
    let batchValues = {};
    try {
      batchValues = await resolveItemsWithLLM(batchItems, profile);
    } finally {
      if (phoneKeepAlive) {
        try {
          clearInterval(phoneKeepAlive);
        } catch {}
      }
    }
    try {
      if (WD.aa) {
        WD.aa("fillStep LLM batch DONE", {
          answered: Object.keys(batchValues).length,
          total: batchItems.length,
          keepOpenPhone: !!(keepOpenPhoneTarget && isMultiListOpen(keepOpenPhoneTarget.multi)),
        });
      }
    } catch {}

    // ── Phase 3a: APPLY keep-open phone CC BEFORE source L2 / other fields ──
    // Source L1 reopen would Escape the phone list; click while still mounted.
    const applyPhoneCcTarget = async (t) => {
      throwIfAborted();
      const labelHead = String(t.label || t.key || "").slice(0, 80);
      let value =
        snapExactPhoneCcAnswer(batchValues[t.cid], t.options || [], t.portalOptions || []) ||
        valueText(batchValues[t.cid]) ||
        null;
      if (value == null || value === "") {
        if (t.required) {
          rep.unmatched.push({ key: t.key, label: t.label });
          rememberFailedField(t.key, t.label);
        }
        try {
          if (WD.aa) WD.aa("fillStep APPLY", { key: t.key, labelHead, ok: false, reason: "no-value", phase: "keep-open" });
        } catch {}
        t.phoneCcApplied = false;
        return;
      }
      const stillOpen = !!(t.multi && isMultiListOpen(t.multi));
      let ok = false;
      try {
        if (WD.aa) {
          WD.aa("fillStep APPLY phone-cc-first", {
            key: t.key,
            stillOpen,
            valueHead: String(value).slice(0, 60),
          });
        }
        ok = await fillMultiselect(t.multi, valueText(value) || value, { alreadyOpen: stillOpen });
      } catch (e) {
        if (e && e.name === "WDAborted") throw e;
      }
      t.phoneCcApplied = !!ok;
      t.phoneCcValue = value;
      if (ok) {
        const cacheKey = (t.label || "").toLowerCase().trim().slice(0, 120);
        if (cacheKey) {
          WD._resolveCache = WD._resolveCache || {};
          WD._resolveCache[cacheKey] = value;
        }
      } else {
        rememberFailedField(t.key, t.label);
      }
      record(rep, t.label || t.key, ok);
      decisions.write += 1;
      try {
        if (WD.aa) {
          WD.aa("fillStep APPLY", {
            key: t.key,
            labelHead,
            ok,
            valueHead: valueText(value).slice(0, 60),
            phase: stillOpen ? "keep-open" : "reopen-fallback",
          });
        }
      } catch {}
    };
    for (const t of phoneCcTargets) {
      if (t.keepOpenMulti || (t.multi && isMultiListOpen(t.multi))) {
        await applyPhoneCcTarget(t);
      }
    }
    // If keep-open was lost during LLM, still apply phone CC before source.
    for (const t of phoneCcTargets) {
      if (t.phoneCcApplied == null) await applyPhoneCcTarget(t);
    }

    // ── Phase 3b: source L2 (hierarchical only) — keep-open harvest → small LLM ──
    const baselineKeys = visibleFormFieldKeys();
    for (const t of targets) {
      throwIfAborted();
      if (!t.isSource || !t.multi || !t.hierarchical) continue;
      try {
        if (WD.reportPhase) WD.reportPhase("Selecting How Did You Hear source…");
      } catch {}
      const raw = batchValues[t.cid];
      // LLM category first (exact snap). Local folder guess only if LLM empty.
      let category =
        snapToHarvestedOption(valueText(raw), t.options || []) ||
        pickSourceCategoryLocal(t.want, t.options || []);
      if (!category) {
        try {
          WD.warn("source batch: no L1 category from LLM", t.want, t.options);
        } catch {}
        continue;
      }
      t.sourceCategory = category;
      if (!(await applySourceL1KeepOpen(t.multi, category))) continue;
      const l2 = await harvestSourceL2(t.multi);
      if (!l2.texts.length) {
        await closePrompt(t.multi, t.multi.querySelector("input"));
        continue;
      }
      t.l2Options = l2.texts;
      t.l2Portals = l2.portals;
      const leafCid = t.cid + "_l2";
      const leafItems = [
        {
          cid: leafCid,
          label: `${t.label} (specific source) — ${sourceL2LeafHint(t.want)}`,
          kind: "select",
          required: true,
          options: l2.texts,
          portalOptions: l2.portals,
          portalHtml: buildPortalOptionsHtml(leafCid, t.label, l2.portals, ""),
          want: t.want || undefined,
        },
      ];
      const leafVals = await resolveItemsWithLLM(leafItems, profile);
      // LLM leaf first; local peers only if model returned nothing usable.
      let leaf = chooseSourceLeaf(t.want, l2.texts, leafVals[leafCid]);
      if (!leaf) {
        try {
          WD.warn("source batch: no L2 leaf from LLM/peers", t.want, l2.texts.slice(0, 12));
        } catch {}
        await closePrompt(t.multi, t.multi.querySelector("input"));
        continue;
      }
      t.sourceLeaf = leaf;
      t.sourceApplied = await applySourceLeaf(t.multi, leaf, baselineKeys);
      try {
        if (WD.aa) {
          WD.aa("fillStep SOURCE L2", {
            category,
            leaf,
            ok: !!t.sourceApplied,
            want: t.want || null,
          });
        }
      } catch {}
    }

    // ── Phase 4: APPLY remaining answers (fast DOM writes; no LLM) ──
    try {
      if (WD.reportPhase) WD.reportPhase("Writing answers into the form…");
    } catch {}
    try {
      if (WD.aa) {
        WD.aa("fillStep APPLY START", {
          count: targets.length,
          labels: targets.map((t) => String(t.label || t.key || "").slice(0, 50)),
        });
      }
    } catch {}
    // Track every plain-listbox pick so we can verify + re-commit them AFTER the
    // whole pass (see the durability sweep below Phase 4).
    const listboxApplied = [];
    for (const t of targets) {
      throwIfAborted();
      const labelHead = String(t.label || t.key || "").slice(0, 80);
      // Already applied in phase 3a.
      if (t.phoneCcApplied != null) continue;
      if (t.isSource) {
        let ok = !!t.sourceApplied;
        const trigger = listboxTrigger(t.container);
        // Zillow (and some tenants): How Did You Hear is a single listbox, NOT
        // multiSelectContainer. Inventory logged kind:"listbox" — the old
        // `if (!ok && t.multi)` gate skipped APPLY entirely (ok:false with no pick log).
        if (!ok && t.multi) {
          // Flat multi source: LLM pick first, then local peer boards from the harvested
          // list (same chooseSourceLeaf used for hierarchical L2). Hierarchical
          // without L2 leaf: fillSourcePrompt recovery within THIS pass only.
          if (!t.hierarchical) {
            const pick = chooseSourceLeaf(t.want, t.options || [], batchValues[t.cid]);
            if (pick) {
              await openMultiPrompt(t.multi);
              await harvestSourceLiveRows(t.multi);
              ok = await applySourceLeaf(t.multi, pick, baselineKeys);
              try {
                WD.log(
                  `source flat APPLY (multi) pick=${JSON.stringify(pick)} llm=${JSON.stringify(valueText(batchValues[t.cid]) || null)} ok=${!!ok}`
                );
              } catch {}
            } else {
              try {
                WD.warn(
                  "source flat APPLY (multi) no pick from LLM/peers",
                  valueText(batchValues[t.cid]),
                  (t.options || []).slice(0, 12)
                );
              } catch {}
            }
          } else if (!t.sourceLeaf) {
            ok = await fillSourcePrompt(t.multi, t.want || "Indeed", t.container);
          }
        } else if (!ok && trigger) {
          // Flat listbox source: options were harvested pre-LLM; APPLY opens once
          // and picks the exact LLM/portal choice (no second harvest).
          const llmText = valueText(batchValues[t.cid]);
          let pick = chooseSourceLeaf(t.want, t.options || [], batchValues[t.cid]);
          if (!pick) pick = llmText || t.want || sourcePreferredChannel(t.want) || "LinkedIn";
          if (pick) {
            const choice =
              resolvePortalChoice(pick, t.portalOptions || []) ||
              resolvePortalChoice(llmText, t.portalOptions || []) ||
              pick;
            ok = await applyListboxPortal(trigger, choice, t.portalOptions || []);
            try {
              WD.log(
                `source flat APPLY (listbox) pick=${JSON.stringify(pick)} llm=${JSON.stringify(llmText || null)} options=${(t.options || []).length} ok=${!!ok}`
              );
            } catch {}
            try {
              if (WD.aa) {
                WD.aa("fillStep APPLY source-listbox", {
                  key: t.key,
                  pick: String(pick).slice(0, 60),
                  llm: (llmText || "").slice(0, 60) || null,
                  options: (t.options || []).length,
                  portals: (t.portalOptions || []).length,
                  ok,
                });
              }
            } catch {}
          } else {
            try {
              WD.warn(
                "source flat APPLY (listbox) no pick from LLM/peers",
                llmText,
                (t.options || []).slice(0, 12)
              );
            } catch {}
            try {
              if (WD.aa) {
                WD.aa("fillStep APPLY source-listbox", {
                  key: t.key,
                  pick: null,
                  llm: (llmText || "").slice(0, 60) || null,
                  options: (t.options || []).length,
                  ok: false,
                  reason: "no-pick",
                });
              }
            } catch {}
          }
        } else if (!ok) {
          try {
            if (WD.aa) {
              WD.aa("fillStep APPLY source-skip", {
                key: t.key,
                reason: "no-multi-no-listbox",
                hasMulti: !!t.multi,
                hasTrigger: !!trigger,
              });
            }
          } catch {}
        }
        record(rep, t.label || t.key, ok);
        if (!ok) rememberFailedField(t.key, t.label);
        decisions.write += 1;
        try {
          if (WD.aa) WD.aa("fillStep APPLY", { key: t.key, labelHead, kind: "source", ok });
        } catch {}
        continue;
      }

      let value = t.localOnly ? t.want : batchValues[t.cid];
      if (value == null || value === "") {
        if (t.want) value = t.want;
      }
      // Skills typeahead: LLM returns multiple tokens (array or comma string).
      if (t.isSkills || isSkillsField(t.key, t.label)) {
        const tokens = parseSkillTokens(value != null && value !== "" ? value : t.want);
        let ok = false;
        const multiEl = t.multi || t.container.querySelector('[data-automation-id="multiSelectContainer"]');
        try {
          ok = multiEl ? await fillSkillsPrompt(multiEl, tokens) : false;
        } catch (e) {
          if (e && e.name === "WDAborted") throw e;
        }
        record(rep, t.label || t.key, ok);
        if (!ok) rememberFailedField(t.key, t.label);
        decisions.write += 1;
        try {
          if (WD.aa) {
            WD.aa("fillStep APPLY", {
              key: t.key,
              labelHead,
              kind: "skills",
              ok,
              tokens: tokens.slice(0, 12),
            });
          }
        } catch {}
        continue;
      }
      // Phone Number: thin digit cleanup of LLM answer (not a different value).
      if (isPhoneNumberField(t.key, t.label)) {
        const fromVal = nationalPhoneDigits(valueText(value) || value);
        const fromWant = nationalPhoneDigits(t.want);
        value = fromVal || fromWant;
      }
      // Country Phone Code: exact LLM option text only (no USA force).
      if (isCountryPhoneCodeField(t.key, t.label)) {
        value =
          snapExactPhoneCcAnswer(value, t.options || [], t.portalOptions || []) ||
          valueText(value) ||
          null;
      }
      if (value == null || value === "") {
        if (t.required || (t.label && /\?/.test(t.label))) {
          rep.unmatched.push({ key: t.key, label: t.label });
          rememberFailedField(t.key, t.label);
        }
        try {
          if (WD.aa) WD.aa("fillStep APPLY", { key: t.key, labelHead, ok: false, reason: "no-value" });
        } catch {}
        continue;
      }

      let ok = false;
      const trigger = listboxTrigger(t.container);
      const multi = t.container.querySelector('[data-automation-id="multiSelectContainer"]');
      try {
        if (trigger && !multi) {
          const choice =
            resolvePortalChoice(value, t.portalOptions || []) ||
            value;
          ok = await applyListboxPortal(trigger, choice, t.portalOptions || []);
          listboxApplied.push({
            trigger,
            container: t.container,
            choice,
            value,
            label: t.label,
            key: t.key,
            portalOptions: t.portalOptions || [],
          });
        } else if (multi && isCountryPhoneCodeField(t.key, t.label)) {
          ok = await fillMultiselect(multi, valueText(value) || value, {
            alreadyOpen: isMultiListOpen(multi),
          });
        } else {
          ok = await writeField(t.container, valueText(value) || value, t.label || t.key);
        }
      } catch (e) {
        if (e && e.name === "WDAborted") throw e;
      }
      if (ok) {
        const cacheKey = (t.label || "").toLowerCase().trim().slice(0, 120);
        if (cacheKey) {
          WD._resolveCache = WD._resolveCache || {};
          WD._resolveCache[cacheKey] = value;
        }
      } else {
        rememberFailedField(t.key, t.label);
      }
      record(rep, t.label || t.key, ok);
      decisions.write += 1;
      try {
        if (WD.aa) {
          WD.aa("fillStep APPLY", {
            key: t.key,
            labelHead,
            ok,
            valueHead: valueText(value).slice(0, 60),
          });
        }
      } catch {}
      await D.delay(40);
    }

    // ── Durability sweep: verify + re-commit reverted listboxes (single pass) ──
    // PROVEN GDIT 2026-08-07: filling ~20 questionnaire listboxes back-to-back,
    // six that reported APPLY ok:true reverted to "Select One" by the rescan
    // (#204 "If you accept…" ok:true → #227 shown:"Select One"). The per-field
    // committed() latch cannot catch this because a sibling's later portal open
    // resets an already-committed field AFTER its own APPLY returned. Now that the
    // whole pass is done (all portals closed, every trigger settled), re-read each
    // listbox trigger and re-pick any that did not durably stick — so all
    // listboxes are filled in THIS first pass instead of depending on the rescan.
    for (const rc of listboxApplied) {
      throwIfAborted();
      if (!rc.trigger || !rc.trigger.isConnected) continue;
      const wantN = D.norm(
        (rc.choice && (rc.choice.text || rc.choice.value)) || valueText(rc.value) || rc.value,
      );
      if (!wantN) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ff = rc.container && rc.container.querySelector('[aria-invalid="true"]');
        const shownN = D.norm(selectDisplayValue(rc.trigger) || triggerCurrentValue(rc.trigger));
        const stuck =
          !triggerShowsPlaceholder(rc.trigger) && valueMatchesWant(shownN, wantN) && !ff;
        if (stuck) break;
        try {
          if (WD.aa) {
            WD.aa("fillStep APPLY re-commit", {
              key: String(rc.key || "").slice(0, 40),
              labelHead: String(rc.label || "").slice(0, 60),
              attempt: attempt + 1,
              shown: shownN.slice(0, 40),
              want: wantN.slice(0, 40),
            });
          }
        } catch {}
        let reok = false;
        try {
          reok = await applyListboxPortal(rc.trigger, rc.choice || rc.value, rc.portalOptions);
        } catch (e) {
          if (e && e.name === "WDAborted") throw e;
        }
        await D.delay(80);
        if (reok) {
          record(rep, rc.label || rc.key, true);
        }
      }
    }

    // One-pass design: no second option recheck / refill after APPLY.
    try {
      if (WD.aa) {
        WD.aa("fillStep END", {
          decisions,
          filled: (rep.filled || []).length,
          unmatched: (rep.unmatched || []).length,
          missed: (rep.missed || []).length,
        });
      }
    } catch {}
    await fillDisabilitySelfId(profile, rep);
  }

  // (recheckUncommittedOptionFields removed — one-pass harvest→LLM→apply only)

  // ── My Experience: repeating Work Experience + Education panels ──────────────
  // Panels do not exist until "Add" is clicked, so the generic formField pass
  // never sees them. We add exactly as many as the profile needs (idempotent -
  // re-running never duplicates), then fill each panel SCOPED to its own root so
  // entries never cross-contaminate. Every text/date field commits through the
  // deferOrCommit path, so a later "Save and Continue" never reports them empty.
  function sectionGroupByLabel(labelId) {
    return D.qa(`[role="group"][aria-labelledby="${labelId}"]`).find(D.isVisible) || null;
  }
  // Locate panels by their STABLE per-entry group label - "Work-Experience-1-panel",
  // "Education-2-panel", etc. ($="-panel" excludes the section group itself, which
  // ends in "-section"). PROVEN necessary: the inner data-fkit-id="...--null"
  // wrapper only marks a brand-new row; once Workday registers the row the suffix
  // changes to "--<id>", so a `$="--null"` count under-reports real panels (the
  // probe showed 2 panels counted as 1). The panel group label never changes.
  function panelRoots(labelPrefix) {
    return D.qa(`[role="group"][aria-labelledby^="${labelPrefix}-"][aria-labelledby$="-panel"]`).filter(D.isVisible);
  }
  // Re-resolve the section + its Add button live on every call (no stale node).
  function sectionAddButton(labelId) {
    const group = sectionGroupByLabel(labelId);
    if (!group) return null;
    const btns = D.qa('[data-automation-id="add-button"]', group).filter(D.isVisible);
    return btns.length ? btns[btns.length - 1] : null; // the "Add" / "Add Another" for THIS section
  }
  // PROVEN root cause of over-adding (console: "0/5 -> 1" then "1/5 -> 7" after a
  // single Add): the My Experience section is SLOW to load, so panelRoots() reads
  // 0–1 before the section's existing panels finish rendering. ensurePanels then
  // clicks Add for panels that already exist and the count overshoots `needed`.
  // Settle the count first: poll until panelRoots() has been UNCHANGED for 1.5s
  // (≈21s ceiling) so every already-present/slow-rendered panel is counted before
  // we decide how many to add. Returns the settled count.
  async function settledPanelCount(panelLabelPrefix) {
    let last = -1;
    let stableMs = 0;
    let count = panelRoots(panelLabelPrefix).length;
    for (let i = 0; i < 140; i++) {
      count = panelRoots(panelLabelPrefix).length;
      if (count === last) {
        stableMs += 150;
        if (stableMs >= 1500) break;
      } else {
        last = count;
        stableMs = 0;
      }
      await D.delay(150);
    }
    return count;
  }
  // Each repeating panel carries its own delete control: a plain <button> with the
  // visible text "Delete" INSIDE the panel group (proven via console - no stable
  // automation-id, so match by text). The attachment "delete-file" buttons live
  // OUTSIDE any panel group and are excluded by scoping to the panel root.
  function panelDeleteButton(root) {
    return D.qa("button", root).find((b) => /^\s*delete\s*$/i.test(b.textContent || "")) || null;
  }
  // Some tenants pop a confirmation dialog after clicking Delete - confirm it if
  // present, otherwise this is a harmless no-op.
  async function confirmDeleteIfPrompted() {
    const dialog = D.qa('[role="dialog"], [data-automation-id="confirmationModal"], [data-automation-id="modalPopup"]').find(D.isVisible);
    if (!dialog) return;
    const btn = D.qa("button", dialog).find((b) => /^(delete|ok|yes|confirm)$/i.test((b.textContent || "").trim()));
    if (btn) {
      D.clickEl(btn);
      await D.delay(300);
    }
  }
  // Remove panels beyond `needed`, bottom-up (the extras our profile never fills).
  // Re-queries live each pass and verifies the count actually shrank.
  async function deleteSurplusPanels(panelLabelPrefix, needed) {
    let panels = panelRoots(panelLabelPrefix);
    let guard = 0;
    while (panels.length > needed && guard++ < panels.length + 2) {
      const before = panels.length;
      const victim = panels[panels.length - 1];
      const del = panelDeleteButton(victim);
      if (!del) {
        try { WD.warn("surplus delete", panelLabelPrefix, ": no Delete button on last panel - stopping"); } catch {}
        break;
      }
      D.clickEl(del);
      await D.delay(250);
      await confirmDeleteIfPrompted();
      let shrank = false;
      for (let i = 0; i < 40; i++) {
        await D.delay(150);
        panels = panelRoots(panelLabelPrefix);
        if (panels.length < before) {
          shrank = true;
          break;
        }
      }
      try { WD.log(`surplus delete ${panelLabelPrefix}: ${before} -> ${panels.length} (${shrank ? "removed" : "NO CHANGE, stopping"})`); } catch {}
      if (!shrank) break;
      await D.delay(200);
    }
    return panelRoots(panelLabelPrefix);
  }
  async function ensurePanels(sectionLabelId, panelLabelPrefix, needed) {
    // Wait for existing/slow-rendered panels to settle BEFORE adding, so we never
    // add duplicates for panels that simply hadn't rendered yet.
    const settled = await settledPanelCount(panelLabelPrefix);
    let panels = panelRoots(panelLabelPrefix);
    try {
      WD.log(`ensurePanels ${panelLabelPrefix}: settled at ${settled}/${needed} before adding`);
    } catch {}
    // Self-correct an over-populated section (e.g. extras left by an earlier run):
    // delete from the bottom down to exactly `needed`.
    if (panels.length > needed) {
      panels = await deleteSurplusPanels(panelLabelPrefix, needed);
    }
    let guard = 0;
    while (panels.length < needed && guard++ < needed + 2) {
      const before = panels.length;
      const add = sectionAddButton(sectionLabelId); // resolved fresh each iteration
      if (!add) {
        try { WD.warn("ensurePanels", panelLabelPrefix, `: have ${before}/${needed}, NO add-button found - stopping`); } catch {}
        break;
      }
      D.clickEl(add);
      const t0 = Date.now();
      let grew = false;
      // Adding the FIRST item to an EMPTY section can trigger a SLOW network load
      // (Workday shows "Slow network detected"), so the panel may render several
      // seconds later. Wait generously (~20s); the poll returns the instant it
      // grows, so the fast "Add Another" clicks don't pay this cost.
      for (let i = 0; i < 140; i++) {
        await D.delay(150);
        panels = panelRoots(panelLabelPrefix);
        if (panels.length > before) {
          grew = true;
          break;
        }
      }
      try { WD.log(`ensurePanels ${panelLabelPrefix}: ${before}/${needed} -> ${panels.length} in ${Date.now() - t0}ms (${grew ? "added" : "NO GROWTH, stopping"})`); } catch {}
      if (!grew) break; // could not add another - stop safely rather than loop
      await D.delay(250); // let the new panel settle before the next add
    }
    return panelRoots(panelLabelPrefix).slice(0, needed);
  }
  function panelField(root, key) {
    return root.querySelector(`[data-automation-id="formField-${key}"]`);
  }
  async function fillPanelField(root, key, value, rep, label) {
    if (value == null || value === "") return;
    const c = panelField(root, key);
    if (!c) return;
    // Already committed — do not rewrite (recovery must not re-type work/edu text).
    if (fieldHasCommittedValue(c)) {
      record(rep, label, true);
      return;
    }
    record(rep, label, await writeField(c, value));
  }

  async function fillWorkPanel(root, entry, n, rep) {
    if (!entry) return;
    await fillPanelField(root, "jobTitle", entry.title, rep, `Work ${n} Job Title`);
    await fillPanelField(root, "companyName", entry.company, rep, `Work ${n} Company`);
    await fillPanelField(root, "location", entry.location, rep, `Work ${n} Location`);
    if (entry.current) await fillPanelField(root, "currentlyWorkHere", true, rep, `Work ${n} Current`);
    await fillPanelField(root, "startDate", entry.startMMYYYY, rep, `Work ${n} From`);
    // When "I currently work here" is checked Workday removes the End Date field.
    if (!entry.current) await fillPanelField(root, "endDate", entry.endMMYYYY, rep, `Work ${n} To`);
    await fillPanelField(root, "roleDescription", stripMarkdown(entry.description), rep, `Work ${n} Description`);
  }

  // PROVEN root cause (read-back PROBE): our write lands CLEAN, then Workday's
  // résumé parser asynchronously re-populates Role Description from the uploaded
  // PDF - which still carries **markdown** - clobbering our text AFTER we set it.
  // We can't out-race a single write, so we re-assert clean text in a short loop
  // until the parser stops overwriting (it parses once per upload). Re-resolves
  // panels/textarea live each pass (the SPA replaces nodes on re-render).
  async function reassertWorkDescriptions(work) {
    const cleans = (work || []).map((w) => (w ? stripMarkdown(w.description) : ""));
    if (!cleans.some(Boolean)) return;
    const isDirty = (ta, clean) => (ta.value || "") !== clean; // parser writes != our clean
    for (let attempt = 0; attempt < 8; attempt++) {
      await D.delay(900);
      const panels = panelRoots("Work-Experience").slice(0, cleans.length);
      let dirty = 0;
      for (let i = 0; i < panels.length; i++) {
        const clean = cleans[i];
        if (!clean) continue;
        const ff = panelField(panels[i], "roleDescription");
        const ta = ff && ff.querySelector("textarea");
        if (!ff || !ta) continue;
        if (isDirty(ta, clean)) {
          dirty++;
          await writeField(ff, clean); // writeField strips textareas anyway
        }
      }
      if (dirty === 0) {
        // Confirm the parser doesn't clobber late: one more quiet check.
        await D.delay(1300);
        const p2 = panelRoots("Work-Experience").slice(0, cleans.length);
        let late = false;
        for (let i = 0; i < p2.length; i++) {
          const clean = cleans[i];
          if (!clean) continue;
          const ff = panelField(p2[i], "roleDescription");
          const ta = ff && ff.querySelector("textarea");
          if (ff && ta && isDirty(ta, clean)) { late = true; break; }
        }
        if (!late) {
          try { WD.log(`role descriptions clean & stable after ${attempt + 1} pass(es)`); } catch {}
          return;
        }
      }
    }
    try { WD.warn("role descriptions: re-assert loop exhausted (parser still fighting)"); } catch {}
  }

  function fieldOfStudyCandidates(entry) {
    const out = [];
    const push = (s) => {
      const t = String(s || "").trim();
      if (!t) return;
      if (out.some((x) => D.norm(x) === D.norm(t))) return;
      out.push(t);
    };
    push(entry && entry.fieldOfStudy);
    const alts = (entry && entry.fieldOfStudyFallbacks) || [];
    for (const a of alts) push(a);
    const primary = String((entry && entry.fieldOfStudy) || "");
    if (/computer|software|electrical|ece|cse/i.test(primary)) {
      push("Computer Science");
      push("Computer Engineering");
      push("Software Engineering");
      push("Information Technology");
    }
    return out;
  }

  async function fillSearchPromptAny(multi, candidates) {
    for (const value of candidates) {
      if (await fillSearchPrompt(multi, value)) return true;
    }
    return false;
  }

  async function fillEducationNonDegree(root, entry, n, rep) {
    if (!entry) return;
    // Live DOM evidence (Siemens Healthineers applyFlowMyExpPage): the School
    // wrapper is data-automation-id="formField-school" (NOT "formField-schoolName").
    // Looking up schoolName returned null, so the engine never typed a university
    // name at all — while Degree / Field of Study / GPA (correct keys) filled fine.
    // Some older tenants use schoolName; try both.
    if (entry.school) {
      const schoolFF = panelField(root, "school") || panelField(root, "schoolName");
      if (schoolFF) {
        const schoolMulti = schoolFF.querySelector('[data-automation-id="multiSelectContainer"]');
        if (schoolMulti && promptChosen(schoolMulti, "")) {
          record(rep, `Edu ${n} School`, true); // already committed — do not re-open
        } else {
          record(
            rep,
            `Edu ${n} School`,
            schoolMulti
              ? await fillSearchPrompt(schoolMulti, entry.school)
              : await writeField(schoolFF, entry.school),
          );
        }
      } else {
        try {
          WD.warn(`Edu ${n} School: formField-school/schoolName not found in panel`);
        } catch {}
      }
    }
    // Field of Study: same search-prompt widget. Skip when any chip is already
    // committed so recovery never re-types a correct value.
    const fosCandidates = fieldOfStudyCandidates(entry);
    if (fosCandidates.length) {
      const fos = panelField(root, "fieldOfStudy");
      const fosMulti = fos && fos.querySelector('[data-automation-id="multiSelectContainer"]');
      if (fosMulti) {
        if (promptChosen(fosMulti, "")) {
          record(rep, `Edu ${n} Field of Study`, true);
        } else {
          record(rep, `Edu ${n} Field of Study`, await fillSearchPromptAny(fosMulti, fosCandidates));
        }
      }
    }
    await fillPanelField(root, "gradeAverage", entry.gpa, rep, `Edu ${n} GPA`);
    await fillPanelField(root, "firstYearAttended", entry.startMMYYYY, rep, `Edu ${n} From`);
    await fillPanelField(root, "lastYearAttended", entry.endMMYYYY, rep, `Edu ${n} To`);
  }

  // Degree is a fixed Workday dropdown. We open it to harvest the exact option
  // strings, then (asynchronously) ask the LLM - via the side panel + backend -
  // to map the candidate's profile degree to the best option, while the rest of
  // the page fills. A local fuzzy pick is the fallback if the LLM is unavailable.
  function degreeButton(root) {
    const c = panelField(root, "degree");
    return c ? c.querySelector('button[aria-haspopup="listbox"]') : null;
  }

  // Workday Canvas Select listboxes render their placeholder as a real option row
  // ("Select One"). Every other option consumer in this file strips it; the Degree
  // path (harvestOptions -> exactOption/bestLocalMatch -> openAndPick) did not, so
  // a degree with no token overlap fell through to options[0] === "Select One",
  // "picked" it, and openAndPickInner then read back "Select One" === want and
  // reported SUCCESS - leaving the field on its placeholder with the required
  // error and giving recovery nothing to retry.
  function isPlaceholderOption(text) {
    const t = D.norm(text);
    if (!t) return true;
    if (/^(no items|no results)\.?$/.test(t)) return true;
    if (/^no response\.?$/.test(t)) return true;
    return /^(select|choose)(\s+one)?\s*\.{0,3}$/.test(t);
  }

  // Résumé degree text almost never equals Workday's option text ("Master of
  // Science in Computer Engineering" vs "Master's Degree"), and raw whole-token
  // overlap scores ZERO across apostrophes and abbreviations ("master" !=
  // "master's", "MSc" shares nothing). Match on academic LEVEL first.
  const DEGREE_LEVELS = [
    { key: "doctorate", re: /(\bph\.?\s?d\b|\bdoctor(ate|al)?\b|\bd\.?sc\b|\bed\.?d\b|\bdba\b)/ },
    { key: "master", re: /(\bmaster'?s?\b|\bm\.?sc?\b|\bm\.?eng\b|\bm\.?b\.?a\b|\bm\.?a\b|\bm\.?tech\b|\bpost\s?graduate\b)/ },
    { key: "bachelor", re: /(\bbachelor'?s?\b|\bb\.?sc?\b|\bb\.?eng\b|\bb\.?a\b|\bb\.?tech\b|\bunder\s?graduate\b|\bhonou?rs\b)/ },
    { key: "associate", re: /(\bassociate'?s?\b|\ba\.?a\b|\ba\.?s\b|\bfoundation\b)/ },
    { key: "diploma", re: /(\bdiploma\b|\bcertificate\b)/ },
    { key: "highschool", re: /(\bhigh school\b|\bsecondary\b|\bged\b|\bmatric)/ },
  ];
  function degreeLevel(text) {
    const t = D.norm(text);
    for (const l of DEGREE_LEVELS) if (l.re.test(t)) return l.key;
    return null;
  }
  // Resolve a profile degree to real option text, or null when nothing is safe.
  // NEVER returns a placeholder.
  function matchDegreeOption(want, options) {
    const real = (options || []).filter((o) => !isPlaceholderOption(o));
    if (!real.length) return null;
    const w = D.norm(want);
    if (!w) return null;
    const exact = real.find((o) => D.norm(o) === w);
    if (exact) return exact;
    const wantLevel = degreeLevel(w);
    if (wantLevel) {
      const sameLevel = real.filter((o) => degreeLevel(o) === wantLevel);
      // Shortest same-level option is the generic one ("Master's Degree" over
      // "Master's Degree - Executive"), which is what these lists expect.
      if (sameLevel.length) return sameLevel.sort((a, b) => a.length - b.length)[0];
    }
    const contains = real
      .filter((o) => D.norm(o).includes(w) || w.includes(D.norm(o)))
      .sort((a, b) => a.length - b.length);
    if (contains.length) return contains[0];
    return null;
  }

  // Proven CrowdStrike flow: pointer-open → read portal option id/value/text +
  // portal HTML → close. Returns { options:[{id,value,text}], portalHtml, listboxId }.
  //
  // Soft close only (Escape, no body-click). Do NOT force window.scrollTo — if the
  // page jumps, that means this open/close harvest path is the wrong behavior to
  // remove, not something to mask.
  async function harvestPortalOptions(btn) {
    // Skip closeAll when nothing is open (saves Escape passes between sequential harvests).
    if (anyFormListboxOpen(btn)) {
      await closeAllListboxes(null, { soft: true });
      await D.delay(20);
    }
    const popup = await openListboxForOptions(btn, { fast: true });
    if (!popup) {
      try {
        WD.warn("harvestPortalOptions: portal did not open", btn && (btn.id || btn.getAttribute("aria-label")));
      } catch {}
      return { options: [], portalHtml: "", listboxId: null };
    }
    // openListboxForOptions already settled options — read once (no second settle).
    let options = readPortalOptionRows(popup);
    if (!options.length) {
      options = await waitForPortalOptionRows(popup, { timeout: 600, settleMs: 40, poll: 40, minCount: 1 });
    }
    const listbox =
      (popup.getAttribute && popup.getAttribute("role") === "listbox" && popup) ||
      popup.querySelector('[role="listbox"]') ||
      popup;
    const listboxId = (listbox && listbox.id) || btn.getAttribute("aria-controls") || null;
    const portalRoot =
      (listbox &&
        (listbox.closest("[data-behavior-click-outside-close]") ||
          listbox.closest("[data-popper-placement]"))) ||
      popup;
    const portalHtml = portalRoot ? String(portalRoot.outerHTML || "").slice(0, 4000) : "";
    await closeListbox(btn, { soft: true });
    try {
      WD.log(
        "harvestPortalOptions",
        btn && (btn.id || "").slice(0, 40),
        "listboxId=",
        listboxId,
        "->",
        options.map((o) => ({ text: o.text, value: o.value, id: o.id })),
      );
    } catch {}
    return { options, portalHtml, listboxId };
  }

  async function harvestOptions(btn) {
    const harvested = await harvestPortalOptions(btn);
    const uniq = [];
    const seen = new Set();
    for (const o of harvested.options || []) {
      const t = o && o.text;
      if (!t || isPlaceholderOption(t)) continue;
      const k = t.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        uniq.push(t);
      }
    }
    return uniq;
  }
  // The option whose text is exactly the candidate's value (case/space-insensitive),
  // or null. An exact match is authoritative - it must NOT be overridden by the LLM.
  function exactOption(want, options) {
    const w = D.norm(want);
    if (!w || !options || isPlaceholderOption(w)) return null;
    return options.find((o) => !isPlaceholderOption(o) && D.norm(o) === w) || null;
  }
  // Deterministic fallback: prefer exact text, else the option sharing the most
  // word tokens with the candidate's field, else the first candidate.
  function bestLocalMatch(want, options) {
    const real = (options || []).filter((o) => !isPlaceholderOption(o));
    if (!real.length) return want;
    const w = D.norm(want);
    const exact = real.find((o) => D.norm(o) === w);
    if (exact) return exact;
    const wt = new Set(w.split(/\s+/).filter(Boolean));
    let best = null;
    let bestScore = 0;
    for (const o of real) {
      const ot = D.norm(o).split(/\s+/).filter(Boolean);
      let s = 0;
      for (const t of ot) if (wt.has(t)) s++;
      if (s > bestScore) {
        bestScore = s;
        best = o;
      }
    }
    // real[0] as the last resort, never the "Select One" placeholder.
    return best || real[0];
  }
  function matchOptionFromList(want, options) {
    if (want == null || want === "" || !options || !options.length) return null;
    const w = D.norm(want);
    const scored = options
      .map((o) => ({ o, t: D.norm(o) }))
      .filter((x) => x.t && !/^select(\s+one)?\.?\.?\.?$/.test(x.t));
    const exact = scored.find((x) => x.t === w);
    if (exact) return exact.o;
    const contains = scored
      .filter((x) => x.t.includes(w) || w.includes(x.t))
      .sort((a, b) => a.t.length - b.t.length);
    if (contains.length) return contains[0].o;
    return null;
  }

  // Deterministic LAST RESORT when the LLM round-trip returns nothing
  // (API error, timeout, truncated JSON, or needs_user). Never used before the
  // LLM when a harvested option list exists — the model must pick live option text.
  function localScreeningPick(label, profile, options) {
    if (!options || !options.length) return null;
    const pick = (w) => snapToHarvestedOption(w, options);
    const e = (profile && profile.eeo) || {};
    const low = (label || "").toLowerCase();
    // Profile facts only — map onto harvested options, do not invent free text.
    if (/hispanic or latino/.test(low) && e.hispanicLatino != null) return pick(e.hispanicLatino ? "Yes" : "No");
    if (/\bgender\b|\bsex\b/.test(low) && e.gender) return pick(e.gender);
    if (/sexual orientation|lgbtq/.test(low)) return pick(e.sexualOrientation || "I don't wish to answer");
    if (/what is your race|race\/ethnicity|ethnicity|\brace\b/.test(low) && e.ethnicity) return pick(e.ethnicity);
    if (/sponsorship|immigration filing|visa sponsorship|open work permit|permanent residency|do you now or in the future require|will you now or in the future require|might you in the future require/.test(low) && e.sponsorship != null) {
      return pick(e.sponsorship ? "Yes" : "No");
    }
    if (/highest degree|degree attained/.test(low) && profile && Array.isArray(profile.education)) {
      for (const ed of profile.education) {
        if (ed && ed.degree) {
          const m = pick(ed.degree) || matchDegreeOption(ed.degree, options);
          if (m) return m;
        }
      }
    }
    if (isDisabilitySelfIdLabel(low)) {
      return (
        pick(e.disability ? "Yes, I have a disability" : "No, I do not have a disability and have not had one in the past") ||
        pick(e.disability ? "Yes" : "No")
      );
    }
    // resolveByLabel may return a short hint; only accept if it snaps to a real option.
    const fromRules = resolveByLabel(label, profile || {});
    if (fromRules) {
      const m = pick(fromRules);
      if (m) return m;
    }
    return null;
  }

  // Round-trip to the side panel (→ backend LLM). Sends portal option DOM
  // (data-af-options-for + id/data-value) so the model returns an exact option
  // id, data-value, or text — matching the proven console harvest flow.
  function requestOptionMatches(items) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v || {});
        }
      };
      try {
        const WDw = (window.__WD = window.__WD || {});
        WDw._waiters = WDw._waiters || {};
        const requestId = "opt-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
        WDw._waiters[requestId] = (values) => {
          delete WDw._waiters[requestId];
          finish(values);
        };
        chrome.runtime.sendMessage({
          type: "WD_RESOLVE",
          requestId,
          kind: "options",
          items: items.map((it) => ({
            cid: it.cid,
            key: it.key,
            label: it.label,
            want: it.want,
            kind: it.kind,
            required: it.required,
            isSource: !!it.isSource,
            isSkills: !!it.isSkills || isSkillsField(it.key, it.label),
            multi: !!it.multi || !!it.isSkills || isSkillsField(it.key, it.label),
            sourceHierarchical: !!it.sourceHierarchical,
            options: it.options,
            portalOptions: it.portalOptions,
            portalHtml: it.portalHtml,
          })),
        });
        setTimeout(() => {
          delete WDw._waiters[requestId];
          finish({});
        }, 90000);
      } catch {
        finish({});
      }
    });
  }

  // Open a multiselect prompt, wait for a stable list, scroll-harvest virtualized
  // rows (phone codes ~249), then close unless keepOpen. Returns portal rows for LLM.
  // keepOpen + resetToTop:false = phone CC path (stay near bottom across LLM).
  async function harvestMultiOptions(multi, opts) {
    const keepOpen = !!(opts && opts.keepOpen);
    const resetToTop = !(opts && opts.resetToTop === false);
    const input = multi && multi.querySelector("input");
    if (!input) return { options: [], portalOptions: [] };
    await openMultiPrompt(multi);
    await waitForOptionsSettled({ timeout: 3500, settleMs: 280, ownerMulti: multi });
    let portalOptions = await scrollCollectMultiOptions(multi, { resetToTop });
    if (!portalOptions.length) {
      const root = activeMultiListRoot(multi);
      portalOptions = (root ? readMultiOptionRows(root) : []).map((r) => ({
        id: r.id,
        value: r.value,
        text: r.text,
        hierarchical: r.hierarchical,
      }));
    }
    if (!keepOpen) await closePrompt(multi, input);
    else {
      try {
        if (WD.aa) {
          WD.aa("harvestMultiOptions keepOpen", {
            count: portalOptions.length,
            resetToTop,
            scrollTop: (multiListScroller(multi) || {}).scrollTop || 0,
          });
        }
      } catch {}
    }
    const seen = new Set();
    const uniq = [];
    for (const o of portalOptions) {
      const t = o && o.text;
      if (!t || isPlaceholderOption(t) || isEmptyPromptRow(t)) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push({
        id: o.id || t,
        value: o.value || o.id || t,
        text: t,
        hierarchical: !!o.hierarchical,
      });
    }
    const capped = uniq.slice(0, 280);
    return { options: capped.map((o) => o.text), portalOptions: capped };
  }

  // Inspect a formField wrapper and describe its control for the LLM: { kind,
  // options } where kind aligns with the backend's AutofillControlIn kinds. For
  // option controls we harvest the exact visible choices so the model can only
  // pick a real one. Returns null for controls we never send to the LLM (dates -
  // filled from the profile; file uploads - handled separately).
  async function classifyControl(container) {
    // Match writeField order: multiSelectContainer BEFORE listboxTrigger.
    // How Did You Hear is a MultiSelect whose search input is also
    // role=combobox[aria-haspopup=listbox]; harvesting it as a listbox opens the
    // wrong widget path and leaves the prompt dirty for the next recovery fill.
    const multi = container.querySelector('[data-automation-id="multiSelectContainer"]');
    if (multi) {
      const harvested = await harvestMultiOptions(multi);
      return {
        kind: "select",
        options: harvested.options || [],
        portalOptions: harvested.portalOptions || [],
        portalHtml: buildPortalOptionsHtml(
          "multi",
          fieldLabel(container),
          harvested.portalOptions || [],
          "",
        ),
      };
    }
    const btn = listboxTrigger(container);
    if (btn) {
      // harvestPortalOptions already closeAllListboxes — do not nest another full
      // close pass before every open (that amplified Escape/focus churn on GDIT).
      let harvested = await harvestPortalOptions(btn);
      if (!(harvested.options && harvested.options.length)) {
        try {
          WD.warn("classifyControl: 0 portal options — retrying", fieldLabel(container));
        } catch {}
        await D.delay(80);
        harvested = await harvestPortalOptions(btn);
      }
      const label = fieldLabel(container);
      let options = (harvested.options || []).map((o) => o.text);
      // Do not third-open on "implausible" — that caused extra scroll/open cycles.
      // Prefer empty options over thrashing the page; LLM / APPLY can recover.
      if (!optionsPlausibleForLabel(label, options) && options.length) {
        try {
          WD.warn("implausible options for", label, "- keeping first harvest", options.slice(0, 8));
        } catch {}
      }
      return {
        kind: "select",
        options,
        portalOptions: harvested.options || [],
        portalHtml: harvested.portalHtml || "",
        listboxId: harvested.listboxId || null,
      };
    }
    const nativeSel = container.querySelector("select");
    if (nativeSel) {
      const opts = [...nativeSel.options]
        .map((o) => (o.text || "").trim())
        .filter((t) => t && !/^select(\s+one)?\.?\.?\.?$/i.test(t));
      return { kind: "select", options: opts };
    }
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    if (radios.length) {
      return { kind: "radio", options: radios.map((r) => (labelForInput(r) || "").trim()).filter(Boolean) };
    }
    const checks = [...container.querySelectorAll('input[type="checkbox"]')];
    if (checks.length > 1) {
      // One-of checkbox group (e.g. disability self-ID) - give the model the real
      // labels and treat it as single-choice so it picks exactly one.
      return { kind: "radio", options: checks.map((c) => (labelForInput(c) || "").trim()).filter(Boolean) };
    }
    if (checks.length === 1) return { kind: "checkbox", options: ["Yes", "No"] };
    if (isDateContainer(container)) {
      return null; // dates come from the profile / today, not the LLM
    }
    if (container.querySelector('input[type="file"]')) return null; // handled by resume upload
    if (container.querySelector("textarea")) return { kind: "textarea", options: [] };
    const text = container.querySelector(
      'input[type="text"], input[type="tel"], input[type="number"], input[type="email"], input[type="url"], input:not([type])',
    );
    if (text) {
      const t = (text.getAttribute("type") || "text").toLowerCase();
      const kind = ["tel", "number", "email", "url"].includes(t) ? t : "text";
      return { kind, options: [] };
    }
    return null;
  }

  // Harvest portal options (id/value/text + HTML) → LLM returns option id or
  // data-value or text → pointer-select that exact portal row.
  async function resolveUnmatchedWithLLM(targets, rep, profile) {
    if (!targets || !targets.length) {
      try {
        if (WD.aa) WD.aa("LLM resolve SKIP", { reason: "no-targets" });
      } catch {}
      return;
    }
    throwIfAborted();
    try {
      if (WD.aa) {
        WD.aa("LLM resolve START", {
          count: targets.length,
          labels: targets.map((t) => String(t.label || t.key || "").slice(0, 70)),
        });
      }
    } catch {}
    WD._resolveCache = WD._resolveCache || {};
    const items = [];
    const byCid = new Map();
    let i = 0;
    for (const t of targets) {
      throwIfAborted();
      const stillInvalid = !!(t.container && t.container.querySelector('[aria-invalid="true"]'));
      if (shouldSkipFailedField(t.key, t.label) && !stillInvalid) {
        try {
          if (WD.aa) {
            WD.aa("LLM target SKIP failed-field", {
              key: t.key,
              labelHead: String(t.label || "").slice(0, 70),
            });
          }
        } catch {}
        rep.unmatched.push({ key: t.key, label: t.label });
        continue;
      }
      // Multi + known want (Country Phone Code): skip harvest/LLM entirely —
      // fillMultiselect type-to-select is authoritative. Contaminated harvest
      // previously returned LinkedIn from the source field.
      const multiEarly =
        t.container && t.container.querySelector('[data-automation-id="multiSelectContainer"]');
      if (multiEarly && t.want) {
        const cid = ((t.key || "field").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "f") + "_" + i++;
        byCid.set(cid, { ...t, options: [], portalOptions: [], portalHtml: "", kind: "select" });
        items.push({
          cid,
          label: t.label,
          kind: "select",
          required: t.required,
          options: [],
          portalOptions: [],
          portalHtml: "",
          want: t.want,
        });
        try {
          WD.log(`LLM skip-harvest multi want '${t.label}' → apply locally`, String(t.want).slice(0, 60));
        } catch {}
        continue;
      }
      let info = null;
      try {
        info = await classifyControl(t.container);
      } catch (e) {
        if (e && e.name === "WDAborted") throw e;
      }
      if (!info) {
        rep.unmatched.push({ key: t.key, label: t.label });
        rememberFailedField(t.key, t.label);
        continue;
      }
      const cid = ((t.key || "field").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "f") + "_" + i++;
      const portalOptions = info.portalOptions || [];
      const options = info.options || portalOptions.map((o) => o.text);
      const portalHtml = buildPortalOptionsHtml(cid, t.label, portalOptions, info.portalHtml || "");
      byCid.set(cid, {
        ...t,
        options,
        portalOptions,
        portalHtml,
        kind: info.kind,
      });
      items.push({
        cid,
        label: t.label,
        kind: info.kind,
        required: t.required,
        options,
        portalOptions,
        portalHtml,
        want: t.want || undefined,
      });
      try {
        WD.log(
          `LLM portal target '${t.label}' kind=${info.kind} options=${options.length}`,
          portalOptions.slice(0, 8),
        );
      } catch {}
    }
    if (!items.length) return;

    const values = {};
    // Apply multi+want items immediately (no LLM).
    for (const item of items) {
      if (item.want && !(item.options && item.options.length) && !(item.portalOptions && item.portalOptions.length)) {
        const meta = byCid.get(item.cid);
        if (meta && meta.container && meta.container.querySelector('[data-automation-id="multiSelectContainer"]')) {
          values[item.cid] = item.want;
        }
      }
    }
    const needLlm = [];
    for (const item of items) {
      if (values[item.cid]) continue;
      const cacheKey = (item.label || "").toLowerCase().trim().slice(0, 120);
      if (cacheKey && WD._resolveCache[cacheKey]) {
        const cached = WD._resolveCache[cacheKey];
        if (item.portalOptions && item.portalOptions.length) {
          const choice = resolvePortalChoice(
            cached && (cached.value || cached.id || cached.text || cached),
            item.portalOptions,
          );
          if (choice) {
            values[item.cid] = choice;
            continue;
          }
        } else {
          const snapped = snapToHarvestedOption(cached, item.options);
          if (snapped) {
            values[item.cid] = snapped;
            continue;
          }
        }
      }
      // Local profile want snap BEFORE LLM — State/California, phone CC, etc.
      if (item.want && item.portalOptions && item.portalOptions.length) {
        const fromWant = resolvePortalChoice(item.want, item.portalOptions);
        if (fromWant) {
          values[item.cid] = fromWant;
          continue;
        }
      }
      if (item.want && item.options && item.options.length) {
        const fromWant = snapToHarvestedOption(item.want, item.options);
        if (fromWant) {
          values[item.cid] = fromWant;
          continue;
        }
      }
      // Multi with known want but empty/contaminated harvest (e.g. LinkedIn leaked
      // into Country Phone Code) — apply want via fillMultiselect type path.
      if (item.want) {
        const meta = byCid.get(item.cid);
        if (meta && meta.container && meta.container.querySelector('[data-automation-id="multiSelectContainer"]')) {
          values[item.cid] = item.want;
          continue;
        }
      }
      needLlm.push(item);
    }
    try {
      const BATCH = 8;
      for (let b = 0; b < needLlm.length; b += BATCH) {
        throwIfAborted();
        const chunk = needLlm.slice(b, b + BATCH);
        const part = await requestOptionMatches(chunk);
        for (const item of chunk) {
          const raw = part && part[item.cid];
          if (raw == null || raw === "") continue;
          if (item.portalOptions && item.portalOptions.length) {
            const choice = resolvePortalChoice(raw, item.portalOptions);
            if (choice) values[item.cid] = choice;
            else {
              try {
                WD.warn(`LLM portal answer not in options for '${item.label}':`, raw, item.portalOptions);
              } catch {}
            }
          } else if (item.options && item.options.length) {
            const snapped = snapToHarvestedOption(raw, item.options);
            if (snapped) values[item.cid] = snapped;
          } else {
            values[item.cid] = raw;
          }
        }
      }
    } catch (e) {
      if (e && e.name === "WDAborted") throw e;
    }

    for (const item of items) {
      if (values[item.cid]) continue;
      if (item.want && item.portalOptions && item.portalOptions.length) {
        const fromWant = resolvePortalChoice(item.want, item.portalOptions);
        if (fromWant) {
          values[item.cid] = fromWant;
          continue;
        }
      }
      if (item.want) {
        const fromWant = snapToHarvestedOption(item.want, item.options);
        if (fromWant) {
          values[item.cid] = fromWant;
          continue;
        }
      }
      if (item.options && item.options.length) {
        // Emergency only after LLM + want snap failed. Never invent free text —
        // localScreeningPick must snap onto harvested options.
        const local = localScreeningPick(item.label, profile, item.options);
        if (local) {
          if (item.portalOptions && item.portalOptions.length) {
            const snapped = resolvePortalChoice(local, item.portalOptions);
            if (snapped) values[item.cid] = snapped;
            else {
              try {
                WD.warn(`localScreeningPick did not snap for '${item.label}':`, local);
              } catch {}
            }
          } else {
            values[item.cid] = local;
          }
        }
      }
    }

    for (const [cid, t] of byCid) {
      throwIfAborted();
      const value = values[cid];
      try {
        if (WD.aa) {
          WD.aa("LLM apply", {
            labelHead: String(t.label || "").slice(0, 80),
            value: value == null ? null : typeof value === "object" ? value : String(value).slice(0, 80),
          });
        }
      } catch {}
      if (value == null || value === "") {
        rep.unmatched.push({ key: t.key, label: t.label });
        rememberFailedField(t.key, t.label);
        continue;
      }

      let ok = false;
      const trigger = listboxTrigger(t.container);
      const multi = t.container && t.container.querySelector('[data-automation-id="multiSelectContainer"]');
      if (trigger && !multi) {
        // Single-select Canvas listbox: always portal id/value click (never text-only writeField).
        ok = await applyListboxPortal(trigger, value);
      } else {
        ok = await writeField(
          t.container,
          typeof value === "object" ? value.text || value.value || value.id : value,
          t.label || t.key,
        );
      }
      try {
        if (WD.aa) {
          WD.aa("LLM apply result", {
            labelHead: String(t.label || "").slice(0, 80),
            ok,
            stillInvalid: !!(t.container && t.container.querySelector('[aria-invalid="true"]')),
            shown: trigger
              ? String(selectDisplayValue(trigger) || triggerCurrentValue(trigger) || "").slice(0, 40)
              : null,
          });
        }
      } catch {}
      if (ok && t.container && t.container.querySelector('[aria-invalid="true"]') && trigger && !multi) {
        try {
          WD.log(`LLM portal re-commit '${t.label}' (still aria-invalid)`);
        } catch {}
        ok = await applyListboxPortal(trigger, value);
      } else if (ok && t.container && t.container.querySelector('[aria-invalid="true"]') && multi) {
        ok = await writeField(
          t.container,
          typeof value === "object" ? value.text || value.value || value.id : value,
          t.label || t.key,
        );
      }
      if (ok) {
        const cacheKey = (t.label || "").toLowerCase().trim().slice(0, 120);
        if (cacheKey) WD._resolveCache[cacheKey] = value;
      } else {
        rememberFailedField(t.key, t.label);
      }
      record(rep, t.label || cid, ok);
      await D.delay(60);
    }
  }

  // The resume widget keeps EVERY uploaded file as its own row, so re-running the
  // step (auto-advance recovery, or a prior step that already uploaded one) piles
  // up duplicates. Remove all currently-uploaded files in this widget - each row
  // is [data-automation-id="file-upload-item"] with its own
  // button[data-automation-id="delete-file"] (proven via the page DOM) - so that
  // after the subsequent attach exactly ONE (the current) resume remains.
  // getScope() is re-evaluated every pass because the widget can re-render. The
  // delete control is button[data-automation-id="delete-file"] inside each
  // file-upload-item row (proven via DOM). Confirms a delete dialog if one pops.
  async function clearUploadedFiles(getScope) {
    let removed = 0;
    for (let guard = 0; guard < 25; guard++) {
      const scope = getScope();
      const items = scope ? D.qa('[data-automation-id="file-upload-item"]', scope) : [];
      if (!items.length) break;
      const before = items.length;
      const del =
        items[items.length - 1].querySelector('[data-automation-id="delete-file"]') ||
        D.qa('[data-automation-id="delete-file"]', scope).pop();
      if (!del) break;
      D.clickEl(del);
      await D.delay(200);
      await confirmDeleteIfPrompted();
      let shrank = false;
      for (let i = 0; i < 40; i++) {
        await D.delay(150);
        const s2 = getScope();
        if (!s2 || D.qa('[data-automation-id="file-upload-item"]', s2).length < before) {
          shrank = true;
          break;
        }
      }
      if (!shrank) break;
      removed++;
      await D.delay(120);
    }
    return removed;
  }

  async function fillExperienceExtras(profile, options, rep) {
    throwIfAborted();
    // Recovery pass (onlyInvalid): panels + resume are already in place from the
    // initial pass, so skip that heavy work and just re-attempt the field fills
    // (fillSearchPrompt/isChosen short-circuit anything already committed).
    const recovery = !!(options && options.onlyInvalid && options.onlyInvalid.length);
    const resumeFile = recovery ? null : options && options.resumeFile;
    try {
      const b = resumeFile && resumeFile.base64 ? resumeFile.base64.length : 0;
      WD.log(`resume upload: file=${resumeFile ? resumeFile.filename || "yes" : "MISSING (none downloaded)"} base64Len=${b}`);
    } catch {}
    if (resumeFile) {
      // Resolve the resume widget LIVE (re-render safe): prefer the one wrapping
      // the file input; fall back to the first attachments widget on the page.
      const getScope = () => {
        const inp = D.q(AID("file-upload-input-ref"));
        return (
          (inp && inp.closest('[data-automation-id="attachments-FileUpload"]')) ||
          D.q('[data-automation-id="attachments-FileUpload"]') ||
          null
        );
      };
      const uploadItemCount = () => {
        const scope = getScope();
        return (scope ? D.qa('[data-automation-id="file-upload-item"]', scope) : D.qa('[data-automation-id="file-upload-item"]'))
          .length;
      };
      const waitForUploadItem = async (ms) => {
        const end = Date.now() + (ms || 8000);
        while (Date.now() < end) {
          throwIfAborted();
          if (uploadItemCount() > 0) return true;
          await D.delay(150);
        }
        return uploadItemCount() > 0;
      };
      // The widget renders slowly; wait for it (or an existing uploaded item)
      // BEFORE clearing, otherwise we'd clear nothing and then add a duplicate
      // (root cause of the lingering multiples: scope was null at clear time).
      for (let i = 0; i < 67; i++) {
        if (getScope() || D.q('[data-automation-id="file-upload-item"]')) break;
        await D.delay(150);
      }
      // Remove ALL previously-uploaded resume(s) so only the current one remains.
      const removed = await clearUploadedFiles(getScope);
      const inputPresent = !!D.q(AID("file-upload-input-ref"));
      let assigned = await D.attachFile(AID("file-upload-input-ref"), resumeFile);
      // UI row is the real commit signal — Workday often clears input.files after
      // accepting the File (see attachFile). Wait for the row; retry once if absent.
      let uiOk = await waitForUploadItem(assigned ? 6000 : 2500);
      if (!uiOk) {
        assigned = await D.attachFile(AID("file-upload-input-ref"), resumeFile);
        uiOk = await waitForUploadItem(8000);
      }
      const ok = uiOk || assigned;
      try {
        WD.log(
          `resume upload result: attached=${ok} assigned=${assigned} uiItem=${uiOk} removedExisting=${removed} inputPresentAtStart=${inputPresent} items=${uploadItemCount()}`,
        );
      } catch {}
      record(rep, "Resume upload", ok);
    }

    const work = Array.isArray(profile.workExperience) ? profile.workExperience : [];
    const edu = Array.isArray(profile.education) ? profile.education : [];
    try {
      WD.log(`experience input: work=${work.length} edu=${edu.length} resumeSource=${profile.resumeSource}`);
      // Evidence for "2nd School not filled": show which entries actually carry a
      // school name. "(empty)" here means the profile has no university_name for
      // that education entry - nothing to type (a profile-data gap, not a bug).
      WD.log(
        "education schools: " +
          edu.map((e, i) => `#${i + 1}:${e && e.school ? JSON.stringify(e.school) : "(empty)"}`).join(" "),
      );
    } catch {}

    // 1. Create exactly the needed panels (idempotent across re-runs). Workday
    //    allows multiple empty blocks (proven), so add them all up front. On a
    //    recovery pass the panels already exist — skip the ~1.5s settle/add work.
    if (!recovery) {
      if (work.length) await ensurePanels("Work-Experience-section", "Work-Experience", work.length);
      if (edu.length) await ensurePanels("Education-section", "Education", edu.length);
    }
    // Re-query live after the adds (the section node may have been replaced).
    const workPanels = panelRoots("Work-Experience").slice(0, work.length);
    const eduPanels = panelRoots("Education").slice(0, edu.length);
    try {
      WD.log(`experience panels: work=${workPanels.length}/${work.length} edu=${eduPanels.length}/${edu.length}`);
    } catch {}

    // 2. Harvest each education's Degree options and fire the LLM match request
    //    NOW (non-blocking) so it resolves while we fill everything else. (Field
    //    of Study is NOT harvested here - it is a free search prompt filled inline
    //    in step 3 by typing the exact value and pressing Enter.)
    // Recovery: only re-attempt EMPTY education fields (School + Degree). Do NOT
    // re-walk work panels — that produced the duplicate "My Experience" report.
    if (recovery) {
      for (let i = 0; i < eduPanels.length; i++) {
        await fillEducationNonDegree(eduPanels[i], edu[i], i + 1, rep);
      }
      await closeAllListboxes();
      await D.delay(120);
      for (let i = 0; i < eduPanels.length; i++) {
        const e = edu[i] || {};
        if (!e.degree) continue;
        const degFF = panelField(eduPanels[i], "degree");
        if (degFF && fieldHasCommittedValue(degFF)) continue;
        const btn = degreeButton(eduPanels[i]);
        if (!btn) continue;
        const harvested = await harvestPortalOptions(btn);
        const texts = (harvested.options || []).map((o) => o.text);
        const textPick =
          exactOption(e.degree, texts) || matchDegreeOption(e.degree, texts) || bestLocalMatch(e.degree, texts);
        const choice = resolvePortalChoice(textPick, harvested.options);
        try {
          WD.log(
            `Edu ${i + 1} Degree recovery: want=${JSON.stringify(e.degree)} -> ${JSON.stringify(choice || textPick)} of ${texts.length} options`,
          );
        } catch {}
        if (!choice && (!textPick || isPlaceholderOption(textPick))) continue;
        await closeAllListboxes();
        record(rep, `Edu ${i + 1} Degree`, await applyListboxPortal(btn, choice || textPick));
      }
      return;
    }

    const matchItems = [];
    for (let i = 0; i < eduPanels.length; i++) {
      const e = edu[i] || {};
      const n = i + 1;
      // Degree: Canvas listbox — portal harvest (id/value/text) then LLM.
      if (e.degree) {
        const degFF = panelField(eduPanels[i], "degree");
        if (degFF && fieldHasCommittedValue(degFF)) continue;
        const btn = degreeButton(eduPanels[i]);
        if (btn && btn.id) {
          const harvested = await harvestPortalOptions(btn);
          const portalOptions = harvested.options || [];
          if (portalOptions.length) {
            matchItems.push({
              kind: "select",
              n,
              cid: btn.id,
              btn,
              want: e.degree,
              label: "Degree",
              options: portalOptions.map((o) => o.text),
              portalOptions,
              portalHtml: buildPortalOptionsHtml(btn.id, "Degree", portalOptions, harvested.portalHtml || ""),
            });
          }
        }
      }
    }
    // LLM degree matching only on the initial pass; recovery uses local matching
    // (exact option / token-overlap) so it never blocks on a network round-trip.
    const matchPromise = matchItems.length ? requestOptionMatches(matchItems) : Promise.resolve({});

    // 3. Fill the panel fields: work history + education School / Field of Study
    //    (server search prompts driven by fillSearchPrompt) + text/dates/GPA.
    for (let i = 0; i < workPanels.length; i++) await fillWorkPanel(workPanels[i], work[i], i + 1, rep);
    for (let i = 0; i < eduPanels.length; i++) await fillEducationNonDegree(eduPanels[i], edu[i], i + 1, rep);

    // 4. Apply Degree via portal id/data-value click (same as Application Questions).
    //
    // CRITICAL: a failed School fill can leave "Search Results (N)" open. That
    // open prompt's options are what pickOption sees, so Degree openAndPick for
    // Education 2 then fails ("Select One" + required error) even though harvest
    // succeeded earlier. Always dismiss open prompts before Degree.
    let chosen = {};
    try {
      chosen = await matchPromise;
    } catch {}
    await closeAllListboxes();
    await D.delay(150);
    for (const it of matchItems) {
      const llmRaw = chosen[it.cid];
      const llmChoice = llmRaw != null ? resolvePortalChoice(llmRaw, it.portalOptions) : null;
      const textFallback =
        exactOption(it.want, it.options) ||
        matchDegreeOption(it.want, it.options) ||
        bestLocalMatch(it.want, it.options);
      const choice =
        llmChoice || resolvePortalChoice(textFallback, it.portalOptions) || (textFallback ? { text: textFallback } : null);
      try {
        WD.log(
          `Edu ${it.n} Degree: want=${JSON.stringify(it.want)} llm=${JSON.stringify(llmRaw || null)} -> ${JSON.stringify(choice)} of ${it.options.length} options ${JSON.stringify(it.options.slice(0, 12))}`,
        );
      } catch {}
      if (!choice || isPlaceholderOption(choice.text || choice.value)) continue;
      const liveBtn = it.btn.isConnected ? it.btn : degreeButton(eduPanels[it.n - 1]);
      if (liveBtn) record(rep, `Edu ${it.n} Degree`, await applyListboxPortal(liveBtn, choice));
    }

    // 5. Win the race against Workday's résumé parser: it re-fills Role Description
    //    from the uploaded PDF (possibly with markdown) AFTER we set it. Re-assert
    //    clean text until the parser stops clobbering it. Only needed after the
    //    initial pass (the parser runs once, on upload) - skip it on recovery.
    if (!recovery) await reassertWorkDescriptions(work);
  }

  // flush(): force any deferred text/date commits to run now. Auto-advance focuses
  // the page (real OS focus) before calling this so the focus-gated commit can fire.
  WD.steps = {
    fillStep,
    fillExperienceExtras,
    buildValueMap,
    resolveByLabel,
    fieldLabel,
    AID,
    isRequired,
    flush: flushCommits,
    // Debug helpers for console probes (Application Questions Acknowledgment).
    listboxTrigger,
    harvestOptions,
    harvestPortalOptions,
    applyListboxPortal,
    openAndPickPortal,
    matchOptionFromList,
    writeField,
    openAndPick,
    fieldIsFilled,
    fieldHasCommittedValue,
    probeCheckboxGroup,
    commitCheckable,
    applyCheckboxGroup,
  };
  // Build marker: if this line is NOT in the console on a run, the tab is running
  // a STALE engine (reload the extension at chrome://extensions, then hard-reload
  // the Workday page).
  try {
    WD.log("wd-steps build: 2026-08-07-listbox-durability-sweep-v27");
    try {
      if (WD.aa) WD.aa("engine-build", { build: "2026-08-07-listbox-durability-sweep-v27", href: location.href });
    } catch {}
  } catch {}
})();
