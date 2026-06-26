// File upload driver: <input type="file">.
//
// Greenhouse hides the real file input (.visually-hidden) inside a
// <div role="group" aria-labelledby="upload-label-resume"> whose label text
// ("Resume/CV", "Cover Letter") is the only thing that distinguishes resume from
// cover letter - the input's own <label> just says "Attach". So we read the
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
      if (el.tagName !== "INPUT" || (el.type || "").toLowerCase() !== "file") return null;
      // Ashby shows a convenience "Autofill from resume" drop zone ABOVE the form
      // whose file input parses the resume and overwrites fields. That's not an
      // application field and fighting it causes races, so never claim it - we
      // attach to the real Resume field (#_systemfield_resume) instead.
      if (
        el.closest &&
        el.closest(".ashby-application-form-autofill-uploader, .ashby-application-form-autofill-input-root")
      ) {
        return null;
      }
      // SmartRecruiters ships THREE file inputs: the "Easy Apply" drop zone (its
      // spl-dropzone host is data-test="apply-with-resume-container"), the avatar
      // "Upload profile image" button, and the real Resume field
      // (spl-dropzone[data-test="resume-upload"]). Claim only the resume one.
      try {
        const rootNode = el.getRootNode && el.getRootNode();
        const dzHost = rootNode && rootNode.host; // spl-dropzone when el is in its shadow
        const dz = dzHost && dzHost.getAttribute && dzHost.getAttribute("data-test");
        if (dz === "apply-with-resume-container") return null;
        const al = (el.getAttribute && el.getAttribute("aria-label")) || "";
        if (/upload profile image|profile image/i.test(al)) return null;
        if (el.closest && el.closest("oc-file-upload-button, oc-apply-with-resume")) return null;
      } catch {}
      // Lever: skip the LinkedIn AWLI widget row - not an application upload field.
      if (el.closest && el.closest(".awli-application-row, .awli-button-container")) return null;
      // Workable: skip photo upload; claim only data-ui="resume".
      try {
        const ui = el.getAttribute && el.getAttribute("data-ui");
        if (ui === "avatar") return null;
        if (el.closest && el.closest('[data-ui="autofill-button"]')) return null;
      } catch {}
      return el;
    },
    extract(root) {
      const grp = root.closest && root.closest('[role="group"][aria-labelledby]');
      let label = grp ? textOfIds(grp.getAttribute("aria-labelledby")) : "";
      // SmartRecruiters' resume dropzone has no group label; name it "Resume" so
      // the backend maps the candidate's resume file to it.
      if (!label) {
        try {
          const rootNode = root.getRootNode && root.getRootNode();
          const dz = rootNode && rootNode.host && rootNode.host.getAttribute && rootNode.host.getAttribute("data-test");
          if (dz === "resume-upload") label = "Resume";
        } catch {}
      }
      if (!label) label = labelForControl(root);
      // Pinpoint structured attachments: question title distinguishes Resume vs Cover Letter.
      if (!label && AF.pinpoint && AF.pinpoint.questionTitleFor) {
        label = AF.pinpoint.questionTitleFor(root);
      }
      // Lever: Resume/CV label lives in .application-label on li.application-question.resume.
      if (!label && AF.lever && AF.lever.questionLabelFor) {
        label = AF.lever.questionLabelFor(root);
      }
      // Breezy: hidden #main-attachment resume upload.
      if (!label && (root.id === "main-attachment" || root.name === "cResume")) label = "Resume";
      if (!label && root.getAttribute && root.getAttribute("data-ui") === "resume") label = "Resume";
      if (!label && (root.name === "resume" || root.id === "resume-upload-input")) label = "Resume/CV";
      return {
        kind: "file",
        label: label || "File",
        required: !!root.required || (root.getAttribute && root.getAttribute("aria-required") === "true"),
        is_file: true,
        // Cap the accept hint: SmartRecruiters' dropzone lists ~60 extensions
        // (600+ chars), which overflows the backend's accept length cap and 422s
        // the whole autofill request. The label already identifies the file.
        accept: String(root.accept || "").slice(0, 280),
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
