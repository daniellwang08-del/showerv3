// Captures the user's Ask-selection hotkey on application pages (all frames).
// On match, sends the current text selection to the extension assistant chat.

(function () {
  if (window.__ATOMSPACE_ASK_HOTKEY__) return;
  window.__ATOMSPACE_ASK_HOTKEY__ = true;

  const DEFAULT = { ctrl: false, alt: true, shift: false, meta: false, key: "a" };

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULT };
    const key = String(raw.key || "")
      .trim()
      .toLowerCase();
    if (!key) return { ...DEFAULT };
    const ctrl = !!raw.ctrl;
    const alt = !!raw.alt;
    const shift = !!raw.shift;
    const meta = !!raw.meta;
    if (!ctrl && !alt && !meta) return { ...DEFAULT };
    return { ctrl, alt, shift, meta, key };
  }

  let combo = { ...DEFAULT };

  function loadCombo() {
    try {
      chrome.storage.local.get("askHotkey", (obj) => {
        void chrome.runtime.lastError;
        combo = normalize(obj && obj.askHotkey);
      });
    } catch {
      /* ignore */
    }
  }

  loadCombo();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.askHotkey) {
        combo = normalize(changes.askHotkey.newValue);
      }
    });
  } catch {
    /* ignore */
  }

  function matches(e) {
    if (!combo || !combo.key) return false;
    if (!!e.ctrlKey !== !!combo.ctrl) return false;
    if (!!e.altKey !== !!combo.alt) return false;
    if (!!e.shiftKey !== !!combo.shift) return false;
    if (!!e.metaKey !== !!combo.meta) return false;
    const pressed = e.key === " " ? "space" : String(e.key || "").toLowerCase();
    return pressed === combo.key;
  }

  function selectedText() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).trim()) return String(sel).trim();
    } catch {
      /* ignore */
    }
    // Fallback: selected text inside focused input/textarea.
    try {
      const el = document.activeElement;
      if (
        el &&
        (el.tagName === "TEXTAREA" ||
          (el.tagName === "INPUT" &&
            /^(text|search|url|tel|password|email|number)$/i.test(el.type || "text")))
      ) {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        if (typeof start === "number" && typeof end === "number" && end > start) {
          return String(el.value || "").slice(start, end).trim();
        }
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || e.isComposing) return;
      if (!matches(e)) return;
      const text = selectedText();
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({
          type: "ASK_SELECTION",
          text,
          empty: !text,
          frameUrl: location.href,
        });
      } catch {
        /* extension context invalidated */
      }
    },
    true
  );
})();
