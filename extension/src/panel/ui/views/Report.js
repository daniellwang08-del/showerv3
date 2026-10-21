import { html, useEffect, useRef, useState } from "../../../lib/preact.js";
import {
  ACCEPT,
  DEFAULT_CATEGORIES,
  DESCRIPTION_MIN,
  addFiles,
  captureTab,
  clipboardFiles,
  formatBytes,
  limits,
  removeFile,
  setDraft,
  startAnother,
  submitReport,
} from "../../actions/report.js";
import { timeAgo } from "../../format.js";
import { Badge, Banner, Button, IconButton, Section, Select, SkeletonRows } from "../components.js";
import { Icon } from "../icons.js";

const STATUS = {
  open: { label: "Open", tone: "brand" },
  in_progress: { label: "In progress", tone: "warn" },
  resolved: { label: "Resolved", tone: "ok" },
  closed: { label: "Closed", tone: "muted" },
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "";
  }
}

function Attachments({ files }) {
  if (!files.length) return null;
  const images = files.filter((f) => f.kind === "image");
  const others = files.filter((f) => f.kind !== "image");
  return html`<div class="report-files">
    ${images.length
      ? html`<div class="report-thumbs">
          ${images.map(
            (f) => html`<figure class="report-thumb" key=${f.id} title=${f.file.name}>
              <img src=${f.url} alt=${f.file.name} />
              <figcaption>${formatBytes(f.file.size)}</figcaption>
              <span class="report-remove"><${IconButton} icon="x" size=${12} label=${`Remove ${f.file.name}`} onClick=${() => removeFile(f.id)} /></span>
            </figure>`,
          )}
        </div>`
      : null}
    ${others.map(
      (f) => html`<div class="report-file" key=${f.id}>
        <${Icon} name="file" size=${15} />
        <span class="report-file-name" title=${f.file.name}>${f.file.name}</span>
        <span class="muted small">${formatBytes(f.file.size)}</span>
        <${IconButton} icon="x" size=${12} label=${`Remove ${f.file.name}`} onClick=${() => removeFile(f.id)} />
      </div>`,
    )}
  </div>`;
}

function DropZone({ r }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const lim = limits();
  const total = r.files.reduce((n, f) => n + f.file.size, 0);
  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    addFiles(e.dataTransfer && e.dataTransfer.files, { prefix: "Attachment" });
  };
  return html`<div class="field">
    <span class="field-label">Screenshots and files</span>
    <div
      class=${`report-drop${over ? " is-over" : ""}`}
      onDragOver=${(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave=${() => setOver(false)}
      onDrop=${onDrop}
    >
      <${Icon} name="image" size=${18} />
      <p class="report-drop-copy">Drop files here or paste a screenshot with <kbd>Ctrl</kbd>+<kbd>V</kbd>.</p>
      <div class="report-drop-actions">
        <${Button} size="sm" variant="secondary" icon="upload" onClick=${() => input.current && input.current.click()}>Upload</${Button}>
        <${Button} size="sm" variant="secondary" icon="camera" busy=${r.capturing} onClick=${captureTab}>Capture page</${Button}>
      </div>
      <input
        ref=${input}
        type="file"
        multiple
        accept=${ACCEPT}
        hidden
        onChange=${(e) => {
          addFiles(e.currentTarget.files, { prefix: "Attachment" });
          e.currentTarget.value = "";
        }}
      />
    </div>
    <${Attachments} files=${r.files} />
    <span class="setting-hint">
      ${r.files.length
        ? `${r.files.length} of ${lim.max_attachments} files, ${formatBytes(total)} of ${formatBytes(lim.max_total_bytes)}.`
        : `Images, PDF, Word, or text files. Up to ${lim.max_attachments} files, ${formatBytes(lim.max_file_bytes)} each.`}
    </span>
  </div>`;
}

