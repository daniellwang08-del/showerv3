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
    try {
      if (AF.workable && AF.workable.applicationGroupInputs) {
        const wb = AF.workable.applicationGroupInputs(root);
        if (wb && wb.length) return wb;
      }
    } catch {}
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
    // Workable post-submit survey: question text is on the outer fieldset legend
    // inside [data-ui="question"]; the inner radiogroup fieldset has no legend.
    try {
      if (AF.workable && AF.workable.questionTitleFor) {
        const q = AF.workable.questionTitleFor(root);
        if (q) return q;
      }
      if (AF.workable && AF.workable.applicationQuestionTitleFor) {
        const q = AF.workable.applicationQuestionTitleFor(root);
        if (q) return q;
      }
    } catch {}
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
    // Pinpoint boolean / screening questions: title in .external-form__label--title.
    try {
      if (AF.pinpoint && AF.pinpoint.questionTitleFor) {
        const q = AF.pinpoint.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
    // Lever checkbox / radio groups: question in .application-label.
    try {
      if (AF.lever && AF.lever.questionLabelFor) {
        const q = AF.lever.questionLabelFor(root);
        if (q) return q;
      }
    } catch {}
    // Breezy: question in preceding <h3> inside li.question or .section.
    try {
      if (AF.breezy && AF.breezy.questionTitleFor) {
        const q = AF.breezy.questionTitleFor(root);
        if (q) return q;
      }
    } catch {}
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
    // YES/NO screening answers often arrive as boolean strings.
    if (w === "yes" || w === "true") {
      if (lt === "yes" || val === "yes" || val === "true" || lt === "true") return 95;
    }
    if (w === "no" || w === "false") {
      if (lt === "no" || val === "no" || val === "false" || lt === "false") return 95;
    }
    if (lt && lt.includes(w)) return 60; // option label contains the (shorter) answer, e.g. "asian"
    if (val && val.includes(w)) return 50;
    if (lt && w.includes(lt)) return 30; // answer contains the (shorter) option label - loosest
    if (val && w.includes(val)) return 20;
    return 0;
  }

  function bestOptionFor(inputs, w) {
    let best = null;
    let bestScore = 0;
    for (const inp of inputs) {
      const lt = clean(optionTextFor(inp)).toLowerCase();
      const val = clean(inp.value).toLowerCase();
      const s = scoreMatch(lt, val, w);
      if (s > bestScore) {
        bestScore = s;
        best = inp;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function activateOption(inp) {
    try {
      if (AF.workable && AF.workable.activateWidgetOption) {
        if (AF.workable.activateWidgetOption(inp)) return true;
      }
    } catch {}
    if (!inp.checked) inp.click();
    return inp.checked;
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
          if (!inp.checked) activateOption(inp);
          any = true;
        }
      }
    } else {
      // Single (radio): pick the one globally best-scoring option.
      let best = null;
      let bestScore = 0;
      for (const inp of inputs) {
        const lt = clean(optionTextFor(inp)).toLowerCase();
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
        if (!best.checked) activateOption(best);
        any = true;
      }
    }
    return any;
  }

  function optionTextFor(inp) {
    if (AF.workable && AF.workable.optionLabelFor) {
      const wb = AF.workable.optionLabelFor(inp);
      if (wb) return wb;
    }
    if (AF.lever && AF.lever.optionLabelFor) {
      const lv = AF.lever.optionLabelFor(inp);
      if (lv) return lv;
    }
    if (AF.breezy && AF.breezy.optionLabelFor) {
      const bz = AF.breezy.optionLabelFor(inp);
      if (bz) return bz;
    }
    return clean(labelForControl(inp)) || clean(inp.value);
  }

  function leverGroupOptions(root, group) {
    const opts = group.map((g) => optionTextFor(g)).filter(Boolean);
    if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root) && AF.lever.pronounsExtraOptions) {
      for (const o of AF.lever.pronounsExtraOptions()) {
        if (o && !opts.includes(o)) opts.push(o);
      }
    }
    return opts;
  }

  async function writeLeverGroup(root, answer, multi) {
    const values =
      Array.isArray(answer.option_values) && answer.option_values.length
        ? answer.option_values
        : [answer.option || answer.value].filter(Boolean);
    const lower = values.map((v) => clean(v).toLowerCase());
    if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root)) {
      const customVal = values.find((v) => v && !/^(he\/him|she\/her|they\/them|xe\/xem|ze\/hir|ey\/em|hir\/hir|fae\/faer|hu\/hu|use name only|custom)$/i.test(clean(v)));
      if (lower.some((v) => v === "custom") || (customVal && !lower.includes("use name only"))) {
        const text = customVal && !/^custom$/i.test(clean(customVal)) ? customVal : answer.value || "";
        if (text && AF.lever.writePronounsCustom) return AF.lever.writePronounsCustom(text);
      }
    }
    return choose(root, multi ? values : values[0], multi);
  }

  AF.registerDriver({
    type: "radio-checkbox-group",
    priority: 50,
    match(el) {
      if (el.tagName !== "INPUT") return null;
      const t = (el.type || "").toLowerCase();
      if (t !== "radio" && t !== "checkbox") return null;
      if (AF.lever && AF.lever.shouldSkipControl && AF.lever.shouldSkipControl(el)) return null;
      if (AF.breezy && AF.breezy.shouldSkipControl && AF.breezy.shouldSkipControl(el)) return null;
      return el;
    },
    consumes(root) {
      const group = groupInputs(root);
      const extra = group.slice();
      if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root)) {
        const field = document.getElementById("customPronounsTextField");
        if (field) extra.push(field);
      }
      return extra;
    },
    extract(root) {
      const t = (root.type || "radio").toLowerCase();
      const group = groupInputs(root);
      return {
        kind: t,
        label: groupLabel(root),
        required: group.some((g) => g.required),
        multi: t === "checkbox" && group.length > 1,
        options: leverGroupOptions(root, group),
        name: root.name || "",
      };
    },
    isFilled(root) {
      const group = groupInputs(root);
      try {
        if (AF.workable && AF.workable.surveyGroupFilled && AF.workable.isSurveyControl && AF.workable.isSurveyControl(root)) {
          return AF.workable.surveyGroupFilled(group);
        }
        if (
          AF.workable &&
          AF.workable.applicationGroupFilled &&
          AF.workable.isApplicationWidgetInput &&
          AF.workable.isApplicationWidgetInput(root)
        ) {
          return AF.workable.applicationGroupFilled(group);
        }
      } catch {}
      if (group.some((g) => g.checked)) return true;
      if (AF.lever && AF.lever.isPronounsGroup && AF.lever.isPronounsGroup(root)) {
        const field = document.getElementById("customPronounsTextField");
        if (field && clean(field.value)) return true;
      }
      return false;
    },
    async write(root, answer) {
      const t = (root.type || "radio").toLowerCase();
      const group = groupInputs(root);
      const multi = t === "checkbox" && group.length > 1;
      if (AF.lever && AF.lever.isLeverPage && AF.lever.isLeverPage()) {
        return writeLeverGroup(root, answer, multi);
      }
      const values =
        Array.isArray(answer.option_values) && answer.option_values.length
          ? answer.option_values
          : [answer.option || answer.value].filter(Boolean);
      return choose(root, multi ? values : values[0], multi);
    },
  });
})();
