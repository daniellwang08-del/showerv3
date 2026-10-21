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

  function attachResumeFile(el, fileData) {
    const bin = atob(fileData.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const name = fileData.filename || "resume.pdf";
    const file = new File([bytes], name, {
      type: fileData.mime || (/\.docx$/i.test(name)
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/pdf"),
    });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    // One change event: parseResume.js posts the file to /parseResume and
    // application.js shows the filename chip. A second change would abort and
    // restart the parse request.
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return !!(el.files && el.files.length);
  }

  // Fields parseResume.js overwrites with parsed values (or "") unless a
  // change/paste event marked them as touched. The hidden selectedLocation has
  // no touch listener at all, so it is always overwritten.
  const PARSED_FIELD_SELECTOR = [
    "input[name=org]",
    "input[name=phone]",
    "input[name=name]",
    "input[name=email]",
    "input[name=location]",
    "input[name=selectedLocation]",
    'input[name^="urls["]',
    '[name^="residentialLocation["]',
  ].join(", ");

  function snapshotParsedFields(form) {
    return [...(form || document).querySelectorAll(PARSED_FIELD_SELECTOR)]
      .map((el) => ({ el, value: el.value || "" }))
      .filter((s) => s.value !== "");
  }

  function restoreParsedFields(snapshot) {
    let restored = 0;
    for (const { el, value } of snapshot) {
      if (!el.isConnected || el.value === value) continue;
      setNativeValue(el, value);
      // Location text must not get input/blur: that reopens the geocoder and
      // its blur handler wipes the committed selection. Plain fields get a
      // change so parseResume.js treats them as user-edited from now on.
      if (el.type !== "hidden" && !isLocationInput(el)) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      restored += 1;
    }
    return restored;
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    try {
      return getComputedStyle(el).display !== "none";
    } catch {
      return false;
    }
  }

  // Wait for Lever's /parseResume round trip to finish. "parsed" and
  // "unreadable" both keep the attached file for submission; "too_large" means
  // Lever rejected it.
  async function waitForResumeParse(timeout) {
    const q = (sel) => document.querySelector(sel);
    const outcome = () => {
      if (isShown(q(".resume-upload-working"))) return null;
      if (isShown(q(".resume-upload-oversize"))) return "too_large";
      if (isShown(q(".resume-upload-success"))) return "parsed";
      if (isShown(q(".resume-upload-failure"))) return "unreadable";
      return null;
    };
    return (await waitUntil(outcome, timeout, 100)) || "timeout";
  }

  /** Attach the resume, let Lever parse it, then put back every value the
   *  parse overwrote. Returns { uploaded, parse, restored, filename }. */
  async function uploadResume(fileData, { parseTimeout = 30000 } = {}) {
    const el = resumeInput();
    if (!el || !fileData || !fileData.base64) return { uploaded: false, parse: "no_input" };
    const snapshot = snapshotParsedFields(el.form);
    // Mark our filled fields as user-edited so parseResume.js leaves them alone
    // on its own; the restore below covers anything it still overwrites.
    for (const { el: field } of snapshot) {
      if (field.type !== "hidden" && !isLocationInput(field)) {
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    let attached = false;
    try {
      attached = attachResumeFile(el, fileData);
    } catch {
      attached = false;
    }
    if (!attached) return { uploaded: false, parse: "attach_failed" };
    const parse = await waitForResumeParse(parseTimeout);
    const restored = restoreParsedFields(snapshot);
    const file = el.files && el.files[0];
    return {
      uploaded: !!file && parse !== "too_large",
      parse,
      restored,
      filename: file ? file.name : "",
    };
  }

  function writeResumeFile(fileData) {
    const el = resumeInput();
    if (!el || !fileData || !fileData.base64) return false;
    try {
      return attachResumeFile(el, fileData);
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

  // retrieveLocations.js renders each geocoder hit as
  // <div class="dropdown-location" id="location-N"> inside .dropdown-results.
  function locationDropdownItems(box) {
    if (!box) return [];
    return [
      ...box.querySelectorAll(".dropdown-location, li, .dropdown-result, [class*='result-item']"),
    ].filter((n) => clean(n.textContent));
  }

  function isLocationInput(el) {
    return (
      !!el &&
      el.tagName === "INPUT" &&
      (el.id === "location-input" ||
        (el.classList && el.classList.contains("location-input")) ||
        el.getAttribute("data-qa") === "location-input")
    );
  }

  // Inputs whose value is only valid when picked from a Lever dropdown. Re-firing
  // input/blur on them (commitPrefilled) reopens the dropdown and Lever's blur
  // handler then clears both the text and the hidden selectedLocation.
  function isAutocompleteInput(el) {
    if (!el || !isLeverPage()) return false;
    if (isLocationInput(el)) return true;
    try {
      return !!(el.closest && el.closest(".application-university"));
    } catch {
      return false;
    }
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
    // Lever commits on mousedown and reads event.target.id / textContent, so the
    // event must target the .dropdown-location row itself, never a child.
    pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
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
    // retrieveLocations.js only searches from its keydown handler (debounced
    // 500 ms); input events merely show the dropdown container. Send a keydown
    // per character, like a person typing, so /searchLocations actually runs.
    let built = "";
    for (const ch of String(text)) {
      built += ch;
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: ch }));
      setNativeValue(input, built);
      fireInput(input);
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: ch }));
      await delay(20);
    }
  }

  async function writeLocationInput(input, value) {
    const queries = leverLocationQueries(value);
    if (!input || !queries.length) return false;

    for (const text of queries) {
      await typeLocationQuery(input, text);

      // Geocoder answers after the 500 ms debounce plus a network round trip.
      const items = await waitForLocationDropdown(input, 6000);
      if (!items || !items.length) continue;

      // Primary commit: mousedown on the matching (or top) row, Lever's own
      // click path. A bare Enter with nothing highlighted would blank the input.
      if (await pickAutocompleteOption(input, text)) {
        if (await waitLocationCommitted(input, 1200)) {
          input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          return true;
        }
      }

      // Keyboard fallback: highlight the first row, then Enter.
      if (locationDropdownItems(locationDropdownBox(input)).length) {
        pressKey(input, "ArrowDown", "ArrowDown", 40);
        await delay(80);
        pressKey(input, "Enter", "Enter", 13);
        if (await waitLocationCommitted(input, 1200)) {
          input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          return true;
        }
      }
    }

    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // Only succeed when Lever actually committed selectedLocation, faking the
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
      // Visible text alone is not enough, Lever only accepts a dropdown pick
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
    uploadResume,
    isAutocompleteInput,
    writeLocationInput,
    pronounsExtraOptions,
    writePronounsCustom,
    isPronounsGroup,
  };
})();
