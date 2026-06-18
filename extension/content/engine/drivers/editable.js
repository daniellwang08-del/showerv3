// contenteditable driver (rich-text answer boxes).
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, labelForControl } = AF.dom;

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const ce = el.getAttribute && el.getAttribute("contenteditable");
    return ce === "" || ce === "true";
  }

  AF.registerDriver({
    type: "contenteditable",
    priority: 70,
    match(el) {
      return isEditable(el) ? el : null;
    },
    extract(root) {
      return {
        kind: "contenteditable",
        label: labelForControl(root) || AF.dom.labelText(root),
        required: root.getAttribute && root.getAttribute("aria-required") === "true",
      };
    },
    isFilled(root) {
      return clean(root.innerText || root.textContent) !== "";
    },
    async write(root, answer) {
      root.focus();
      root.textContent = answer.value || "";
      root.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
  });
})();
