// Lever (jobs.lever.co) application form helpers + custom drivers.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, delay, waitUntil, setNativeValue, fireInput, labelForControl } = AF.dom;

  function isLeverPage() {
    try {
      if (/\.lever\.co$/i.test(location.hostname) || /jobs\.(?:eu\.)?lever\.co/i.test(location.hostname)) {
        return !!document.querySelector(".application-form, .application-question");
      }
      return !!document.querySelector(".application-form");
    } catch {
      return false;
    }
  }

  // Question title from .application-label inside .application-question.
  function questionLabelFor(el) {
    if (!el) return "";
    try {
      const q = el.closest && el.closest("li.application-question, .application-question");
      if (!q) return "";
      const lbl = q.querySelector(".application-label");
      if (!lbl) return "";
      return clean(lbl.textContent)
        .replace(/\s*✱\s*$/, "")
        .replace(/\s*\*\s*$/, "")
        .slice(0, 200);
    } catch {}
    return "";
  }

  // Checkbox / radio option text from .application-answer-alternative.
  function optionLabelFor(inp) {
    if (!inp) return "";
    try {
      const wrap = inp.closest && inp.closest("label");
      if (wrap) {
        const alt = wrap.querySelector(".application-answer-alternative");
        if (alt && clean(alt.textContent)) return clean(alt.textContent).slice(0, 200);
      }
    } catch {}
    return labelForControl(inp);
  }

  function shouldSkipControl(el) {
    if (!el) return true;
    try {
      if (el.closest && el.closest(".awli-application-row, .awli-button-container")) return true;
      if (el.id === "customPronounsOption") return true;
      if (el.id === "selected-location") return true;
      if (el.name === "selectedLocation" && (el.type || "").toLowerCase() === "hidden") return true;
    } catch {}
    return false;
  }

  function shouldSkipSubtree(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.matches && el.matches(".awli-application-row")) return true;
    } catch {}
    return false;
  }

  function resumeInput() {
    return (
      document.getElementById("resume-upload-input") ||
      document.querySelector('input.application-file-input[name="resume"], input[data-qa="input-resume"]')
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

  function hiddenLocationField(scope) {
    const q = (scope && scope.closest && scope.closest(".application-question")) || scope;
    return (
      (q && q.querySelector('[name="selectedLocation"], #selected-location')) ||
      document.getElementById("selected-location")
    );
  }

  async function pickAutocompleteOption(input, value) {
    const want = normText(value);
    if (!want) return false;
    const field = input.closest && input.closest(".application-field");
    const box = (field && field.querySelector(".dropdown-results")) || document.querySelector(".dropdown-results");
    if (!box) return false;
    const items = [...box.querySelectorAll("li, .dropdown-result, [class*='dropdown-result'], [class*='result-item']")].filter(
      (n) => clean(n.textContent)
    );
    if (!items.length) {
      await waitUntil(() => {
        const fresh = box.querySelectorAll("li, .dropdown-result, [class*='dropdown-result'], [class*='result-item']");
        return fresh.length ? fresh : null;
      }, 2500, 80);
    }
    const opts = [...box.querySelectorAll("li, .dropdown-result, [class*='dropdown-result'], [class*='result-item']")].filter(
      (n) => clean(n.textContent)
    );
    let pick = null;
    for (const o of opts) {
      const t = normText(o.textContent);
      if (t === want || (t && (t.includes(want) || want.includes(t)))) {
        pick = o;
        break;
      }
    }
    if (!pick && opts.length) pick = opts[0];
    if (!pick) return false;
    pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    pick.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      pick.click();
    } catch {}
    await delay(120);
    return true;
  }

  async function writeLocationInput(input, value) {
    const text = clean(value);
    if (!input || !text) return false;
    input.focus && input.focus();
    setNativeValue(input, text);
    fireInput(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    await delay(350);
    const picked = await pickAutocompleteOption(input, text);
    const hidden = hiddenLocationField(input);
    if (hidden && !clean(hidden.value)) {
      hidden.value = text;
      hidden.dispatchEvent(new Event("input", { bubbles: true }));
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    }
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return picked || clean(input.value) !== "";
  }

  async function writeUniversityInput(input, value) {
    const text = clean(value);
    if (!input || !text) return false;
    const uni = input.closest && input.closest(".application-university, .application-question");
    if (uni && uni.classList && uni.classList.contains("application-university")) {
      try {
        uni.click();
      } catch {}
      await delay(150);
    }
    input.focus && input.focus();
    setNativeValue(input, text);
    fireInput(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    await delay(200);
    if (!(await pickAutocompleteOption(input, text))) {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13 }));
    }
    return clean(input.value) !== "";
  }

  function pronounsExtraOptions() {
    const out = [];
    try {
      const useName = document.getElementById("useNameOnlyPronounsOption");
      if (useName) out.push(clean(optionLabelFor(useName)) || "Use name only");
      const custom = document.getElementById("customPronounsOption");
      if (custom) out.push(clean(optionLabelFor(custom)) || "Custom");
    } catch {}
    return out;
  }

  async function writePronounsCustom(customText) {
    const cb = document.getElementById("customPronounsOption");
    const field = document.getElementById("customPronounsTextField");
    if (cb && !cb.checked) {
      cb.click();
      await delay(100);
    }
    if (field) {
      try {
        field.style.display = "";
      } catch {}
      return AF.native.setTextInput(field, clean(customText));
    }
    return !!cb && cb.checked;
  }

  function isPronounsGroup(root) {
    return (root.name || "") === "pronouns" && questionLabelFor(root).toLowerCase().includes("pronoun");
  }

  // Lever location autocomplete: #location-input + hidden selectedLocation.
  AF.registerDriver({
    type: "lever-location",
    priority: 12,
    match(el) {
      if (!isLeverPage()) return null;
      if (el.tagName !== "INPUT") return null;
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden" || t === "file") return null;
      if (el.id === "location-input" || el.classList.contains("location-input") || el.getAttribute("data-qa") === "location-input") {
        return el;
      }
      return null;
    },
    cidEl(root) {
      return root;
    },
    extract(root) {
      return {
        kind: "text",
        label: questionLabelFor(root) || "Current location",
        required: !!root.required,
        constraints: AF.dom.constraintsOf(root),
      };
    },
    isFilled(root) {
      const hidden = hiddenLocationField(root);
      if (hidden && clean(hidden.value)) return true;
      return clean(root.value) !== "";
    },
    async write(root, answer) {
      return writeLocationInput(root, answer.value || answer.option || "");
    },
  });

  // Lever university picker: .application-university with a search input.
  AF.registerDriver({
    type: "lever-university",
    priority: 12,
    match(el) {
      if (!isLeverPage()) return null;
      if (el.tagName !== "INPUT") return null;
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden" || t === "file" || t === "checkbox" || t === "radio") return null;
      const q = el.closest && el.closest(".application-university, li.application-university");
      if (q) return el;
      if (el.type === "search" && el.closest && el.closest(".application-question")) return el;
      return null;
    },
    cidEl(root) {
      return root;
    },
    extract(root) {
      return {
        kind: "text",
        label: questionLabelFor(root) || "University",
        required: !!root.required,
        constraints: AF.dom.constraintsOf(root),
      };
    },
    isFilled(root) {
      return clean(root.value) !== "";
    },
    async write(root, answer) {
      return writeUniversityInput(root, answer.value || answer.option || "");
    },
  });

  AF.lever = {
    isLeverPage,
    questionLabelFor,
    optionLabelFor,
    shouldSkipControl,
    shouldSkipSubtree,
    resumeInput,
    writeResumeFile,
    pronounsExtraOptions,
    writePronounsCustom,
    isPronounsGroup,
  };
})();
