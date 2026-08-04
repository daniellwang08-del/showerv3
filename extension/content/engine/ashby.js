// Ashby (jobs.ashbyhq.com) helpers.
//
// Ashby parses an uploaded resume and autofills name/email/location/socials
// (Ashby product feature). The convenience "Autofill from resume" zone is never
// used (file.js). Resume is uploaded EARLY (parallel with the LLM round-trip)
// so parse settles before the single text/select write pass — avoiding a second
// ashbyReapply write that re-opened comboboxes and toggled Yes/No.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean } = AF.dom;

  function isAshbyHost() {
    try {
      return /(^|\.)ashbyhq\.com$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  function isAshbyPage() {
    try {
      if (document.querySelector(".ashby-application-form-container, [data-field-path]")) return true;
      return isAshbyHost() && !!document.querySelector("#_systemfield_resume, #_systemfield_name, #_systemfield_email");
    } catch {
      return false;
    }
  }

  function resumeInput() {
    try {
      return (
        document.querySelector("#_systemfield_resume") ||
        document.querySelector('input[type="file"][name="_systemfield_resume"]') ||
        document.querySelector(
          '.ashby-application-form-field-entry input[type="file"]:not(.ashby-application-form-autofill-uploader input)'
        )
      );
    } catch {
      return null;
    }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function writeResumeFile(fileData) {
    const el = resumeInput();
    if (!el || !fileData || !fileData.base64) return false;
    // Never use the convenience autofill drop zone - file.js documents it races.
    if (el.closest && el.closest(".ashby-application-form-autofill-uploader, .ashby-application-form-autofill-input-root")) {
      return false;
    }
    try {
      const bytes = base64ToBytes(fileData.base64);
      const name = fileData.filename || "resume.pdf";
      const mime =
        fileData.mime || (/\.pdf$/i.test(name) ? "application/pdf" : "application/octet-stream");
      const file = new File([bytes], name, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
      } catch {}
      return !!(el.files && el.files.length);
    } catch {
      return false;
    }
  }

  function fieldEntryLabel(el) {
    try {
      const entry = el.closest && el.closest(".ashby-application-form-field-entry, [data-field-path]");
      if (!entry) return "";
      const q = entry.querySelector(".ashby-application-form-question-title");
      return q ? clean(q.innerText).slice(0, 200) : "";
    } catch {
      return "";
    }
  }

  // Ashby "select all that apply" checkboxes put the OPTION TEXT in name= (unique
  // per box). The shared-name grouper then emits 12 one-option controls and the
  // backend's len(opts)==1 safety net checks every box. Group by the enclosing
  // fieldset / data-field-path instead when names diverge inside one question.
  function checkboxGroupInputs(root) {
    try {
      if (!root || (root.type || "").toLowerCase() !== "checkbox") return null;
      if (!isAshbyPage()) return null;
      const fs = root.closest && root.closest("fieldset");
      const entry = root.closest && root.closest("[data-field-path]");
      const scope = fs || entry;
      if (!scope || !scope.querySelectorAll) return null;
      const boxes = [...scope.querySelectorAll('input[type="checkbox"]')];
      if (boxes.length <= 1) return null;
      const names = new Set(boxes.map((b) => String(b.name || "")));
      // Shared name → normal radio/checkbox grouping already works.
      if (names.size <= 1) return null;
      return boxes;
    } catch {
      return null;
    }
  }

  // Ashby location / source pickers keep the committed answer in input.value.
  // They are NOT react-select (no .singleValue chip); opening the menu clears
  // a committed value.
  function isValueCombobox(el) {
    try {
      if (!isAshbyPage() || !el) return false;
      const inp =
        el.tagName === "INPUT"
          ? el
          : el.querySelector && el.querySelector('input[role="combobox"], input[aria-autocomplete="list"]');
      if (!inp || inp.tagName !== "INPUT") return false;
      const role = (inp.getAttribute && inp.getAttribute("role")) || "";
      const auto = (inp.getAttribute && inp.getAttribute("aria-autocomplete")) || "";
      const popup = (inp.getAttribute && inp.getAttribute("aria-haspopup")) || "";
      return role === "combobox" || auto === "list" || popup === "listbox";
    } catch {
      return false;
    }
  }

  function comboboxValue(el) {
    try {
      if (!isValueCombobox(el)) return "";
      const inp =
        el.tagName === "INPUT"
          ? el
          : el.querySelector && el.querySelector('input[role="combobox"], input[aria-autocomplete="list"]');
      return inp ? clean(inp.value) : "";
    } catch {
      return "";
    }
  }

  AF.ashby = {
    isAshbyHost,
    isAshbyPage,
    resumeInput,
    writeResumeFile,
    fieldEntryLabel,
    checkboxGroupInputs,
    isValueCombobox,
    comboboxValue,
  };
})();
