// Breezy.hr (AngularJS) application form helpers.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, delay, isVisible } = AF.dom;

  function isBreezyHost() {
    try {
      return /(^|\.)breezy\.hr$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  function isBreezyPage() {
    try {
      const form =
        document.querySelector('.application-container form[name="form"]') ||
        document.querySelector('form[ng-controller*="FormWithQuestionnaire"]');
      if (!form) return false;
      if (isBreezyHost()) return true;
      const ctrl = form.getAttribute("ng-controller") || "";
      if (/FormWithQuestionnaire/i.test(ctrl)) return true;
      return !!form.querySelector(".questionnaire-section, .eeoc-form-container, input[name='cName']");
    } catch {
      return false;
    }
  }

  function titleFromH3(h) {
    if (!h) return "";
    return clean(h.textContent)
      .replace(/\s*✱\s*$/, "")
      .replace(/\s*\*\s*$/, "")
      .slice(0, 200);
  }

  // Question text from preceding <h3> (personal fields, screening, EEO).
  function questionTitleFor(el) {
    if (!el || !isBreezyPage()) return "";
    try {
      const qLi = el.closest && el.closest("li.question");
      if (qLi) {
        const h = qLi.querySelector("h3");
        if (h) return titleFromH3(h);
      }

      const section =
        (el.closest && el.closest(".section, .questionnaire-section, .eeoc-form-container")) || null;
      if (section) {
        const hdr = section.querySelector(".section-header h3");
        if (hdr && section.contains(el) && !el.closest("li.question")) return titleFromH3(hdr);

        let prev = el.previousElementSibling;
        while (prev && prev !== section) {
          if (prev.matches && prev.matches(".form-divider, .error-container, .question-body")) {
            prev = prev.previousElementSibling;
            continue;
          }
          if (prev.tagName === "H3") return titleFromH3(prev);
          if (prev.matches && prev.matches(".section-header")) {
            const h = prev.querySelector("h3");
            if (h) return titleFromH3(h);
          }
          break;
        }
      }

      // EEO veteran / disability blocks: nearest preceding <h3> (prose in between).
      let node = el;
      for (let depth = 0; depth < 30 && node; depth++) {
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.tagName === "H3") return titleFromH3(sib);
          if (sib.tagName === "HR") break;
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
        if (node && node.matches && node.matches("li.question, .multiplechoice")) {
          const h = node.querySelector("h3");
          if (h) return titleFromH3(h);
        }
      }
    } catch {}
    return "";
  }

  // Radio/checkbox option label: <label><input><span>Yes</span></label>.
  function optionLabelFor(inp) {
    if (!inp || !isBreezyPage()) return "";
    try {
      const wrap = inp.closest && inp.closest("label");
      if (wrap) {
        const sp = wrap.querySelector("span.ng-binding, span.polygot, span:not(.required)");
        if (sp && clean(sp.textContent)) return clean(sp.textContent).slice(0, 200);
      }
      const id = inp.id;
      if (id) {
        const lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lbl && clean(lbl.textContent)) return clean(lbl.textContent).slice(0, 200);
      }
    } catch {}
    return "";
  }

  function shouldSkipControl(el) {
    if (!el || !isBreezyPage()) return false;
    try {
      if (el.closest && el.closest(".apply-field-extra, .apply-buttons")) return true;
      const t = (el.type || "").toLowerCase();
      if (t === "hidden") return true;
      const id = el.id || "";
      const nm = el.name || "";
      if (/^hp_/i.test(id) || /^hp_/i.test(nm)) return true;
      if (id === "questions" || id === "form_token" || id === "questionnaireVersion" || id === "eeoc" || id === "eeocVsid") {
        return true;
      }
    } catch {}
    return false;
  }

  function resumeInput() {
    return (
      document.getElementById("main-attachment") ||
      document.querySelector('input[name="cResume"][type="file"], input.attachment[type="file"]')
    );
  }

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
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function continueButton() {
    try {
      const buttons = document.querySelectorAll(".navigation-buttons button");
      for (const b of buttons) {
        const ng = b.getAttribute("ng-click") || "";
        if (/nextSection/.test(ng) && isVisible(b) && !b.disabled) return b;
      }
    } catch {}
    return null;
  }

  async function advanceSection() {
    const btn = continueButton();
    if (!btn) return { advanced: false };
    try {
      btn.click();
    } catch {}
    await delay(500);
    return { advanced: true };
  }

  AF.breezy = {
    isBreezyHost,
    isBreezyPage,
    questionTitleFor,
    optionLabelFor,
    shouldSkipControl,
    resumeInput,
    writeResumeFile,
    advanceSection,
    continueButton,
  };
})();
