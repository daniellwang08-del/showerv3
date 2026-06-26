// Autofill content script - region picker + thin engine bridge.
//
// This file owns ONLY the on-page UX (hover overlay, click-to-select blocks)
// and chrome.runtime messaging. All detection/extraction/writing is delegated to
// the modular engine (window.__AF.engine), which dispatches to per-component
// drivers. Injected into every frame; idempotent via the guard below.
(() => {
  try {
    console.log("[autofill] picker.js build 2026-06-23r (ATJ: no Lever apply click)");
  } catch {}
  if (window.__JOB_AUTOFILL__) return;
  window.__JOB_AUTOFILL__ = true;

  const AF = window.__AF || {};
  const dom = AF.dom || {};
  const clean = dom.clean || ((s) => (s || "").replace(/\s+/g, " ").trim());
  const isVisible =
    dom.isVisible ||
    ((el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  const labelText = dom.labelText || ((el) => clean((el && (el.innerText || el.textContent)) || "").slice(0, 200));

  // SmartRecruiters builds every field from "spl-*" Lit web components whose real
  // <input>/<textarea> lives inside a declarative shadow root. The engine's
  // control collection and the dom label/cid resolvers consult this flag to walk
  // into those shadow roots. It returns true ONLY on a SmartRecruiters form, so
  // every other engine keeps its plain light-DOM behaviour untouched.
  AF.deepCollect = function deepCollect() {
    try {
      // SmartRecruiters renders the whole application with shadow-DOM web
      // components (spl-*/sr-*/oc-*). On the screening-questions step the fields
      // live inside <sr-screening-questions-form>'s shadow root, so a light-DOM
      // querySelector finds nothing - key off the host so shadow-piercing stays
      // enabled across every step, not just the personal-info step.
      if (/(^|\.)smartrecruiters\.com$/i.test(location.hostname)) return true;
      return !!document.querySelector("oc-oneclick-form, spl-input, spl-autocomplete, spl-date-field");
    } catch {
      return false;
    }
  };

  // handle -> selected block element
  const state = { picking: false, hoverEl: null, selected: new Map() };
  let box = null;
  let badge = null;

  // ── overlay ────────────────────────────────────────────────────────────
  function ensureOverlay() {
    if (box) return;
    box = document.createElement("div");
    box.className = "jaf-overlay-box";
    badge = document.createElement("div");
    badge.className = "jaf-overlay-badge";
    (document.documentElement || document.body).appendChild(box);
    (document.documentElement || document.body).appendChild(badge);
  }
  function hideOverlay() {
    if (box) box.style.display = "none";
    if (badge) badge.style.display = "none";
  }
  function removeOverlay() {
    if (box) box.remove();
    if (badge) badge.remove();
    box = null;
    badge = null;
  }

  // ── hover classification (badge UX only) ────────────────────────────────
  function scan(el) {
    const controls = [];
    let file = false;
    let custom = false;
    const nodes = [];
    if (el.matches && el.matches("input, textarea, select")) nodes.push(el);
    if (el.querySelectorAll) {
      el.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]').forEach((n) =>
        nodes.push(n)
      );
      if (el.querySelector('[role="combobox"], [role="listbox"], [role="radiogroup"]')) custom = true;
    }
    for (const n of nodes) {
      if (n.tagName === "INPUT") {
        const t = (n.type || "text").toLowerCase();
        if (["hidden", "submit", "button", "image", "reset"].includes(t)) continue;
        if (t === "file") {
          file = true;
          continue;
        }
      }
      controls.push(n);
    }
    return { controls, file, custom };
  }

  function hasShadow(el) {
    if (el.shadowRoot) return true;
    if (!el.querySelectorAll) return false;
    const nodes = el.querySelectorAll("*");
    for (let i = 0; i < nodes.length && i < 400; i++) {
      if (nodes[i].shadowRoot) return true;
    }
    return false;
  }

  function validity(el) {
    const s = scan(el);
    const n = s.controls.length;
    let level;
    if (n === 0) {
      if (s.file) level = "file";
      else if (hasShadow(el)) level = "shadow";
      else if (s.custom) level = "custom";
      else level = "invalid";
    } else if (n === 1) {
      level = "valid";
    } else {
      level = "group";
    }
    const count = n + (s.file ? 1 : 0);
    return { level, n, count, file: s.file };
  }

  function badgeText(v) {
    switch (v.level) {
      case "invalid":
        return "No input - include the field";
      case "file":
        return "File upload (resume / cover letter)";
      case "custom":
        return "Custom control (best effort)";
      case "shadow":
        return "Shadow DOM (not supported)";
      case "group":
        return v.count + " fields in block";
      default:
        return v.file ? "Field + file" : "Selectable";
    }
  }

  function positionOverlay(el, level, text) {
    ensureOverlay();
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    box.setAttribute("data-level", level);
    badge.style.display = "block";
    badge.style.left = r.left + "px";
    badge.style.top = Math.max(0, r.top - 22) + "px";
    badge.setAttribute("data-level", level);
    badge.textContent = text;
  }

  // ── selection ──────────────────────────────────────────────────────────
  function onMove(e) {
    if (!state.picking) return;
    const el = e.target;
    if (!el || el === box || el === badge) return;
    state.hoverEl = el;
    const v = validity(el);
    positionOverlay(el, v.level, badgeText(v));
  }

  function onClick(e) {
    if (!state.picking) return;
    const el = state.hoverEl || e.target;
    if (!el || el === box || el === badge) return;
    e.preventDefault();
    e.stopPropagation();
    const v = validity(el);
    if (v.level === "invalid") {
      positionOverlay(el, "invalid", "No input here - select the field area");
      return;
    }
    if (v.level === "shadow") {
      positionOverlay(el, "shadow", "Shadow DOM control - fill this one manually");
      return;
    }
    const handle = Math.floor(Math.random() * 2000000000);
    el.setAttribute("data-autofill-id", String(handle));
    state.selected.set(handle, el);
    announceFieldAdded({
      type: "AF_FIELD_ADDED",
      handle,
      label: labelText(el),
      level: v.level,
      controlCount: v.count,
    });
  }

  function frameMeta() {
    try {
      return { frameUrl: location.href, frameHost: location.hostname };
    } catch {
      return { frameUrl: "", frameHost: "" };
    }
  }

  function formLabelForContainer(container) {
    if (container.matches && container.matches('form[data-ui="survey-form"]')) return "Survey questions";
    try {
      if (AF.greenhouse && AF.greenhouse.isApplicationFrame && AF.greenhouse.isApplicationFrame()) {
        return "Application form (Greenhouse)";
      }
      if (AF.greenhouse && AF.greenhouse.isEmbedParent && AF.greenhouse.isEmbedParent()) {
        return "Application form (Greenhouse embed)";
      }
    } catch {}
    return "Application form";
  }

  function announceFieldAdded(payload) {
    try {
      chrome.runtime.sendMessage({ ...frameMeta(), ...payload });
    } catch {}
  }

  // ── auto-discovery (no manual clicking) ───────────────────────────────────
  // Many ATSs (Greenhouse, etc.) wrap the ENTIRE application in one stable
  // container, so we can select that single region and let the engine claim
  // every control inside it via the per-component drivers. Ordered, most-
  // specific first; first visible match wins. The form is preferred over its
  // outer container because it bounds exactly the fillable fields + submit.
  const AUTO_CONTAINER_SELECTORS = [
    // Greenhouse
    "form#application-form",
    "form.application--form",
    ".application--container form",
    "#application-form",
    "form[action*='greenhouse']",
    ".application--container",
    ".application--form",
    // ApplyToJob (JazzHR / resumator)
    "form#form_submit_new_resume",
    "form[action*='applytojob']",
    "#resumator-resume-upload",
    // RecruiterFlow
    ".apply-to-job-form-inputs-container form",
    ".apply-to-job-form-inputs-container",
    // Ashby (jobs.ashbyhq.com): the application can render as SEVERAL sibling
    // ".ashby-application-form-container" blocks (the main form + a separate EEO
    // survey form), all inside the "#form" tab panel. Select that panel so every
    // section is filled in one pass; the convenience "Autofill from resume"
    // uploader it also contains is ignored by the file driver. The form root is a
    // <div> (not a <form>), so the generic "form" fallback never matches it.
    "#form:has(.ashby-application-form-container)",
    ".ashby-application-form-container",
    // SmartRecruiters (jobs.smartrecruiters.com): each application STEP has its
    // own top web component (NOT a <form>), so the generic "form" fallback never
    // matches. Selecting it lets the shadow-piercing engine claim every field
    // inside its spl-* shadow roots. The personal-info step is <oc-oneclick-form>;
    // the screening step is <sr-screening-questions-form>.
    "oc-oneclick-form",
    "sr-screening-questions-form",
    "[data-test='screening-questions']",
    // Workable (apply.workable.com): post-submit survey OR application form.
    'form[data-ui="survey-form"]',
    'form[data-ui="application-form"]',
    // Breezy.hr: AngularJS application + questionnaire + EEO in one form.
    '.application-container form[name="form"]',
    'form[ng-controller*="FormWithQuestionnaire"]',
    ".application-container",
    // Lever (jobs.lever.co): apply form is a .application-form section (often a
    // <div> inside or instead of a native <form>). Select the whole block so
    // every .application-question is filled in one pass.
    "form[action*='lever.co']",
    ".section.application-form",
    ".application-form",
    // Generic fallback
    "form",
  ];

  // SmartRecruiters step containers, in priority order. Used by the
  // shadow-piercing fallback below because the mounted container changes between
  // steps and can sit inside a shadow root that light-DOM querySelector misses.
  const SR_CONTAINER_SELECTORS = [
    "sr-screening-questions-form",
    "oc-oneclick-form",
    "[data-test='screening-questions']",
    "oc-easy-apply",
  ];

  // Ashby renders the application under a tabbed pane; the form only mounts when
  // the "Application" tab is active. If the candidate opened the job on the
  // "Overview" tab the container is absent, so activate the Application tab once
  // (idempotent) before discovery so the form has a chance to render.
  function ensureAshbyFormVisible() {
    try {
      if (document.querySelector(".ashby-application-form-container")) return;
      const tab = document.querySelector('a#job-application-form, a[aria-controls="form"]');
      if (tab && tab.getAttribute("aria-selected") !== "true") tab.click();
    } catch {}
  }

  // Lever job pages split description vs apply (/apply). Activate the apply form
  // when the candidate opened the posting page instead of the apply URL.
  // MUST NOT run on other ATS pages (ApplyToJob, etc.): their URLs and nav links
  // also contain "/apply" but clicking them navigates away from the open form.
  function ensureLeverApplyVisible() {
    try {
      if (AF.lever && AF.lever.isLeverPage && AF.lever.isLeverPage()) return;
      if (/\.lever\.co$/i.test(location.hostname) || /jobs\.(?:eu\.)?lever\.co/i.test(location.hostname)) {
        /* fall through - Lever host but apply form not mounted yet */
      } else {
        return; // not Lever - never click generic /apply links on other ATS pages
      }
      if (document.querySelector(".application-form, .application-question")) return;
      if (document.querySelector('form#form_submit_new_resume, #resumator-resume-upload, #resumator-resume-value')) {
        return; // ApplyToJob form already on this page
      }
      const apply =
        document.querySelector('a.postings-btn[href*="/apply"], a.template-btn-submit[href*="/apply"], a[href$="/apply"]') ||
        document.querySelector(".postings-btn-wrapper a[href*='apply']");
      if (apply) apply.click();
    } catch {}
  }

  function findAutoContainer() {
    ensureAshbyFormVisible();
    ensureLeverApplyVisible();
    for (const sel of AUTO_CONTAINER_SELECTORS) {
      let node = null;
      try {
        node = document.querySelector(sel);
      } catch {
        node = null;
      }
      if (node && isVisible(node)) return node;
    }
    // SmartRecruiters fallback: the step container changes between steps
    // (oc-oneclick-form -> sr-screening-questions-form) and can be nested inside
    // a shadow root, so the light-DOM loop above misses it. Pierce shadow roots.
    if (AF.deepCollect && AF.deepCollect()) {
      for (const sel of SR_CONTAINER_SELECTORS) {
        const node = srDeepOne(document.body, sel);
        if (node) return node;
      }
    }
    return null;
  }

  // Register the topmost application container as a single selected block and
  // notify the side panel (same AF_FIELD_ADDED contract as a manual pick).
  // Returns the number of containers registered (0 if none found in this frame).
  function autoSelect() {
    const container = findAutoContainer();
    if (!container) return 0;
    pruneStaleSelections(container);
    // Reuse the container's data-autofill-id when present (survives re-injection);
    // otherwise assign a new handle and stamp it on the DOM node.
    let handle = null;
    const existing = container.getAttribute("data-autofill-id");
    if (existing && /^\d+$/.test(String(existing))) handle = Number(existing);
    if (handle == null) {
      handle = Math.floor(Math.random() * 2000000000);
      container.setAttribute("data-autofill-id", String(handle));
    }
    state.selected.set(handle, container);
    const v = validity(container);
    const formLabel = formLabelForContainer(container);
    announceFieldAdded({
      type: "AF_FIELD_ADDED",
      handle,
      label: formLabel,
      level: "group",
      controlCount: v.count,
    });
    return 1;
  }

  // Drop detached containers and superseded Workable forms (application ->
  // post-submit survey) so autofill does not keep targeting a removed form.
  function pruneStaleSelections(activeContainer) {
    for (const [handle, el] of Array.from(state.selected.entries())) {
      if (!el || !el.isConnected) {
        removeSelection(handle);
        continue;
      }
      if (!activeContainer) continue;
      try {
        const wb =
          el.matches &&
          (el.matches('form[data-ui="application-form"]') || el.matches('form[data-ui="survey-form"]'));
        const activeWb =
          activeContainer.matches &&
          (activeContainer.matches('form[data-ui="application-form"]') ||
            activeContainer.matches('form[data-ui="survey-form"]'));
        if (wb && activeWb && el !== activeContainer) removeSelection(handle);
      } catch {}
    }
  }

  // ── repeating education rows (Greenhouse) ─────────────────────────────────
  // Greenhouse renders ONE education row (school--0 / degree--0 / discipline--0)
  // plus an "Add another" button. A candidate may have several education
  // entries, so before filling we add enough rows for the whole history and let
  // the fill pass map each entry to its 0-based index. The indexed ids make this
  // deterministic - mirrors the Workday repeating-panel flow.
  function educationBlockCount() {
    const set = new Set();
    document
      .querySelectorAll('[id^="school--"], [id^="degree--"], [id^="discipline--"]')
      .forEach((el) => {
        const m = /--(\d+)$/.exec(el.id || "");
        if (m) set.add(Number(m[1]));
      });
    return set.size;
  }

  function educationAddButton() {
    const scope =
      document.querySelector(".education--container") ||
      document.querySelector(".education--form") ||
      document;
    const direct = scope.querySelector && scope.querySelector("button.add-another-button");
    if (direct) return direct;
    const btns = scope.querySelectorAll ? [...scope.querySelectorAll("button")] : [];
    return btns.find((b) => /add another/i.test((b.textContent || "").trim())) || null;
  }

  function clickButton(btn) {
    try {
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } catch {}
    try {
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    } catch {}
    try {
      btn.click();
    } catch {}
  }

  // Ensure at least `needed` education rows exist. Idempotent: never removes a
  // row and never over-adds (re-running is safe). Returns the final row count.
  async function ensureEducationBlocks(needed) {
    const want = Math.max(1, Number(needed) || 0);
    const waitUntil = (dom.waitUntil ? dom.waitUntil : async () => null);
    let guard = 0;
    while (educationBlockCount() < want && guard++ < want + 4) {
      const before = educationBlockCount();
      const btn = educationAddButton();
      if (!btn || !isVisible(btn)) break;
      clickButton(btn);
      await waitUntil(() => (educationBlockCount() > before ? true : null), 3000, 100);
      if (educationBlockCount() <= before) break; // the Add click did nothing - stop
    }
    return educationBlockCount();
  }

  function reactSelectDriver() {
    return AF.orderedDrivers ? AF.orderedDrivers().find((d) => d.type === "react-select") : null;
  }

  // Classify a field label into a stable identity / EEO / work-authorization /
  // consent category, or null. MUST stay identical to the copy in src/app.js so
  // remembered keys line up. Order matters (work_auth keywords overlap citizen).
  function answerCategory(label) {
    const s = (label || "").toLowerCase();
    if (!s) return null;
    if (/\bgender\b|\bsex\b/.test(s)) return "gender";
    if (/hispanic|latino|latina|latinx/.test(s)) return "hispanic";
    if (/\brace\b|ethnic|nationalit/.test(s)) return "race";
    if (/veteran/.test(s)) return "veteran";
    if (/disab/.test(s)) return "disability";
    if (/sponsor/.test(s)) return "sponsorship";
    if (/citizen|authoriz|eligible to work|right to work|legally authorized/.test(s)) return "work_auth";
    if (/how did you hear|hear about (us|this|the)/.test(s)) return "how_hear";
    if (/\bconsent\b|acknowledg|i agree|\bterms\b|privacy/.test(s)) return "consent";
    return null;
  }

  // Replay remembered identity answers: for each labeled control whose category
  // we have a cached answer for, write it via its driver, ONE at a time (so any
  // dropdown menu closes before the next opens). Skips controls already filled
  // (e.g. by the education prep). Cached answers are exact option text; the
  // driver fuzzy-matches, and anything that doesn't fit this ATS's phrasing
  // simply stays unfilled and falls back to the normal LLM pass.
  // Commit browser-autofilled values into the page's framework state. The
  // engine skips controls that already hold a value (isFilled), so a value the
  // browser autofilled WITHOUT firing React's onChange would never get committed
  // to the controlled component - and a React form (e.g. Ashby) then rejects it
  // as a missing required field on submit. Re-fire each pre-filled text input's
  // own value through the React-safe path so the framework records it. We don't
  // change any text, so this is safe to run on every text field in the form.
  async function commitPrefilledInputs() {
    const commit = dom.commitReactValue;
    if (typeof commit !== "function") return 0;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let n = 0;
    const nodes = [
      ...document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="search"], input:not([type]), textarea'
      ),
    ];
    for (const el of nodes) {
      try {
        if (!isVisible(el)) continue;
        // NOTE: we deliberately DO commit intl-tel-input (.iti) fields here. The
        // browser autofills phone numbers (often with a "+1" country prefix) into
        // the visible tel input WITHOUT firing React's onChange, so a controlled
        // form (Ashby) reads the phone as a missing required field. Re-firing the
        // same value through the React-safe path registers it; intl-tel-input just
        // reformats the identical value, which is a no-op.
        if (commit(el)) {
          n++;
          // CRITICAL: yield a macrotask between fields. Each field commits into
          // the form's (Apollo) state on blur as an async React update; firing all
          // our blurs in one synchronous burst lets React 18 batch them into a
          // single render where the shared form-state merges clobber each other,
          // so some fields we just committed read back as "missing required
          // field". A real macrotask gap flushes each field's commit before the
          // next - exactly what happens when a user clicks in and out one field at
          // a time (the gesture that reliably fixes it by hand).
          await wait(16);
        }
      } catch {}
    }
    return n;
  }

  async function applyCachedAnswers(pairs) {
    if (!pairs || !AF.orderedDrivers) return 0;
    const drivers = AF.orderedDrivers();
    const anchors = [
      ...document.querySelectorAll('input, textarea, select, [role="combobox"], .yes-no-inputs, [class*="_yesno_"]'),
    ];
    const seen = new Set();
    let n = 0;
    for (const anchor of anchors) {
      let root = null;
      let driver = null;
      for (const d of drivers) {
        try {
          root = d.match(anchor);
        } catch {
          root = null;
        }
        if (root) {
          driver = d;
          break;
        }
      }
      if (!root || seen.has(root)) continue;
      seen.add(root);
      // Yes/No button groups (Ashby) must be clicked AFTER the form is fully
      // interactive. This replay runs right after the form mounts, so a click
      // here can fire before Ashby wires its onClick - it would flip only the
      // button's visual and never reach React's form state, then the
      // data-af-yesno-answered marker makes the post-hydration pass skip it and
      // the answer reads as a missing required field on submit. Skip them here;
      // the normal post-extraction write pass (after the LLM round-trip, when
      // the form is definitely interactive) clicks them once and reliably.
      if (driver.type === "yes-no-buttons") continue;
      let spec;
      try {
        spec = driver.extract(root);
      } catch {
        continue;
      }
      const cat = answerCategory(spec && spec.label);
      const answer = cat && pairs[cat];
      if (!answer) continue;
      let filled = false;
      try {
        filled = driver.isFilled(root);
      } catch {}
      if (filled) continue;
      try {
        if (await driver.write(root, { value: answer, option: answer })) n++;
      } catch {}
    }
    return n;
  }

  // Map a candidate's free-form degree to Greenhouse's fixed Degree taxonomy so
  // type+Enter snaps to a real option (typing "Bachelor of Science" alone never
  // substring-matches "Bachelor's Degree"). Unknown -> return as-is and let the
  // driver fuzzy-match / the user adjust.
  const GH_DEGREE_RULES = [
    [/ph\.?\s*d|doctor of philosophy|doctorate/i, "Doctor of Philosophy (Ph.D.)"],
    [/m\.?\s*d\.?\b|doctor of medicine/i, "Doctor of Medicine (M.D.)"],
    [/j\.?\s*d\.?\b|juris doctor/i, "Juris Doctor (J.D.)"],
    [/m\.?\s*b\.?\s*a|master of business/i, "Master of Business Administration (M.B.A.)"],
    [/master|m\.?\s*sc|m\.?\s*eng|\bm\.?\s*s\b|\bm\.?\s*a\b/i, "Master's Degree"],
    [/bachelor|b\.?\s*sc|b\.?\s*eng|\bb\.?\s*s\b|\bb\.?\s*a\b|undergrad/i, "Bachelor's Degree"],
    [/associate/i, "Associate's Degree"],
    [/engineer/i, "Engineer's Degree"],
    [/high\s*school|secondary|diploma/i, "High School"],
  ];
  function mapDegree(raw) {
    const s = clean(raw || "");
    if (!s) return "";
    for (const [re, label] of GH_DEGREE_RULES) if (re.test(s)) return label;
    return s;
  }

  async function writeReactSelectById(driver, id, value) {
    const v = clean(value || "");
    if (!v) return false;
    const input = document.getElementById(id);
    if (!input) return false;
    let root = null;
    try {
      root = driver.match(input);
    } catch {
      root = null;
    }
    if (!root) return false;
    try {
      return await driver.write(root, { value: v, option: v });
    } catch {
      return false;
    }
  }

  // Fill every education row deterministically, ONE control at a time. Each
  // react-select selection closes its own menu, so we never have several
  // Greenhouse education menus open at once - the exact stacked-open state that
  // leaves School/Degree unselected when the generic option-harvest pass opens
  // them all together. School = profile school name (best-effort typeahead),
  // Degree = profile degree mapped to Greenhouse's taxonomy, Discipline = the
  // standard value. Filled controls then report filled, so the LLM pass (and its
  // multi-open harvest) skips them entirely.
  async function fillEducationRows(entries, discipline) {
    const list = Array.isArray(entries) ? entries : [];
    const disc = clean(discipline || "");
    const driver = reactSelectDriver();
    if (!driver) return 0;
    let n = 0;
    const total = Math.max(list.length, educationBlockCount());
    for (let i = 0; i < total; i++) {
      const e = list[i] || {};
      if (e.school && (await writeReactSelectById(driver, `school--${i}`, e.school))) n++;
      if (e.degree && (await writeReactSelectById(driver, `degree--${i}`, mapDegree(e.degree)))) n++;
      if (disc && (await writeReactSelectById(driver, `discipline--${i}`, disc))) n++;
    }
    return n;
  }

  // ── repeating Experience / Education rows (RecruiterFlow) ──────────────────
  // RecruiterFlow ships ONE Experience row and ONE Education row plus
  // "+Add Experience" / "+Add Education" buttons. Field NAMES carry a 0-based
  // index (candidate_profile.company-name.0, candidate_profile.school.1, …) - the
  // ids are duplicated across rows, so the name is the reliable identifier. As
  // with Greenhouse education, we add a row per profile entry, then fill each by
  // index. Company/Title/School/Degree are plain text; dates are react-datepicker
  // text inputs filled best-effort (the widget may reject an unrecognized format,
  // in which case the field is left for the user / the LLM pass).
  function rfRowCount(prefix) {
    const set = new Set();
    document.querySelectorAll('[name^="' + prefix + '."]').forEach((el) => {
      const m = /\.(\d+)$/.exec(el.getAttribute("name") || "");
      if (m) set.add(Number(m[1]));
    });
    return set.size;
  }

  async function ensureRfRows(prefix, addButtonId, needed) {
    const want = Math.max(1, Number(needed) || 0);
    const waitUntil = dom.waitUntil ? dom.waitUntil : async () => null;
    let guard = 0;
    while (rfRowCount(prefix) < want && guard++ < want + 4) {
      const before = rfRowCount(prefix);
      const btn = document.getElementById(addButtonId);
      if (!btn || !isVisible(btn)) break;
      clickButton(btn);
      await waitUntil(() => (rfRowCount(prefix) > before ? true : null), 3000, 100);
      if (rfRowCount(prefix) <= before) break; // the Add click did nothing - stop
    }
    return rfRowCount(prefix);
  }

  function rfSetByName(name, value) {
    const v = clean(value || "");
    if (!v) return false;
    const el = document.querySelector('[name="' + name + '"]');
    const setText = AF.native && AF.native.setTextInput;
    if (!el || !setText || clean(el.value)) return false; // skip missing / already-filled
    try {
      setText(el, v);
      return true;
    } catch {
      return false;
    }
  }

  function rfSetDateInRow(row, cls, value) {
    const v = clean(value || "");
    if (!row || !v) return false;
    const el = row.querySelector("input." + cls);
    const setText = AF.native && AF.native.setTextInput;
    if (!el || !setText || clean(el.value)) return false;
    try {
      setText(el, v);
      return true;
    } catch {
      return false;
    }
  }

  // Resolve a row's container from one of its named inputs. Prefer the known
  // wrapper class, but fall back to the nearest ancestor that actually holds a
  // .date-picker-container so a re-styled "added" row still resolves its dates.
  function rfRowOf(name, rowSel) {
    const el = document.querySelector('[name="' + name + '"]');
    if (!el || !el.closest) return null;
    const exact = el.closest(rowSel);
    if (exact) return exact;
    let node = el.parentElement;
    for (let d = 0; node && d < 5; d++) {
      if (node.querySelector && node.querySelector(".date-picker-container")) return node;
      node = node.parentElement;
    }
    return null;
  }

  async function fillRfExperience(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const total = Math.max(list.length, rfRowCount("candidate_profile.company-name"));
    let n = 0;
    for (let i = 0; i < total; i++) {
      const e = list[i] || {};
      if (rfSetByName("candidate_profile.company-name." + i, e.company)) n++;
      if (rfSetByName("candidate_profile.designation." + i, e.title)) n++;
      const row = rfRowOf("candidate_profile.company-name." + i, ".experience-company-title-container");
      if (e.start) rfSetDateInRow(row, "start-date-picker", e.start);
      if (!e.current && e.end) rfSetDateInRow(row, "end-date-picker", e.end);
      if (e.current && row) {
        const cb = row.querySelector('.is-current-custom-checkbox-container input[type="checkbox"]');
        if (cb && !cb.checked) clickButton(cb);
      }
    }
    return n;
  }

  async function fillRfEducation(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const total = Math.max(list.length, rfRowCount("candidate_profile.school"));
    let n = 0;
    for (let i = 0; i < total; i++) {
      const e = list[i] || {};
      if (rfSetByName("candidate_profile.school." + i, e.school)) n++;
      if (rfSetByName("candidate_profile.degree." + i, e.degree)) n++;
      const row = rfRowOf("candidate_profile.school." + i, ".education-school-degree-container");
      if (e.start) rfSetDateInRow(row, "start-date-picker", e.start);
      if (e.end) rfSetDateInRow(row, "end-date-picker", e.end);
    }
    return n;
  }

  // Country is a react-select with a huge (~240) country list. Filling it
  // deterministically from the profile avoids harvesting that list to the LLM.
  // The country widget is the combobox sitting beside the hidden
  // <input name="country"> in the Location group.
  async function fillRfCountry(country) {
    const v = clean(country || "");
    if (!v) return false;
    const driver = reactSelectDriver();
    if (!driver) return false;
    const hidden = document.querySelector('input[name="country"]');
    const scope = (hidden && hidden.closest && hidden.closest(".location-group, .location-groups-container")) || document;
    const input = scope.querySelector('input[role="combobox"]');
    if (!input) return false;
    let root = null;
    try {
      root = driver.match(input);
    } catch {
      root = null;
    }
    if (!root) return false;
    try {
      return await driver.write(root, { value: v, option: v });
    } catch {
      return false;
    }
  }

  // The final data-policy consent checkbox is REQUIRED to submit. It shares its
  // id/name ("data-policy") with the per-experience "currently working" box, so
  // target the one inside the form-level .data-policy-checkbox wrapper.
  function tickRfConsent() {
    const wrap = document.querySelector(".data-policy-checkbox");
    const cb = wrap && wrap.querySelector ? wrap.querySelector('input[type="checkbox"]') : null;
    if (cb && !cb.checked) {
      clickButton(cb);
      return true;
    }
    return false;
  }

  // ── SmartRecruiters repeating Experience / Education + consent ─────────────
  // SmartRecruiters renders its form from "spl-*" Lit web components whose inputs
  // live in declarative shadow roots, and its Experience/Education sections are
  // repeating blocks with an Add -> fill -> Save flow (each entry must be saved
  // before the next "Add"). This prep drives those blocks deterministically from
  // the candidate's history and ticks the required privacy-consent box, BEFORE
  // the generic LLM pass (which excludes these subtrees). Personal info / resume
  // are handled by that generic pass.
  const SR_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Query across shadow roots, starting from `root` (an element or document).
  function srDeepQuery(root, selector) {
    const out = [];
    const visit = (el) => {
      if (!el || el.nodeType !== 1) return;
      try {
        if (el.matches && el.matches(selector)) out.push(el);
      } catch {}
      if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c);
      const kids = el.children;
      if (kids) for (const c of kids) visit(c);
    };
    if (!root) return out;
    if (root.nodeType === 1) visit(root);
    else if (root.children) for (const c of root.children) visit(c);
    return out;
  }
  function srDeepOne(root, selector) {
    const all = srDeepQuery(root, selector);
    return all.length ? all[0] : null;
  }

  const srRoot = () => document.documentElement || document.body || document;
  const srWait = dom.waitUntil ? dom.waitUntil : async () => null;
  const srDelay = dom.delay ? dom.delay : (ms) => new Promise((r) => setTimeout(r, ms));

  function srParseMMYYYY(s) {
    const m = /^(\d{1,2})\/(\d{4})$/.exec(clean(s || ""));
    if (!m) return null;
    return { month: Math.max(1, Math.min(12, parseInt(m[1], 10))), year: parseInt(m[2], 10) };
  }
  function srLastMonth() {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
  }

  // Click the spl-button (or its inner <button>) inside an oc-button host.
  function srClickButton(host) {
    if (!host) return false;
    const btn = srDeepOne(host, "button") || host;
    clickButton(btn);
    return true;
  }

  // Type into an spl-autocomplete (Title / Company / Institution - they carry
  // allowcustomvalues) and pick the topmost search result if one appears; else
  // commit the typed text as a custom value. `host` is the oc-*-autocomplete.
  async function srFillAutocomplete(host, value) {
    const v = clean(value || "");
    if (!v || !host) return false;
    const input = srDeepOne(host, 'input[role="combobox"], input.c-spl-input');
    if (!input) return false;
    const setNativeValue = dom.setNativeValue;
    try {
      input.focus({ preventScroll: true });
    } catch {}
    if (setNativeValue) setNativeValue(input, v);
    else input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Wait for the async result list, then click the first non-disabled option.
    const opt = await srWait(
      () => {
        const opts = srDeepQuery(host, '[role="option"]:not([aria-disabled="true"])');
        return opts.length ? opts[0] : null;
      },
      2200,
      80
    );
    if (opt) {
      clickButton(opt);
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
      try {
        input.blur();
      } catch {}
    }
    await srDelay(180);
    return true;
  }

  // Fill a plain spl-input text field (education Degree / Major) inside an oc-host.
  function srFillText(host, value) {
    const v = clean(value || "");
    if (!v || !host) return false;
    const input = srDeepOne(host, 'input.c-spl-input, input[type="text"], input:not([type])');
    if (!input) return false;
    const setText = AF.native && AF.native.setTextInput;
    try {
      if (setText) setText(input, v);
      else {
        input.focus();
        if (dom.setNativeValue) dom.setNativeValue(input, v);
        else input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      }
      return true;
    } catch {
      return false;
    }
  }

  // Normalize a location (a "City, State, Country" string OR a {city,state,
  // country} object) into ordered geocoder queries. SmartRecruiters' location
  // autocompletes are async-geocoded and DO NOT accept custom values, so the
  // committed value is always the suggestion we pick (canonical "Newark, CA, US"
  // form). Querying "City, State" makes the geocoder rank the correct city top;
  // a bare "City" is the fallback when the state is unknown / yields nothing.
  function srLocParts(loc) {
    if (loc && typeof loc === "object") {
      return {
        city: clean(loc.city || ""),
        state: clean(loc.state || ""),
        country: clean(loc.country || ""),
        postalCode: clean(loc.postalCode || loc.postal_code || ""),
      };
    }
    const parts = clean(loc || "").split(",").map((x) => clean(x)).filter(Boolean);
    return { city: parts[0] || "", state: parts[1] || "", country: parts[2] || "", postalCode: "" };
  }
  function srLocQueries(loc) {
    const p = srLocParts(loc);
    const out = [];
    if (p.city && p.state) out.push(p.city + ", " + p.state);
    if (p.city) out.push(p.city);
    return [...new Set(out)].filter(Boolean);
  }

  // Climb across shadow boundaries to the nearest ancestor element matching `tag`.
  function srClosestHost(el, tag) {
    let node = el;
    for (let i = 0; node && i < 16; i++) {
      if (node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === tag) return node;
      const p = node.parentNode;
      node = p && p.nodeType === 11 && p.host ? p.host : p;
    }
    return null;
  }

  // Type each query into a geocoded combobox input and click the top suggestion
  // from ITS OWN listbox. The options popup is scoped to the input's enclosing
  // spl-autocomplete so that, when a block has two pickers (Country/Region +
  // Postal code), we never cross-pick the wrong one. Returns true once committed.
  async function srTypePick(input, queries) {
    if (!input) return false;
    const scope =
      srClosestHost(input, "spl-autocomplete") || (input.getRootNode && input.getRootNode().host) || input;
    const setVal = (v) => {
      if (dom.setNativeValue) dom.setNativeValue(input, v);
      else input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    for (const q of (queries || []).filter(Boolean)) {
      try {
        input.focus({ preventScroll: true });
      } catch {}
      setVal(q);
      const opt = await srWait(
        () => {
          const opts = srDeepQuery(scope, '[role="option"]:not([aria-disabled="true"])');
          return opts.length ? opts[0] : null;
        },
        2500,
        80
      );
      if (opt) {
        clickButton(opt);
        await srDelay(200);
        return true;
      }
      setVal(""); // clear before the next (shorter) query attempt
      await srDelay(150);
    }
    try {
      input.blur();
    } catch {}
    return false;
  }

  // Classify a location sub-field by its (shadow-host) label.
  function srLocFieldKind(input) {
    const lab = (dom.labelForControl ? dom.labelForControl(input) || "" : "").toLowerCase();
    if (/postal|zip/.test(lab)) return "postal";
    if (/country|region/.test(lab)) return "country";
    return "city";
  }

  function srCountryQueries(country) {
    const c = clean(country || "");
    if (!c) return [];
    if (/united states|u\.?s\.?a\.?|^u\.?s\.?$/i.test(c)) return [...new Set(["United States", c])];
    return [c];
  }

  // Fill a location block. SmartRecruiters renders location EITHER as a single
  // city autocomplete (label "City"/"Office location"/"School location") OR - when
  // the company configured postal lookup - as a "Country/Region" picker plus a
  // "Postal code" search. Both the postal field and the country picker are
  // geocoded autocompletes (no custom values), so we type and pick the top
  // suggestion. In postal mode we type the candidate's ZIP (not address text).
  async function srFillLocation(host, loc) {
    if (!host) return false;
    const parts = srLocParts(loc);
    const inputs = srDeepQuery(
      host,
      'input[role="combobox"], input[aria-autocomplete], input.c-spl-input'
    ).filter((el) => isVisible(el));
    if (!inputs.length) return false;
    let countryInput = null;
    let postalInput = null;
    let cityInput = null;
    for (const el of inputs) {
      const k = srLocFieldKind(el);
      if (k === "country") countryInput = countryInput || el;
      else if (k === "postal") postalInput = postalInput || el;
      else cityInput = cityInput || el;
    }
    // Postal-code mode: select Country/Region first, then enter the ZIP and pick it.
    if (postalInput) {
      if (countryInput && parts.country) await srTypePick(countryInput, srCountryQueries(parts.country));
      if (!parts.postalCode) return false;
      const zipQueries = [parts.postalCode];
      if (parts.city) zipQueries.push(parts.postalCode + " " + parts.city);
      return await srTypePick(postalInput, zipQueries);
    }
    // City-search mode.
    const target = cityInput || inputs[0];
    return await srTypePick(target, srLocQueries(loc));
  }

  // Fill a multi-line spl-textarea (Experience / Education Description) inside an
  // oc-textarea host. Preserves newlines (unlike clean()), so a multi-paragraph
  // description keeps its line breaks.
  function srFillTextarea(host, value) {
    const v = String(value || "").trim();
    if (!v || !host) return false;
    const ta = srDeepOne(host, "textarea");
    if (!ta) return false;
    const setText = AF.native && AF.native.setTextInput;
    try {
      if (setText) setText(ta, v);
      else {
        ta.focus();
        if (dom.setNativeValue) dom.setNativeValue(ta, v);
        else ta.value = v;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        ta.blur();
      }
      return true;
    } catch {
      return false;
    }
  }

  // Set a month-year flatpickr date inside an oc-datepicker host by driving its
  // (always-rendered "static") calendar: step the year with the prev/next arrows
  // (a year per click in monthSelect mode), then click the month cell. Format-
  // independent and deterministic - no guessing flatpickr's parse format.
  async function srFillDate(host, year, month) {
    if (!host || !year || !month) return false;
    const input = srDeepOne(host, "input.flatpickr-input");
    if (!input) return false;
    try {
      input.focus({ preventScroll: true });
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      input.click();
    } catch {}
    const grid = await srWait(() => srDeepOne(host, ".flatpickr-monthSelect-months"), 1500, 60);
    if (!grid) return false;
    const curYear = () => {
      const g = srDeepOne(host, ".flatpickr-monthSelect-months");
      const a = g && g.getAttribute("aria-roledescription");
      const n = a ? parseInt(a, 10) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    let guard = 0;
    while (curYear() !== year && guard++ < 80) {
      const y = curYear();
      if (y == null) break;
      const arrow = srDeepOne(host, y > year ? ".flatpickr-prev-month" : ".flatpickr-next-month");
      if (!arrow) break;
      clickButton(arrow);
      await srDelay(30);
    }
    const name = SR_MONTHS[month - 1];
    const cell = srDeepQuery(host, ".flatpickr-monthSelect-month").find((s) => {
      const al = s.getAttribute("aria-label") || "";
      return al.indexOf(name + " ") === 0 && al.indexOf(String(year)) >= 0;
    });
    if (!cell) return false;
    clickButton(cell);
    await srDelay(150);
    return true;
  }

  // Open one Experience edit form (if not already open), fill it, and Save.
  async function srAddAndFillExperience(entry, home) {
    const e = entry || {};
    if (!srDeepOne(srRoot(), "oc-experience-edit-form")) {
      const addBtn = srDeepOne(srRoot(), 'oc-button[data-test="add-experience"]');
      if (!addBtn) return false; // Experience section isn't on this step
      srClickButton(addBtn);
      await srWait(() => srDeepOne(srRoot(), "oc-experience-edit-form"), 2500, 80);
    }
    const form = srDeepOne(srRoot(), "oc-experience-edit-form");
    if (!form) return false;
    if (e.title) await srFillAutocomplete(srDeepOne(form, "oc-job-title-autocomplete"), e.title);
    if (e.company) await srFillAutocomplete(srDeepOne(form, "oc-company-autocomplete"), e.company);
    // Office location: async geocoded autocomplete with NO custom values, so it
    // must resolve to a real suggestion (top pick). Use the role's location, or
    // the candidate's home location as a fallback so it isn't left blank.
    await srFillLocation(
      srDeepOne(form, 'oc-location-autocomplete-wrapper[data-test="experience-form-location"]'),
      e.location || home
    );
    if (e.description) srFillTextarea(srDeepOne(form, 'oc-textarea[data-test="experience-description"]'), e.description);
    const start = srParseMMYYYY(e.start);
    if (start) await srFillDate(srDeepOne(form, 'oc-datepicker[data-test="experience-date-from"]'), start.year, start.month);
    // Never tick "I currently work here" - always commit a real end date (last
    // month when the role is marked current / has no end).
    let end = srParseMMYYYY(e.end);
    if (!end || e.current) end = srLastMonth();
    await srFillDate(srDeepOne(form, 'oc-datepicker[data-test="experience-date-to"]'), end.year, end.month);
    srClickButton(srDeepOne(form, 'oc-button[data-test="experience-save"]'));
    await srWait(() => !srDeepOne(srRoot(), "oc-experience-edit-form"), 3000, 100);
    return true;
  }

  async function srAddAndFillEducation(entry) {
    const e = entry || {};
    if (!srDeepOne(srRoot(), "oc-education-edit-form")) {
      const addBtn = srDeepOne(srRoot(), 'oc-button[data-test="add-education"]');
      if (!addBtn) return false; // Education section isn't on this step
      srClickButton(addBtn);
      await srWait(() => srDeepOne(srRoot(), "oc-education-edit-form"), 2500, 80);
    }
    const form = srDeepOne(srRoot(), "oc-education-edit-form");
    if (!form) return false;
    if (e.school) await srFillAutocomplete(srDeepOne(form, "oc-institution-autocomplete"), e.school);
    if (e.major) srFillText(srDeepOne(form, 'oc-input[data-test="education-major"]'), e.major);
    if (e.degree) srFillText(srDeepOne(form, 'oc-input[data-test="education-degree"]'), e.degree);
    if (e.description) srFillTextarea(srDeepOne(form, 'oc-textarea[data-test="education-description"]'), e.description);
    const start = srParseMMYYYY(e.start);
    if (start) await srFillDate(srDeepOne(form, 'oc-datepicker[data-test="education-date-from"]'), start.year, start.month);
    let end = srParseMMYYYY(e.end);
    if (!end) end = srLastMonth();
    await srFillDate(srDeepOne(form, 'oc-datepicker[data-test="education-date-to"]'), end.year, end.month);
    srClickButton(srDeepOne(form, 'oc-button[data-test="education-save"]'));
    await srWait(() => !srDeepOne(srRoot(), "oc-education-edit-form"), 3000, 100);
    return true;
  }

  // Tick REQUIRED privacy/consent checkboxes on any SmartRecruiters step.
  // Step 1 uses oc-checkbox[data-test="consent-box"]; later steps (EEO/submit)
  // use spl-checkbox (privacy notice, accuracy acknowledgement, …).
  async function srTickConsent() {
    try {
      if (AF.srTickRequiredCheckboxes) return await AF.srTickRequiredCheckboxes();
    } catch {}
    const box = srDeepOne(srRoot(), 'oc-checkbox[data-test="consent-box"]');
    if (!box) return 0;
    const input = srDeepOne(box, 'input[type="checkbox"]');
    if (input && !input.checked) {
      srFireClick(input);
      return input.checked ? 1 : 0;
    }
    return 0;
  }

  async function fillSmartRecruiters(experience, education, home) {
    // Personal-info City (place of residence): same async geocoded autocomplete,
    // filled from the candidate's home address.
    let homeLoc = false;
    try {
      homeLoc = await srFillLocation(srDeepOne(srRoot(), '[data-test="personal-info-location"]'), home);
    } catch {}
    let filledExp = 0;
    let filledEdu = 0;
    for (const e of Array.isArray(experience) ? experience : []) {
      try {
        if (await srAddAndFillExperience(e, home)) filledExp++;
      } catch {}
    }
    for (const e of Array.isArray(education) ? education : []) {
      try {
        if (await srAddAndFillEducation(e)) filledEdu++;
      } catch {}
    }
    let consent = false;
    try {
      consent = (await srTickConsent()) > 0;
    } catch {}
    return { filledExp, filledEdu, consent, homeLoc };
  }

  // ── Workable repeating Education / Experience ─────────────────────────────
  // Workable mounts edu/exp as Add -> [data-ui="editor"] -> Update -> saved
  // [data-ui="group"] cards. Prep fills any missing rows from the profile before
  // the generic LLM pass (which excludes these subtrees).
  function wbDelay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function wbWait(check, timeoutMs, intervalMs) {
    const waitUntil = dom.waitUntil ? dom.waitUntil : async () => null;
    try {
      await waitUntil(check, timeoutMs || 3000, intervalMs || 80);
    } catch {}
    try {
      return !!check();
    } catch {
      return false;
    }
  }

  function wbSection(sectionUi) {
    return document.querySelector('[data-ui="' + sectionUi + '"]');
  }

  function wbSavedCount(sectionUi) {
    const sec = wbSection(sectionUi);
    if (!sec) return 0;
    return sec.querySelectorAll('ul li [data-ui="group"]').length;
  }

  function wbEditor(sectionUi) {
    const sec = wbSection(sectionUi);
    return sec ? sec.querySelector('[data-ui="editor"]') : null;
  }

  async function wbSetField(input, value) {
    const v = String(value || "").trim();
    if (!input || !v) return false;
    try {
      const wbSet =
        AF.workable && AF.workable.setEditorField ? AF.workable.setEditorField.bind(AF.workable) : null;
      if (wbSet && wbSet(input, v)) {
        await wbDelay(60);
        return true;
      }
      const setText = AF.native && AF.native.setTextInput;
      if (setText) setText(input, v);
      else if (dom.setNativeValue) {
        dom.setNativeValue(input, v);
        if (dom.fireInput) dom.fireInput(input);
        else {
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        input.blur();
      } else {
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await wbDelay(60);
      return true;
    } catch {
      return false;
    }
  }

  async function wbCommitEditor(editor) {
    if (!editor) return;
    try {
      if (AF.workable && AF.workable.commitEditorFields) AF.workable.commitEditorFields(editor);
    } catch {}
    await wbDelay(120);
  }

  async function wbOpenEditor(sectionUi) {
    const sec = wbSection(sectionUi);
    if (!sec) return null;
    const open = sec.querySelector('[data-ui="editor"]');
    if (open) return open;
    const btn = sec.querySelector('[data-ui="add-section"]:not([disabled])');
    if (!btn || !isVisible(btn)) return null;
    clickButton(btn);
    await wbWait(() => wbEditor(sectionUi), 3500, 80);
    return wbEditor(sectionUi);
  }

  async function wbSaveEditor(sectionUi) {
    const sec = wbSection(sectionUi);
    if (!sec) return false;
    const editor = sec.querySelector('[data-ui="editor"]');
    if (!editor) return false;
    const save = editor.querySelector('[data-ui="save-section"]');
    if (!save) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      await wbCommitEditor(editor);
      clickButton(save);
      const closed = await wbWait(() => !sec.querySelector('[data-ui="editor"]'), 4000, 100);
      if (closed) {
        await wbDelay(150);
        return true;
      }
    }
    return false;
  }

  async function wbSetCurrent(editor, current) {
    if (!editor) return false;
    const cb = editor.querySelector(
      '[role="checkbox"]#current, [role="checkbox"][aria-labelledby="checkbox_label_current"]'
    );
    if (!cb) return false;
    const on = cb.getAttribute("aria-checked") === "true";
    if (current && !on) clickButton(cb);
    else if (!current && on) clickButton(cb);
    await wbDelay(80);
    return true;
  }

  async function wbFillEducationEntry(entry) {
    const e = entry || {};
    if (!e.school) return false;
    const editor = await wbOpenEditor("education");
    if (!editor) return false;
    let n = 0;
    // Optional fields first; required School last so a later write cannot drop it
    // from React state while the DOM still shows the typed value.
    if (e.field_of_study && (await wbSetField(editor.querySelector('[name="field_of_study"]'), e.field_of_study))) n++;
    if (e.degree && (await wbSetField(editor.querySelector('[name="degree"]'), e.degree))) n++;
    if (e.start && (await wbSetField(editor.querySelector('[name="start_date"]'), e.start))) n++;
    if (e.end && (await wbSetField(editor.querySelector('[name="end_date"]'), e.end))) n++;
    if (await wbSetField(editor.querySelector('[name="school"]'), e.school)) n++;
    if (!n) return false;
    return wbSaveEditor("education");
  }

  async function wbFillExperienceEntry(entry) {
    const e = entry || {};
    if (!e.title) return false;
    const editor = await wbOpenEditor("experience");
    if (!editor) return false;
    let n = 0;
    // Optional fields first; required Title last (see education note above).
    if (e.company && (await wbSetField(editor.querySelector('[name="company"]'), e.company))) n++;
    if (e.industry && (await wbSetField(editor.querySelector('[name="industry"]'), e.industry))) n++;
    if (e.description && (await wbSetField(editor.querySelector('textarea[name="summary"]'), e.description))) n++;
    if (e.start && (await wbSetField(editor.querySelector('[name="start_date"]'), e.start))) n++;
    if (e.current) {
      await wbSetCurrent(editor, true);
    } else {
      await wbSetCurrent(editor, false);
      if (e.end) await wbSetField(editor.querySelector('[name="end_date"]'), e.end);
    }
    if (await wbSetField(editor.querySelector('[name="title"]'), e.title)) n++;
    if (!n) return false;
    return wbSaveEditor("experience");
  }

  async function fillWorkable(experience, education) {
    let filledExp = 0;
    let filledEdu = 0;
    const expList = Array.isArray(experience) ? experience : [];
    const eduList = Array.isArray(education) ? education : [];
    const eduStart = wbSavedCount("education");
    for (let i = eduStart; i < eduList.length; i++) {
      try {
        if (await wbFillEducationEntry(eduList[i])) filledEdu++;
      } catch {}
    }
    const expStart = wbSavedCount("experience");
    for (let i = expStart; i < expList.length; i++) {
      try {
        if (await wbFillExperienceEntry(expList[i])) filledExp++;
      } catch {}
    }
    return { filledExp, filledEdu };
  }

  // ── SmartRecruiters multi-page navigation ─────────────────────────────────
  // Longer applications split the form across steps with a "Next" footer button
  // (oc-button[data-test="footer-next"]); the final step shows "Submit" instead.
  // We fill the current step, click Next, let the next step render, fill again,
  // and stop once Next is gone (the Submit step) - we never auto-submit.

  // A fingerprint of the currently rendered step: the count + ids of every
  // data-test node across the form (shadow-piercing). A different step exposes a
  // different set, so a change confirms the page actually advanced.
  function srPageSignature() {
    try {
      const form = document.querySelector("oc-oneclick-form") || document.body;
      const ids = srDeepQuery(form, "[data-test]")
        .map((n) => n.getAttribute("data-test"))
        .filter(Boolean);
      const footer = document.querySelector('[data-test="footer"] oc-button');
      return ids.length + ":" + ids.join(",").slice(0, 6000) + "|" + ((footer && footer.getAttribute("data-test")) || "");
    } catch {
      return "sig:" + Math.random();
    }
  }

  function srSubmitVisible() {
    try {
      const b = document.querySelector(
        'oc-button[data-test="footer-submit"], oc-button[data-test*="submit"], [data-test="footer"] [type="submit"]'
      );
      return !!(b && isVisible(b));
    } catch {
      return false;
    }
  }

  // Report invalid/required controls (regardless of visibility - a saved
  // Experience/Education block collapses but can still hold an invalid field).
  function srValidationErrors() {
    const nodes = srDeepQuery(
      srRoot(),
      '[aria-invalid="true"], .c-spl-input--error, [data-test$="-error"], [class*="--error"]'
    );
    const labels = [];
    const seen = new Set();
    for (const e of nodes) {
      let lab = "";
      try {
        lab = (dom.labelForControl ? dom.labelForControl(e) : "") || "";
      } catch {}
      if (!lab) lab = e.getAttribute("data-test") || e.getAttribute("data-sr-id") || clean(e.textContent) || "(field)";
      lab = clean(lab).slice(0, 60);
      if (lab && !seen.has(lab)) {
        seen.add(lab);
        labels.push(lab);
      }
    }
    return labels;
  }

  // Fire a full, shadow-crossing pointer+mouse+click sequence on `el`. The key vs.
  // the old clickButton: every event is composed:true (so it propagates OUT of the
  // spl-button shadow root to the oc-button/Angular click handler) and carries a
  // real pointer position, which some web-component buttons require.
  function srFireClick(el) {
    if (!el) return;
    let cx = 1;
    let cy = 1;
    try {
      const r = el.getBoundingClientRect();
      cx = Math.floor(r.left + r.width / 2);
      cy = Math.floor(r.top + r.height / 2);
    } catch {}
    const base = { bubbles: true, composed: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy };
    try {
      el.focus({ preventScroll: true });
    } catch {}
    const seq = [
      ["pointerover", typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent],
      ["pointerenter", typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent],
      ["pointerdown", typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent],
      ["mousedown", MouseEvent],
      ["pointerup", typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent],
      ["mouseup", MouseEvent],
    ];
    for (const [type, Ctor] of seq) {
      try {
        el.dispatchEvent(new Ctor(type, base));
      } catch {}
    }
    try {
      el.click(); // native composed click (the actual activation)
    } catch {
      try {
        el.dispatchEvent(new MouseEvent("click", base));
      } catch {}
    }
  }

  // Click the footer "Next" to advance one step. Returns:
  //   { advanced:true }            - page changed, fill the next step
  //   { advanced:false, submit }   - no Next (we're on the Submit step) -> stop
  //   { advanced:false, blocked }  - Next exists but the page didn't change
  //                                  (validation blocked it) -> stop
  async function srNavigateNext() {
    // Clear any required spl-checkbox consent boxes before attempting Next -
    // unchecked boxes leave c-spl-form-field--invalid and block navigation.
    try {
      const ticked = AF.srTickRequiredCheckboxes ? await AF.srTickRequiredCheckboxes() : 0;
      if (ticked) console.log("[autofill] SR nav: ticked", ticked, "required checkbox(es) before Next");
    } catch {}

    const next = document.querySelector('oc-button[data-test="footer-next"]');
    const submit = srSubmitVisible();
    console.log("[autofill] SR nav: footer-next present =", !!next, "| submit present =", submit);
    if (!next || !isVisible(next)) return { advanced: false, submit };

    const sig = srPageSignature();
    try {
      next.scrollIntoView({ block: "center" });
    } catch {}
    await srDelay(150);

    // Try the real activation targets in order: the inner native <button>, then
    // the spl-button host, then the oc-button. Each is given time to either
    // change the step or surface validation before falling through.
    const targets = [srDeepOne(next, "button"), srDeepOne(next, "spl-button"), next].filter(Boolean);
    let changed = false;
    for (let i = 0; i < targets.length && !changed; i++) {
      const t = targets[i];
      console.log("[autofill] SR nav: clicking target #" + i, t.tagName ? t.tagName.toLowerCase() : t);
      srFireClick(t);
      const deadline = Date.now() + 4500;
      while (Date.now() < deadline) {
        await srDelay(200);
        if (srPageSignature() !== sig) {
          changed = true;
          break;
        }
        // If validation errors appeared, the click DID register - stop clicking
        // other targets and report the blocking fields.
        if (srValidationErrors().length) break;
      }
      if (srValidationErrors().length) break;
    }

    if (changed) {
      console.log("[autofill] SR nav: ADVANCED to the next step");
      await srDelay(500); // let the new step settle before re-discovery
      return { advanced: true };
    }
    const errs = srValidationErrors();
    console.log(
      "[autofill] SR nav: did NOT advance. aria-invalid/error fields:",
      errs.length ? errs : "(none - click still not registering)"
    );
    return { advanced: false, blocked: true, errors: errs };
  }

  // ── ApplyToJob (JazzHR) resume reveal ─────────────────────────────────────
  // The real <input type=file id="resumator-resume-value"> starts hidden inside
  // #resumator-resume-upload-wrapper.none; clicking "Attach resume" reveals it.
  // Revealing it before extraction makes the input visible (so the engine claims
  // it) and lets the file driver attach the resume PDF normally.
  async function revealApplyToJobResume() {
    const shown = () => {
      const el = document.getElementById("resumator-resume-value");
      return !!(el && el.offsetParent !== null);
    };
    if (shown()) return true;
    const link = document.getElementById("resumator-choose-upload");
    if (!link) return shown();
    // Some tenants use <a href="...">; avoid navigation - toggle visibility only.
    if (link.tagName === "A") {
      try {
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch {}
    } else {
      clickButton(link);
    }
    const waitUntil = dom.waitUntil ? dom.waitUntil : async () => null;
    await waitUntil(() => (shown() ? true : null), 2000, 100);
    return shown();
  }

  // Fill a cover-letter textarea (or text input) with the AI-generated cover
  // letter body. Matched by label ("cover letter"); only fills empty controls so
  // we never clobber something the user already typed. Uses the native driver's
  // React-safe value setter.
  function fillCoverLetter(text) {
    const body = String(text || "");
    if (!body) return 0;
    const setText = AF.native && AF.native.setTextInput;
    const anchors = [...document.querySelectorAll("textarea, input[type='text']")];
    let n = 0;
    for (const el of anchors) {
      if (!isVisible(el)) continue;
      const label = dom.labelForControl ? dom.labelForControl(el) : "";
      if (!/cover\s*letter/i.test(label)) continue;
      if (clean(el.value)) continue; // don't overwrite existing content
      try {
        if (setText) setText(el, body);
        else {
          el.focus();
          el.value = body;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        n++;
      } catch {}
    }
    return n;
  }

  function startPicking() {
    if (state.picking) return;
    state.picking = true;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  function stopPicking(notify) {
    if (!state.picking) return;
    state.picking = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    hideOverlay();
    if (notify) {
      try {
        chrome.runtime.sendMessage({ type: "AF_PICKING_STOPPED" });
      } catch {}
    }
  }

  function removeSelection(handle) {
    const el = state.selected.get(handle);
    if (el) {
      el.classList.remove("jaf-selected");
      el.removeAttribute("data-autofill-id");
    }
    state.selected.delete(handle);
  }

  function clearAll() {
    for (const handle of Array.from(state.selected.keys())) removeSelection(handle);
    if (AF.engine) AF.engine.reset();
    removeOverlay();
  }

  // Drop the selection outlines (and hover overlay) but KEEP data-autofill-id /
  // data-autofill-cid so the engine can still find each control while filling.
  function hideMarks() {
    hideOverlay();
    for (const el of state.selected.values()) {
      if (el && el.classList) el.classList.remove("jaf-selected");
    }
  }

  function relocate(handle) {
    let el = state.selected.get(handle);
    if (el && document.contains(el)) return el;
    try {
      el = document.querySelector('[data-autofill-id="' + CSS.escape(String(handle)) + '"]');
    } catch {
      el = null;
    }
    if (el) state.selected.set(handle, el);
    return el || null;
  }

  // ── engine bridge ────────────────────────────────────────────────────────
  async function handleExtract(requestedHandles) {
    if (!AF.engine) {
      chrome.runtime.sendMessage({ type: "AF_FIELDS", fields: [] });
      return;
    }
    AF.engine.reset();
    const consumed = new WeakSet();
    const fields = [];
    const handleList =
      Array.isArray(requestedHandles) && requestedHandles.length
        ? requestedHandles
        : [...state.selected.keys()];
    try {
      for (const handle of handleList) {
        const el = relocate(handle);
        if (!el) continue;
        try {
          fields.push(await AF.engine.extractRegionDom(el, consumed, handle));
        } catch {
          fields.push({ handle, label: "", controls: [], html: "" });
        }
      }
    } finally {
      try {
        if (AF.closeReactSelectMenus) AF.closeReactSelectMenus(document);
      } catch {}
    }
    chrome.runtime.sendMessage({ type: "AF_FIELDS", fields });
  }

  async function handleWrite(results, files, passId) {
    try {
      console.groupCollapsed("[autofill] LLM payload (autofill-ready)");
      const flat = [];
      for (const r of results || []) {
        for (const c of r.controls || []) {
          flat.push({
            handle: r.handle,
            cid: c.cid,
            kind: c.kind,
            value: c.value,
            option: c.option,
            option_values: (c.option_values || []).join(" | "),
            file_role: c.file_role || "",
            needs_user: !!c.needs_user,
            reason: c.reason || "",
          });
        }
      }
      console.table(flat);
      console.groupEnd();
    } catch {}

    if (!AF.engine) return;
    let report = [];
    try {
      report = await AF.engine.writeControls(results, files);
    } finally {
      try {
        if (AF.closeReactSelectMenus) AF.closeReactSelectMenus(document);
      } catch {}
    }
    try {
      if (AF.srTickRequiredCheckboxes && /smartrecruiters\.com$/i.test(location.hostname)) {
        const ticked = await AF.srTickRequiredCheckboxes();
        if (ticked) console.log("[autofill] post-write: ticked", ticked, "required SR checkbox(es)");
      }
    } catch {}
    try {
      console.log("[autofill] write report:", report);
    } catch {}
    // Only the frame that actually wrote controls reports completion, tagged
    // with passId so the side panel waits for the RIGHT pass before re-scanning.
    if (report.length) chrome.runtime.sendMessage({ type: "AF_WRITE_RESULT", passId, report });
  }

  // ── serialize extract/write ───────────────────────────────────────────────
  // Extraction rebuilds the control registry and opens dropdowns to harvest
  // options; writing reads that registry and drives the same dropdowns. They
  // MUST NOT overlap, or a re-extract would wipe state and close a menu mid-write.
  let opChain = Promise.resolve();
  function runExclusive(fn) {
    const run = opChain.then(() => fn());
    opChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    // Greenhouse pre-pass: add enough repeating education rows for the whole
    // history BEFORE the fill. Only the frame that actually hosts the education
    // section answers, so its real count wins over empty frames.
    if (msg.type === "AF_GH_PREP") {
      const hasEdu = !!document.querySelector('.education--container, .education--form, [id^="school--"]');
      if (!hasEdu) return;
      runExclusive(async () => {
        const entries = Array.isArray(msg.entries) ? msg.entries : [];
        const count = await ensureEducationBlocks(entries.length || 1);
        await fillEducationRows(entries, msg.discipline);
        return count;
      });
      return;
    }
    // RecruiterFlow pre-pass: add a repeating Experience/Education row per profile
    // entry (Workday-style), fill them + Country deterministically, and tick the
    // required consent box, all BEFORE the generic fill. Only the frame hosting
    // the RecruiterFlow form answers.
    if (msg.type === "AF_RF_PREP") {
      const isRf = !!document.querySelector(
        ".apply-to-job-form-inputs-container, #add-experience-button, #add-education-button"
      );
      if (!isRf) return false; // not this frame
      runExclusive(async () => {
        const exp = Array.isArray(msg.experience) ? msg.experience : [];
        const edu = Array.isArray(msg.education) ? msg.education : [];
        await ensureRfRows("candidate_profile.company-name", "add-experience-button", exp.length || 1);
        await ensureRfRows("candidate_profile.school", "add-education-button", edu.length || 1);
        const filledExp = await fillRfExperience(exp);
        const filledEdu = await fillRfEducation(edu);
        let country = false;
        try {
          country = await fillRfCountry(msg.country);
        } catch {}
        const consent = tickRfConsent();
        return { filledExp, filledEdu, country, consent };
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...res });
        } catch {}
      });
      return true; // async sendResponse
    }
    // SmartRecruiters pre-pass: add + Save a repeating Experience/Education entry
    // per profile entry (Workday-style) and tick the required consent box, all
    // BEFORE the generic fill (which excludes these subtrees). Only the frame
    // hosting the SmartRecruiters form answers.
    if (msg.type === "AF_SR_PREP") {
      const isSr = !!document.querySelector("oc-oneclick-form, oc-personal-information, oc-experience");
      if (!isSr) return false; // not this frame
      runExclusive(async () => {
        return await fillSmartRecruiters(msg.experience, msg.education, msg.home);
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...res });
        } catch {}
      });
      return true; // async sendResponse
    }
    // SmartRecruiters multi-page: click the footer "Next" to advance to the next
    // application step. Only the frame hosting the SmartRecruiters form answers.
    if (msg.type === "AF_SR_NEXT") {
      const isSr = !!document.querySelector("oc-oneclick-form, oc-personal-information, oc-experience");
      if (!isSr) return false; // not this frame
      console.log("[autofill] AF_SR_NEXT received in form frame");
      runExclusive(async () => srNavigateNext()).then((res) => {
        try {
          sendResponse({ ok: true, ...(res || {}) });
        } catch {}
      });
      return true; // async sendResponse
    }
    if (msg.type === "AF_SR_TICK_CHECKBOXES") {
      if (!/smartrecruiters\.com$/i.test(location.hostname)) return false;
      runExclusive(async () => {
        const ticked = AF.srTickRequiredCheckboxes ? await AF.srTickRequiredCheckboxes() : 0;
        return { ticked };
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...(res || {}) });
        } catch {}
      });
      return true;
    }
    // Pinpoint: tick the required application-process consent checkbox before submit.
    if (msg.type === "AF_PP_TICK_CONSENT") {
      const isPp = !!(AF.pinpoint && AF.pinpoint.isPinpointPage && AF.pinpoint.isPinpointPage());
      if (!isPp) return false;
      runExclusive(async () => {
        const ticked = AF.pinpoint && AF.pinpoint.tickPinpointConsent ? AF.pinpoint.tickPinpointConsent() : 0;
        return { ticked };
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...(res || {}) });
        } catch {}
      });
      return true;
    }
    // Workable pre-pass: Add -> fill -> Update for Education/Experience rows
    // BEFORE the generic fill. Only the frame hosting the Workable form answers.
    if (msg.type === "AF_WB_PREP") {
      const isWb = !!(AF.workable && AF.workable.isWorkableApplicationPage && AF.workable.isWorkableApplicationPage());
      if (!isWb) return false;
      runExclusive(async () => {
        return await fillWorkable(msg.experience, msg.education);
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...res });
        } catch {}
      });
      return true;
    }
    // Workable: upload resume LAST so import/parse does not overwrite fields.
    if (msg.type === "AF_WB_UPLOAD_RESUME") {
      const isWb = !!(AF.workable && AF.workable.isWorkableApplicationPage && AF.workable.isWorkableApplicationPage());
      if (!isWb) return false;
      runExclusive(async () => {
        const uploaded = AF.workable && AF.workable.writeResumeFile ? AF.workable.writeResumeFile(msg.file) : false;
        return { uploaded: uploaded ? 1 : 0 };
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...(res || {}) });
        } catch {}
      });
      return true;
    }
    // Workable: report whether the post-submit survey form is mounted.
    if (msg.type === "AF_WB_HAS_SURVEY") {
      const survey = !!(AF.workable && AF.workable.isWorkableSurveyPage && AF.workable.isWorkableSurveyPage());
      try {
        sendResponse({ ok: true, survey });
      } catch {}
      return true;
    }
    // Lever: upload resume LAST so Lever's parser does not overwrite fields we
    // already filled. Only the frame hosting the Lever application form answers.
    if (msg.type === "AF_LV_UPLOAD_RESUME") {
      const isLv = !!(AF.lever && AF.lever.isLeverPage && AF.lever.isLeverPage());
      if (!isLv) return false;
      runExclusive(async () => {
        const uploaded = AF.lever && AF.lever.writeResumeFile ? AF.lever.writeResumeFile(msg.file) : false;
        return { uploaded: uploaded ? 1 : 0 };
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...(res || {}) });
        } catch {}
      });
      return true;
    }
    // Breezy: upload resume LAST so any parser does not overwrite filled fields.
    if (msg.type === "AF_BZY_UPLOAD_RESUME") {
      const isBz = !!(AF.breezy && AF.breezy.isBreezyPage && AF.breezy.isBreezyPage());
      if (!isBz) return false;
      runExclusive(async () => {
        const uploaded = AF.breezy && AF.breezy.writeResumeFile ? AF.breezy.writeResumeFile(msg.file) : false;
        return { uploaded: uploaded ? 1 : 0 };
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...(res || {}) });
        } catch {}
      });
      return true;
    }
    // Breezy multi-step: click Continue to expose the next section (never Submit).
    if (msg.type === "AF_BZY_NEXT") {
      const isBz = !!(AF.breezy && AF.breezy.isBreezyPage && AF.breezy.isBreezyPage());
      if (!isBz) return false;
      runExclusive(async () => {
        const nav = AF.breezy && AF.breezy.advanceSection ? await AF.breezy.advanceSection() : { advanced: false };
        return nav || { advanced: false };
      }).then((res) => {
        try {
          sendResponse({ ok: true, ...(res || {}) });
        } catch {}
      });
      return true;
    }
    // ApplyToJob pre-pass: reveal the hidden resume file input before extraction.
    // Only the frame that hosts the resumator form answers.
    if (msg.type === "AF_ATJ_PREP") {
      const isAtj = !!document.querySelector("#resumator-resume-upload, form#form_submit_new_resume, #resumator-resume-value");
      if (!isAtj) return false; // not this frame
      runExclusive(async () => {
        const revealed = await revealApplyToJobResume();
        return { revealed };
      }).then((res) => {
        try {
          sendResponse({ ok: true, revealed: res.revealed });
        } catch {}
      });
      return true; // async sendResponse
    }
    // Fill a cover-letter textarea with the AI-generated cover letter body before
    // extraction. Only the frame that hosts a text/textarea control answers.
    if (msg.type === "AF_FILL_COVER_LETTER") {
      const has = !!document.querySelector("textarea, input[type='text']");
      if (!has) return false; // not this frame
      runExclusive(() => fillCoverLetter(msg.text)).then((count) => {
        try {
          sendResponse({ ok: true, count });
        } catch {}
      });
      return true; // async sendResponse
    }
    // Replay remembered identity answers (EEO/work-auth/consent) before extract.
    // Only the frame that actually hosts form controls answers.
    if (msg.type === "AF_APPLY_CACHE") {
      const hasControls = !!document.querySelector('input, textarea, select, [role="combobox"]');
      if (!hasControls) return false; // not this frame
      runExclusive(() => applyCachedAnswers(msg.pairs)).then((count) => {
        try {
          sendResponse({ ok: true, count });
        } catch {}
      });
      return true; // async sendResponse
    }
    switch (msg.type) {
      case "AF_START":
        startPicking();
        break;
      case "AF_COMMIT_PREFILLED":
        runExclusive(async () => {
          const count = await commitPrefilledInputs();
          try {
            chrome.runtime.sendMessage({ type: "AF_COMMIT_PREFILLED_DONE", count });
          } catch {}
        });
        break;
      case "AF_AUTOSELECT":
        // Auto-discovery: select the topmost application container (no manual
        // picking) and tell the side panel discovery finished so it can fill.
        // Retry briefly so a form that renders just after Start is still caught.
        runExclusive(async () => {
          let count = 0;
          for (let i = 0; i < 12; i++) {
            count = autoSelect();
            if (count) break;
            await new Promise((r) => setTimeout(r, 200));
          }
          try {
            console.log(
              "[autofill] AF_AUTOSELECT -> registered",
              count,
              "container(s); host =",
              location.hostname,
              "ghFrame =",
              !!(AF.greenhouse && AF.greenhouse.isApplicationFrame && AF.greenhouse.isApplicationFrame())
            );
          } catch {}
          try {
            chrome.runtime.sendMessage({ type: "AF_AUTOSELECT_DONE", count });
          } catch {}
        });
        break;
      case "AF_STOP":
        stopPicking();
        break;
      case "AF_HIDE_MARKS":
        hideMarks();
        break;
      case "AF_REMOVE":
        removeSelection(msg.handle);
        break;
      case "AF_CLEAR":
        stopPicking();
        clearAll();
        break;
      case "AF_EXTRACT":
        runExclusive(() => handleExtract(msg.handles));
        break;
      case "AF_WRITE":
        runExclusive(() => handleWrite(msg.results, msg.files, msg.passId));
        break;
      default:
        break;
    }
  });
})();
