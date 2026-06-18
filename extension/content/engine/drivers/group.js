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
    const grp = root.closest && root.closest("[aria-labelledby]");
    if (grp) {
      const t = AF.dom.textOfIds(grp.getAttribute("aria-labelledby"));
      if (t) return t.slice(0, 200);
    }
    return labelForControl(root);
  }

  function choose(root, want, multi) {
    const wants = (Array.isArray(want) ? want : [want]).map((w) => clean(w).toLowerCase()).filter(Boolean);
    if (!wants.length) return false;
    let any = false;
    for (const inp of groupInputs(root)) {
      const lt = clean(labelForControl(inp)).toLowerCase();
      const val = clean(inp.value).toLowerCase();
      const hit = wants.some((w) => lt === w || val === w || (w && lt && (lt.includes(w) || w.includes(lt))));
      if (hit) {
        if (!inp.checked) inp.click();
        any = true;
        if (!multi) break;
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
