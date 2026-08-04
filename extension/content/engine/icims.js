// iCIMS candidate-portal (*.icims.com) helpers.
//
// iCIMS renders the profile / application as a div "table": each
// .iCIMS_ProfileFormTable holds .iCIMS_TableRow rows pairing a .iCIMS_InfoField
// (the <label for> plus a <span class="Field_RequiredStar">*</span>) with a
// .iCIMS_InfoData (the control). It is classic server-rendered HTML + jQuery -
// there is no React state to commit - but four things need platform handling:
//
//  1. RESUME UPLOAD NAVIGATES. The resume input's own onchange ends with
//     `this.form.action = this.form.action + '&uploadResume=1'; this.form.submit();`
//     and the page says "Existing data in the form will be replaced". So the
//     file must be attached FIRST, before anything else is filled, and the
//     server re-renders the form pre-filled from the parsed resume (exactly the
//     fields carrying bgtparse="true"). Deferring it - the Lever/Ashby pattern -
//     would throw away every value we wrote.
//  2. REQUIRED-NESS is carried by i_required="true" and the row's
//     .Field_RequiredStar; aria-required is present on some controls only (e.g.
//     rcf3048 has it, -1_PersonProfileFields.CountryCode does not - there it
//     sits on the sibling <a> instead).
//  3. AJAX DROPDOWNS. A field with icimsdropdown-enabled="1" hides its <select>
//     (which holds no real <option>s) behind <a id="X_icimsDropdown"> plus
//     #X_icimsDropdown_ctnr. drivers/icims-dropdown.js owns those.
//  4. DEPENDENT FIELDS. State/Province carries data-ddd-parent-link and lists
//     "No Results" until Country is answered; "Please specify further" ships
//     disabled until "How did you hear about us?" fires SourceChange(). Both are
//     skipped while unanswered and picked up by a later extraction pass.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText } = AF.dom;

  function isIcimsHost() {
    try {
      return /(^|\.)icims\.com$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  // Memoized: isIcimsPage() is consulted for EVERY anchor the engine walks (via
  // labelForControl / shouldSkipControl / isRequiredControl), and on a non-iCIMS
  // page each call would otherwise run a document-wide querySelector. iCIMS is
  // server-rendered, so a page never becomes an iCIMS page after load - and a
  // real navigation tears down this whole script anyway.
  let pageCache = null;

  function isIcimsPage() {
    if (pageCache !== null) return pageCache;
    try {
      pageCache =
        isIcimsHost() ||
        !!document.querySelector(".iCIMS_ProfileFormTable, .iCIMS_CenteredPageContent, #cp_form_submit_i");
    } catch {
      pageCache = false;
    }
    return pageCache;
  }

  // The <form> that owns the profile fields. The resume input's onchange calls
  // `this.form.submit()`, so a form element definitely encloses these controls;
  // prefer the one holding the Submit Profile button over any outer search form.
  function applicationForm() {
    try {
      const submit = document.getElementById("cp_form_submit_i");
      if (submit && submit.form) return submit.form;
      const table = document.querySelector(".iCIMS_ProfileFormTable");
      const form = table && table.closest && table.closest("form");
      if (form) return form;
      return document.querySelector(".iCIMS_CenteredPageContent") || null;
    } catch {
      return null;
    }
  }

  // ── labels ─────────────────────────────────────────────────────────────────

  // Strip the required marker the row appends after the label text
  // ("Legal First Name* required.").
  function stripRequiredMarker(s) {
    return clean(s)
      .replace(/\s*required\.?\s*$/i, "")
      .replace(/\s*\*\s*$/, "")
      .trim();
  }

  function labelCellText(el) {
    if (!el) return "";
    try {
      if (el.id) {
        // The star lives in a SIBLING <span class="Field_Required">, so the
        // label's own text is already clean. Prefer the non-508 label: some rows
        // ship an extra <label class="iCIMS_508_Label"> with identical text.
        const all = document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]');
        for (const l of all) {
          if (l.classList && l.classList.contains("iCIMS_508_Label")) continue;
          const t = stripRequiredMarker(l.innerText || l.textContent);
          if (t) return t;
        }
        for (const l of all) {
          const t = stripRequiredMarker(l.innerText || l.textContent);
          if (t) return t;
        }
      }
    } catch {}
    const dl = el.getAttribute && el.getAttribute("data-label");
    if (dl && clean(dl)) return clean(dl);
    const al = el.getAttribute && el.getAttribute("aria-label");
    if (al && clean(al)) return clean(al);
    try {
      const row = el.closest(".iCIMS_TableRow");
      const cell = row && row.querySelector(".iCIMS_InfoField");
      if (cell) {
        const t = stripRequiredMarker(cell.innerText);
        if (t) return t;
      }
    } catch {}
    return "";
  }

  // Repeating collections (Phones, Addresses) reuse plain labels: BOTH ship a
  // required "Type" dropdown with different option sets, so an unqualified
  // "Type" is ambiguous to the model. Qualify every collection field with its
  // group name, taken from data-collection (or the fieldset legend).
  function collectionNameFor(el) {
    if (!el) return "";
    try {
      const row = el.closest("[data-collection]");
      if (row) {
        const raw = row.getAttribute("data-collection") || "";
        const short = raw.split(".").pop();
        if (short) return clean(short);
      }
      const fs = el.closest("fieldset.iCIMS_CollectionGroup");
      if (fs) {
        const lg = fs.querySelector("legend .iCIMS_LabelText, legend");
        if (lg) {
          return stripRequiredMarker(lg.innerText).replace(/\s*\(\d+\)\s*$/, "").trim();
        }
      }
    } catch {}
    return "";
  }

  function questionTitleFor(el) {
    if (!el || !isIcimsPage()) return "";
    const base = labelCellText(el);
    if (!base) return "";
    const group = collectionNameFor(el);
    if (group && !normText(base).includes(normText(group))) {
      return (group + " - " + base).slice(0, 200);
    }
    return base.slice(0, 200);
  }

  // ── required detection ─────────────────────────────────────────────────────

  function isRequiredControl(el) {
    if (!el || !isIcimsPage()) return false;
    try {
      if (el.required) return true;
      if (el.getAttribute("aria-required") === "true") return true;
      if (el.getAttribute("i_required") === "true") return true;
      // Custom dropdowns put aria-required on the visible <a>, not the <select>.
      const a = dropdownAnchorFor(el);
      if (a && a.getAttribute("aria-required") === "true") return true;
      const row = el.closest(".iCIMS_TableRow");
      const cell = row && row.querySelector(".iCIMS_InfoField");
      if (cell && cell.querySelector(".Field_RequiredStar")) return true;
    } catch {}
    return false;
  }

  // ── AJAX dropdown pairing ──────────────────────────────────────────────────

  function dropdownAnchorFor(sel) {
    if (!sel || sel.tagName !== "SELECT" || !sel.id) return null;
    if (sel.getAttribute("icimsdropdown-enabled") !== "1") return null;
    try {
      return document.getElementById(sel.id + "_icimsDropdown");
    } catch {
      return null;
    }
  }

  function selectForAnchor(a) {
    if (!a || !a.id) return null;
    const m = /^(.*)_icimsDropdown$/.exec(a.id);
    if (!m) return null;
    try {
      return document.getElementById(m[1]);
    } catch {
      return null;
    }
  }

  // True when the list is fetched page-by-page as the user types
  // (icimsdropdown-search="1"). Such a list is NOT fully present in the DOM -
  // a country dropdown renders 26 <li> of ~250 - so its options must never be
  // harvested and offered to the model as the complete set of choices.
  function isSearchableDropdown(sel) {
    return !!(sel && sel.getAttribute && sel.getAttribute("icimsdropdown-search") === "1");
  }

  // A child dropdown (State/Province) whose parent (Country) has no answer yet
  // renders "No Results". data-ddd-parent-link names the parent field; both
  // share the collection index prefix ("-1_").
  function parentUnanswered(sel) {
    if (!sel || !sel.getAttribute) return false;
    const link = sel.getAttribute("data-ddd-parent-link");
    if (!link) return false;
    try {
      const idx = /^(-?\d+_)/.exec(sel.id || "");
      const parent = document.getElementById((idx ? idx[1] : "") + link);
      if (!parent) return false;
      const v = clean(parent.value);
      return !v || v === "-999";
    } catch {
      return false;
    }
  }

  // ── controls the generic LLM pass must not claim ───────────────────────────

  // Written deterministically by the credentials prep: the two password boxes
  // must hold the SAME value and satisfy the complexity rule stated in their own
  // title attribute, which a language model cannot guarantee.
  const CREDENTIAL_IDS = new Set([
    "PersonProfileFields.Login",
    "PersonProfileFields.Password",
    "PersonProfileFields.Password_Confirm",
  ]);

  const RESUME_INPUT_ID = "PortalProfileFields.Resume_File";

  function hasRealOptions(sel) {
    try {
      for (const o of sel.options || []) {
        const v = clean(o.value);
        if (v && v !== "-999") return true;
      }
    } catch {}
    return false;
  }

  function shouldSkipControl(el) {
    if (!el || !isIcimsPage()) return false;
    try {
      const t = (el.type || "").toLowerCase();
      if (t === "hidden") return true;
      // The dropdown widget's search box and result list are driven by
      // drivers/icims-dropdown.js; they are not fields in their own right.
      if (el.classList && el.classList.contains("dropdown-search")) return true;
      if (el.closest && el.closest(".dropdown-container")) return true;
      // Social single-sign-on replaces window.top.location - never touch it.
      if (el.closest && el.closest(".iCIMS_SocialLoginContainer")) return true;

      const id = el.id || "";
      const nm = el.name || "";
      if (CREDENTIAL_IDS.has(id) || CREDENTIAL_IDS.has(nm)) return true;
      if (id === RESUME_INPUT_ID || nm === RESUME_INPUT_ID) return true;
      if (el.closest && el.closest(".iCIMS_ResumeContentDiv")) return true;
      if (/^portalLabel/i.test(id) || /^portalLabel/i.test(nm)) return true;
      if (id === "accountId" || nm === "accountId") return true;

      // Dependent fields: disabled until their parent commits (rcf3049 waits on
      // SourceChange()), or listing "No Results" until Country is answered.
      if (el.disabled) return true;
      if (el.tagName === "SELECT") {
        if (parentUnanswered(el)) return true;
        // A plain <select> with no real options and no custom widget cannot be
        // answered; offering it to the model only produces a wrong value.
        if (!hasRealOptions(el) && !dropdownAnchorFor(el)) return true;
      }
    } catch {}
    return false;
  }

  // ── resume ─────────────────────────────────────────────────────────────────

  function resumeInput() {
    try {
      return (
        document.getElementById(RESUME_INPUT_ID) ||
        document.querySelector('input[type="file"][id$="Resume_File"]') ||
        null
      );
    } catch {
      return null;
    }
  }

  // iCIMS records the upload in hidden mirror fields and reveals the current-file
  // row, so a re-run after the page reload can tell the resume is already there.
  function resumeAttached() {
    try {
      const flag = document.getElementById("PortalProfileFields.Resume");
      if (flag && clean(flag.value).toLowerCase() === "true") return true;
      const nameEl = document.getElementById("PortalProfileFields.Resume_FileName");
      if (nameEl && clean(nameEl.value)) return true;
      const label = document.getElementById("PortalProfileFields.Resume_FileNameLabel");
      if (label && label.classList && !label.classList.contains("iCIMS_NoDisplay")) return true;
      const el = resumeInput();
      if (el && el.files && el.files.length) return true;
    } catch {}
    return false;
  }

  function isResumeParsing() {
    try {
      const l = document.getElementById("PortalProfileFields.Resume_Loading");
      return !!(l && l.classList && !l.classList.contains("iCIMS_NoDisplay"));
    } catch {
      return false;
    }
  }

  function resumeState() {
    return {
      present: !!resumeInput(),
      attached: resumeAttached(),
      parsing: isResumeParsing(),
    };
  }

  // Attach the resume and let iCIMS' OWN onchange handler take over: it stamps
  // the hidden mirror fields, appends &uploadResume=1 to the form action and
  // calls form.submit(). This NAVIGATES the tab, so the caller must treat a lost
  // message channel as success and wait for the reload before doing anything else.
  function writeResumeFile(fileData) {
    const el = resumeInput();
    if (!el || !fileData || !fileData.base64) return false;
    try {
      const bin = atob(fileData.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], fileData.filename || "resume.pdf", {
        type: fileData.mime || "application/pdf",
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      if (!el.files || !el.files.length) return false;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  // ── phone ──────────────────────────────────────────────────────────────────
  //
  // The phone block is filled deterministically from the profile rather than by
  // the model, because both halves of it are things the model provably gets
  // wrong here:
  //
  //  * Number carries autocomplete="tel-national" - iCIMS wants the LOCAL number
  //    only, with the dial code chosen in the separate Phone Country Code
  //    dropdown. It also carries bgtparse="true", so iCIMS' OWN resume parser
  //    pre-fills it with the full international string from the PDF
  //    ("+1 814 313-3369"), which its validator then rejects with "Phones (1):
  //    Invalid phone number. Verify the phone country code and number." A
  //    pre-filled control reads as filled, so the generic pass never sees it and
  //    the backend's own country-code stripping (which only runs on values the
  //    model produced) never applies. It has to be normalized here.
  //  * Phone Country Code is a searchable AJAX dropdown, so it is offered to the
  //    model with no options; the backend then treats it as a free-text dial-code
  //    field and answers "1", which is not a searchable term against a list whose
  //    entries read "(+1) United States". Searching by COUNTRY NAME is what
  //    actually resolves, and the profile already knows the country.

  function phoneNumberInput() {
    try {
      return (
        document.getElementById("-1_PersonProfileFields.PhoneNumber") ||
        document.querySelector('input[id$="PersonProfileFields.PhoneNumber"]') ||
        null
      );
    } catch {
      return null;
    }
  }

  function phoneCountryCodeSelect() {
    try {
      return (
        document.getElementById("-1_PersonProfileFields.CountryCode") ||
        document.querySelector('select[id$="PersonProfileFields.CountryCode"]') ||
        null
      );
    } catch {
      return null;
    }
  }

  // "+1 814 313-3369" -> "814 313-3369". Idempotent: a number that is already
  // national is returned unchanged.
  function nationalPhoneNumber(value) {
    let v = clean(value);
    if (!v) return "";
    v = v.replace(/^\+\s*\d{1,3}[\s\-./]+(?=\d)/, "");
    if (/^\+/.test(v)) {
      // "+18143133369" - no separator to split on, so fall back to digits and
      // drop the NANP trunk "1" when the rest is a full 10-digit number.
      const digits = v.replace(/\D/g, "");
      v = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    }
    return clean(v);
  }

  function normalizeDialCode(v) {
    const m = /(\d{1,4})/.exec(String(v == null ? "" : v));
    return m ? m[1] : "";
  }

  // Recover the dial code from an international number when the profile has no
  // explicit phoneCountryCode ("+1 814 313-3369" -> "1").
  function dialCodeFromNumber(value) {
    const m = /^\+\s*(\d{1,3})[\s\-./]*\d/.exec(clean(value));
    return m ? m[1] : "";
  }

  // Returns { number, codePresent, code } where `code` reports whether the
  // required dial-code dropdown ends up SELECTED - already or by us - so the
  // side panel can surface it for manual review when it does not.
  async function fillPhone(data) {
    const out = { number: 0, codePresent: 0, code: 0 };
    const d = data || {};

    const numEl = phoneNumberInput();
    // Read the parser's value BEFORE normalizing it: the international prefix it
    // carries is the last available source for the dial code below.
    const parsed = numEl ? clean(numEl.value) : "";
    if (numEl) {
      // Prefer the profile's number; otherwise normalize what the parser left.
      const want = nationalPhoneNumber(clean(d.phone) ? d.phone : parsed);
      if (want && parsed !== want && setField(numEl, want)) out.number = 1;
    }

    const sel = phoneCountryCodeSelect();
    const anchor = sel && dropdownAnchorFor(sel);
    if (!anchor) return out;
    out.codePresent = 1;
    const dd = AF.icimsDropdown;
    if (!dd || !dd.pickDialCode) return out;
    if (dd.hasSelection && dd.hasSelection(anchor)) {
      out.code = 1;
      return out;
    }
    // The resume parser writes the international number but never the dial code,
    // so that number is a reliable last source for it.
    const code =
      normalizeDialCode(d.countryCode) || dialCodeFromNumber(d.phone) || dialCodeFromNumber(parsed);
    try {
      out.code = (await dd.pickDialCode(anchor, code, clean(d.country))) ? 1 : 0;
    } catch {
      out.code = 0;
    }
    return out;
  }

  // ── login + password ───────────────────────────────────────────────────────

  function setField(el, value) {
    if (!el) return false;
    try {
      if (AF.native && typeof AF.native.setTextInput === "function") {
        AF.native.setTextInput(el, value);
      } else {
        AF.dom.setNativeValue(el, value);
        AF.dom.fireInput(el, value);
      }
    } catch {
      return false;
    }
    // The password boxes bind handlePasswordFieldChange to onkeyup as well as
    // onchange/onblur; the keyup is what re-evaluates the on-screen requirement
    // list and the confirm-match indicator.
    try {
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
    } catch {}
    return true;
  }

  // Fill the "Create a login" block. Never overwrites a value the candidate
  // already typed. Returns how many fields were written.
  function fillCredentials(creds) {
    const out = { login: 0, password: 0 };
    if (!creds) return out;
    try {
      const login = document.getElementById("PersonProfileFields.Login");
      if (login && creds.login && !clean(login.value)) {
        if (setField(login, creds.login)) out.login = 1;
      }
      if (creds.password) {
        const pw = document.getElementById("PersonProfileFields.Password");
        const pw2 = document.getElementById("PersonProfileFields.Password_Confirm");
        if (pw && !clean(pw.value) && setField(pw, creds.password)) out.password++;
        if (pw2 && !clean(pw2.value) && setField(pw2, creds.password)) out.password++;
      }
    } catch {}
    return out;
  }

  // True when this page actually asks the candidate to create an account (the
  // block is absent once they are signed in).
  function needsCredentials() {
    try {
      return !!document.getElementById("PersonProfileFields.Password");
    } catch {
      return false;
    }
  }

  // ── application steps ──────────────────────────────────────────────────────
  //
  // An iCIMS application spans a variable number of server-rendered pages, each
  // a full POST + navigation. The header renders the whole itinerary up front:
  //
  //   <div class="iCIMS_Steps"><ul>
  //     <li class="iCIMS_Steps_First iCIMS_Steps_NotCurrent iCIMS_Steps_Completed"
  //         id="Step_profileStep" title="Candidate Profile&nbsp;(Completed Step)">
  //       <span class="iCIMS_Steps_Content sr-only">Step 1 of 4. Candidate Profile(Completed Step)</span>
  //     <li class=" iCIMS_Steps_Current" id="Step_personQuestionsStep" ...>
  //       <span ...>Step 2 of 4. Candidate Questions(Current Step)</span>
  //     ...
  //
  // That gives position AND total before any click, which is what lets the run
  // advance through the middle pages while stopping short of the final Submit
  // (the one that actually files the application).
  //
  // Two traps: "iCIMS_Steps_NotCurrent" contains the word "Current", so the
  // current step must be found with classList.contains and never a regex on
  // className; and the sr-only text is padded with &nbsp; (\u00a0), which \s
  // matches, so clean() normalises it.
  function stepsRoot() {
    try {
      return document.querySelector(".iCIMS_Steps");
    } catch {
      return null;
    }
  }

  function stepTitle(li) {
    if (!li) return "";
    const raw = clean(li.getAttribute("title") || "");
    // "Candidate Questions (Current Step)" -> "Candidate Questions"
    return clean(raw.replace(/\((?:completed|current|incomplete)\s+step\)\s*$/i, ""));
  }

  // Position read from the sr-only text alone ("Step 2 of 4. Candidate
  // Questions(Current Step)"). This deliberately keys off the "(Current Step)"
  // wording rather than the class, so it is a genuinely independent second
  // opinion on the structural reading below.
  function stepTextPosition(root) {
    try {
      for (const li of root.querySelectorAll("li")) {
        const t = clean(li.textContent);
        if (!/\(current step\)/i.test(t)) continue;
        const m = /step\s+(\d+)\s+of\s+(\d+)/i.exec(t);
        if (m) return { current: Number(m[1]), total: Number(m[2]) };
      }
    } catch {}
    return null;
  }

  function stepInfo() {
    const root = stepsRoot();
    if (!root) return { present: false, current: 0, total: 0, title: "", last: false };
    let items = [];
    try {
      items = Array.from(root.querySelectorAll("li"));
    } catch {
      items = [];
    }
    const total = items.length;
    const idx = items.findIndex((li) => li.classList && li.classList.contains("iCIMS_Steps_Current"));
    const structural = idx >= 0 ? idx + 1 : 0;
    const title = idx >= 0 ? stepTitle(items[idx]) : "";

    const text = stepTextPosition(root);
    let current = structural || (text ? text.current : 0);
    // Two readings that disagree mean neither can be trusted. Report an unknown
    // position so the caller hands over rather than clicking Submit blind.
    if (structural && text && text.current !== structural) current = 0;

    const tot = total || (text ? text.total : 0);
    return {
      present: tot > 0,
      current,
      total: tot,
      title,
      last: current > 0 && tot > 0 && current >= tot,
    };
  }

  // ── advance controls ───────────────────────────────────────────────────────
  //
  // Every step ends with the same pair, differing only by an id prefix
  // ("cp_" on the profile, "quesp_" on the questions page):
  //
  //   <input type="submit" id="quesp_form_save_i"   name="save"
  //          class="iCIMS_SecondaryButton" value="Finish Later">
  //   <input type="submit" id="quesp_form_submit_i" class="iCIMS_PrimaryButton"
  //          value="Submit">
  //
  // Only the presence of `save` in the POST distinguishes them server-side, so
  // "Finish Later" is excluded by name, id AND class - clicking it would abandon
  // the application into a draft.
  function isSaveForLater(el) {
    if (!el) return true;
    try {
      if ((el.name || "").toLowerCase() === "save") return true;
      if (/_form_save_i$/i.test(el.id || "")) return true;
      if (el.classList && el.classList.contains("iCIMS_SecondaryButton")) return true;
      if (/finish\s+later/i.test(clean(el.value || el.textContent || ""))) return true;
    } catch {}
    return false;
  }

  function submitButton() {
    const form = applicationForm();
    const scope = form || document;
    let candidates = [];
    try {
      candidates = Array.from(
        scope.querySelectorAll(
          'input[type="submit"], button[type="submit"], .iCIMS_PrimaryButton'
        )
      );
    } catch {
      return null;
    }
    for (const el of candidates) {
      if (isSaveForLater(el)) continue;
      if (el.disabled) continue;
      // Social sign-on replaces window.top.location - never treat it as advance.
      if (el.closest && el.closest(".iCIMS_SocialLoginContainer")) continue;
      if (!AF.dom.isVisible(el)) continue;
      return el;
    }
    return null;
  }

  // iCIMS wires each control to its own error container via
  // aria-describedby="Q10_error"; after a rejected POST the server re-renders
  // the step with those containers filled in.
  function validationErrors() {
    const out = [];
    const form = applicationForm();
    const scope = form || document;
    let nodes = [];
    try {
      nodes = Array.from(scope.querySelectorAll('[id$="_error"]'));
    } catch {
      return out;
    }
    for (const n of nodes) {
      const msg = clean(n.textContent);
      if (!msg || !AF.dom.isVisible(n)) continue;
      // Name the field by the control the container is bound to, falling back to
      // the message itself so the side panel always shows something actionable.
      let label = "";
      try {
        const id = n.id.replace(/_error$/, "");
        const ctl = document.getElementById(id);
        if (ctl) label = questionTitleFor(ctl);
      } catch {}
      out.push(label ? label + ": " + msg : msg);
    }
    return [...new Set(out)];
  }

  // Everything the side panel needs to decide whether to advance, all read from
  // the freshly loaded document after a navigation.
  function stageState() {
    const step = stepInfo();
    const btn = submitButton();
    let heading = "";
    try {
      const h = document.querySelector(".iCIMS_CenteredPageContent h2, .iCIMS_MainSection h2, h2");
      heading = clean(h && h.textContent);
    } catch {}
    return {
      icims: true,
      step: step.current,
      total: step.total,
      stepsPresent: step.present,
      stepTitle: step.title || heading,
      last: step.last,
      heading,
      hasSubmit: !!btn,
      errors: validationErrors(),
    };
  }

  // Click the real control so iCIMS' own onclick (pageDirtyFlag=false) and the
  // form's onsubmit (icimsDisableSaveAndSubmitButtons) both run, and so the
  // submitter's name/value pair is what the server sees. form.submit() would
  // bypass both. This NAVIGATES: the caller must expect the reply to be lost.
  function clickSubmit() {
    const btn = submitButton();
    if (!btn) return false;
    try {
      btn.scrollIntoView({ block: "center" });
    } catch {}
    try {
      btn.click();
      return true;
    } catch {
      return false;
    }
  }

  AF.icims = {
    isIcimsHost,
    isIcimsPage,
    applicationForm,
    questionTitleFor,
    collectionNameFor,
    isRequiredControl,
    dropdownAnchorFor,
    selectForAnchor,
    isSearchableDropdown,
    parentUnanswered,
    shouldSkipControl,
    resumeInput,
    resumeAttached,
    isResumeParsing,
    resumeState,
    writeResumeFile,
    phoneNumberInput,
    phoneCountryCodeSelect,
    nationalPhoneNumber,
    fillPhone,
    fillCredentials,
    needsCredentials,
    stepInfo,
    submitButton,
    validationErrors,
    stageState,
    clickSubmit,
  };
})();
