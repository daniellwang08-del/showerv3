// SmartRecruiters screening-question dropdown driver.
//
// Every screening question on the later steps — single-select, yes/no, and the
// long "pick a range" lists — is the SAME widget: an
//   <spl-autocomplete id="question_<uuid>" name="question_<uuid>">
// whose choices are <spl-select-option> nodes inside a shadow listbox, each
// carrying clean text in <spl-truncate title="...">. A custom Lit widget will
// NOT accept a value just by setting text on its inner <input>, so we:
//   harvestOptions -> open it, read every option label (for the LLM), close it
//   write          -> open it and CLICK the option whose label matches the LLM's
//                     answer, then let it commit
// Gated to SmartRecruiters (deepCollect) and matched only to question_* widgets,
// so location/experience autocompletes and every other engine are untouched.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const clean = AF.dom.clean || ((s) => (s || "").replace(/\s+/g, " ").trim());
  const waitUntil = AF.dom.waitUntil ? AF.dom.waitUntil : async () => null;

  function deepActive() {
    try {
      return typeof AF.deepCollect === "function" && AF.deepCollect();
    } catch {
      return false;
    }
  }

  // Query across (open) shadow roots starting at `root`.
  function deepQuery(root, sel) {
    const out = [];
    const visit = (el) => {
      if (!el || el.nodeType !== 1) return;
      try {
        if (el.matches && el.matches(sel)) out.push(el);
      } catch {}
      if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c);
      const kids = el.children;
      if (kids) for (const c of kids) visit(c);
    };
    if (root && root.nodeType === 1) visit(root);
    return out;
  }
  const deepOne = (r, s) => deepQuery(r, s)[0] || null;

  // Climb across shadow boundaries to the nearest ancestor matching `tag`.
  function closestHost(el, tag) {
    let node = el;
    for (let i = 0; node && i < 16; i++) {
      if (node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === tag) return node;
      const p = node.parentNode;
      node = p && p.nodeType === 11 && p.host ? p.host : p;
    }
    return null;
  }

  function isQuestion(host) {
    if (!host) return false;
    const id = (host.getAttribute && (host.getAttribute("id") || host.getAttribute("name"))) || "";
    if (/^question_/.test(id)) return true;
    try {
      return !!(host.closest && host.closest("sr-question-field-select"));
    } catch {
      return false;
    }
  }

  function inputOf(host) {
    return deepOne(host, 'input[role="combobox"], input.c-spl-input, input.c-spl-multiselect-autocomplete-input');
  }
  function cssEsc(s) {
    try {
      return CSS.escape(s);
    } catch {
      return String(s).replace(/[^\w-]/g, "\\$&");
    }
  }
  function isMenuVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    } catch {}
    return true;
  }

  // Read the option elements out of a resolved menu element. The dropdown body is
  // a <spl-keyboard-list-navigator> with the choices assigned to its
  // <slot name="menu">; the choices themselves are usually <spl-select-option>,
  // but we DON'T depend on that tag — we also read the slot's assignedElements so
  // any option markup works.
  function optionsInMenu(menu) {
    if (!menu) return [];
    let opts = deepQuery(menu, "spl-select-option");
    if (opts.length) return opts;
    opts = deepQuery(menu, '[role="option"]');
    if (opts.length) return opts;
    const slot = deepOne(menu, 'slot[name="menu"]');
    if (slot && slot.assignedElements) {
      const out = [];
      for (const a of slot.assignedElements()) {
        const inner = deepQuery(a, 'spl-select-option, [role="option"]');
        if (inner.length) out.push(...inner);
        else out.push(a);
      }
      if (out.length) return out;
    }
    return [];
  }

  // Resolve options ONLY for `host`'s currently-open menu. Console evidence:
  // - 11 `.c-spl-dropdown-menu-wrapper` nodes exist in the DOM at once
  // - `wrapper contains sample (deep)? false` — options are NOT descendants of the wrapper
  // - 5 visible `spl-select-option` appear only after THIS input's aria-expanded=true
  // A global spl-select-option scan without scoping assigns wrong/empty options when
  // harvesting many selects sequentially (→ LLM "No options provided in HTML").
  function optionEls(host) {
    const input = inputOf(host);
    if (!input) return [];

    const inlined = deepQuery(host, "spl-select-option");
    if (inlined.length) return inlined;

    if (input.getAttribute("aria-expanded") !== "true") return [];

    const ctrl = input.getAttribute("aria-controls");
    if (ctrl) {
      let m = null;
      try {
        m = document.getElementById(ctrl);
      } catch {}
      if (!m) m = deepOne(document.documentElement, "#" + cssEsc(ctrl));
      if (m) {
        const opts = optionsInMenu(m);
        if (opts.length) return opts;
      }
    }

    for (const w of deepQuery(document.documentElement, ".c-spl-dropdown-menu-wrapper, .c-spl-dropdown-menu")) {
      if (w.getAttribute && w.getAttribute("aria-hidden") === "true") continue;
      if (!isMenuVisible(w)) continue;
      const opts = optionsInMenu(w);
      if (opts.length) return opts;
    }

    const expanded = deepQuery(document.documentElement, 'input[role="combobox"][aria-expanded="true"]');
    if (expanded.length === 1 && expanded[0] === input) {
      return deepQuery(document.documentElement, "spl-select-option").filter(isMenuVisible);
    }
    return [];
  }
  // spl-multiselect-autocomplete renders an ALWAYS-present spl-tags-list wrapper
  // whose class is `c-spl-multiselect-autocomplete-tags` — the old `[class*="tag"]`
  // selector matched that empty shell and reported isFilled=true, so the control
  // was skipped entirely (Value is required on an untouched field).
  function multiselectHasSelection(host) {
    if (deepQuery(host, "spl-tag").length) return true;
    if (deepOne(host, ".c-spl-tags-list-item, .c-spl-tag")) return true;
    return false;
  }

  function questionLabel(host) {
    let label = clean(host.getAttribute("aria-label") || "").replace(/^select\s+/i, "");
    if (!label) {
      const sp = host.querySelector && host.querySelector('[slot="label-content"]');
      if (sp) label = clean(sp.textContent);
    }
    if (!label && AF.dom && AF.dom.labelForControl) {
      const inp = inputOf(host);
      if (inp) label = clean(AF.dom.labelForControl(inp));
    }
    return label || "Question";
  }

  function optionLabel(opt) {
    const tr = deepOne(opt, "spl-truncate[title]");
    if (tr) {
      const t = clean(tr.getAttribute("title"));
      if (t) return t;
    }
    const def = deepOne(opt, ".c-spl-autocomplete-option-content");
    if (def) {
      const t = clean(def.textContent);
      if (t) return t;
    }
    return clean(opt.textContent);
  }

  // Full, shadow-crossing pointer+click sequence (every event composed:true so it
  // escapes the spl-* shadow root to the Lit/Angular handler).
  function fireClick(el) {
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
    const P = typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
    for (const [type, Ctor] of [
      ["pointerdown", P],
      ["mousedown", MouseEvent],
      ["pointerup", P],
      ["mouseup", MouseEvent],
    ]) {
      try {
        el.dispatchEvent(new Ctor(type, base));
      } catch {}
    }
    try {
      el.click();
    } catch {
      try {
        el.dispatchEvent(new MouseEvent("click", base));
      } catch {}
    }
  }

  function isOpen(host) {
    const input = inputOf(host);
    return !!(input && input.getAttribute("aria-expanded") === "true");
  }

  async function closeMenuAndWait(host) {
    closeMenu(host);
    await waitUntil(() => {
      const input = inputOf(host);
      return !input || input.getAttribute("aria-expanded") !== "true" ? true : null;
    }, 1200, 60);
    await new Promise((r) => setTimeout(r, 80));
  }

  async function openMenu(host) {
    const input = inputOf(host);
    if (!input) return false;
    // Close any other open SR combobox first so portaled menus don't cross-contaminate
    // option harvesting (11 wrappers stay mounted; only one should be expanded).
    for (const other of deepQuery(document.documentElement, 'input[role="combobox"][aria-expanded="true"]')) {
      if (other === input) continue;
      const oh =
        closestHost(other, "spl-autocomplete") || closestHost(other, "spl-multiselect-autocomplete");
      if (oh) await closeMenuAndWait(oh);
    }
    if (!isOpen(host) || !optionEls(host).length) {
      fireClick(input);
      try {
        input.focus({ preventScroll: true });
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {}
    }
    await waitUntil(() => {
      const i = inputOf(host);
      return i && i.getAttribute("aria-expanded") === "true" && optionEls(host).length ? true : null;
    }, 2200, 80);
    return isOpen(host) && optionEls(host).length > 0;
  }

  // Greenhouse-style: always open → read scoped options → close → wait. Never read
  // options before opening; SR keeps every menu wrapper in the DOM and options are
  // only visible while the matching combobox is expanded.
  async function harvestOptionsForHost(root) {
    let opts = [];
    try {
      if (!(await openMenu(root))) return [];
      opts = optionEls(root).map(optionLabel).filter(Boolean);
    } catch {
      opts = [];
    } finally {
      await closeMenuAndWait(root);
    }
    return [...new Set(opts)];
  }
  function closeMenu(host) {
    const input = inputOf(host);
    if (!input) return;
    try {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    } catch {}
    try {
      input.blur();
    } catch {}
  }

  function bestOption(host, want) {
    const w = clean(want).toLowerCase();
    if (!w) return null;
    let best = null;
    let score = 0;
    for (const el of optionEls(host)) {
      const t = clean(optionLabel(el)).toLowerCase();
      let s = 0;
      if (t === w) s = 100;
      else if (t && t.replace(/[.,]/g, "") === w.replace(/[.,]/g, "")) s = 90;
      else if (t && t.includes(w)) s = 60;
      else if (t && w.includes(t)) s = 40;
      if (s > score) {
        score = s;
        best = el;
      }
    }
    return score > 0 ? best : null;
  }

  async function selectValue(host, want) {
    if (!clean(want)) return false;
    if (!(await openMenu(host))) return false;
    const opt = bestOption(host, want);
    if (!opt) {
      closeMenu(host);
      return false;
    }
    const clickable = deepOne(opt, '[role="option"]') || opt;
    try {
      clickable.scrollIntoView({ block: "center" });
    } catch {}
    fireClick(clickable);
    await waitUntil(
      () => {
        const i = inputOf(host);
        return i && clean(i.value) ? true : null;
      },
      1200,
      60
    );
    const input = inputOf(host);
    return !!(input && clean(input.value));
  }

  AF.registerDriver({
    type: "sr-select",
    priority: 15, // before react-select (20): claim SmartRecruiters question dropdowns first
    match(el) {
      if (!deepActive()) return null;
      if (!el || el.tagName !== "INPUT") return null;
      if ((el.getAttribute && el.getAttribute("role")) !== "combobox") return null;
      const host = closestHost(el, "spl-autocomplete");
      return host && isQuestion(host) ? host : null;
    },
    cidEl(root) {
      return root;
    },
    consumes(root) {
      return deepQuery(root, 'input, [role="combobox"]');
    },
    extract(root) {
      let label = clean(root.getAttribute("aria-label") || "").replace(/^select\s+/i, "");
      if (!label) {
        const sp = root.querySelector && root.querySelector('[slot="label-content"]');
        if (sp) label = clean(sp.textContent);
      }
      const input = inputOf(root);
      const required = root.hasAttribute("required") || (input && input.getAttribute("aria-required") === "true");
      return { kind: "select", label: label || "Question", required: !!required };
    },
    isFilled(root) {
      const input = inputOf(root);
      return !!(input && clean(input.value));
    },
    async harvestOptions(root) {
      return harvestOptionsForHost(root);
    },
    async write(root, answer) {
      return await selectValue(root, answer.option || answer.value);
    },
  });

  // ── spl-radio-group (screening yes/no & single-choice radios) ──────────────
  // The group is a <spl-radio-group id="spl-form-element_NN"> whose question text
  // is a slotted light child <span slot="label-content">, and whose choices are
  // light-child <spl-radio label="Yes" value="1" role="radio"> custom elements
  // (NO native <input> exists, which is why the group element itself is the
  // anchor — see ANCHOR_SEL). We pick by matching the answer against each radio's
  // `label`/`value` and fire a composed click so the Lit handler toggles it.
  function radioOptionEls(group) {
    try {
      return [...group.querySelectorAll("spl-radio")];
    } catch {
      return [];
    }
  }
  function radioLabelOf(r) {
    return clean(r.getAttribute("label") || r.textContent);
  }
  function radioGroupLabel(group) {
    const sp = group.querySelector && group.querySelector('[slot="label-content"]');
    if (sp && clean(sp.textContent)) return clean(sp.textContent);
    const al = clean(group.getAttribute("aria-label") || "");
    return al || "Question";
  }
  function radioChecked(group) {
    return radioOptionEls(group).some((r) => r.getAttribute("aria-checked") === "true");
  }
  function bestRadio(group, want) {
    const w = clean(want).toLowerCase();
    if (!w) return null;
    let best = null;
    let score = 0;
    for (const r of radioOptionEls(group)) {
      const lt = radioLabelOf(r).toLowerCase();
      const val = clean(r.getAttribute("value")).toLowerCase();
      let s = 0;
      if (lt === w || val === w) s = 100;
      else if (lt && lt.includes(w)) s = 60;
      else if (val && val.includes(w)) s = 50;
      else if (lt && w.includes(lt)) s = 30;
      if (s > score) {
        score = s;
        best = r;
      }
    }
    return score > 0 ? best : null;
  }

  AF.registerDriver({
    type: "sr-radio",
    priority: 14, // before the generic radio-checkbox-group driver (50)
    match(el) {
      if (!deepActive()) return null;
      return el && el.tagName === "SPL-RADIO-GROUP" ? el : null;
    },
    cidEl(root) {
      return root;
    },
    consumes(root) {
      return [...radioOptionEls(root), ...deepQuery(root, 'fieldset[role="radiogroup"]')];
    },
    extract(root) {
      const fs = deepOne(root, 'fieldset[role="radiogroup"]');
      return {
        kind: "radio",
        label: radioGroupLabel(root),
        required:
          root.hasAttribute("required") || !!(fs && fs.getAttribute("aria-required") === "true"),
        options: radioOptionEls(root).map(radioLabelOf).filter(Boolean),
      };
    },
    isFilled(root) {
      return radioChecked(root);
    },
    async write(root, answer) {
      const r = bestRadio(root, answer.option || answer.value);
      if (!r) return false;
      try {
        r.scrollIntoView({ block: "center" });
      } catch {}
      fireClick(r);
      await waitUntil(() => (r.getAttribute("aria-checked") === "true" ? true : null), 1000, 60);
      return r.getAttribute("aria-checked") === "true" || radioChecked(root);
    },
  });

  // ── spl-checkbox (consent / single-confirmation checkbox) ──────────────────
  // <spl-checkbox required> hosts a shadow-nested <input type="checkbox"> and a
  // light-DOM <span slot="label-content"> prompt. A bare click on the inner input
  // often does NOT commit into the Lit host (the field stays c-spl-form-field--invalid).
  // Try the host, wrapper, and label with composed pointer events, then fall back.
  const CB_NEGATIVE = /^(no|false|n|0|decline|declined|unchecked|disagree|disagreed|off|never)$/i;
  const CB_CONSENT =
    /\bconsent\b|acknowledg|i agree|\bagree\b|privacy|terms|declare|accurate|information i provide/i;

  function checkboxHost(el) {
    return closestHost(el, "spl-checkbox");
  }
  function checkboxInput(host) {
    return deepOne(host, 'input[type="checkbox"]');
  }
  function checkboxLabel(host) {
    const sp = host.querySelector && host.querySelector('[slot="label-content"]');
    if (sp && clean(sp.textContent)) return clean(sp.textContent);
    const lab = deepOne(host, "label[for]");
    if (lab && clean(lab.textContent)) return clean(lab.textContent);
    return clean(host.getAttribute("aria-label") || "") || "Confirmation";
  }
  function checkboxShowsValid(host) {
    const input = checkboxInput(host);
    if (!input || !input.checked) return false;
    if (input.getAttribute("aria-invalid") === "true") return false;
    if (deepOne(host, ".c-spl-form-field--invalid")) return false;
    return true;
  }
  function checkboxClickTargets(host) {
    const out = [];
    const input = checkboxInput(host);
    const wrap = deepOne(host, ".c-spl-checkbox-wrapper, .c-spl-checkbox");
    const lab = deepOne(host, "label[for]");
    if (host) out.push(host);
    if (wrap) out.push(wrap);
    if (lab) out.push(lab);
    if (input) out.push(input);
    return out;
  }
  function wantsChecked(host, wants) {
    const list = (wants || []).map((w) => clean(w)).filter(Boolean);
    if (!list.length) return host.hasAttribute("required") || host.getAttribute("aria-required") === "true";
    return list.some((w) => !CB_NEGATIVE.test(w));
  }
  async function setCheckboxChecked(host, want) {
    const input = checkboxInput(host);
    if (!input) return false;
    if (want && checkboxShowsValid(host)) return true;
    if (!want && !input.checked) return true;

    if (want) {
      try {
        host.scrollIntoView({ block: "center" });
      } catch {}
      for (const t of checkboxClickTargets(host)) {
        fireClick(t);
        await waitUntil(() => (checkboxShowsValid(host) ? true : null), 500, 50);
        if (checkboxShowsValid(host)) return true;
      }
    } else if (input.checked) {
      for (const t of checkboxClickTargets(host)) {
        fireClick(t);
        await waitUntil(() => (!checkboxInput(host) || !checkboxInput(host).checked ? true : null), 500, 50);
        if (!checkboxInput(host)?.checked) return true;
      }
    }

    let cur = checkboxInput(host);
    if (cur && cur.checked !== want) {
      try {
        cur.checked = want;
        cur.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        cur.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      } catch {}
      await waitUntil(() => {
        const i = checkboxInput(host);
        return i && i.checked === want ? true : null;
      }, 400, 60);
    }

    try {
      if (want) host.checked = true;
    } catch {}
    try {
      if (want) host.setAttribute("checked", "");
      else host.removeAttribute("checked");
    } catch {}

    await waitUntil(() => (want ? (checkboxShowsValid(host) ? true : null) : true), 600, 60);
    return want ? checkboxShowsValid(host) : !checkboxInput(host)?.checked;
  }

  function isRequiredSplCheckbox(host) {
    if (!host || host.tagName !== "SPL-CHECKBOX") return false;
    if (host.hasAttribute("required") || host.getAttribute("aria-required") === "true") return true;
    return CB_CONSENT.test(checkboxLabel(host));
  }

  // Tick every required (or consent-labeled) spl-checkbox still unchecked. Used
  // after the LLM write pass and before SR "Next" so privacy/consent boxes on
  // later steps (not oc-checkbox[data-test="consent-box"]) clear validation.
  async function tickRequiredSplCheckboxes() {
    if (!deepActive()) return 0;
    let n = 0;
    for (const host of deepQuery(document.documentElement, "spl-checkbox")) {
      if (!isRequiredSplCheckbox(host)) continue;
      if (checkboxShowsValid(host)) continue;
      if (await setCheckboxChecked(host, true)) n++;
    }
    const ocBox = deepOne(document.documentElement, 'oc-checkbox[data-test="consent-box"]');
    if (ocBox) {
      const inp = deepOne(ocBox, 'input[type="checkbox"]');
      if (inp && !inp.checked) {
        fireClick(inp);
        if (inp.checked) n++;
      }
    }
    return n;
  }

  AF.srTickRequiredCheckboxes = tickRequiredSplCheckboxes;

  AF.registerDriver({
    type: "sr-checkbox",
    priority: 14, // before the generic radio-checkbox-group driver (50)
    match(el) {
      if (!deepActive()) return null;
      if (!el || el.tagName !== "INPUT") return null;
      if ((el.type || "").toLowerCase() !== "checkbox") return null;
      return checkboxHost(el);
    },
    cidEl(root) {
      return checkboxInput(root) || root;
    },
    consumes(root) {
      return deepQuery(root, 'input[type="checkbox"]');
    },
    extract(root) {
      const input = checkboxInput(root);
      const label = checkboxLabel(root);
      return {
        kind: "checkbox",
        label,
        required:
          root.hasAttribute("required") || !!(input && input.getAttribute("aria-required") === "true"),
        multi: false,
        options: [label],
      };
    },
    isFilled(root) {
      return checkboxShowsValid(root);
    },
    async write(root, answer) {
      const wants =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option, answer.value].filter(Boolean);
      return setCheckboxChecked(root, wantsChecked(root, wants));
    },
  });

  // ── spl-multiselect-autocomplete (screening multi-choice lists) ────────────
  // Same listbox machinery as the single sr-select, but the host is a
  // <spl-multiselect-autocomplete id="question_<uuid>"> and several values can be
  // chosen. It closes the menu after each pick (closeonselect), so we reopen for
  // every wanted value.
  async function selectValuesMulti(host, wants) {
    let any = false;
    for (const w of wants) {
      if (!clean(w)) continue;
      if (!(await openMenu(host))) continue;
      const opt = bestOption(host, w);
      if (!opt) {
        closeMenu(host);
        continue;
      }
      const clickable = deepOne(opt, '[role="option"]') || opt;
      try {
        clickable.scrollIntoView({ block: "center" });
      } catch {}
      fireClick(clickable);
      any = true;
      await waitUntil(() => (multiselectHasSelection(host) ? true : null), 1200, 60);
      await closeMenuAndWait(host);
    }
    if (!multiselectHasSelection(host)) await closeMenuAndWait(host);
    return multiselectHasSelection(host) || any;
  }

  AF.registerDriver({
    type: "sr-multiselect",
    priority: 14, // before sr-select (15) so the multiselect host is claimed first
    match(el) {
      if (!deepActive()) return null;
      if (!el || el.tagName !== "INPUT") return null;
      if ((el.getAttribute && el.getAttribute("role")) !== "combobox") return null;
      const host = closestHost(el, "spl-multiselect-autocomplete");
      return host && isQuestion(host) ? host : null;
    },
    cidEl(root) {
      return root;
    },
    consumes(root) {
      return deepQuery(root, 'input, [role="combobox"]');
    },
    extract(root) {
      const input = inputOf(root);
      const label = questionLabel(root);
      return {
        kind: "multiselect",
        label,
        required:
          root.hasAttribute("required") ||
          !!(input && input.getAttribute("aria-required") === "true"),
        multi: true,
      };
    },
    isFilled(root) {
      return multiselectHasSelection(root);
    },
    async harvestOptions(root) {
      return harvestOptionsForHost(root);
    },
    async write(root, answer) {
      const wants =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option, answer.value].filter(Boolean);
      if (!(await selectValuesMulti(root, wants))) return false;
      return multiselectHasSelection(root);
    },
  });
})();
