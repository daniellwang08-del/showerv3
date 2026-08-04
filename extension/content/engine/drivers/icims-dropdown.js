// iCIMS AJAX dropdown driver.
//
// A field with icimsdropdown-enabled="1" renders as THREE elements:
//
//   <select id="X" class="... dropdown-hide" icimsdropdown-ajax="1"
//           icimsdropdown-search="0|1">   <-- holds NO real <option>s
//   <a id="X_icimsDropdown" class="dropdown-select" role="combobox">
//       <span class="dropdown-text"><span class="dropdown-placeholder">…</span></span>
//   <div id="X_icimsDropdown_ctnr" class="dropdown-container dropdown-invisible">
//       <input class="dropdown-search">
//       <ul id="X_dropdown-results"><li class="dropdown-result result-selectable">
//
// The options are fetched over AJAX, so they are NOT in the static DOM and the
// hidden <select> cannot be written directly. This driver therefore drives the
// visible widget the way a candidate does: open it, type into the search box
// when the list is searchable, then click the matching <li>.
//
// Harvesting is deliberately limited to NON-searchable lists. A searchable list
// only ever renders one page of results (a country dropdown shows 26 of ~250 -
// its own status region literally reads "26 results available"), so publishing
// those 26 to the model as the complete set of choices would force a wrong
// answer. Searchable fields are sent with no options: the model answers from the
// label in free text ("United States", "+1") and the search below finds it.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, normText, delay, waitUntil } = AF.dom;

  const MAX_OPTIONS = 120;

  function icims() {
    return AF.icims || null;
  }

  function selectOf(a) {
    const i = icims();
    return i && i.selectForAnchor ? i.selectForAnchor(a) : null;
  }

  // The engine relocates a control by its cid, which is the hidden <select>'s id.
  // If the stamped anchor is ever lost (re-render) the fallback getElementById
  // hands us the <select> instead of the <a>, so normalize back to the anchor
  // rather than silently operating on an element this driver cannot drive.
  function asAnchor(el) {
    if (!el) return null;
    if (el.tagName === "A") return el;
    const i = icims();
    if (el.tagName === "SELECT" && i && i.dropdownAnchorFor) return i.dropdownAnchorFor(el) || null;
    return null;
  }

  function containerOf(a) {
    if (!a || !a.id) return null;
    try {
      return document.getElementById(a.id + "_ctnr");
    } catch {
      return null;
    }
  }

  function searchBox(a) {
    const c = containerOf(a);
    return c ? c.querySelector("input.dropdown-search") : null;
  }

  function optionText(li) {
    return clean((li.getAttribute && li.getAttribute("title")) || li.textContent);
  }

  // Real choices only: drop the "— Make a Selection —" placeholder (it carries a
  // .dropdown-placeholder child) and the "No Results" filler, which is rendered
  // as .result-unselectable but is defensively filtered by text too.
  function resultNodes(a) {
    const c = containerOf(a);
    if (!c) return [];
    let nodes = [];
    try {
      nodes = [...c.querySelectorAll("li.dropdown-result.result-selectable")];
    } catch {
      return [];
    }
    return nodes.filter((li) => {
      if (li.querySelector(".dropdown-placeholder")) return false;
      const t = optionText(li);
      return !!t && !/^no results$/i.test(t);
    });
  }

  function isOpen(a) {
    const c = containerOf(a);
    if (c && c.classList && !c.classList.contains("dropdown-invisible")) return true;
    return a.getAttribute && a.getAttribute("aria-expanded") === "true";
  }

  function fire(el, type) {
    try {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch {}
  }

  function open(a) {
    if (isOpen(a)) return;
    try {
      a.focus({ preventScroll: true });
    } catch {}
    fire(a, "mousedown");
    fire(a, "mouseup");
    try {
      a.click();
    } catch {}
  }

  function close(a) {
    if (!isOpen(a)) return;
    try {
      a.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27 }));
    } catch {}
    if (!isOpen(a)) return;
    try {
      a.click();
    } catch {}
  }

  function selectionText(a) {
    const t = a.querySelector && a.querySelector(".dropdown-text");
    if (!t) return "";
    if (t.querySelector(".dropdown-placeholder")) return "";
    return clean(t.textContent);
  }

  function hasSelection(a) {
    if (selectionText(a)) return true;
    const sel = selectOf(a);
    const v = sel ? clean(sel.value) : "";
    return !!v && v !== "-999";
  }

  // ── option matching ────────────────────────────────────────────────────────

  // Phone-code entries read "(+93) Afghanistan", so an answer of "+1", "1" or
  // "United States" all have to resolve. Score exact matches decisively above
  // substring ones so "United States" never loses to "United States Minor
  // Outlying Islands" just because it was found first.
  function dialCodeOf(text) {
    const m = /^\(\+(\d+)\)/.exec(clean(text));
    return m ? m[1] : "";
  }

  function wantedDialCode(want) {
    const m = /^\+?(\d{1,4})$/.exec(clean(want));
    return m ? m[1] : "";
  }

  // Option text without its "(+N) " prefix - the country name on its own.
  function bareName(text) {
    return clean(text).replace(/^\(\+\d+\)\s*/, "");
  }

  // How well an option's NAME matches a wanted name. A prefix relationship is
  // scored by how much text is left over, so "United States" beats "United
  // States Minor Outlying Islands" for a want of "United States of America".
  function nameScore(optionName, wantName) {
    const o = normText(optionName);
    const w = normText(wantName);
    if (!o || !w) return 0;
    if (o === w) return 100;
    if (w.startsWith(o)) return 90 - Math.min(20, w.length - o.length);
    if (o.startsWith(w)) return 80 - Math.min(20, o.length - w.length);
    if (o.includes(w) || w.includes(o)) return 40;
    return 0;
  }

  // A dial code is NOT a unique key: +1 covers Canada, the Dominican Republic,
  // Jamaica, Puerto Rico, the United States and the US Minor Outlying Islands.
  // Matching on the code alone therefore picks whichever of those the widget
  // happens to list first (alphabetically, Canada) - which is how a US number
  // ended up tagged "(+1) Canada". Only accept a code-only match when it is
  // unambiguous; otherwise leave the field for the country-name pass.
  function pickByDialCode(nodes, code) {
    if (!code) return null;
    const hits = nodes.filter((n) => dialCodeOf(optionText(n)) === code);
    return hits.length === 1 ? hits[0] : null;
  }

  function pickOption(nodes, want) {
    const code = wantedDialCode(want);
    if (code) return pickByDialCode(nodes, code);
    let best = null;
    let bestScore = 0;
    for (const li of nodes) {
      const text = optionText(li);
      // Score against both the full text and the bare name so "United States"
      // matches "(+1) United States".
      const s = Math.max(nameScore(text, want), nameScore(bareName(text), want));
      if (s > bestScore) {
        best = li;
        bestScore = s;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function clickOption(li) {
    try {
      li.scrollIntoView({ block: "nearest" });
    } catch {}
    fire(li, "mouseover");
    fire(li, "mousedown");
    fire(li, "mouseup");
    try {
      li.click();
    } catch {}
  }

  function setSearch(box, value) {
    try {
      box.focus({ preventScroll: true });
    } catch {}
    AF.dom.setNativeValue(box, value);
    try {
      box.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    } catch {
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // The widget filters on keyup, so an input event alone can leave the list
    // showing the previous page of results.
    try {
      box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
      box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    } catch {}
  }

  // Progressively shorter search terms. The model may answer "United States of
  // America" for an option listed as "United States", which filters the AJAX
  // list down to nothing; a shorter prefix brings the real entry back.
  function shorterProbes(want) {
    const w = clean(want).replace(/^\(\+\d+\)\s*/, "");
    const out = [];
    const firstWord = w.split(/\s+/)[0];
    for (const n of [12, 8, 5]) {
      if (w.length > n) out.push(w.slice(0, n));
    }
    if (firstWord && firstWord !== w && !out.includes(firstWord)) out.push(firstWord);
    return [...new Set(out.filter((s) => s.length >= 2))];
  }

  // Every term worth typing into the search box for a wanted value, best first.
  //
  // A bare dial code needs special handling: the backend hands the Phone Country
  // Code control to the model as free text (this driver publishes no options for
  // a searchable list) and its phone rule then asks for "only the numeric
  // dialing code ... with no '+'", so the answer arrives as "1". Typing "1" into
  // a list whose entries read "(+1) United States" matches nothing useful, and a
  // one-character term produces no shorter probes either - which is exactly how
  // this control ended up reported as "skipped". Try the parenthesised form the
  // options actually render with before falling back to the bare digits.
  function searchTermsFor(want) {
    const w = clean(want);
    if (!w) return [];
    const code = wantedDialCode(w);
    const terms = code ? ["(+" + code + ")", "+" + code, code] : [w, ...shorterProbes(w)];
    return [...new Set(terms.filter(Boolean))];
  }

  // The widget normally writes the chosen id back into the hidden <select> (that
  // is what the form POSTs). When the option has not been spliced in yet, mirror
  // the choice ourselves so the submitted value matches what is on screen.
  function syncSelect(a, text) {
    const sel = selectOf(a);
    if (!sel) return;
    const cur = clean(sel.value);
    if (cur && cur !== "-999") return;
    const want = normText(text);
    try {
      for (const o of sel.options) {
        const ot = normText(o.text);
        const title = normText(o.getAttribute("title") || "");
        if ((ot && ot === want) || (title && title === want)) {
          AF.dom.setNativeValue(sel, o.value);
          AF.dom.fireInput(sel);
          return;
        }
      }
    } catch {}
  }

  async function waitForResults(a, timeout) {
    return waitUntil(() => (resultNodes(a).length ? true : null), timeout, 100);
  }

  // While an AJAX page is in flight the PREVIOUS term's <li> nodes are still in
  // the DOM, so "are there any results?" is not a usable signal after typing -
  // it returns instantly with the stale list and the caller matches against the
  // wrong options. Fingerprint the list (the widget's own live-region count plus
  // the first entry) and wait for it to actually change.
  function isLoading(a) {
    const c = containerOf(a);
    const l = c && c.querySelector(".dropdown-loading");
    return !!(l && l.classList && !l.classList.contains("hide"));
  }

  function resultsFingerprint(a) {
    const c = containerOf(a);
    if (!c) return "";
    let summary = "";
    try {
      const s = c.querySelector('[id^="result-summary"]');
      if (s) summary = clean(s.textContent);
    } catch {}
    const nodes = resultNodes(a);
    return summary + "|" + nodes.length + "|" + (nodes[0] ? optionText(nodes[0]) : "");
  }

  async function searchAndWait(a, box, term, timeout) {
    const before = resultsFingerprint(a);
    setSearch(box, term);
    await waitUntil(
      () => (!isLoading(a) && resultsFingerprint(a) !== before ? true : null),
      timeout,
      80
    );
    // The last page can land a beat after the count updates.
    await delay(150);
  }

  // Commit the highlighted <li> and confirm the widget accepted it.
  async function commit(a, li) {
    const text = optionText(li);
    clickOption(li);
    const landed = await waitUntil(() => (hasSelection(a) ? true : null), 2000, 60);
    syncSelect(a, text);
    close(a);
    return !!landed || hasSelection(a);
  }

  // Open the widget, run each search term in turn and hand the resulting <li>
  // nodes to choose(); the first term that yields a pick wins.
  async function searchAndPick(a, terms, choose) {
    const sel = selectOf(a);
    const i = icims();
    const searchable = !!(i && i.isSearchableDropdown && i.isSearchableDropdown(sel));

    open(a);
    await waitUntil(() => (isOpen(a) ? true : null), 1200, 50);
    const box = searchable ? searchBox(a) : null;

    if (!box) {
      // Non-searchable: the whole list is already rendered.
      await waitForResults(a, 2000);
      const li = choose(resultNodes(a));
      if (!li) {
        close(a);
        return false;
      }
      return commit(a, li);
    }

    for (const term of terms) {
      await searchAndWait(a, box, term, 2500);
      const li = choose(resultNodes(a));
      if (li) return commit(a, li);
    }
    close(a);
    return false;
  }

  async function pickValue(a, want) {
    const target = clean(want);
    if (!target) return false;
    return searchAndPick(a, searchTermsFor(target), (nodes) => pickOption(nodes, target));
  }

  // Deterministic selection for the Phone Country Code widget, driven by the
  // profile instead of the model.
  //
  // The country NAME decides, never the dial code on its own: six countries
  // share +1, so a code-only match resolves to whichever the widget lists first
  // and silently tags a US number as "(+1) Canada". The code is used only to
  // break ties between equally-named options and as the last resort when the
  // profile has no country at all - and even then only when exactly one option
  // carries it. If the name never matches, this returns false and the side panel
  // flags the field, which is far better than submitting the wrong country.
  async function pickDialCode(a, code, countryName) {
    const want = String(code || "").replace(/\D/g, "");
    const name = clean(countryName);
    if (!want && !name) return false;

    const terms = [];
    if (name) terms.push(name, ...shorterProbes(name));
    if (want) terms.push("(+" + want + ")", "+" + want, want);

    return searchAndPick(a, [...new Set(terms.filter(Boolean))], (nodes) => {
      if (name) {
        let best = null;
        let bestScore = 0;
        for (const li of nodes) {
          const text = optionText(li);
          let s = nameScore(bareName(text), name);
          if (!s) continue;
          if (want && dialCodeOf(text) === want) s += 5; // tie-break only
          if (s > bestScore) {
            best = li;
            bestScore = s;
          }
        }
        return best;
      }
      return pickByDialCode(nodes, want);
    });
  }

  AF.registerDriver({
    type: "icims-dropdown",
    // Ahead of react-select (20): the hidden <select> and the visible <a> BOTH
    // carry role="combobox", so react-select would otherwise claim them and try
    // to harvest a menu that does not exist.
    priority: 18,
    match(el) {
      const i = icims();
      if (!i || !i.isIcimsPage || !i.isIcimsPage()) return null;
      if (el.tagName === "A" && el.id && /_icimsDropdown$/.test(el.id)) return el;
      if (el.tagName === "SELECT") {
        const a = i.dropdownAnchorFor && i.dropdownAnchorFor(el);
        if (a) return a;
      }
      return null;
    },
    // Key the control off the hidden <select>'s id (the real field name, e.g.
    // "-1_PersonProfileFields.AddressCountry") rather than the "_icimsDropdown"
    // anchor, so the cid matches the form field the value belongs to.
    cidEl(root) {
      return selectOf(asAnchor(root) || root) || root;
    },
    consumes(root) {
      const extra = [];
      root = asAnchor(root) || root;
      const sel = selectOf(root);
      if (sel) extra.push(sel);
      const c = containerOf(root);
      if (c) {
        extra.push(c);
        try {
          c.querySelectorAll('input, select, [role="combobox"]').forEach((n) => extra.push(n));
        } catch {}
      }
      return extra;
    },
    extract(root) {
      root = asAnchor(root) || root;
      const sel = selectOf(root);
      const i = icims();
      return {
        kind: "custom",
        label: (i && i.questionTitleFor && i.questionTitleFor(sel || root)) || AF.dom.labelForControl(sel || root),
        required: !!(i && i.isRequiredControl && i.isRequiredControl(sel || root)),
        multi: false,
        options: [],
      };
    },
    isFilled(root) {
      const a = asAnchor(root);
      return a ? hasSelection(a) : false;
    },
    async harvestOptions(root) {
      root = asAnchor(root);
      if (!root) return [];
      const sel = selectOf(root);
      const i = icims();
      // Searchable lists are AJAX-paged: what is in the DOM is one page, not the
      // choices. Leave options empty and let write() search for the answer.
      if (i && i.isSearchableDropdown && i.isSearchableDropdown(sel)) return [];
      // A dependent list has nothing to offer until its parent is answered.
      if (i && i.parentUnanswered && sel && i.parentUnanswered(sel)) return [];
      open(root);
      await waitForResults(root, 2500);
      const out = [];
      for (const li of resultNodes(root)) {
        const t = optionText(li);
        if (t && !out.includes(t)) out.push(t);
        if (out.length >= MAX_OPTIONS) break;
      }
      close(root);
      return out;
    },
    async write(root, answer) {
      const a = asAnchor(root);
      if (!a) return false;
      const want =
        (Array.isArray(answer.option_values) && answer.option_values[0]) ||
        answer.option ||
        answer.value ||
        "";
      return pickValue(a, want);
    },
  });

  // Exposed so a deterministic prep (content/engine/icims.js) can drive the same
  // widget without going through the LLM pass.
  AF.icimsDropdown = { asAnchor, hasSelection, pickValue, pickDialCode };
})();