function Sent({ sent }) {
  return html`<div class="card report-sent" role="status">
    <span class="report-sent-icon"><${Icon} name="check" size=${18} /></span>
    <div>
      <p class="report-sent-title">Report #${sent.number} sent</p>
      <p class="muted small">
        Thanks. The NAO team reviews every report${sent.attachments && sent.attachments.length
          ? `, including the ${sent.attachments.length} attachment${sent.attachments.length === 1 ? "" : "s"} you added`
          : ""}. Follow its status below.
      </p>
    </div>
    <${Button} size="sm" variant="secondary" icon="plus" onClick=${startAnother}>Report another issue</${Button}>
  </div>`;
}

function Form({ r }) {
  const categories = (r.options && r.options.categories) || DEFAULT_CATEGORIES;
  const short = r.description.trim().length < DESCRIPTION_MIN;
  const submit = (e) => {
    e.preventDefault();
    void submitReport();
  };
  return html`<form class="card stack report-form" onSubmit=${submit}>
    <label class="field">
      <span class="field-label">What is it about?</span>
      <${Select} label="What is it about?" value=${r.category} options=${categories} onChange=${(v) => setDraft({ category: v })} class="select-block" />
    </label>
    <label class="field">
      <span class="field-label">Summary <span class="muted">(optional)</span></span>
      <input class="input" type="text" maxlength="160" placeholder="For example: Resume did not upload on Workable" value=${r.title}
        onInput=${(e) => setDraft({ title: e.currentTarget.value })} />
    </label>
    <label class="field">
      <span class="field-label">What happened?</span>
      <textarea
        class="input"
        rows="7"
        maxlength="10000"
        placeholder="What were you doing, what did you expect, and what happened instead? Steps to reproduce help us fix it faster."
        value=${r.description}
        onInput=${(e) => setDraft({ description: e.currentTarget.value })}
        onKeyDown=${(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
        }}
      ></textarea>
    </label>
    <${DropZone} r=${r} />
    ${r.page
      ? html`<label class="check report-page">
          <input type="checkbox" checked=${r.includePage} onChange=${(e) => setDraft({ includePage: e.currentTarget.checked })} />
          <span>Include the page I'm on <span class="report-page-host" title=${r.page.url}>${hostOf(r.page.url)}</span></span>
        </label>`
      : null}
    ${r.error ? html`<${Banner} tone="danger">${r.error}</${Banner}>` : null}
    <div class="paste-foot">
      <span class="muted small">Your app version and browser are included to help us reproduce it.</span>
      <${Button} variant="primary" icon="send" type="submit" busy=${r.sending} disabled=${short}>Send report</${Button}>
    </div>
  </form>`;
}

function Mine({ r }) {
  if (r.mineLoading && !r.mine) return html`<${Section} title="Your reports"><${SkeletonRows} count=${2} /></${Section}>`;
  if (!r.mine || !r.mine.length) return null;
  return html`<${Section} title="Your reports">
    <div class="rows rows-card" role="list">
      ${r.mine.map((it) => {
        const st = STATUS[it.status] || STATUS.open;
        const files = (it.attachments || []).length;
        return html`<div class="row" role="listitem" key=${it.id}>
          <span class="row-body">
            <span class="row-title">#${it.number} ${it.title}</span>
            <span class="row-meta">
              <${Badge} tone=${st.tone} dot>${st.label}</${Badge}>
              <span>${timeAgo(it.created_at)}</span>
              ${files ? html`<span><${Icon} name="paperclip" size=${11} /> ${files}</span>` : null}
            </span>
          </span>
        </div>`;
      })}
    </div>
  </${Section}>`;
}

export function ReportView({ s }) {
  const r = s.report;
  useEffect(() => {
    const onPaste = (e) => {
      const files = clipboardFiles(e);
      if (!files.length) return;
      e.preventDefault();
      startAnother();
      addFiles(files, { prefix: "Screenshot" });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
  return html`<div class="stack">
    ${r.sent ? html`<${Sent} sent=${r.sent} />` : html`<${Form} r=${r} />`}
    <${Mine} r=${r} />
  </div>`;
}
