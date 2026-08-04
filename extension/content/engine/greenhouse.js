// Greenhouse (boards.greenhouse.io / job-boards embed) helpers.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, delay, waitUntil, isVisible, setNativeValue, fireInput, labelForControl } = AF.dom;

  function isGreenhouseHost() {
    try {
      return /(?:^|\.)greenhouse\.io$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  function hasApplicationRoot() {
    try {
      return !!document.querySelector(
        'form#application-form, form.application--form, .application--container, .application--form'
      );
    } catch {
      return false;
    }
  }

  function isApplicationFrame() {
    return isGreenhouseHost() && hasApplicationRoot();
  }

  function isEmbedParent() {
    try {
      if (window.top !== window) return false;
      return !!document.querySelector(
        'iframe[src*="greenhouse.io"][src*="embed/job_app"], iframe[src*="greenhouse.io/embed/job_app"]'
      );
    } catch {
      return false;
    }
  }

  function embedIframe() {
    try {
      if (window.top !== window) return null;
      return (
        document.querySelector('iframe[src*="greenhouse.io/embed/job_app"]') ||
        document.querySelector('iframe[src*="greenhouse.io"][src*="job_app"]')
      );
    } catch {
      return null;
    }
  }

  AF.greenhouse = {
    isGreenhouseHost,
    hasApplicationRoot,
    isApplicationFrame,
    isEmbedParent,
    embedIframe,
  };

  // ── Location (City) typeahead ───────────────────────────────────────────────
  //
  // Greenhouse's Location field is a react-aria combobox (role="combobox",
  // aria-autocomplete="list") backed by an async, debounced geocoder
  // (api-geocode-earth-proxy.greenhouse.io). It renders a role="listbox" of
  // role="option" rows as you type, and ONLY commits when an option is picked -
  // which populates the field's hidden latitude/longitude inputs. Per Greenhouse's
  // public Job Board API, if `location` is submitted without latitude/longitude it
  // is IGNORED entirely, and the form rejects the submit with a "Location required"
  // error even though the visible box shows the typed text.
  //
  // The generic react-select driver cannot fill this: (1) it sets the value with a
  // single bulk setNativeValue + one input event, which usually does not trip the
  // debounced geocoder, so the listbox never opens and Enter commits nothing; and
  // (2) it verifies success by looking for a .select__single-value chip node that a
  // react-aria combobox never renders, so even a real pick is reported "skipped".
  // We therefore own this field here - progressive typing to trip the geocoder,
  // wait for the listbox, commit via Enter / ArrowDown+Enter / click the top row,
  // and verify the hidden lat/lng actually committed (mirrors lever-location).

  function isUsCountryToken(s) {
    return /^(united states( of america)?|u\.?s\.?a?\.?)$/i.test(clean(s || ""));
  }

  // A TRAILING country token the Greenhouse Location combobox does NOT want. The
  // autofill prompt makes the model output "City, State, Country" (e.g.
  // "Newark, CA, USA"), but the geocoder (api-geocode-earth-proxy) matches on
  // "City, Region" - appending the country empties/degrades the suggestion list,
  // so the dropdown never opens. Only ever tested against the LAST comma part.
  function isCountryToken(s) {
    const t = clean(s || "");
    if (!t) return false;
    return (
      isUsCountryToken(t) ||
      /^(us|usa)$/i.test(t) ||
      /^(canada|can)$/i.test(t) ||
      /^(united kingdom|u\.?k\.?|great britain|england|scotland|wales)$/i.test(t) ||
      /^(australia|aus|new zealand|india|ireland|germany|france|spain|italy|portugal|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|mexico|brazil|argentina|japan|china|singapore|philippines|indonesia|malaysia|vietnam|south africa|nigeria|kenya|egypt|uae|united arab emirates|israel|turkey|greece)$/i.test(
        t
      )
    );
  }

  // Ordered geocoder queries, SHORTEST-useful first. We type "City, State" up
  // front (what the dropdown matches best) and NEVER lead with the full
  // country-appended string: typing "Newark, CA, USA" makes the geocoder return
  // nothing, so the old code wasted the whole 3s dropdown timeout before falling
  // back. City-only is kept as a last resort.
  function locationQueries(value) {
    const text = clean(value);
    if (!text) return [];
    let parts = text.split(",").map((x) => clean(x)).filter(Boolean);
    // Drop a trailing country token so we submit "City, State" (per the prompt
    // the model's 3rd part is the country).
    if (parts.length >= 3 && isCountryToken(parts[parts.length - 1])) {
      parts = parts.slice(0, -1);
    }
    const out = [];
    if (parts.length >= 2) {
      // "City, State" - the geocoder's best match; commit on the first attempt.
      out.push(`${parts[0]}, ${parts[1]}`);
      // Uppercase a 2-letter state code ("ca" -> "CA") as an equivalent variant.
      if (/^[A-Za-z]{2}$/.test(parts[1]) && !isCountryToken(parts[1])) {
        out.push(`${parts[0]}, ${parts[1].toUpperCase()}`);
      }
      out.push(parts[0]);
    } else if (parts.length === 1) {
      out.push(parts[0]);
    }
    return [...new Set(out)].filter(Boolean);
  }

  function locationFieldBlock(el) {
    return (
      (el.closest &&
        (el.closest('[class*="field"]') ||
          el.closest('[class*="question"]') ||
          el.closest("fieldset") ||
          el.closest("label"))) ||
      el.parentElement ||
      el
    );
  }

  // Hidden latitude/longitude inputs that ONLY get set when a suggestion commits.
  // They live in the same field block as the visible combobox.
  function locationHiddenFields(el) {
    const out = [];
    const scopes = [locationFieldBlock(el), el.parentElement, document.getElementById("application-form")].filter(
      Boolean
    );
    for (const scope of scopes) {
      try {
        scope.querySelectorAll('input[type="hidden"]').forEach((h) => {
          const key = ((h.name || "") + " " + (h.id || "")).toLowerCase();
          if (/(^|[^a-z])(lat|latitude|lng|lon|long|longitude)([^a-z]|$)/.test(key)) out.push(h);
        });
      } catch {}
      if (out.length) break;
    }
    return [...new Set(out)];
  }

  function locationIsCommitted(el) {
    const hidden = locationHiddenFields(el);
    if (hidden.length) return hidden.some((h) => clean(h.value));
    // No hidden fields locatable in this build: fall back to "the box shows a
    // multi-part geocoded value" (a picked result is "City, Region, Country",
    // never a bare fragment the user typed).
    const v = clean(el.value);
    return !!v && v.split(",").filter(Boolean).length >= 2;
  }

  // The listbox belonging to THIS combobox (aria-controls / aria-owns), plus
  // legacy fallbacks (Google Places .pac-container, jQuery-UI .ui-autocomplete).
  function locationOptionNodes(input) {
    const nodes = [];
    const push = (list) => {
      if (!list) return;
      list.forEach((n) => {
        try {
          if (clean(n.textContent) && isVisible(n)) nodes.push(n);
        } catch {}
      });
    };
    try {
      const id = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
      const lb = id && document.getElementById(id);
      if (lb) push(lb.querySelectorAll('[role="option"], li[role="option"]'));
    } catch {}
    if (!nodes.length) {
      const active = document.querySelector('[role="listbox"]');
      if (active) push(active.querySelectorAll('[role="option"], li[role="option"]'));
    }
    push(document.querySelectorAll(".pac-container .pac-item"));
    push(document.querySelectorAll("ul.ui-autocomplete li.ui-menu-item, ul.ui-autocomplete li"));
    return [...new Set(nodes)];
  }

  function pressKey(el, key, keyCode) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, key, code: key, keyCode, which: keyCode };
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, opts));
    }
  }

  // Open/activate the react-aria combobox BEFORE typing. These widgets ignore
  // programmatic `input` events while the popup is closed, so we must first put
  // the field into its open state with the full pointer+mouse+click sequence
  // (libraries disagree on which event opens the menu) plus an ArrowDown fallback,
  // exactly like the react-select driver's openCombo. Without this, the geocoder
  // never fires and the suggestion listbox never mounts.
  function openLocationCombo(input) {
    try {
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {}
    }
    try {
      input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    try {
      input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    } catch {}
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    try {
      input.click();
    } catch {}
    pressKey(input, "ArrowDown", 40);
  }

  // Type character-by-character so the debounced geocoder fires like real typing;
  // a single bulk setNativeValue frequently never opens the suggestion listbox.
  // The combobox must already be open (see openLocationCombo) before we type.
  async function typeLocationQuery(input, text) {
    openLocationCombo(input);
    await delay(120);
    setNativeValue(input, "");
    fireInput(input);
    await delay(60);
    let built = "";
    for (const ch of String(text)) {
      built += ch;
      // Fire a key event pair around each character so react-aria's keyboard
      // handlers register the interaction and keep the popup open.
      pressKey(input, ch, ch.charCodeAt(0));
      setNativeValue(input, built);
      fireInput(input);
      await delay(30);
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function clickBestOption(input, want) {
    const opts = locationOptionNodes(input);
    if (!opts.length) return false;
    const w = normText(want);
    let pick = null;
    if (w) {
      for (const o of opts) {
        const t = normText(o.textContent);
        if (t === w || (t && (t.includes(w) || w.includes(t)))) {
          pick = o;
          break;
        }
      }
    }
    // The geocoder ranks the best match first; when nothing matches by text the
    // top row is the intended pick (exactly what pressing Enter would select).
    if (!pick) pick = opts[0];
    try {
      pick.scrollIntoView && pick.scrollIntoView({ block: "nearest" });
    } catch {}
    pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    pick.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try {
      pick.click();
    } catch {}
    await delay(120);
    return true;
  }

  async function writeLocationInput(input, value) {
    const queries = locationQueries(value);
    if (!input || !queries.length) return false;
    if (locationIsCommitted(input) && normText(input.value).includes(normText(queries[queries.length - 1]))) {
      return true;
    }

    for (const text of queries) {
      await typeLocationQuery(input, text);

      const opened = await waitUntil(() => (locationOptionNodes(input).length ? true : null), 3000, 80);
      if (!opened) continue;

      // Primary: Enter commits the highlighted (top) geocode result.
      pressKey(input, "Enter", 13);
      if (await waitUntil(() => (locationIsCommitted(input) ? true : null), 1400, 60)) {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return true;
      }

      // Some builds need ArrowDown to highlight the first row before Enter commits.
      pressKey(input, "ArrowDown", 40);
      await delay(80);
      pressKey(input, "Enter", 13);
      if (await waitUntil(() => (locationIsCommitted(input) ? true : null), 1200, 60)) {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return true;
      }

      // Click fallback on the matching / top dropdown row (react-aria commits the
      // selection and fills the hidden lat/lng on mousedown+click).
      if (await clickBestOption(input, text)) {
        if (await waitUntil(() => (locationIsCommitted(input) ? true : null), 1400, 60)) {
          input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          return true;
        }
      }
    }

    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // Only succeed when the pick actually committed - a typed-but-uncommitted
    // value is dropped by Greenhouse on submit.
    return locationIsCommitted(input);
  }

  function locationLabelBlob(el) {
    return [
      labelForControl(el),
      el.id || "",
      el.name || "",
      (el.getAttribute && el.getAttribute("aria-label")) || "",
      (el.getAttribute && el.getAttribute("placeholder")) || "",
    ]
      .join(" ")
      .toLowerCase();
  }

  // The Location (City) combobox specifically - not EEOC / screening comboboxes
  // (whose labels are Gender/Veteran/... and which carry no lat/lng hidden inputs).
  function isLocationField(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const t = (el.type || "text").toLowerCase();
    if (["hidden", "file", "checkbox", "radio", "submit", "button", "tel", "email"].includes(t)) return false;
    const blob = locationLabelBlob(el);
    if (/\blocation\b|\bcity\b/.test(blob)) return true;
    // Attribute-agnostic fallback: a text/combobox input backed by hidden lat/lng.
    return locationHiddenFields(el).length > 0;
  }

  // Priority 12 (below react-select's 20) so we claim the Greenhouse location box
  // before the generic combobox driver. Host-gated to greenhouse.io application
  // frames so the shared "greenhouse" bundle never hijacks Lever/Ashby/etc.
  AF.registerDriver({
    type: "greenhouse-location",
    priority: 12,
    match(el) {
      if (!isApplicationFrame()) return null;
      return isLocationField(el) ? el : null;
    },
    cidEl(root) {
      return root;
    },
    extract(root) {
      return {
        kind: "text",
        label: labelForControl(root) || "Location (City)",
        required:
          !!root.required ||
          (root.getAttribute && root.getAttribute("aria-required") === "true"),
        constraints: AF.dom.constraintsOf(root),
      };
    },
    isFilled(root) {
      // Visible text is not enough - Greenhouse only accepts a committed geocode
      // pick (hidden latitude/longitude populated).
      return locationIsCommitted(root);
    },
    async write(root, answer) {
      return writeLocationInput(root, answer.value || answer.option || "");
    },
  });

  // ── required free-text safety net ───────────────────────────────────────────
  //
  // Some Greenhouse questions are REQUIRED free-text (e.g. an open-ended
  // availability / "describe your upcoming commitments" textarea). When the
  // profile has no fact for them the model returns needs_user or omits the
  // control entirely, so the field is left empty - and Greenhouse then blocks the
  // submit with "This field is required". After the model's passes, this
  // deterministically fills any still-empty VISIBLE REQUIRED free-text field with
  // "N/A" (the same convention the server prompt uses for required conditional
  // follow-ups). Restricted to <input type="text"> / <textarea>: email/tel/
  // number/url carry patterns "N/A" would fail, and select/radio/checkbox have
  // their own handling. The Location combobox and any react-select combobox input
  // are explicitly excluded. We never auto-submit; the user reviews before send.

  function ghApplicationRoot() {
    try {
      return (
        document.querySelector(
          "form#application-form, form.application--form, .application--container, .application--form"
        ) || document
      );
    } catch {
      return document;
    }
  }

  function isFreeTextFillable(el) {
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    const t = (el.type || "text").toLowerCase();
    return t === "text" || t === "";
  }

  function isRequiredField(el) {
    try {
      if (el.required || (el.getAttribute && el.getAttribute("aria-required") === "true")) return true;
      // Greenhouse marks a required question with a trailing "*" in its label.
      const lbl = labelForControl(el) || "";
      if (/\*\s*$/.test(lbl) || /\brequired\b/i.test(lbl)) return true;
    } catch {}
    return false;
  }

  function shouldSkipRequiredFill(el) {
    try {
      if (el.readOnly || el.disabled) return true;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
      // The Location combobox commits via geocode, never a free-text "N/A".
      if (isLocationField(el)) return true;
      // react-select / combobox inner inputs are filled by their own driver.
      const role = (el.getAttribute && el.getAttribute("role")) || "";
      if (role === "combobox") return true;
      if (el.getAttribute && el.getAttribute("aria-autocomplete") === "list") return true;
      if (el.getAttribute && el.getAttribute("aria-haspopup") === "listbox") return true;
      if (el.closest && el.closest('[class*="select__control"], [class*="-control"], [role="combobox"]')) return true;
    } catch {}
    return false;
  }

  function fillRequiredPlaceholders(placeholder) {
    if (!isApplicationFrame()) return 0;
    const val = placeholder || "N/A";
    const root = ghApplicationRoot();
    let count = 0;
    let controls = [];
    try {
      controls = [...root.querySelectorAll("input, textarea")];
    } catch {
      controls = [];
    }
    for (const el of controls) {
      try {
        if (!isFreeTextFillable(el)) continue;
        if (shouldSkipRequiredFill(el)) continue;
        if (!isVisible(el)) continue;
        if (!isRequiredField(el)) continue;
        if (clean(el.value)) continue; // already answered
        setNativeValue(el, val);
        fireInput(el);
        try {
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {}
        count++;
      } catch {}
    }
    return count;
  }

  AF.greenhouse.fillRequiredPlaceholders = fillRequiredPlaceholders;
})();
