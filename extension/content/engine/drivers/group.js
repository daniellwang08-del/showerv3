// Radio / checkbox group driver.
//
// A group is the set of <input type="radio|checkbox"> sharing a name. The first
// input claims the group; `consumes` reports its siblings so they aren't each
// treated as a separate control. Options are the per-input labels.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, labelForControl } = AF.dom;

  function scopeOf(el) {
    return (el.closest && el.closest("form, fieldset, [role='group'], [role='radiogroup']")) || document;
  }

  function groupInputs(root) {
    const t = (root.type || "radio").toLowerCase();
    const name = root.name || "";
    const scope = scopeOf(root);
    if (!name) return [root];
    try {
      return [...scope.querySelectorAll('input[type="' + t + '"]')].filter((x) => (x.name || "") === name);
    } catch {
      return [root];
    }
  }

  function groupLabel(root) {
    const fs = root.closest && root.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg && clean(lg.innerText)) return clean(lg.innerText).slice(0, 200);
    }
    // Ashby EEO groups are a <fieldset> whose question is a sibling <label
    // class="ashby-application-form-question-title"> (no <legend>); each radio's
    // own label[for] is just its option text ("Male"), so labelForControl(root)
    // would mislabel the whole group. Prefer the field's question title.
    const entry =
      root.closest && root.closest("fieldset, .ashby-application-form-field-entry, [data-field-path]");
    if (entry && entry.querySelector) {
      const q = entry.querySelector(".ashby-application-form-question-title");
      if (q && clean(q.innerText)) return clean(q.innerText).slice(0, 200);
    }
    const grp = root.closest && root.closest("[aria-labelledby]");
    if (grp) {
      const t = AF.dom.textOfIds(grp.getAttribute("aria-labelledby"));
      if (t) return t.slice(0, 200);
    }
    return labelForControl(root);
  }

  // Score how well an option (label/value) matches a wanted answer. Exact wins
  // decisively over any substring match. This MUST be ranked, not first-hit:
  // every race option ends with "(Not Hispanic or Latino)", so a first-hit
  // substring scan picks "Hispanic or Latino" for an answer of "Asian (Not
  // Hispanic or Latino)" (the answer literally contains that substring). With
  // scoring, the exact "Asian (Not Hispanic or Latino)" option (100) beats the
  // loose "Hispanic or Latino" substring (30).
  function scoreMatch(lt, val, w) {
    if (!w) return 0;
    if (lt === w || val === w) return 100; // exact label / value
    if (lt && lt.includes(w)) return 60; // option label contains the (shorter) answer, e.g. "asian"
    if (val && val.includes(w)) return 50;
    if (lt && w.includes(lt)) return 30; // answer contains the (shorter) option label — loosest
    if (val && w.includes(val)) return 20;
    return 0;
  }

  function bestOptionFor(inputs, w) {
    let best = null;
    let bestScore = 0;
    for (const inp of inputs) {
      const lt = clean(labelForControl(inp)).toLowerCase();
      const val = clean(inp.value).toLowerCase();
      const s = scoreMatch(lt, val, w);
      if (s > bestScore) {
        bestScore = s;
        best = inp;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function choose(root, want, multi) {
    const wants = (Array.isArray(want) ? want : [want]).map((w) => clean(w).toLowerCase()).filter(Boolean);
    if (!wants.length) return false;
    const inputs = groupInputs(root);
    let any = false;
    if (multi) {
      // Each wanted value selects its own best option (checkbox group).
      for (const w of wants) {
        const inp = bestOptionFor(inputs, w);
        if (inp) {
          if (!inp.checked) inp.click();
          any = true;
        }
      }
    } else {
      // Single (radio): pick the one globally best-scoring option.
      let best = null;
      let bestScore = 0;
      for (const inp of inputs) {
        const lt = clean(labelForControl(inp)).toLowerCase();
        const val = clean(inp.value).toLowerCase();
        for (const w of wants) {
          const s = scoreMatch(lt, val, w);
          if (s > bestScore) {
            bestScore = s;
            best = inp;
          }
        }
      }
      if (best) {
        if (!best.checked) best.click();
        any = true;
      }
    }
    return any;
  }

  AF.registerDriver({
    type: "radio-checkbox-group",
    priority: 50,
    match(el) {
      if (el.tagName !== "INPUT") return null;
      const t = (el.type || "").toLowerCase();
      return t === "radio" || t === "checkbox" ? el : null;
    },
    consumes(root) {
      return groupInputs(root);
    },
    extract(root) {
      const t = (root.type || "radio").toLowerCase();
      const group = groupInputs(root);
      return {
        kind: t,
        label: groupLabel(root),
        required: group.some((g) => g.required),
        multi: t === "checkbox" && group.length > 1,
        options: group.map((g) => clean(labelForControl(g)) || clean(g.value)).filter(Boolean),
        name: root.name || "",
      };
    },
    isFilled(root) {
      return groupInputs(root).some((g) => g.checked);
    },
    async write(root, answer) {
      const t = (root.type || "radio").toLowerCase();
      const multi = t === "checkbox";
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
      return choose(root, multi ? values : values[0], multi);
    },
  });
})();
