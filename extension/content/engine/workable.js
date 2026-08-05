// Workable (apply.workable.com) application form helpers.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean } = AF.dom;

  function isWorkableHost() {
    try {
      return /workable\.com$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  function isWorkableApplicationPage() {
    return isWorkableHost() && !!document.querySelector('form[data-ui="application-form"]');
  }

  function isWorkableSurveyPage() {
    return isWorkableHost() && !!document.querySelector('form[data-ui="survey-form"]');
  }

  function isWorkablePage() {
    return isWorkableApplicationPage() || isWorkableSurveyPage();
  }

  function isSurveyControl(el) {
    return !!(el && el.closest && el.closest('form[data-ui="survey-form"]'));
  }

  function isSurveyRadioInput(el) {
    if (!el || el.tagName !== "INPUT" || !isSurveyControl(el)) return false;
    return isWidgetInput(el);
  }

  function isApplicationControl(el) {
    return !!(el && el.closest && el.closest('form[data-ui="application-form"]'));
  }

  // Screening-question host: fieldset / role=group carrying data-ui="QA_*".
  function applicationQuestionHost(el) {
    if (!el || !isApplicationControl(el)) return null;
    try {
      if (el.closest('[data-ui="education"], [data-ui="experience"], [data-ui="editor"]')) return null;
      const host = el.closest('fieldset[data-ui], [role="group"][data-ui], [role="radiogroup"][data-ui]');
      if (!host) return null;
      const ui = host.getAttribute("data-ui") || "";
      if (!/^QA_/i.test(ui)) return null;
      return host;
    } catch {
      return null;
    }
  }

  function widgetRoleForInput(el) {
    const t = (el.type || "").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    return "";
  }

  function widgetWrapForInput(el) {
    const role = widgetRoleForInput(el);
    if (!role) return null;
    try {
      return el.closest('[role="' + role + '"]');
    } catch {
      return null;
    }
  }

  function isWidgetInput(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const t = widgetRoleForInput(el);
    if (!t) return false;
    try {
      const wrap = widgetWrapForInput(el);
      if (!wrap || !wrap.getBoundingClientRect) return false;
      const r = wrap.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  }

  function isApplicationWidgetInput(el) {
    if (!el || !isWorkableApplicationPage()) return false;
    if (!applicationQuestionHost(el)) return false;
    return isWidgetInput(el);
  }

  function shouldSkipControl(el) {
    if (!el || !isWorkablePage()) return false;
    try {
      // Post-submit survey: native radios are aria-hidden behind role=radio widgets.
      if (isSurveyControl(el)) return false;
      if (!isWorkableApplicationPage()) return false;
      if (el.closest && el.closest('[data-ui="autofill-button"]')) return true;
      if (el.getAttribute && el.getAttribute("data-ui") === "avatar") return true;
      const nm = el.name || el.id || "";
      if (nm === "city" || nm === "postcode" || nm === "country") return true;
      // Hidden native checkbox; prep uses [role="checkbox"]#current instead.
      if (nm === "current" && el.type === "checkbox") return true;
      // Application screening widgets: aria-hidden native input + visible role=radio/checkbox.
      if (isApplicationWidgetInput(el)) return false;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") {
        try {
          const t = (el.type || "").toLowerCase();
          if (t === "radio" || t === "checkbox") {
            const host = el.closest && el.closest("fieldset[data-ui], [role='group'][data-ui], [role='radiogroup'][data-ui]");
            console.warn("[autofill] WB skip aria-hidden widget (no QA_ host?)", {
              type: t,
              name: el.name || "",
              hostUi: host ? host.getAttribute("data-ui") : null,
              inGroup: !!(el.closest && el.closest('[data-ui="group"]')),
            });
          }
        } catch {}
        return true;
      }
      if (el.closest && el.closest('[data-ui="group"]')) return true;
    } catch {}
    return false;
  }

  function shouldSkipSubtree(el) {
    if (!el || el.nodeType !== 1 || !isWorkableApplicationPage()) return false;
    try {
      if (el.matches && el.matches('[data-ui="education"], [data-ui="experience"], [data-ui="autofill-button"]')) {
        return true;
      }
    } catch {}
    return false;
  }

  function queryIdInScope(root, id) {
    if (!id || !root) return null;
    try {
      if (typeof CSS !== "undefined" && CSS.escape) {
        const ref = root.querySelector("#" + CSS.escape(id));
        if (ref) return ref;
      }
    } catch {}
    try {
      return root.querySelector('[id="' + String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]');
    } catch {}
    try {
      return document.getElementById(id);
    } catch {}
    return null;
  }

  // Resolve aria-labelledby within the nearest label wrapper so duplicate global
  // ids (summary, start_date_label, …) inside open editors do not collide.
  function textOfIdsScoped(root, ids) {
    if (!ids || !root) return "";
    try {
      const parts = ids
        .split(/\s+/)
        .map((id) => {
          const ref = queryIdInScope(root, id);
          return ref ? clean(ref.innerText || ref.textContent) : "";
        })
        .filter(Boolean);
      return parts.join(" ");
    } catch {
      return "";
    }
  }

  function labelForControl(inp) {
    if (!inp || !isWorkablePage()) return "";
    try {
      if (isSurveyControl(inp)) {
        const t = (inp.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") {
          const opt = optionLabelFor(inp);
          if (opt) return opt;
        }
      }
      const dataUi = inp.getAttribute && inp.getAttribute("data-ui");
      if (dataUi === "resume") return "Resume";
      if (dataUi === "cover_letter") return "Cover letter";
      const editor = inp.closest && inp.closest('[data-ui="editor"]');
      const section = inp.closest && inp.closest('[data-ui="education"], [data-ui="experience"]');
      const scope =
        (inp.closest && inp.closest("label.styles--3aPac")) ||
        editor ||
        section ||
        inp.closest('form[data-ui="application-form"]') ||
        inp.closest('form[data-ui="survey-form"]');
      if (scope) {
        const labelledby = inp.getAttribute && inp.getAttribute("aria-labelledby");
        const byId = textOfIdsScoped(scope, labelledby);
        if (byId) {
          return byId
            .replace(/\s*\(Optional\)\s*$/i, "")
            .replace(/\s*\*\s*$/, "")
            .slice(0, 200);
        }
        const wrap = inp.closest && inp.closest("label");
        if (wrap && clean(wrap.innerText)) {
          return clean(wrap.innerText)
            .replace(/\s*\(Optional\)\s*$/i, "")
            .replace(/\s*\*\s*$/, "")
            .slice(0, 200);
        }
      }
    } catch {}
    return "";
  }

  function cleanQuestionTitle(t) {
    return clean(t)
      .replace(/\s*\(Optional\)\s*$/i, "")
      .replace(/\s*\*\s*$/, "")
      .slice(0, 200);
  }

  function questionTitleFor(el) {
    if (!el || !isSurveyControl(el)) return "";
    try {
      const q = el.closest('[data-ui="question"]');
      if (!q) return "";
      const lg = q.querySelector("fieldset > legend");
      return lg ? clean(lg.innerText).slice(0, 200) : "";
    } catch {
      return "";
    }
  }

  function applicationQuestionTitleFor(el) {
    const host = applicationQuestionHost(el);
    if (!host) return "";
    try {
      const scope =
        host.closest(".styles--3aPac") ||
        host.closest('form[data-ui="application-form"]') ||
        host;
      const by = host.getAttribute("aria-labelledby");
      if (by) {
        const t = textOfIdsScoped(scope, by);
        if (t) return cleanQuestionTitle(t);
      }
    } catch {}
    return "";
  }

  function applicationOptionLabelFor(el) {
    if (!el || !applicationQuestionHost(el)) return "";
    try {
      const role = widgetRoleForInput(el);
      const wrap = widgetWrapForInput(el);
      const scope =
        (el.closest && el.closest(".styles--3aPac")) ||
        applicationQuestionHost(el) ||
        document;
      const labelPrefix = role === "checkbox" ? "checkbox_label_" : "radio_label_";
      if (wrap && wrap.id) {
        const sp = queryIdInScope(scope, labelPrefix + wrap.id);
        if (sp && clean(sp.textContent)) return clean(sp.textContent).slice(0, 200);
      }
      if (el.id) {
        const sp = queryIdInScope(scope, labelPrefix + el.id);
        if (sp && clean(sp.textContent)) return clean(sp.textContent).slice(0, 200);
      }
      if (wrap) {
        const by = wrap.getAttribute("aria-labelledby") || "";
        for (const id of by.split(/\s+/)) {
          if (!id.startsWith(labelPrefix)) continue;
          const sp = queryIdInScope(scope, id);
          if (sp && clean(sp.textContent)) return clean(sp.textContent).slice(0, 200);
        }
      }
      const lbl = el.closest("label");
      const span = lbl && lbl.querySelector("span[id], span.styles--QTMDv");
      if (span && clean(span.textContent)) return clean(span.textContent).slice(0, 200);
    } catch {}
    return "";
  }

  function optionLabelFor(el) {
    if (!el) return "";
    if (isSurveyControl(el)) {
      try {
        const q = el.closest('[data-ui="question"]') || document;
        const wrap = el.closest && el.closest('[role="radio"]');
        if (wrap) {
          const byRole = textOfIdsScoped(q, wrap.getAttribute("aria-labelledby"));
          if (byRole) return byRole;
        }
        const labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
        const byId = textOfIdsScoped(q, labelledby);
        if (byId) return byId;
        const span = el.closest("label") && el.closest("label").querySelector("span[id]");
        if (span && clean(span.innerText)) return clean(span.innerText);
      } catch {}
      return "";
    }
    return applicationOptionLabelFor(el);
  }

  function clickWidgetWrap(wrap, input) {
    if (!wrap) return false;
    try {
      wrap.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      wrap.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      wrap.click();
      return wrap.getAttribute("aria-checked") === "true" || !!(input && input.checked);
    } catch {
      return false;
    }
  }

  function activateSurveyOption(input) {
    if (!input || !isSurveyControl(input)) return false;
    try {
      const wrap = input.closest('[role="radio"]');
      if (wrap) return clickWidgetWrap(wrap, input);
      if (!input.checked) input.click();
      return input.checked;
    } catch {
      return false;
    }
  }

  function activateApplicationOption(input) {
    if (!input || !applicationQuestionHost(input)) return false;
    try {
      const wrap = widgetWrapForInput(input);
      if (wrap) return clickWidgetWrap(wrap, input);
      if (!input.checked) input.click();
      return input.checked;
    } catch {
      return false;
    }
  }

  function activateWidgetOption(input) {
    if (activateSurveyOption(input)) return true;
    if (activateApplicationOption(input)) return true;
    return false;
  }

  function widgetGroupFilled(inputs) {
    for (const inp of inputs || []) {
      if (!inp) continue;
      const wrap = widgetWrapForInput(inp);
      if (wrap && wrap.getAttribute("aria-checked") === "true") return true;
      if (inp.checked) return true;
    }
    return false;
  }

  function surveyGroupFilled(inputs) {
    return widgetGroupFilled(inputs);
  }

  function applicationGroupFilled(inputs) {
    return widgetGroupFilled(inputs);
  }

  // Workable multi-select checkboxes use a unique name per option but share
  // data-ui="QA_*" on the enclosing fieldset / role=group host.
  function applicationGroupInputs(root) {
    const host = applicationQuestionHost(root);
    if (!host) return null;
    const t = (root.type || "radio").toLowerCase();
    try {
      return [...host.querySelectorAll('input[type="' + t + '"]')];
    } catch {
      return [root];
    }
  }

  function cidFor(el) {
    if (!el || !isWorkablePage()) return "";
    try {
      if (isSurveyControl(el) && el.name) return "wb:survey:" + el.name;
      const qHost = applicationQuestionHost(el);
      if (qHost) {
        const ui = qHost.getAttribute("data-ui");
        if (ui) return ui;
      }
      const dataUi = el.getAttribute && el.getAttribute("data-ui");
      if (dataUi) return dataUi;
      if (el.name === "phone") return "phone";
      const editor = el.closest && el.closest('[data-ui="editor"]');
      const section = el.closest && el.closest('[data-ui="education"], [data-ui="experience"]');
      if (editor && section) {
        const sec = section.getAttribute("data-ui") || "section";
        const nm = el.getAttribute("name") || el.id || "";
        if (nm) return "wb:" + sec + ":" + nm;
      }
    } catch {}
    return "";
  }

  function resumeInput() {
    return document.querySelector('form[data-ui="application-form"] input[data-ui="resume"]');
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

  // Workable edu/exp editors are React-controlled. A bulk write + later textarea
  // fill can leave the DOM showing a value while React state is still empty, so
  // Update shows "This is a required field" on Title/School. Rewind the value
  // tracker, set via the native prototype setter, fire InputEvent, then blur so
  // focusout reaches React's onBlur commit path.
  function setEditorField(el, value) {
    if (!el || value == null) return false;
    const v = String(value).trim();
    if (!v) return false;
    try {
      const proto =
        el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const prev = el.value;
      let focused = false;
      try {
        el.focus({ preventScroll: true });
        focused = document.activeElement === el;
      } catch {}
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue(prev);
      if (setter) setter.call(el, v);
      else el.value = v;
      try {
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: v })
        );
      } catch {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (focused) {
        try {
          el.blur();
        } catch {}
      } else {
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      }
      return true;
    } catch {
      return false;
    }
  }

  function editorFieldInvalid(el) {
    if (!el) return false;
    try {
      if (el.getAttribute("aria-invalid") === "true") return true;
      const wrap = el.closest && el.closest("[data-role='illustrated-input'], label.styles--3aPac");
      if (wrap && wrap.querySelector && wrap.querySelector('[class*="error"], [role="alert"]')) return true;
    } catch {}
    return false;
  }

  // Re-commit every filled control in an open editor (required after large
  // textarea writes that can drop earlier field state).
  function commitEditorFields(editor) {
    if (!editor) return 0;
    let n = 0;
    const fields = editor.querySelectorAll(
      'input[name]:not([type="checkbox"]):not([type="hidden"]):not([type="file"]), textarea[name]'
    );
    for (const el of fields) {
      const v = el.value;
      if (v != null && String(v).trim() && setEditorField(el, v)) n++;
    }
    return n;
  }

  // Console probe: paste `__AF.workable.debugDump()` on apply.workable.com.
  function debugDump(tag) {
    const out = { tag: tag || "dump", href: "", address: null, qa: [], radios: [], skippedRadios: [], expEditors: [] };
    try {
      out.href = String(location.href || "");
    } catch {}
    try {
      const form = document.querySelector('form[data-ui="application-form"]');
      const addr = form && form.querySelector('input[name="address"], textarea[name="address"]');
      out.address = addr
        ? { value: String(addr.value || ""), name: addr.name || "", id: addr.id || "" }
        : null;
      const hosts = form ? form.querySelectorAll('[data-ui^="QA_"], [data-ui^="qa_"]') : [];
      for (const h of hosts) {
        const ui = h.getAttribute("data-ui") || "";
        const radios = [...h.querySelectorAll('input[type="radio"]')];
        const checks = [...h.querySelectorAll('input[type="checkbox"]')];
        out.qa.push({
          ui,
          role: h.getAttribute("role") || h.tagName,
          label: applicationQuestionTitleFor(radios[0] || checks[0] || h) || "",
          radios: radios.length,
          checks: checks.length,
          filled: applicationGroupFilled(radios.length ? radios : checks),
          options: (radios.length ? radios : checks).map((inp) => ({
            value: inp.value,
            checked: !!inp.checked,
            opt: optionLabelFor(inp),
            ariaHidden: inp.getAttribute("aria-hidden"),
            skip: shouldSkipControl(inp),
            isWidget: isApplicationWidgetInput(inp),
          })),
        });
      }
      for (const inp of form ? form.querySelectorAll('input[type="radio"], input[type="checkbox"]') : []) {
        if (shouldSkipControl(inp) && (inp.type === "radio" || inp.type === "checkbox")) {
          const host = inp.closest("fieldset[data-ui], [role='group'][data-ui], [role='radiogroup'][data-ui]");
          out.skippedRadios.push({
            type: inp.type,
            name: inp.name || "",
            hostUi: host ? host.getAttribute("data-ui") : null,
          });
        }
      }
      for (const ed of document.querySelectorAll('[data-ui="experience"] [data-ui="editor"], [data-ui="education"] [data-ui="editor"]')) {
        const startEl = ed.querySelector('[name="start_date"]');
        const endEl = ed.querySelector('[name="end_date"]');
        out.expEditors.push({
          start: startEl ? startEl.value : "",
          end: endEl ? endEl.value : "",
          title: (ed.querySelector('[name="title"], [name="school"]') || {}).value || "",
        });
      }
    } catch (err) {
      out.error = String(err && err.message);
    }
    try {
      console.log("[autofill] WB debugDump", out);
    } catch {}
    return out;
  }

  AF.workable = {
    isWorkableHost,
    isWorkablePage,
    isWorkableApplicationPage,
    isWorkableSurveyPage,
    isSurveyControl,
    isSurveyRadioInput,
    isApplicationWidgetInput,
    applicationQuestionHost,
    applicationGroupInputs,
    applicationQuestionTitleFor,
    applicationGroupFilled,
    shouldSkipControl,
    shouldSkipSubtree,
    labelForControl,
    questionTitleFor,
    optionLabelFor,
    activateSurveyOption,
    activateApplicationOption,
    activateWidgetOption,
    surveyGroupFilled,
    cidFor,
    resumeInput,
    writeResumeFile,
    setEditorField,
    commitEditorFields,
    editorFieldInvalid,
    debugDump,
  };
})();
