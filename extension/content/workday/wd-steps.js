// Workday engine — field discovery + control-aware writing + value resolution.
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
    if (!clean(t)) t = container.getAttribute("aria-label") || "";
    return clean(t);
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
  // "https://linkedin.com/in/x" — it requires the canonical "www.linkedin.com"
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
    // Bare handle (e.g. "kzwang" or "in/kzwang") — build the profile URL.
    v = v.replace(/^@/, "").replace(/^in\//i, "");
    return "https://www.linkedin.com/in/" + v;
  }

  // Strip Markdown so a plain-text form field (Workday Role Description) never
  // shows readme markup like **bold**. Mirrors the backend sanitizer and is
  // applied client-side too, so the field is clean regardless of the profile
  // source. Keeps line breaks and "- " bullets; preserves lone */_ (e.g. the
  // identifier feature_store) — only PAIRED **/__/` are removed.
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
      // Social Network URLs (My Experience page) — keyed by the formField id.
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

  // Known company / EEO questions resolved by label text (the part of the hybrid
  // that doesn't depend on a stable key). Returns undefined when no rule matches.
  function resolveByLabel(label, p) {
    if (!label) return undefined;
    const e = p.eeo || {};
    const nm = p.name || {};
    const fullName = [nm.first, nm.last].filter(Boolean).join(" ").trim();
    const RULES = [
      // Self-Identify (CC-305) "Name" — a standalone full-name field. The keyed
      // legalName--first/last fields are resolved by buildValueMap and never reach
      // here, and "Preferred/Legal Name" labels won't match the strict ^name$.
      [/^name$/i, fullName],
      // Order-independent: catches "previously been employed", "been employed by
      // <Company> previously", "ever worked for", "worked here before", etc. Note:
      // no \b after employ/work — "employ" must match the stem in "employed".
      [/(previously|formerly|prior|before|ever)[\s\S]{0,40}?(employ|work)/i, "No"],
      [/(employ|work)[\s\S]{0,40}?(previously|formerly|prior|before)/i, "No"],
      [/legally (eligible|authorized) to work|authorized to work/i, "Yes"],
      [/require sponsorship|sponsorship for (a )?work visa|need sponsorship/i, "No"],
      [/will you now or in the future require/i, "No"],
      [/at least 18|18 years of age/i, "Yes"],
      [/non-disclosure|non-compete|non-competitive|restrict your employment/i, "No"],
      [/hispanic or latino/i, e.hispanicLatino ? "Yes" : "No"],
      [/gender/i, e.gender],
      [/what is your race|race\/ethnicity|ethnicity|\brace\b/i, e.ethnicity],
      [/veteran/i, e.veteran ? "I am a veteran" : "I am not a protected veteran"],
      [/disab/i, e.disability ? "Yes" : "No, I do not have a disability"],
    ];
    for (const [re, val] of RULES) {
      if (re.test(label) && val != null && val !== "") return val;
    }
    return undefined;
  }

  // ── control-aware writers ───────────────────────────────────────────────────
  // ROOT CAUSE (proven on the live page via the [workday] textfill diagnostic:
  // `pageHadFocus=false focusLanded=true` for every text field): autofill runs from
  // the extension SIDE PANEL, which holds OS focus, so the Workday page does NOT
  // have system focus (document.hasFocus() === false). el.focus() still sets
  // document.activeElement (focusLanded=true), BUT browsers do NOT dispatch
  // focus/blur/focusout events while the document lacks system focus — so when we
  // move focus to the sink, the input's `focusout` never fires and Workday's
  // onBlur commit handler never runs. The value stays in the DOM property only and
  // the field keeps `aria-invalid="true"`. window.focus() canNOT pull system focus
  // away from the side panel (the log still shows pageHadFocus=false). The ONLY
  // thing that gives the page real focus is a genuine user interaction in the page.
  // → So we set the visible value now and DEFER the commit until the page regains
  //   real focus (the user clicking anywhere on the form, e.g. Save and Continue).
  function setReactValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const prev = el.value;
    setter.call(el, String(value));
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

  // Controlled inputs (text, textarea, AND the date month/year spin-inputs) whose
  // value is set but NOT yet committed because the page lacked system focus at
  // fill time. Each item re-asserts its value(s) then chains focus across its
  // inputs and finally to a sink, producing a real focusout per input so
  // Workday's onBlur commit + validation runs. Flushed the instant the page
  // regains real focus (the user's first click on the form — even on Save).
  // Shared on WD so a module reinstall reuses the same queue + single listener:
  // the (one) armed listener closes over this same array, so commits queued by
  // freshly-installed code are still flushed by the original listener.
  const pendingCommits = (WD._pendingCommits = WD._pendingCommits || []);

  function commitItem(item, sink) {
    item.applyValue();
    for (const el of item.els) {
      if (el && el.isConnected) {
        try {
          el.focus({ preventScroll: true });
        } catch {}
      }
    }
    try {
      sink.focus({ preventScroll: true }); // focusout of the last input → commit
    } catch {}
  }

  function flushCommits() {
    if (!document.hasFocus() || !pendingCommits.length) return;
    const sink = makeSink(document);
    for (const item of pendingCommits.splice(0)) {
      try {
        commitItem(item, sink);
      } catch {}
    }
    sink.remove();
  }

  function armFocusFlush() {
    if (WD._focusFlushArmed) return;
    WD._focusFlushArmed = true;
    // window 'focus' fires synchronously when the user clicks into the page,
    // BEFORE the click's default action — so even clicking "Save and Continue"
    // commits the values first. pointerdown is a capture-phase backstop.
    window.addEventListener("focus", flushCommits, true);
    document.addEventListener("pointerdown", flushCommits, true);
  }

  // Set a controlled input's value now (so it's visible) and ensure it COMMITS.
  // applyValue() must (re)assign the value(s) + dispatch input/change; els are the
  // inputs that need a focusout to commit. If the page has real focus we commit
  // immediately; otherwise defer to the next genuine page focus.
  async function deferOrCommit(applyValue, els) {
    applyValue();
    if (document.hasFocus()) {
      const sink = makeSink(document);
      for (const el of els) {
        if (el && el.isConnected) {
          try {
            el.focus({ preventScroll: true });
          } catch {}
        }
      }
      sink.focus({ preventScroll: true });
      await D.delay(50);
      sink.remove();
    } else {
      pendingCommits.push({ applyValue, els });
      armFocusFlush();
    }
  }

  async function writeTextEl(el, value) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus({ preventScroll: true });
    const applyValue = () => {
      setReactValue(el, value);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: String(value) }),
      );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await deferOrCommit(applyValue, [el]);
    return true;
  }

  function visibleOptions(root) {
    return D.qa(OPTION_SEL, root).filter(D.isVisible);
  }
  function pickOption(want, root) {
    const w = D.norm(want);
    const scored = visibleOptions(root)
      .map((o) => ({ o, t: D.norm(o.textContent) }))
      .filter((x) => x.t);
    // 1. Exact text match always wins.
    const exact = scored.find((x) => x.t === w);
    if (exact) return exact.o;
    // 2. Options whose text CONTAINS the wanted value — pick the SHORTEST so a
    //    prefix like "united states" resolves to "united states of america", not
    //    the longer "united states minor outlying islands" that happens to sort
    //    first in the list.
    const contains = scored.filter((x) => x.t.includes(w)).sort((a, b) => a.t.length - b.t.length);
    if (contains.length) return contains[0].o;
    // 3. Wanted value contains the option text — pick the LONGEST (most specific).
    const within = scored.filter((x) => w.includes(x.t)).sort((a, b) => b.t.length - a.t.length);
    if (within.length) return within[0].o;
    return null;
  }

  // The overlay a single-select button just opened. Workday renders the popup in
  // a portal (not inside the field wrapper), so we locate it via the ARIA contract
  // (aria-controls / aria-owns) and fall back to the visible list container. This
  // is the anchor that scopes the search box + option lookups — without it, a
  // document-wide input query grabs the always-present, page-top "How Did You Hear
  // About Us?" multiselect and types THIS field's value into it.
  function openedListbox(btn) {
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
    if (!el) {
      const lists = D.qa('[data-automation-id="activeListContainer"], [role="listbox"]').filter(D.isVisible);
      el = lists.length ? lists[lists.length - 1] : null;
    }
    if (!el) return null;
    // Prefer the overlay container that wraps BOTH the search box and the options.
    return el.closest('[data-automation-id="activeListContainer"]') || el;
  }

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

  // Single-select: click the button, type into the search box scoped to the
  // popup this button opened (long lists are virtualized + filtered), then click
  // the matching promptOption. All lookups are confined to that popup so we never
  // write into another field's input.
  async function openAndPick(btn, value) {
    if (D.norm(btn.textContent) === D.norm(value)) return true; // already set
    D.clickEl(btn);
    await D.delay(150);
    let popup = openedListbox(btn);
    for (let i = 0; i < 12 && !popup; i++) {
      await D.delay(80);
      popup = openedListbox(btn);
    }
    const search = popup
      ? popup.querySelector('input[data-automation-id="searchBox"], input[type="search"], input[type="text"]')
      : null;
    if (search && D.isVisible(search)) {
      search.focus();
      D.nativeSet(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await D.delay(400);
    }
    if (!(await D.waitFor(OPTION_SEL, 2000, popup || undefined))) {
      await closeListbox(btn);
      return false;
    }
    await D.delay(120);
    const match = pickOption(value, popup || undefined);
    if (match) {
      D.clickEl(match);
      await D.delay(120);
      return true;
    }
    // No matching option — close so we don't leave an open popup that corrupts
    // the next interaction (e.g. the LLM-fallback harvest of this same control).
    await closeListbox(btn);
    return false;
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
  // non-null relatedTarget) fires — a bare input.blur() (relatedTarget=null) is
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
    const isChosen = () => {
      const sel = multi.querySelector('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"]');
      return !!(sel && D.norm(sel.textContent).includes(want));
    };
    if (isChosen()) return true;

    const input = multi.querySelector("input");
    if (!input) return false;

    // Open the prompt — the search box is minimized until the field is activated.
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
    // leaf as a clickable option — click it, then close the still-open list.
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
    // itself is focused — so refocus it (and re-assert the typed value) first.
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

    // After Enter the matching leaf may render as a result — click it as a fallback.
    if (await D.waitFor(OPTION_SEL, 1500)) {
      await D.delay(120);
      match = pickOption(value);
      if (match) {
        D.clickEl(match);
        await D.delay(150);
      }
    }
    const ok = isChosen();
    if (ok) await closePrompt(multi, input);
    return ok;
  }

  // True once a currently-visible option's text matches `want` (either direction),
  // i.e. the server-backed list has FINISHED filtering to our query. Polls so we
  // never press Enter against a stale, unfiltered list.
  async function waitForFilteredOption(want, ms) {
    const w = D.norm(want);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = visibleOptions().some((o) => {
        const t = D.norm(o.textContent);
        return t && (t === w || t.includes(w) || w.includes(t));
      });
      if (hit) return true;
      await D.delay(120);
    }
    return false;
  }

  // Field of Study (and similar large, server-backed search prompts) must be
  // driven in a strict order, proven by DOM evidence: clicking + typing within
  // ~150ms loads the prompt's DEFAULT unfiltered list AFTER our text, discarding
  // the query (search box shows the text, list stays A→Z). So: open → WAIT until
  // the list actually renders → type so the initialized search filters → WAIT for
  // the filtered result → press Enter to commit the highlighted best match.
  async function fillSearchPrompt(multi, value) {
    const want = D.norm(value);
    const isChosen = () => {
      const sel = multi.querySelector('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"]');
      return !!(sel && D.norm(sel.textContent).includes(want));
    };
    if (isChosen()) return true;
    const input = multi.querySelector("input");
    if (!input) return false;
    const opener = multi.querySelector('[data-automation-id="multiselectInputContainer"]') || input;

    for (let attempt = 0; attempt < 2; attempt++) {
      // 1. Open and WAIT until the prompt is genuinely open (its list renders).
      D.clickEl(opener);
      input.focus();
      await D.waitFor(OPTION_SEL, 4000);
      await D.delay(250);

      // 2. Type into the now-initialized search so it filters. Clear first, then
      //    set the value and fire input + a trailing keyup (some search debounces
      //    read input.value on keyup) to trigger the server query.
      input.focus();
      D.nativeSet(input, "");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      await D.delay(80);
      D.nativeSet(input, String(value));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
      const last = String(value).slice(-1) || "a";
      pressKey(input, last, "Key" + last.toUpperCase(), last.toUpperCase().charCodeAt(0));

      // 3. WAIT until the list has actually filtered to our value.
      await waitForFilteredOption(value, 3500);
      await D.delay(150);

      // 4. Press Enter to select the highlighted best match (search input must be
      //    focused for Workday to run search-and-select).
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

      // 5. Fallback: click the exact/closest filtered option directly.
      if (await D.waitFor(OPTION_SEL, 1200)) {
        await D.delay(120);
        const match = pickOption(value);
        if (match) {
          D.clickEl(match);
          await D.delay(180);
        }
      }
      if (isChosen()) {
        await closePrompt(multi, input);
        return true;
      }
      // Not committed — close and retry the whole sequence once.
      await closePrompt(multi, input);
      await D.delay(200);
    }
    return isChosen();
  }

  function pickRadio(radios, value) {
    const want = D.norm(value);
    for (const r of radios) {
      const lt = D.norm(labelForInput(r));
      if (lt && (lt === want || (want === "yes" && lt === "yes") || (want === "no" && lt === "no"))) {
        D.clickEl(r);
        return true;
      }
    }
    for (const r of radios) {
      if (D.norm(r.value) === want) {
        D.clickEl(r);
        return true;
      }
    }
    // "I am not a protected veteran" / "No, I do not have a disability" style.
    for (const r of radios) {
      const lt = D.norm(labelForInput(r));
      if ((want.startsWith("no") && lt.startsWith("no")) || (want.startsWith("i am not") && lt.includes("not"))) {
        D.clickEl(r);
        return true;
      }
    }
    return false;
  }

  async function selectNativeEl(sel, value) {
    for (let i = 0; i < 20 && sel.options.length < 2; i++) await D.delay(100);
    const want = D.norm(value);
    const scored = [...sel.options].map((o) => ({ o, t: D.norm(o.text) })).filter((x) => x.t);
    const contains = scored.filter((x) => x.t.includes(want)).sort((a, b) => a.t.length - b.t.length);
    const opt =
      (scored.find((x) => x.t === want) || contains[0] || { o: null }).o;
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
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
    // Workday commits them via the onKeyDown digit handler, NOT onInput/onChange —
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
  async function writeField(container, value) {
    if (value == null || value === "") return null;
    const multi = container.querySelector('[data-automation-id="multiSelectContainer"]');
    if (multi) return await fillMultiselect(multi, value);
    const btn = container.querySelector('button[aria-haspopup="listbox"]');
    if (btn) return await openAndPick(btn, value);
    const nativeSel = container.querySelector("select");
    if (nativeSel) return await selectNativeEl(nativeSel, value);
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    if (radios.length) return pickRadio(radios, value);
    if (isDateContainer(container)) {
      return await fillDateContainer(container, value);
    }
    const text = container.querySelector(
      'input[type="text"]:not(.css-77hcv), textarea, input[type="tel"], input[type="number"], input:not([type])',
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
        if (!!checks[0].checked !== on) D.clickEl(checks[0]);
        return true;
      }
      // A checkbox GROUP (pick one, e.g. disability self-ID) — check the box whose
      // label matches the resolved value and leave the others unchecked.
      const target = pickByLabel(checks, value);
      if (target) {
        if (!target.checked) D.clickEl(target);
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
  // visually hidden behind a styled box — so the generic formField pass never
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
      console.warn(`[workday] disability self-ID -> '${target.t}' checked=${target.el.checked}`);
    } catch {}
    record(rep, "Disability self-identification", !!target.el.checked);
  }

  // ── generic step filler (My Information, Voluntary, Questions) ───────────────
  async function fillStep(profile, _options, rep) {
    // Wait briefly for the step to render its controls. After navigation (e.g.
    // Voluntary Disclosures → Self Identify), filling too early finds nothing —
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
    for (const c of containers) {
      const aid = c.getAttribute("data-automation-id") || "";
      const key = aid.replace(/^formField-/, "");
      const label = fieldLabel(c);
      let value = key in valueByKey ? valueByKey[key] : undefined;
      if (value === undefined) value = resolveByLabel(label, profile);
      // Any unmapped date widget (e.g. the Self-Identify signature date) defaults
      // to today — the form expects the current date, never a profile value.
      if ((value === undefined || value === null || value === "") && isDateContainer(c)) {
        value = todayDate();
      }
      const interesting = label && (isRequired(c) || /\?/.test(label));
      if (value === undefined || value === null || value === "") {
        // Defer to the LLM for things a human should look at: required fields or
        // actual questions. Skip optional niceties (middle name, extension, …).
        if (interesting) llmTargets.push({ container: c, key, label, required: isRequired(c) });
        continue;
      }
      const ok = await writeField(c, value);
      // A deterministic value that does NOT match this tenant's actual options
      // fails to apply (e.g. veteran "I am not a protected veteran" when the
      // options say "I AM NOT A VETERAN"). Route those to the LLM, which harvests
      // the real options and picks the truthful one — rather than leaving it empty.
      if (ok === false && interesting) {
        llmTargets.push({ container: c, key, label, required: isRequired(c) });
      } else {
      record(rep, label || key, ok);
      }
      await D.delay(60);
    }
    // Layer 2: resolve everything the deterministic layer missed via the LLM.
    await resolveUnmatchedWithLLM(llmTargets, rep);
    // Disability Self-ID lives outside the formField wrappers — handle it last so
    // it is authoritative over anything the generic/LLM passes may have touched.
    await fillDisabilitySelfId(profile, rep);
  }

  // ── My Experience: repeating Work Experience + Education panels ──────────────
  // Panels do not exist until "Add" is clicked, so the generic formField pass
  // never sees them. We add exactly as many as the profile needs (idempotent —
  // re-running never duplicates), then fill each panel SCOPED to its own root so
  // entries never cross-contaminate. Every text/date field commits through the
  // deferOrCommit path, so a later "Save and Continue" never reports them empty.
  function sectionGroupByLabel(labelId) {
    return D.qa(`[role="group"][aria-labelledby="${labelId}"]`).find(D.isVisible) || null;
  }
  // Locate panels by their STABLE per-entry group label — "Work-Experience-1-panel",
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
  // visible text "Delete" INSIDE the panel group (proven via console — no stable
  // automation-id, so match by text). The attachment "delete-file" buttons live
  // OUTSIDE any panel group and are excluded by scoping to the panel root.
  function panelDeleteButton(root) {
    return D.qa("button", root).find((b) => /^\s*delete\s*$/i.test(b.textContent || "")) || null;
  }
  // Some tenants pop a confirmation dialog after clicking Delete — confirm it if
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
        try { console.warn(`[workday] surplus delete ${panelLabelPrefix}: no Delete button on last panel — stopping`); } catch {}
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
      try { console.warn(`[workday] surplus delete ${panelLabelPrefix}: ${before} -> ${panels.length} (${shrank ? "removed" : "NO CHANGE, stopping"})`); } catch {}
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
      console.warn(`[workday] ensurePanels ${panelLabelPrefix}: settled at ${settled}/${needed} before adding`);
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
        try { console.warn(`[workday] ensurePanels ${panelLabelPrefix}: have ${before}/${needed}, NO add-button found — stopping`); } catch {}
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
      try { console.warn(`[workday] ensurePanels ${panelLabelPrefix}: ${before}/${needed} -> ${panels.length} in ${Date.now() - t0}ms (${grew ? "added" : "NO GROWTH, stopping"})`); } catch {}
      if (!grew) break; // could not add another — stop safely rather than loop
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
    if (c) record(rep, label, await writeField(c, value));
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
  // PDF — which still carries **markdown** — clobbering our text AFTER we set it.
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
          try { console.warn(`[workday] role descriptions clean & stable after ${attempt + 1} pass(es)`); } catch {}
          return;
        }
      }
    }
    try { console.warn("[workday] role descriptions: re-assert loop exhausted (parser still fighting)"); } catch {}
  }

  async function fillEducationNonDegree(root, entry, n, rep) {
    if (!entry) return;
    await fillPanelField(root, "schoolName", entry.school, rep, `Edu ${n} School`);
    // Field of Study is a large server-backed search prompt that must be driven in
    // a strict open → wait → type → wait → Enter order (see fillSearchPrompt), so
    // it bypasses the generic fillMultiselect path. Filled inline per panel.
    if (entry.fieldOfStudy) {
      const fos = panelField(root, "fieldOfStudy");
      const fosMulti = fos && fos.querySelector('[data-automation-id="multiSelectContainer"]');
      if (fosMulti) {
        record(rep, `Edu ${n} Field of Study`, await fillSearchPrompt(fosMulti, entry.fieldOfStudy));
      }
    }
    await fillPanelField(root, "gradeAverage", entry.gpa, rep, `Edu ${n} GPA`);
    await fillPanelField(root, "firstYearAttended", entry.startMMYYYY, rep, `Edu ${n} From`);
    await fillPanelField(root, "lastYearAttended", entry.endMMYYYY, rep, `Edu ${n} To`);
  }

  // Degree is a fixed Workday dropdown. We open it to harvest the exact option
  // strings, then (asynchronously) ask the LLM — via the side panel + backend —
  // to map the candidate's profile degree to the best option, while the rest of
  // the page fills. A local fuzzy pick is the fallback if the LLM is unavailable.
  function degreeButton(root) {
    const c = panelField(root, "degree");
    return c ? c.querySelector('button[aria-haspopup="listbox"]') : null;
  }
  async function harvestOptions(btn) {
    // Only click to OPEN when it isn't already open — clicking an open dropdown
    // toggles it CLOSED, which would harvest zero options.
    if (!openedListbox(btn)) {
      D.clickEl(btn);
      await D.delay(150);
    }
    let popup = openedListbox(btn);
    for (let i = 0; i < 15 && !popup; i++) {
      await D.delay(80);
      popup = openedListbox(btn);
    }
    let opts = [];
    if (popup && (await D.waitFor(OPTION_SEL, 1500, popup))) {
      opts = visibleOptions(popup).map((o) => (o.textContent || "").replace(/\s+/g, " ").trim());
    }
    // Close the listbox (single-selects close on Escape); sink-blur as a backup.
    pressKey(btn, "Escape", "Escape", 27);
    await D.delay(120);
    if (openedListbox(btn)) focusSinkOutside(btn.ownerDocument || document);
    await D.delay(100);
    const seen = new Set();
    const uniq = [];
    for (const o of opts) {
      const k = o.toLowerCase();
      if (o && !seen.has(k)) {
        seen.add(k);
        uniq.push(o);
      }
    }
    return uniq;
  }
  // The option whose text is exactly the candidate's value (case/space-insensitive),
  // or null. An exact match is authoritative — it must NOT be overridden by the LLM.
  function exactOption(want, options) {
    const w = D.norm(want);
    if (!w || !options) return null;
    return options.find((o) => D.norm(o) === w) || null;
  }
  // Deterministic fallback: prefer exact text, else the option sharing the most
  // word tokens with the candidate's field, else the first candidate.
  function bestLocalMatch(want, options) {
    if (!options || !options.length) return want;
    const w = D.norm(want);
    const exact = options.find((o) => D.norm(o) === w);
    if (exact) return exact;
    const wt = new Set(w.split(/\s+/).filter(Boolean));
    let best = null;
    let bestScore = 0;
    for (const o of options) {
      const ot = D.norm(o).split(/\s+/).filter(Boolean);
      let s = 0;
      for (const t of ot) if (wt.has(t)) s++;
      if (s > bestScore) {
        bestScore = s;
        best = o;
      }
    }
    return best || options[0];
  }
  // Round-trip to the side panel (→ backend LLM) to map profile values to the
  // harvested options. Resolves to {} on any failure/timeout so filling never
  // blocks. The matching id is the source control's element id.
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
          })),
        });
        setTimeout(() => {
          delete WDw._waiters[requestId];
          finish({});
        }, 30000);
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
  // pick a real one. Returns null for controls we never send to the LLM (dates —
  // filled from the profile; file uploads — handled separately).
  async function classifyControl(container) {
    const btn = container.querySelector('button[aria-haspopup="listbox"]');
    if (btn) return { kind: "select", options: await harvestOptions(btn) };
    const multi = container.querySelector('[data-automation-id="multiSelectContainer"]');
    if (multi) return { kind: "select", options: await harvestMultiOptions(multi) };
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
      // One-of checkbox group (e.g. disability self-ID) — give the model the real
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

  // LLM fallback for fields the deterministic layer (buildValueMap + resolveByLabel)
  // could not map. Classify + harvest each control, round-trip ALL of them to the
  // backend LLM in one batch, then apply each answer with the control-aware
  // writeField. Anything the LLM declines (needs_user / no answer) stays in
  // rep.unmatched so the side panel flags it for manual review.
  async function resolveUnmatchedWithLLM(targets, rep) {
    if (!targets || !targets.length) return;
    const items = [];
    const byCid = new Map();
    let i = 0;
    for (const t of targets) {
      let info = null;
      try {
        info = await classifyControl(t.container);
      } catch {}
      if (!info) {
        rep.unmatched.push({ key: t.key, label: t.label });
        continue;
      }
      const cid = ((t.key || "field").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "f") + "_" + i++;
      byCid.set(cid, t);
      items.push({ cid, label: t.label, kind: info.kind, required: t.required, options: info.options });
      try {
        console.warn(`[workday] LLM fallback target '${t.label}' kind=${info.kind} options=${info.options.length}`, info.options);
      } catch {}
    }
    if (!items.length) return;
    let values = {};
    try {
      values = await requestOptionMatches(items);
    } catch {}
    for (const [cid, t] of byCid) {
      const value = values[cid];
      try {
        console.warn(`[workday] LLM fallback apply '${t.label}' <- ${value == null ? "(none)" : JSON.stringify(value)}`);
      } catch {}
      if (value == null || value === "") {
        rep.unmatched.push({ key: t.key, label: t.label }); // LLM declined / no answer
        continue;
      }
      const ok = await writeField(t.container, value);
      try { console.warn(`[workday] LLM fallback apply '${t.label}' result=${ok}`); } catch {}
      record(rep, t.label || cid, ok);
      await D.delay(60);
    }
  }

  // The resume widget keeps EVERY uploaded file as its own row, so re-running the
  // step (auto-advance recovery, or a prior step that already uploaded one) piles
  // up duplicates. Remove all currently-uploaded files in this widget — each row
  // is [data-automation-id="file-upload-item"] with its own
  // button[data-automation-id="delete-file"] (proven via the page DOM) — so that
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
    const resumeFile = options && options.resumeFile;
    try {
      const b = resumeFile && resumeFile.base64 ? resumeFile.base64.length : 0;
      console.warn(`[workday] resume upload: file=${resumeFile ? resumeFile.filename || "yes" : "MISSING (none downloaded)"} base64Len=${b}`);
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
        console.warn(`[workday] resume upload result: attached=${ok} removedExisting=${removed} inputPresentAtStart=${inputPresent}`);
      } catch {}
      record(rep, "Resume upload", ok);
    }

    const work = Array.isArray(profile.workExperience) ? profile.workExperience : [];
    const edu = Array.isArray(profile.education) ? profile.education : [];
    try {
      console.warn(`[workday] experience input: work=${work.length} edu=${edu.length} resumeSource=${profile.resumeSource}`);
    } catch {}

    // 1. Create exactly the needed panels (idempotent across re-runs). Workday
    //    allows multiple empty blocks (proven), so add them all up front.
    if (work.length) await ensurePanels("Work-Experience-section", "Work-Experience", work.length);
    if (edu.length) await ensurePanels("Education-section", "Education", edu.length);
    // Re-query live after the adds (the section node may have been replaced).
    const workPanels = panelRoots("Work-Experience").slice(0, work.length);
    const eduPanels = panelRoots("Education").slice(0, edu.length);
    try {
      console.warn(`[workday] experience panels: work=${workPanels.length}/${work.length} edu=${eduPanels.length}/${edu.length}`);
    } catch {}

    // 2. Harvest each education's Degree options and fire the LLM match request
    //    NOW (non-blocking) so it resolves while we fill everything else. (Field
    //    of Study is NOT harvested here — it is a free search prompt filled inline
    //    in step 3 by typing the exact value and pressing Enter.)
    const matchItems = [];
    for (let i = 0; i < eduPanels.length; i++) {
      const e = edu[i] || {};
      const n = i + 1;
      // Degree: a fixed dropdown — open it to read every option.
      if (e.degree) {
        const btn = degreeButton(eduPanels[i]);
        if (btn && btn.id) {
          const opts = await harvestOptions(btn);
          if (opts.length) {
            matchItems.push({ kind: "select", n, cid: btn.id, btn, want: e.degree, label: "Degree", options: opts });
          }
        }
      }
    }
    const matchPromise = matchItems.length ? requestOptionMatches(matchItems) : Promise.resolve({});

    // 3. Fill all the plain fields (work history + education text/dates/GPA +
    //    Field of Study via type-exact-then-Enter inside fillMultiselect).
    for (let i = 0; i < workPanels.length; i++) await fillWorkPanel(workPanels[i], work[i], i + 1, rep);
    for (let i = 0; i < eduPanels.length; i++) await fillEducationNonDegree(eduPanels[i], edu[i], i + 1, rep);

    // 4. Apply the resolved Degree. Precedence: an EXACT option match for the
    //    candidate's own value is authoritative (fill it verbatim — never let the
    //    LLM swap it for a merely "relevant" one). Only when there is no exact
    //    option do we defer to the LLM, falling back to local token-overlap.
    let chosen = {};
    try {
      chosen = await matchPromise;
    } catch {}
    for (const it of matchItems) {
      const value = exactOption(it.want, it.options) || chosen[it.cid] || bestLocalMatch(it.want, it.options);
      if (it.btn.isConnected) record(rep, `Edu ${it.n} Degree`, await openAndPick(it.btn, value));
    }

    // 5. Win the race against Workday's résumé parser: it re-fills Role Description
    //    from the uploaded PDF (possibly with markdown) AFTER we set it. Re-assert
    //    clean text until the parser stops clobbering it.
    await reassertWorkDescriptions(work);
  }

  // flush(): force any deferred text/date commits to run now. Auto-advance focuses
  // the page (real OS focus) before calling this so the focus-gated commit can fire.
  WD.steps = { fillStep, fillExperienceExtras, buildValueMap, resolveByLabel, fieldLabel, AID, isRequired, flush: flushCommits };
  // Build marker: if this line is NOT in the console on a run, the tab is running
  // a STALE engine (reload the extension at chrome://extensions, then hard-reload
  // the Workday page). markdown-strip is part of this build.
  try { console.warn("[workday] wd-steps build: 2026-06-21-md-strip+reinstall"); } catch {}
})();
