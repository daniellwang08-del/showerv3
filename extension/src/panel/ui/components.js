import { html, useEffect, useRef } from "../../lib/preact.js";
import { formatCount, matchTone, monogram } from "../format.js";
import { Icon } from "./icons.js";

export function Button({ variant = "secondary", size = "md", icon, busy = false, disabled = false, onClick, title, type = "button", block = false, children }) {
  const cls = ["btn", `btn-${variant}`, `btn-${size}`, block ? "btn-block" : "", busy ? "is-busy" : ""].join(" ");
  return html`<button type=${type} class=${cls} disabled=${disabled || busy} onClick=${onClick} title=${title}>
    ${busy ? html`<${Spinner} size=${14} />` : icon ? html`<${Icon} name=${icon} size=${size === "sm" ? 14 : 16} />` : null}
    ${children ? html`<span>${children}</span>` : null}
  </button>`;
}

export function IconButton({ icon, label, onClick, active = false, disabled = false, size = 16 }) {
  return html`<button type="button" class=${`icon-btn${active ? " is-active" : ""}`} aria-label=${label} title=${label} disabled=${disabled} onClick=${onClick}>
    <${Icon} name=${icon} size=${size} />
  </button>`;
}

export function Spinner({ size = 16 }) {
  return html`<span class="spinner" style=${`width:${size}px;height:${size}px`} role="status" aria-label="Loading"></span>`;
}

export function Badge({ tone = "muted", dot = false, children, title }) {
  return html`<span class=${`badge badge-${tone}`} title=${title}>${dot ? html`<i class="badge-dot"></i>` : null}${children}</span>`;
}

export function Score({ value, matching = false, size = "md" }) {
  if (matching && value == null) return html`<span class=${`score score-${size} score-pending`} title="Scoring">...</span>`;
  if (value == null) return html`<span class=${`score score-${size} score-none`} title="Not scored yet">-</span>`;
  const tone = matchTone(value);
  return html`<span class=${`score score-${size} score-${tone}`} title=${`Match score ${value}`}>${value}</span>`;
}

export function Avatar({ label }) {
  return html`<span class="avatar" aria-hidden="true">${monogram(label)}</span>`;
}

export function Count({ value, loading }) {
  if (loading && value == null) return html`<span class="skeleton skeleton-count"></span>`;
  return html`<span>${formatCount(value || 0)}</span>`;
}

export function SkeletonRows({ count = 6 }) {
  return html`<div class="rows">
    ${Array.from({ length: count }, () => html`<div class="row row-skeleton">
      <span class="skeleton skeleton-avatar"></span>
      <span class="row-body"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span></span>
    </div>`)}
  </div>`;
}

export function Empty({ icon = "inbox", title, children, action }) {
  return html`<div class="empty">
    <span class="empty-icon"><${Icon} name=${icon} size=${20} /></span>
    ${title ? html`<p class="empty-title">${title}</p>` : null}
    ${children ? html`<p class="empty-body">${children}</p>` : null}
    ${action || null}
  </div>`;
}

export function Banner({ tone = "info", icon, children, action, onDismiss }) {
  return html`<div class=${`banner banner-${tone}`} role=${tone === "danger" ? "alert" : "status"}>
    <${Icon} name=${icon || (tone === "ok" ? "check" : tone === "info" ? "info" : "alert")} size=${16} />
    <div class="banner-body">${children}</div>
    ${action || null}
    ${onDismiss ? html`<${IconButton} icon="x" label="Dismiss" size=${14} onClick=${onDismiss} />` : null}
  </div>`;
}

export function Section({ title, meta, action, children, flush = false }) {
  return html`<section class=${`section${flush ? " section-flush" : ""}`}>
    ${title
      ? html`<header class="section-head">
          <h2 class="section-title">${title}</h2>
          ${meta ? html`<span class="section-meta">${meta}</span>` : null}
          ${action ? html`<span class="section-action">${action}</span>` : null}
        </header>`
      : null}
    ${children}
  </section>`;
}

export function Toggle({ checked, onChange, label, hint, disabled = false }) {
  return html`<label class=${`toggle-row${disabled ? " is-disabled" : ""}`}>
    <span class="toggle-copy">
      <span class="toggle-label">${label}</span>
      ${hint ? html`<span class="toggle-hint">${hint}</span>` : null}
    </span>
    <input type="checkbox" class="toggle" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} />
  </label>`;
}

export function Select({ value, options, onChange, label, class: cls = "" }) {
  return html`<label class=${`select ${cls}`}>
    ${label ? html`<span class="sr-only">${label}</span>` : null}
    <select value=${String(value ?? "")} aria-label=${label} onChange=${(e) => onChange(e.currentTarget.value)}>
      ${options.map((o) => html`<option value=${String(o.value)}>${o.label}</option>`)}
    </select>
    <${Icon} name="chevronDown" size=${14} />
  </label>`;
}

export function Segmented({ value, options, onChange, label }) {
  return html`<div class="segmented" role="radiogroup" aria-label=${label}>
    ${options.map(
      (o) => html`<button type="button" role="radio" aria-checked=${o.value === value} class=${o.value === value ? "is-on" : ""} onClick=${() => onChange(o.value)}>
        ${o.label}
      </button>`,
    )}
  </div>`;
}

export function Pager({ page, pages, total, perPage, onPage, loading }) {
  if (!total) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return html`<nav class="pager" aria-label="Pages">
    <span class="pager-range">${formatCount(from)} to ${formatCount(to)} of ${formatCount(total)}</span>
    <span class="pager-buttons">
      <${IconButton} icon="back" label="Previous page" disabled=${loading || page <= 1} onClick=${() => onPage(page - 1)} />
      <span class="pager-page">${page} / ${pages}</span>
      <${IconButton} icon="chevron" label="Next page" disabled=${loading || page >= pages} onClick=${() => onPage(page + 1)} />
    </span>
  </nav>`;
}

export function Modal({ modal, onClose }) {
  const confirmRef = useRef(null);
  useEffect(() => {
    if (!modal) return undefined;
    confirmRef.current && confirmRef.current.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);
  if (!modal) return null;
  return html`<div class="modal-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title" class="modal-title">${modal.title}</h2>
      ${modal.message ? html`<p class="modal-body">${modal.message}</p>` : null}
      <div class="modal-actions">
        <${Button} variant="ghost" onClick=${onClose} disabled=${modal.busy}>Cancel</${Button}>
        <button ref=${confirmRef} type="button" class=${`btn btn-md btn-${modal.tone === "danger" ? "danger" : "primary"}`} disabled=${modal.busy} onClick=${modal.onConfirm}>
          ${modal.busy ? html`<${Spinner} size=${14} />` : null}<span>${modal.confirmLabel || "Confirm"}</span>
        </button>
      </div>
    </div>
  </div>`;
}

export function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  return html`<div class=${`toast toast-${toast.tone}`} role="status" key=${toast.id} onClick=${onDismiss}>
    <${Icon} name=${toast.tone === "ok" ? "check" : toast.tone === "info" ? "info" : "alert"} size=${15} />
    <span>${toast.text}</span>
  </div>`;
}
