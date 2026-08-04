// Ashby (jobs.ashbyhq.com) helpers.
//
// Ashby parses an uploaded resume and autofills name/email/location/socials
// (Ashby product feature). This repo's file driver already documents that the
// convenience "Autofill from resume" zone "parses the resume and overwrites
// fields". The real Resume input (#_systemfield_resume) triggers the same
// parse - so resume MUST be attached AFTER text fields are committed, then
// text values re-applied (mirrors Lever/Breezy/Workable).
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

  AF.ashby = {
    isAshbyHost,
    isAshbyPage,
    resumeInput,
    writeResumeFile,
    fieldEntryLabel,
  };
})();
