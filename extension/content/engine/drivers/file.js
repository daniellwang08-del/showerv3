// File upload driver: <input type="file">.
//
// Greenhouse hides the real file input (.visually-hidden) inside a
// <div role="group" aria-labelledby="upload-label-resume"> whose label text
// ("Resume/CV", "Cover Letter") is the only thing that distinguishes resume from
// cover letter — the input's own <label> just says "Attach". So we read the
// enclosing group label first. The file bytes are injected via DataTransfer.
(() => {
  const AF = window.__AF;
  if (!AF) return;
  const { clean, textOfIds, labelForControl, markFilled } = AF.dom;

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function writeFile(el, fileData) {
    try {
      const bytes = base64ToBytes(fileData.base64);
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

  AF.registerDriver({
    type: "file",
    priority: 30,
    match(el) {
      return el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file" ? el : null;
    },
    extract(root) {
      const grp = root.closest && root.closest('[role="group"][aria-labelledby]');
      let label = grp ? textOfIds(grp.getAttribute("aria-labelledby")) : "";
      if (!label) label = labelForControl(root);
      return {
        kind: "file",
        label: label || "File",
        required: !!root.required || (root.getAttribute && root.getAttribute("aria-required") === "true"),
        is_file: true,
        accept: root.accept || "",
      };
    },
    isFilled(root) {
      return !!(root.files && root.files.length);
    },
    async write(root, answer, env) {
      const fd = env && env.file;
      if (!fd) return false;
      const ok = writeFile(root, fd);
      if (ok) markFilled(root);
      return ok;
    },
  });
})();
