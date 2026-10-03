import { html } from "../../lib/preact.js";
import {
  FIELD_STATUS_LABEL,
  blockStatus,
  cancelAutofill,
  removeAutofillField,
  rerunWorkday,
  resumePicking,
  runAutofill,
  startAutofill,
  stopWorkdayAutofill,
  wdStepLabel,
} from "../autofill/index.js";
import { setAutofill } from "../state.js";
import { toast } from "../toast.js";
import { Badge, Banner, Button, IconButton } from "./components.js";
import { Icon } from "./icons.js";

const STATUS_TONE = { filled: "ok", attached: "ok", partial: "warn", needs_user: "warn", skipped: "muted", not_found: "danger" };

function Status({ tone, pulse = false, children }) {
  return html`<p class=${`af-status af-${tone}`}><i class=${`af-light${pulse ? " is-pulsing" : ""}`}></i><span>${children}</span></p>`;
}

function Head({ engine, title = "Autofill", action }) {
  return html`<header class="af-head">
    <span class="af-title"><${Icon} name="wand" size=${16} />${title}</span>
    ${engine ? html`<${Badge} tone="brand">${engine.label}</${Badge}>` : null}
    <span class="topbar-spacer"></span>
    ${action || null}
  </header>`;
}

function NeedsYou({ items }) {
  if (!items || !items.length) return null;
  return html`<div class="af-needs">
    <p class="af-needs-title"><${Icon} name="alert" size=${14} />${items.length === 1 ? "1 field needs you" : `${items.length} fields need you`}</p>
    <ul>
      ${items.slice(0, 6).map((n) => html`<li><strong>${n.label || "Field"}</strong>${n.reason ? html`<span>${n.reason}</span>` : null}</li>`)}
      ${items.length > 6 ? html`<li class="muted">and ${items.length - 6} more on the page</li>` : null}
    </ul>
  </div>`;
}

function Idle({ engine }) {
  const ok = !engine || engine.available;
  return html`<div class="card af">
    <${Head} engine=${engine} />
    <p class="af-note">${ok ? (engine && engine.note) || "Fills the application on the open tab from your profile." : `${engine.label} forms are not supported yet.`}</p>
    <${Button} variant="primary" icon="wand" block disabled=${!ok} onClick=${() => startAutofill()}>Fill application</${Button}>
  </div>`;
}

function copyDiagnostics(logs) {
  const text = logs.map((row) => `${row && row.t ? new Date(row.t).toISOString() : ""} ${(row && row.line) || ""}`).join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast("Diagnostics copied.", "ok"),
    () => toast("Could not copy to the clipboard.", "danger"),
  );
}

function Workday({ af, autoAdvance }) {
  const busy = !!af.running;
  let status = null;
  if (busy) {
    status = html`<${Status} tone="info" pulse>${af.autoLoop ? af.loopStatus || "Working through the application" : "Filling this step from your profile"}</${Status}>`;
  } else if (af.autoLoop && af.done && af.loopMessage) {
    const tone = af.loopFinished === "review" ? "ok" : ["error", "needs_user", "stuck"].includes(af.loopFinished) ? "warn" : "info";
    status = html`<${Status} tone=${tone}>${af.loopMessage}</${Status}>`;
  } else if (af.done && !af.reports.length && !af.error) {
    status = html`<${Status} tone="warn">No Workday step found. Open the application form and try again.</${Status}>`;
  } else if (!af.done) {
    status = html`<${Status} tone="info" pulse>Starting</${Status}>`;
  }
  return html`<div class="card af">
    <${Head}
      engine=${af.engine}
      title=${af.autoLoop ? "Autofill, all steps" : "Autofill"}
      action=${html`<button type="button" class="link" onClick=${() => (busy ? stopWorkdayAutofill() : cancelAutofill())}>${busy ? "Stop" : "Close"}</button>`}
    />
    ${status}
    ${af.error ? html`<${Banner} tone="danger">${af.error}</${Banner}>` : null}
    ${af.reports.length
      ? html`<ul class="af-steps">
          ${af.reports.map((r) => {
            const toCheck = [...(r.missed || []), ...(r.unmatched || []).map((u) => u.label || u.key)];
            return html`<li>
              <span class="af-step-name">${wdStepLabel(r.step)}</span>
              <${Badge} tone="ok">${(r.filled || []).length} filled</${Badge}>
              ${toCheck.length ? html`<${Badge} tone="warn" title=${toCheck.join(", ")}>${toCheck.length} to check</${Badge}>` : null}
            </li>`;
          })}
        </ul>`
      : null}
    ${af.reports.length && !af.autoLoop && !busy ? html`<p class="af-note">Check the step, click Continue in Workday, then fill again. You submit the application yourself.</p>` : null}
    <${Button} variant="primary" icon="refresh" block busy=${busy} disabled=${!af.done} onClick=${() => rerunWorkday()}>
      ${autoAdvance ? "Run again from this step" : "Fill this step again"}
    </${Button}>
    ${af.aaLogs && af.aaLogs.length
      ? html`<details class="af-diag">
          <summary>Diagnostics</summary>
          <p class="af-note">A step-by-step trace for troubleshooting. Share it with support if a step keeps failing.</p>
          <${Button} size="sm" variant="ghost" icon="copy" onClick=${() => copyDiagnostics(af.aaLogs)}>Copy diagnostics</${Button}>
        </details>`
      : null}
  </div>`;
}

