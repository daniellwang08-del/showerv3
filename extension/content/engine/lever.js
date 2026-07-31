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

  function locationDropdownBox(input) {
    const field = input && input.closest && input.closest(".application-field");
    return (field && field.querySelector(".dropdown-results")) || document.querySelector(".dropdown-results");
  }

  function locationDropdownItems(box) {
    if (!box) return [];
    return [...box.querySelectorAll("li, .dropdown-result, [class*='dropdown-result'], [class*='result-item']")].filter(
      (n) => clean(n.textContent)
    );
  }

  function pressKey(el, key, code, keyCode) {
    if (!el) return;
    try {
      el.focus && el.focus();
    } catch {}
    const opts = { bubbles: true, cancelable: true, key, code, keyCode, which: keyCode };
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, opts));
    }
  }

  function isUsCountryToken(s) {
    return /^(united states( of america)?|u\.?s\.?a?\.?)$/i.test(clean(s || ""));
  }

  // Lever's Current location geocoder expects "City, State, Country"
  // (e.g. "Newark, CA, USA") and only commits when a dropdown result is chosen.
  function normalizeLeverLocation(value) {
    const text = clean(value);
    if (!text) return "";
    const parts = text.split(",").map((x) => clean(x)).filter(Boolean);
    if (!parts.length) return text;
    if (parts.length >= 3) {
      if (isUsCountryToken(parts[parts.length - 1])) parts[parts.length - 1] = "USA";
      return parts.slice(0, 3).join(", ");
    }
    if (parts.length === 2) {
      const second = parts[1];
      if (isUsCountryToken(second)) return `${parts[0]}, USA`;
      // US state code / common 2-letter region → append USA for the geocoder.
      if (/^[A-Za-z]{2}$/.test(second)) return `${parts[0]}, ${second.toUpperCase()}, USA`;
      return `${parts[0]}, ${second}`;
    }
    return parts[0];
  }

  // Ordered geocoder queries: full City/State/Country first, then shorter fallbacks.
  function leverLocationQueries(value) {
    const normalized = normalizeLeverLocation(value);
    const parts = normalized.split(",").map((x) => clean(x)).filter(Boolean);
    const out = [];
    if (parts.length >= 3) {
      out.push(parts.join(", "));
      if (/^usa$/i.test(parts[2])) out.push(`${parts[0]}, ${parts[1]}, US`);
      out.push(`${parts[0]}, ${parts[1]}`);
      out.push(parts[0]);
    } else if (parts.length === 2) {
      out.push(normalized);
      out.push(parts[0]);
    } else if (parts.length === 1) {
      out.push(parts[0]);
    }
    return [...new Set(out)].filter(Boolean);
  }

  function locationIsCommitted(input) {
    const hidden = hiddenLocationField(input);
    return !!(hidden && clean(hidden.value));
  }

  async function waitLocationCommitted(input, timeout = 1400) {
    return !!(await waitUntil(() => (locationIsCommitted(input) ? true : null), timeout, 60));
  }

  async function waitForLocationDropdown(input, timeout = 2800) {
    return waitUntil(() => {
      const items = locationDropdownItems(locationDropdownBox(input));
      return items.length ? items : null;
    }, timeout, 80);
  }

  async function pickAutocompleteOption(input, value) {
    const want = normText(value);
    const box = locationDropdownBox(input);
    if (!box) return false;
    let opts = locationDropdownItems(box);
    if (!opts.length) {
      await waitUntil(() => {
        const fresh = locationDropdownItems(box);
        return fresh.length ? fresh : null;
      }, 2500, 80);
      opts = locationDropdownItems(box);
    }
    let pick = null;
    if (want) {
      for (const o of opts) {
        const t = normText(o.textContent);
        if (t === want || (t && (t.includes(want) || want.includes(t)))) {
          pick = o;
          break;
        }
      }
    }
    // Lever requires selecting a suggestion; top result is the intended pick.
    if (!pick && opts.length) pick = opts[0];
    if (!pick) return false;
    pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    pick.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      pick.click();
    } catch {}
    await delay(150);
    return true;
  }

  async function typeLocationQuery(input, text) {
    try {
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {}
    }
    setNativeValue(input, "");
    fireInput(input);
    await delay(60);
    // Progressive updates so Lever's async geocoder debounce sees typing like a
    // human (bulk setNativeValue alone often never opens .dropdown-results).
    let built = "";
    for (const ch of String(text)) {
      built += ch;
      setNativeValue(input, built);
      fireInput(input);
      await delay(20);
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function writeLocationInput(input, value) {
    const queries = leverLocationQueries(value);
    if (!input || !queries.length) return false;

    for (const text of queries) {
      await typeLocationQuery(input, text);

      const items = await waitForLocationDropdown(input, 3000);
      if (!items || !items.length) continue;

      // Primary commit: Enter selects the top/highlighted geocoder result.
      pressKey(input, "Enter", "Enter", 13);
      if (await waitLocationCommitted(input, 1400)) {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return true;
      }

      // Some Lever builds need ArrowDown to highlight before Enter commits.
      pressKey(input, "ArrowDown", "ArrowDown", 40);
      await delay(80);
      pressKey(input, "Enter", "Enter", 13);
      if (await waitLocationCommitted(input, 1200)) {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return true;
      }

      // Click fallback on the matching / top dropdown row.
      if (await pickAutocompleteOption(input, text)) {
        if (await waitLocationCommitted(input, 1200)) {
          input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          return true;
        }
      }
    }

    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // Only succeed when Lever actually committed selectedLocation — faking the
    // hidden field fails server-side validation on submit.
    return locationIsCommitted(input);
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
      // Visible text alone is not enough — Lever only accepts a dropdown pick
      // that populates hidden selectedLocation.
      return locationIsCommitted(root);
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
