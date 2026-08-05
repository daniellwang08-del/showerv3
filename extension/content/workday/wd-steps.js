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
// Strategy (the hybrid): discover every formField, resolve its value from a
// static key map (instant, deterministic) or a label-keyword rule, write it with
// the control-aware writer, and collect anything still unanswered (required
// fields / questions) into rep.unmatched for the LLM phase. Namespaced under
// window.__WD.steps.
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
    return !t || /^select(\s+one)?\.?\.?\.?$/.test(t);
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
    if (/what is your (sex|gender)|\bsex\b/.test(low)) {
      return /male|female|do not wish/.test(opts) && !/bachelor|master|veteran/.test(opts);
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

  async function closeAllListboxes() {
    for (let pass = 0; pass < 3; pass++) {
      let anyOpen = false;
      // Only form/application triggers — never header Language/Settings buttons
      // (they also use aria-haspopup=listbox and poisoned openedListbox fallback).
      const triggers = D.qa(
        '[data-automation-id^="formField-"] button[aria-haspopup="listbox"], [data-automation-id^="formField-"] [role="combobox"][aria-haspopup="listbox"], [data-automation-id^="formField-"] input[aria-haspopup="listbox"], [data-automation-id="applyFlowPage"] button[aria-haspopup="listbox"]',
      ).filter(D.isVisible);
      for (const btn of triggers) {
        if (btn.getAttribute("aria-expanded") === "true" || openedListbox(btn)) {
          anyOpen = true;
          await closeListbox(btn);
        }
      }
      const popups = D.qa(
        '[data-behavior-click-outside-close] [role="listbox"], [data-popper-placement] [role="listbox"], [data-automation-id="activeListContainer"], [role="listbox"]',
      ).filter(D.isVisible);
      if (popups.length) {
        anyOpen = true;
        pressKey(document.body, "Escape", "Escape", 27);
        await D.delay(80);
        focusSinkOutside(document);
      }
      if (!anyOpen) break;
      await D.delay(100);
    }
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

  // Phone country code: the multiselect needs the full label, not the digits.
  const PHONE_CC_LABEL = { "1": "United States of America (+1)" };

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
    const cc = String(c.phoneCountryCode || "").replace(/\D/g, "");
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
      countryPhoneCode: PHONE_CC_LABEL[cc],
      phoneNumber: String(c.phone || "").replace(/\D/g, ""),
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
      [
        /(?:do you have a disability|i have a disability|no,? i do not have a disability|cc-305|disability status|self-identif)/i,
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
  function isDisabilitySelfIdLabel(labelOrLow) {
    const low = String(labelOrLow || "").toLowerCase();
    if (!low) return false;
    if (isAcknowledgmentSelectLabel(low) || isReasonableAccommodationLabel(low)) return false;
    return /please check one of the boxes|cc-305|self.identif|do you have a disability|i have a disability|no,? i do not have a disability|disability status|had one in the past|without a disability/i.test(
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
    el.scrollIntoView({ block: "center", behavior: "instant" });
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
      const t = D.norm(o.textContent);
      return !!t && t !== "no items" && t !== "no results";
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
  function firePointerClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {}
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
  function pickOption(want, root) {
    const w = D.norm(want);
    const scored = visibleOptions(root)
      .map((o) => ({
        o,
        t: D.norm(o.textContent),
        id: (o.id || "").trim(),
        val: (o.getAttribute("data-value") || o.getAttribute("value") || "").trim(),
      }))
      .filter((x) => x.t);
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
    const n = D.norm(raw);
    // Prefer stable Workday data-value / element id (proven portal rows).
    let hit =
      portalOptions.find((o) => D.norm(o.value) === n) ||
      portalOptions.find((o) => D.norm(o.id) === n) ||
      portalOptions.find((o) => D.norm(o.text) === n);
    if (hit) return hit;
    // Encoded forms: "No (value=…)" / "value=…" / "id=…"
    const mVal = raw.match(/(?:data-)?value\s*[=:]\s*([^\s)|,]+)/i);
    if (mVal) {
      hit = portalOptions.find((o) => D.norm(o.value) === D.norm(mVal[1]));
      if (hit) return hit;
    }
    const mId = raw.match(/(?:data-af-option-)?id\s*[=:]\s*([^\s)|,]+)/i);
    if (mId) {
      hit = portalOptions.find((o) => D.norm(o.id) === D.norm(mId[1]));
      if (hit) return hit;
    }
    hit = portalOptions.find((o) => D.norm(o.text).includes(n) || n.includes(D.norm(o.text)));
    return hit || null;
  }

  // Universal Workday single-select path (ALL Canvas listbox dropdowns):
  // harvest portal rows → resolve answer to id/data-value/text → pointer-click.
  // Never invent Yes/No / acknowledgment expansions here — callers must pass
  // an LLM (or profile) answer that snaps onto harvested options.
  async function applyListboxPortal(trigger, answer) {
    if (!trigger || answer == null || answer === "") return false;
    if (typeof answer === "object" && !Array.isArray(answer) && (answer.id || answer.value || answer.text)) {
      return await openAndPickPortal(trigger, answer);
    }
    const harvested = await harvestPortalOptions(trigger);
    const choice = resolvePortalChoice(answer, harvested.options);
    if (choice) return await openAndPickPortal(trigger, choice);
    // Rare: input combobox with searchable options when portal harvest failed.
    try {
      WD.warn("applyListboxPortal: no portal snap, falling back to text pick", answer, harvested.options);
    } catch {}
    return await openAndPick(trigger, typeof answer === "object" ? answer.text || answer.value : answer);
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

    const popup = await openListboxForOptions(trigger);
    if (!popup) {
      try {
        WD.warn("openAndPickPortal: portal did not open");
      } catch {}
      return false;
    }
    await D.delay(80);

    let match = null;
    // Prefer stable data-value (proven CrowdStrike); option element ids change per open.
    if (choice.value) {
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
      match =
        popup.querySelector(`[role="option"][data-value="${esc(choice.value)}"]`) ||
        popup.querySelector(`[role="option"][id="${esc(choice.value)}"]`);
    }
    if ((!match || !popup.contains(match)) && choice.id) {
      const byId = document.getElementById(choice.id);
      if (byId && popup.contains(byId)) match = byId;
      else {
        const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
        match = popup.querySelector(`[role="option"][id="${esc(choice.id)}"]`) || match;
      }
    }
    if (!match) match = pickOption(choice.value || choice.id || choice.text, popup);
    if (!match) match = pickOption(choice.text, popup);
    if (!match) {
      try {
        WD.warn("openAndPickPortal: option not found", choice, readPortalOptionRows(popup));
      } catch {}
      await closeListbox(trigger);
      return false;
    }

    const chosen = (match.textContent || "").replace(/\s+/g, " ").trim();
    firePointerClick(match);
    await D.delay(220);
    const committed = () => {
      const got = selectDisplayValue(trigger) || triggerCurrentValue(trigger);
      return valueMatchesWant(got, want) || valueMatchesWant(got, chosen) || valueMatchesWant(got, choice.text);
    };
    if (!committed()) await typeAheadCommit(trigger, chosen, committed);
    await closeListbox(trigger);
    if (committed()) return true;
    try {
      WD.warn("openAndPickPortal did not commit", choice, selectDisplayValue(trigger));
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
      const target = pickByLabel(checks, pick);
      if (!target) return false;
      if (!target.checked) clickInputOrLabel(target);
      return true;
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
  async function openListboxForOptions(btn) {
    if (!btn) return null;
    // Already open with a resolvable portal — do not pointer-click again (toggles closed).
    if (listboxIsOpen(btn)) {
      const existing = openedListbox(btn);
      if (existing) {
        await D.waitFor(OPTION_SEL, 1500, existing);
        return existing;
      }
    }
    firePointerClick(btn);
    await D.delay(200);
    let popup = openedListbox(btn);
    for (let i = 0; i < 20 && !popup; i++) {
      await D.delay(80);
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
    if (popup) await D.waitFor(OPTION_SEL, 2000, popup);
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
  async function closeListbox(btn) {
    if (!openedListbox(btn)) return;
    pressKey(btn, "Escape", "Escape", 27);
    await D.delay(100);
    if (openedListbox(btn)) {
      focusSinkOutside(btn.ownerDocument || document);
      await D.delay(100);
    }
  }

  // Single-select: click the listbox trigger (button OR Canvas Select combobox
  // input), type into the search box scoped to the popup it opened, then click
  // the matching promptOption. All lookups are confined to that popup.
  async function openAndPick(trigger, value) {
    try {
      return await openAndPickInner(trigger, value);
    } catch (e) {
      if (e && e.name === "WDAborted") throw e;
      try {
        WD.warn("openAndPick failed", (e && e.message) || e);
      } catch {}
      try {
        await closeListbox(trigger);
      } catch {}
      return false;
    }
  }

  async function openAndPickInner(trigger, value) {
    const want = D.norm(value);
    // Picking the placeholder row leaves the field on "Select One" yet the
    // read-back below would match want === "select one" and report success.
    if (isPlaceholderOption(want)) {
      try {
        WD.warn(`openAndPick refused placeholder value ${JSON.stringify(value)}`);
      } catch {}
      return false;
    }
    const ff = trigger && trigger.closest && trigger.closest('[data-automation-id^="formField-"]');
    // PROVEN (CrowdStrike AQ accommodation): button text already reads "No" while
    // aria-invalid="true" remains. Auto-advance's WD_VALIDATE then puts this
    // label in lastNames → panel "Couldn't resolve on Application Questions: …"
    // even though the UI looks filled. Early-returning on display match skipped
    // the pointer-click that actually commits Workday's React model.
    const markedInvalid =
      (trigger && trigger.getAttribute("aria-invalid") === "true") ||
      !!(ff && ff.querySelector('[aria-invalid="true"]'));
    const cur = D.norm(selectDisplayValue(trigger) || triggerCurrentValue(trigger));
    if (cur && valueMatchesWant(cur, want) && !markedInvalid) return true;
    if (cur && !triggerShowsPlaceholder(trigger) && valueMatchesWant(cur, want) && !markedInvalid) return true;
    if (markedInvalid && cur && valueMatchesWant(cur, want)) {
      try {
        WD.log("openAndPick forcing re-commit (display matches but aria-invalid)", { cur, want });
      } catch {}
    }

    // ONLY real <input> Canvas Select supports typeahead + value setter.
    // button[aria-haspopup=listbox] also has aria-haspopup=listbox — treating it
    // as a combobox and calling setReactValue caused "Illegal invocation".
    const isInputCombo =
      trigger.tagName === "INPUT" &&
      (trigger.getAttribute("role") === "combobox" || trigger.getAttribute("aria-haspopup") === "listbox");

    // Canvas Select input: type the option then Enter (WAI select pattern).
    if (isInputCombo) {
      D.clickEl(trigger);
      await D.delay(120);
      try {
        trigger.focus();
      } catch {}
      const str = String(value);
      setReactValue(trigger, "");
      trigger.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      await D.delay(40);
      setReactValue(trigger, str);
      trigger.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: str, inputType: "insertText" }),
      );
      const last = str.slice(-1) || "a";
      const meta = keyMetaForChar(last);
      fireKey(trigger, last, meta.code, meta.keyCode);
      await D.delay(220);
      pressEnter(trigger);
      await D.delay(200);
      const typed = selectDisplayValue(trigger) || triggerCurrentValue(trigger);
      if (valueMatchesWant(typed, want) || (!triggerShowsPlaceholder(trigger) && D.norm(typed))) {
        await closeListbox(trigger);
        return true;
      }
    }

    // Open with POINTER events (proven: Canvas portal listboxes). Never toggle
    // closed an already-open menu with a second click.
    let popup = await openListboxForOptions(trigger);
    if (!popup) {
      try {
        WD.warn("openAndPick: listbox portal did not open", trigger && trigger.id);
      } catch {}
      return false;
    }
    // Prefer a dedicated search box inside the popup — never type into the
    // page-top How Did You Hear multiselect (same class of bug as openedListbox).
    const search = popup
      ? [...popup.querySelectorAll('input[data-automation-id="searchBox"], input[type="search"], input[type="text"]')]
          .filter((el) => el !== trigger && D.isVisible(el) && !el.classList.contains("css-77hcv"))[0] || null
      : null;
    if (search) {
      try {
        search.focus();
      } catch {}
      D.nativeSet(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await D.delay(400);
    }
    if (!(await D.waitFor(OPTION_SEL, 2000, popup))) {
      await closeListbox(trigger);
      return false;
    }
    await D.delay(120);
    const match = pickOption(value, popup);
    if (!match) {
      try {
        WD.warn(
          "openAndPick: no option matched",
          value,
          visibleOptions(popup).map((o) => (o.textContent || "").trim()),
        );
      } catch {}
      await closeListbox(trigger);
      return false;
    }
    const chosen = (match.textContent || "").replace(/\s+/g, " ").trim();
    const committed = () => {
      const got = selectDisplayValue(trigger) || triggerCurrentValue(trigger);
      return valueMatchesWant(got, want) || valueMatchesWant(got, chosen);
    };

    // Strategy 1: pointer-click the row. Canvas listbox rows select on POINTER
    // events; D.clickEl's mousedown/mouseup/click triple only DISMISSED the
    // popup without selecting (the same defect that blocked the School prompt).
    firePointerClick(match);
    await D.delay(200);

    if (isInputCombo && chosen && !committed()) {
      setReactValue(trigger, chosen);
      trigger.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: chosen,
          inputType: "insertReplacementText",
        }),
      );
      trigger.dispatchEvent(new Event("change", { bubbles: true }));
      pressEnter(trigger);
      await D.delay(150);
    }

    // Strategy 2: keyboard, exactly what the user does by hand - with the list
    // open, type the option text so ARIA type-ahead moves the active option,
    // then Enter to commit. Independent of any pointer handling.
    if (!committed()) await typeAheadCommit(trigger, chosen, committed);

    if (committed()) {
      await closeListbox(trigger);
      return true;
    }
    // NEVER treat bare yes/no as success just because the listbox closed.
    // CrowdStrike Acknowledgment options are long ("Yes, I acknowledge and
    // agree…"); typing/clicking can dismiss the menu while the button still
    // reads "Select One". Only succeed when the visible selection matches.
    await closeListbox(trigger);
    if (committed()) return true;
    if (!triggerShowsPlaceholder(trigger)) {
      const got = D.norm(selectDisplayValue(trigger) || triggerCurrentValue(trigger));
      if (got && (want === "yes" || want === "no") && (got.startsWith(want) || valueMatchesWant(got, want))) {
        return true;
      }
    }
    try {
      const got = selectDisplayValue(trigger) || triggerCurrentValue(trigger);
      WD.warn(`openAndPick did not commit ${JSON.stringify(chosen)} - field reads ${JSON.stringify(got)}`);
    } catch {}
    return false;
  }

  // ARIA listbox type-ahead: with the list OPEN, printable keys move the active
  // option and Enter commits it. Keys are sent to the listbox first (Canvas moves
  // DOM focus there and tracks aria-activedescendant), then to the trigger.
  // Enter is only sent when the active option actually matches the target text,
  // so a non-type-ahead widget can never be made to commit the wrong option.
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
  function pressKey(el, key, code, keyCode) {
    try {
      el.focus();
    } catch {}
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code, keyCode, which: keyCode }),
      );
    }
  }
  const pressEnter = (el) => pressKey(el, "Enter", "Enter", 13);

  // Move focus to a throwaway off-screen sink so a genuine focusout (with a
  // non-null relatedTarget) fires - a bare input.blur() (relatedTarget=null) is
  // ignored by the widget. An outside click-away is dispatched as a backup for
  // widgets that dismiss on document click rather than focusout.
  function focusSinkOutside(doc) {
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

  async function fillMultiselect(multi, value) {
    const want = D.norm(value);
    // A committed selection is a pill/label, NOT a dropdown option.
    const isChosen = () => promptChosen(multi, want);
    if (isChosen()) return true;

    const input = multi.querySelector("input");
    if (!input) return false;

    // Open the prompt - the search box is minimized until the field is activated.
    const opener = multi.querySelector('[data-automation-id="multiselectInputContainer"]') || input;
    D.clickEl(opener);
    await D.delay(150);
    input.focus();
    D.nativeSet(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    D.nativeSet(input, String(value));
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value) }));
    await D.delay(450);

    // Path A: a flat multiselect (e.g. Country Phone Code) surfaces the matching
    // leaf as a clickable option - click it, then close the still-open list.
    let match = pickOption(value);
    if (match) {
      D.clickEl(match);
      await D.delay(150);
      await closePrompt(multi, input);
      return true;
    }

    // Path B: a hierarchical search prompt (e.g. "How Did You Hear About Us?")
    // keeps showing parent categories; typing never exposes a clickable "LinkedIn"
    // leaf. Enter runs Workday's search-and-select, but ONLY when the search input
    // itself is focused - so refocus it (and re-assert the typed value) first.
    input.focus();
    if (document.activeElement !== input) D.clickEl(input);
    if (D.norm(input.value) !== want) {
      D.nativeSet(input, String(value));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value) }));
      await D.delay(250);
    }
    pressEnter(input);
    await D.delay(500);
    if (isChosen()) {
      await closePrompt(multi, input);
      return true;
    }

    // After Enter the matching leaf may render as a result - click it as a fallback.
    if (await D.waitFor(OPTION_SEL, 1500)) {
      await D.delay(120);
      match = pickOption(value);
      if (match) {
        D.clickEl(match);
        await D.delay(150);
      }
    }
    // ALWAYS dismiss the prompt - leaving it open (even on failure) lets the
    // page-top "How Did You Hear About Us?" search steal later field typing
    // (see openedListbox comment). Proven corruption path for State/etc.
    const ok = isChosen();
    await closePrompt(multi, input);
    return ok;
  }

  // ── "How Did You Hear About Us?" (source) — select-and-verify ───────────────
  //
  // This is a hierarchical single-select SOURCE prompt. The SAME label (e.g.
  // "LinkedIn") can appear as several leaves: a plain channel AND a REFERRAL
  // leaf that, once selected, mounts a NEW required "referred-by name / email"
  // field we cannot fill - that is the observed "must have a value" error. The
  // searched leaves are byte-identical (same text + data-automation-*), so the
  // correct one cannot be chosen up front. Strategy: try each matching leaf (then
  // follow-up-free fallback sources) and, after each pick, detect whether a NEW
  // required + empty field appeared. Keep the first pick that produces none. The
  // prompt is single-select, so choosing another leaf REPLACES the prior one and
  // unmounts its conditional follow-up - no manual de-select needed.

  // Non-referral fallbacks tried, in order, only when the profile value's leaves
  // all spawn a follow-up (or none match). pickOption's contains-match absorbs
  // tenant wording ("Job Board" -> "Job Boards", etc.).
  const SOURCE_FALLBACKS = [
    "Indeed",
    "Glassdoor",
    "Job Board",
    "Company Website",
    "Company Career Site",
    "Online",
    "Other",
  ];

  function isSourceField(container, label) {
    try {
      const id = (container.getAttribute && container.getAttribute("data-automation-id")) || "";
      if (/formField-source\b/i.test(id)) return true;
    } catch {}
    return /how did you hear|how.*hear about/i.test(label || "");
  }

  function sourceCandidates(primary) {
    const out = [];
    const seen = new Set();
    for (const v of [primary, ...SOURCE_FALLBACKS]) {
      const s = String(v || "").trim();
      const k = s.toLowerCase();
      if (s && !seen.has(k)) {
        seen.add(k);
        out.push(s);
      }
    }
    return out;
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

  // Commit ONE value into the source prompt using the ONLY sequence this
  // server-backed hierarchical prompt honors (confirmed on-tenant): open → wait
  // for the list → type → Enter (runs the search so the matching leaf surfaces &
  // highlights) → wait until the list filters → Enter again (confirms the
  // highlighted best match). A plain click on the typed list does NOT commit -
  // that was the bug that left the field empty while candidates cycled. A click
  // on the filtered option is kept only as a last-ditch fallback.
  async function selectSourceValue(multi, value) {
    const want = D.norm(value);
    const isChosen = () => promptChosen(multi, want);
    if (isChosen()) return true;
    const input = multi.querySelector("input");
    if (!input) return false;
    const opener = multi.querySelector('[data-automation-id="multiselectInputContainer"]') || input;

    for (let attempt = 0; attempt < 2; attempt++) {
      // 1. Open and WAIT until the prompt genuinely renders its list.
      D.clickEl(opener);
      input.focus();
      await D.waitFor(OPTION_SEL, 4000);
      await D.delay(200);

      // 2. Clear + type the value (fire input + a trailing keyup so debounced
      //    search boxes read input.value).
      input.focus();
      D.nativeSet(input, "");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      await D.delay(80);
      D.nativeSet(input, String(value));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
      const last = String(value).slice(-1) || "a";
      pressKey(input, last, "Key" + last.toUpperCase(), last.toUpperCase().charCodeAt(0));
      await D.delay(150);

      // 3. Enter #1 - run the search so the matching leaf surfaces.
      input.focus();
      pressEnter(input);

      // 4. WAIT until the list has filtered to our value, then Enter #2 - confirm
      //    the highlighted best match.
      await waitForFilteredOption(value, 3500);
      await D.delay(150);
      input.focus();
      if (document.activeElement !== input) D.clickEl(input);
      pressEnter(input);
      await D.delay(450);
      if (isChosen()) {
        await closePrompt(multi, input);
        return true;
      }

      // 5. Last-ditch fallback: click the exact/closest filtered option.
      if (await D.waitFor(OPTION_SEL, 1200)) {
        await D.delay(120);
        const match = pickOption(value);
        if (match) {
          D.clickEl(match);
          await D.delay(200);
        }
      }
      if (isChosen()) {
        await closePrompt(multi, input);
        return true;
      }
      await closePrompt(multi, input);
      await D.delay(200);
    }
    return isChosen();
  }

  async function fillSourcePrompt(multi, primaryValue, container) {
    // Recovery re-entry: never re-open a committed source prompt - re-opening
    // clears the prior selection (documented corruption path).
    if (multiSelectedText(container)) return true;

    const baselineKeys = visibleFormFieldKeys();
    for (const value of sourceCandidates(primaryValue)) {
      const chosen = await selectSourceValue(multi, value);
      if (!chosen) continue; // value not offered by this tenant - try the next
      await D.delay(200);
      const followups = newRequiredEmptyFollowups(baselineKeys);
      if (!followups.length) {
        try {
          WD.log(`source: '${value}' selected cleanly (no required follow-up)`);
        } catch {}
        return true;
      }
      // Referral-type leaf: it spawned an unfillable required "name/email" field.
      // The next candidate's selection replaces this one (single-select prompt)
      // and unmounts the follow-up, so just move on to a follow-up-free source.
      try {
        WD.log(`source: '${value}' triggered required follow-up ${JSON.stringify(followups)} - trying next`);
      } catch {}
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

  function clickInputOrLabel(input) {
    if (!input) return;
    let lbl = null;
    if (input.id) {
      try {
        lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      } catch {}
    }
    if (!lbl) lbl = input.closest("label");
    D.clickEl(lbl || input);
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
    const raw = String(value);
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
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    if (radios.length) return pickRadio(radios, value);
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
    const checks = [...container.querySelectorAll('input[type="checkbox"]')];
    if (checks.length) {
      // A single boolean checkbox ("I agree", "I certify") toggles by yes/no/true.
      if (checks.length === 1 && /^(yes|no|true|false|on|off|1|0)$/i.test(String(value))) {
        const on = value === true || /^(yes|true|on|1)$/i.test(String(value));
        if (!!checks[0].checked !== on) clickInputOrLabel(checks[0]);
        return true;
      }
      // A checkbox GROUP (pick one, e.g. disability self-ID) - check the box whose
      // label matches the resolved value and leave the others unchecked.
      const target = pickByLabel(checks, value);
      if (target) {
        if (!target.checked) clickInputOrLabel(target);
      return true;
      }
      return false;
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
    if (/please check one of the boxes|cc-305|self.identif/i.test(low)) return true;
    // Require disability self-ID phrasing — bare "disability" alone is too broad.
    if (isDisabilitySelfIdLabel(low)) return true;
    const inputs = [...container.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    if (inputs.length < 2 || inputs.length > 5) return false;
    const blob = inputs.map((el) => labelForInput(el)).join(" ").toLowerCase();
    return /disability|do not want to answer/.test(blob);
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
    const exact = exactOption(raw, options);
    if (exact) return exact;
    const listed = matchOptionFromList(raw, options);
    if (listed) return listed;
    const soft = (options || []).find((o) => !isPlaceholderOption(o) && valueMatchesWant(o, raw));
    return soft || null;
  }

  // Profile fact to hint the LLM (country, phone type, how-did-you-hear, …).
  // Screening Yes/No is NOT invented here — the model picks from live options.
  function profileWantForField(key, label, profile, valueByKey) {
    if (key && Object.prototype.hasOwnProperty.call(valueByKey, key) && valueByKey[key] != null && valueByKey[key] !== "") {
      return String(valueByKey[key]);
    }
    const e = (profile && profile.eeo) || {};
    const low = (label || "").toLowerCase();
    if (/hispanic or latino/.test(low) && e.hispanicLatino != null) return e.hispanicLatino ? "Yes" : "No";
    if (/\bgender\b|\bsex\b/.test(low) && e.gender) return String(e.gender);
    if (/sexual orientation|lgbtq/.test(low)) return String(e.sexualOrientation || "I don't wish to answer");
    if (/what is your race|race\/ethnicity|ethnicity|\brace\b/.test(low) && e.ethnicity) return String(e.ethnicity);
    if (/\bveteran\b/.test(low) && e.veteran != null) return e.veteran ? "veteran" : "not a veteran";
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

  async function fillStep(profile, options, rep) {
    options = options || {};
    const onlyInvalid = Array.isArray(options.onlyInvalid) ? options.onlyInvalid : null;
    throwIfAborted();
    // Wait briefly for the step to render its controls. After navigation (e.g.
    // Voluntary Disclosures → Self Identify), filling too early finds nothing -
    // which is exactly how Self Identify ended up blank. Skip the wait the instant
    // any formField / checkbox / radio is present (so populated steps aren't slowed).
    for (
      let i = 0;
      i < 16 &&
      D.qa('[data-automation-id^="formField-"]').filter(D.isVisible).length === 0 &&
      D.qa('input[type="checkbox"], input[type="radio"]').filter(D.isVisible).length === 0;
      i++
    ) {
      await D.delay(250);
    }
    const valueByKey = buildValueMap(profile);
    const containers = D.qa('[data-automation-id^="formField-"]').filter(D.isVisible);
    const llmTargets = [];
    const decisions = { skip: 0, deferLlm: 0, write: 0, experience: 0 };
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
      // Delegate all Work Experience / Education panel fields to fillExperienceExtras.
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
      // Already failed this attempt — do not re-open widgets on recovery passes.
      // EXCEPTION: onlyInvalid + still aria-invalid must be allowed to re-commit.
      // Otherwise a prior false openAndPick / LLM miss permanently skips the field
      // while the UI may already show "No" (CrowdStrike accommodation — panel
      // Couldn't resolve + Application Questions 0 filled).
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
          if (WD.aa) {
            WD.aa("fillStep bypass-failed-skip", { key: key.slice(0, 40), labelHead });
          }
        } catch {}
      }
      // CC-305 disability is handled exclusively by fillDisabilitySelfId (label click).
      // Must NOT swallow interview Acknowledgment listboxes (label contains "disability").
      if (isDisabilityContainer(c, label)) {
        if (/acknowledg|generative\s*ai|personally participate/i.test(label || "")) {
          try {
            WD.warn("ACK TRACE unexpectedly classified as disability container — check isDisabilityContainer", {
              labelHead: (label || "").slice(0, 120),
            });
          } catch {}
        }
        skipLog("isDisabilityContainer");
        continue;
      }

      // Recovery re-entry: Workday often leaves aria-invalid=true until the next
      // Save even after a successful write. Re-opening How Did You Hear / State
      // prompts in that window clears the first good selection. Skip rewrite when
      // committed — EXCEPT simple listboxes that are STILL aria-invalid.
      if (onlyInvalid && fieldHasCommittedValue(c)) {
        const stillInvalid = !!c.querySelector('[aria-invalid="true"]');
        const simpleList =
          !!listboxTrigger(c) && !c.querySelector('[data-automation-id="multiSelectContainer"]');
        if (!(stillInvalid && simpleList)) {
          record(rep, label || key, true);
          skipLog("onlyInvalid+committed-skip-rewrite", { stillInvalid, simpleList });
          continue;
        }
      }

      // ── Option controls: ALWAYS harvest options → LLM returns exact option ──
      // Do NOT apply resolveByLabel predefined Yes/No/EEO strings to listboxes.
      if (isOptionBearingContainer(c)) {
        const want = profileWantForField(key, label, profile, valueByKey);
        llmTargets.push({
          container: c,
          key,
          label: label || fieldLabel(c) || key,
          required: isRequired(c),
          want: want || undefined,
        });
        decisions.deferLlm += 1;
        try {
          if (WD.aa) {
            WD.aa("fillStep DEFER-LLM", {
              key: key.slice(0, 40),
              labelHead,
              required: isRequired(c),
              want: want || null,
              ariaInvalid: !!c.querySelector('[aria-invalid="true"]'),
              shown: (() => {
                const t = listboxTrigger(c);
                return t ? String(selectDisplayValue(t) || triggerCurrentValue(t) || "").slice(0, 40) : null;
              })(),
            });
          }
        } catch {}
        continue;
      }

      // ── Text / date / textarea: profile keys + label rules (not option lists) ──
      let value = key in valueByKey ? valueByKey[key] : undefined;
      if (value === undefined) value = resolveByLabel(label, profile);
      // Any unmapped date widget (e.g. the Self-Identify signature date) defaults
      // to today - the form expects the current date, never a profile value.
      if ((value === undefined || value === null || value === "") && isDateContainer(c)) {
        value = todayDate();
      }
      const interesting = isRequired(c) || !!(label && /\?/.test(label));
      if (value === undefined || value === null || value === "") {
        if (interesting) {
          llmTargets.push({ container: c, key, label: label || fieldLabel(c), required: isRequired(c) });
          decisions.deferLlm += 1;
          try {
            if (WD.aa) WD.aa("fillStep DEFER-LLM text", { key: key.slice(0, 40), labelHead, reason: "no-profile-value" });
          } catch {}
        } else {
          skipLog("no-value-not-interesting");
        }
        continue;
      }
      decisions.write += 1;
      try {
        if (WD.aa) {
          WD.aa("fillStep WRITE", {
            key: key.slice(0, 40),
            labelHead,
            valueHead: String(value).slice(0, 60),
          });
        }
      } catch {}
      const ok = await writeField(c, value, label || key);
      try {
        if (WD.aa) WD.aa("fillStep WRITE result", { key: key.slice(0, 40), labelHead, ok });
      } catch {}
      if (ok === false && interesting) {
        llmTargets.push({ container: c, key, label, required: isRequired(c), want: value });
        decisions.deferLlm += 1;
      } else {
        record(rep, label || key, ok);
        if (ok === false) rememberFailedField(key, label);
      }
      await D.delay(60);
    }
    // Self-ID / voluntary: fill disability before LLM so we never round-trip for it.
    if (onSelfIdOrVoluntaryPage()) {
      await fillDisabilitySelfId(profile, rep);
    }
    try {
      if (WD.aa) {
        WD.aa("fillStep → LLM", {
          decisions,
          count: llmTargets.length,
          labels: llmTargets.map((t) => String(t.label || t.key || "").slice(0, 80)),
        });
      }
    } catch {}
    // Layer 2: harvest options + LLM picks exact option text for every target.
    await resolveUnmatchedWithLLM(llmTargets, rep, profile);
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
    // Disability Self-ID lives outside the formField wrappers - reassert after LLM.
    await fillDisabilitySelfId(profile, rep);
  }

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
  async function harvestPortalOptions(btn) {
    await closeAllListboxes();
    const popup = await openListboxForOptions(btn);
    if (!popup) {
      try {
        WD.warn("harvestPortalOptions: portal did not open", btn && (btn.id || btn.getAttribute("aria-label")));
      } catch {}
      return { options: [], portalHtml: "", listboxId: null };
    }
    await D.delay(100);
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
    const options = readPortalOptionRows(popup);
    pressKey(btn, "Escape", "Escape", 27);
    await D.delay(120);
    if (openedListbox(btn) || btn.getAttribute("aria-expanded") === "true") {
      focusSinkOutside(btn.ownerDocument || document);
      await D.delay(100);
    }
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
            label: it.label,
            want: it.want,
            kind: it.kind,
            required: it.required,
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

  // Open a multiselect search prompt, read its currently-visible options, close.
  // Used to hand the LLM a candidate list for an unmatched prompt field.
  async function harvestMultiOptions(multi) {
    const input = multi.querySelector("input");
    if (!input) return [];
    const opener = multi.querySelector('[data-automation-id="multiselectInputContainer"]') || input;
    D.clickEl(opener);
    input.focus();
    let opts = [];
    if (await D.waitFor(OPTION_SEL, 1500)) {
      await D.delay(120);
      opts = visibleOptions().map((o) => (o.textContent || "").replace(/\s+/g, " ").trim());
    }
    await closePrompt(multi, input);
    const seen = new Set();
    const uniq = [];
    for (const o of opts) {
      const k = o.toLowerCase();
      if (o && !seen.has(k)) {
        seen.add(k);
        uniq.push(o);
      }
    }
    return uniq.slice(0, 60);
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
    if (multi) return { kind: "select", options: await harvestMultiOptions(multi) };
    const btn = listboxTrigger(container);
    if (btn) {
      await closeAllListboxes();
      let harvested = await harvestPortalOptions(btn);
      if (!(harvested.options && harvested.options.length)) {
        try {
          WD.warn("classifyControl: 0 portal options — retrying", fieldLabel(container));
        } catch {}
        await D.delay(250);
        harvested = await harvestPortalOptions(btn);
      }
      const label = fieldLabel(container);
      let options = (harvested.options || []).map((o) => o.text);
      if (!optionsPlausibleForLabel(label, options) && options.length) {
        try {
          WD.warn("implausible options for", label, "- re-harvesting", options);
        } catch {}
        await closeAllListboxes();
        await D.delay(200);
        harvested = await harvestPortalOptions(btn);
        options = (harvested.options || []).map((o) => o.text);
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
    const needLlm = [];
    for (const item of items) {
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
      const ok = await D.attachFile(AID("file-upload-input-ref"), resumeFile);
      try {
        WD.log(`resume upload result: attached=${ok} removedExisting=${removed} inputPresentAtStart=${inputPresent}`);
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
  };
  // Build marker: if this line is NOT in the console on a run, the tab is running
  // a STALE engine (reload the extension at chrome://extensions, then hard-reload
  // the Workday page).
  try {
    WD.log("wd-steps build: 2026-08-05-aa-full-trace-v1");
    try {
      if (WD.aa) WD.aa("engine-build", { build: "2026-08-05-aa-full-trace-v1", href: location.href });
    } catch {}
  } catch {}
})();