function FieldList({ af, removable }) {
  if (!af.fields.length || af.discovering) return null;
  return html`<ul class="af-fields">
    ${af.fields.map((f) => {
      const st = blockStatus(af, f.handle);
      return html`<li>
        <span class="af-field-name">${f.label || "Form section"}</span>
        ${st ? html`<${Badge} tone=${STATUS_TONE[st] || "muted"}>${FIELD_STATUS_LABEL[st] || st}</${Badge}>` : null}
        ${removable ? html`<${IconButton} icon="x" size=${14} label="Remove" onClick=${() => removeAutofillField(f.handle)} />` : null}
      </li>`;
    })}
  </ul>`;
}

function Form({ af }) {
  const auto = !!(af.engine && af.engine.autoDiscover);
  const n = af.fields.length;
  const filled = af.done || af.fields.some((f) => blockStatus(af, f.handle));
  let status;
  if (af.discovering) status = html`<${Status} tone="info" pulse>Finding the application form</${Status}>`;
  else if (af.picking) status = html`<${Status} tone="info">Click the form sections to fill on the page. Press Esc when done.</${Status}>`;
  else if (af.running) status = html`<${Status} tone="info" pulse>${af.runStatus || "Filling the application"}</${Status}>`;
  else if (filled && !af.error) status = html`<${Status} tone=${af.needsUser.length ? "warn" : "ok"}>${af.needsUser.length ? "Filled. A few fields need you." : "Filled. Review the form and submit."}</${Status}>`;
  else if (!n) status = html`<${Status} tone="muted">${auto ? "No application form found on this page." : "No form sections selected yet."}</${Status}>`;
  else status = html`<${Status} tone="muted">${n === 1 ? "Form found. Ready to fill." : `${n} sections ready to fill.`}</${Status}>`;

  return html`<div class="card af">
    <${Head} engine=${af.engine} action=${html`<button type="button" class="link" onClick=${() => cancelAutofill()}>Close</button>`} />
    ${status}
    ${af.error ? html`<${Banner} tone="danger" onDismiss=${() => setAutofill({ error: null })}>${af.error}</${Banner}>` : null}
    <${FieldList} af=${af} removable=${!auto && !af.running} />
    ${!af.running && !af.discovering ? html`<${NeedsYou} items=${af.needsUser} />` : null}
    <div class="af-actions">
      ${!auto && !af.discovering && !af.picking && !af.running
        ? html`<${Button} variant="ghost" size="sm" icon="mouse" onClick=${() => resumePicking()}>Select more</${Button}>`
        : null}
      <${Button}
        variant="primary"
        icon="wand"
        block=${auto}
        busy=${af.running || af.discovering}
        disabled=${af.picking || !n}
        onClick=${() => runAutofill()}
      >${filled ? "Fill again" : "Fill"}</${Button}>
    </div>
  </div>`;
}

export function AutofillCard({ s }) {
  const af = s.autofill;
  if (!af.active) return html`<${Idle} engine=${s.job && s.job.engine} />`;
  if (af.engine && af.engine.mode === "workday") return html`<${Workday} af=${af} autoAdvance=${s.autoAdvance} />`;
  return html`<${Form} af=${af} />`;
}
