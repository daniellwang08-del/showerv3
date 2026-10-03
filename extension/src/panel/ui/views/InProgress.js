import { html, useEffect } from "../../../lib/preact.js";
import { openFromSessions } from "../../actions/job.js";
import { loadInProgress } from "../../actions/tools.js";
import { timeAgo } from "../../format.js";
import { Avatar, Banner, Empty, SkeletonRows } from "../components.js";
import { Icon } from "../icons.js";

export function InProgressView({ s }) {
  const { items, loading, error } = s.inProgress;
  useEffect(() => {
    void loadInProgress();
  }, []);
  const ids = items.map((r) => String(r.job_id));
  return html`<div class="stack">
    <p class="muted small">Applications you opened but have not marked applied.</p>
    ${error ? html`<${Banner} tone="danger">${error}</${Banner}>` : null}
    ${loading && !items.length
      ? html`<${SkeletonRows} count=${5} />`
      : !items.length
        ? html`<${Empty} title="Nothing in progress">Jobs you open from a list show up here until you mark them applied.</${Empty}>`
        : html`<div class="rows" role="list">
            ${items.map(
              (r) => html`<button type="button" class="row" role="listitem" onClick=${() => openFromSessions(r.job_id, ids)}>
                <${Avatar} label=${r.company || r.job_title} />
                <span class="row-body">
                  <span class="row-title">${r.job_title || "Untitled role"}</span>
                  <span class="row-sub">${[r.company, timeAgo(r.updated_at)].filter(Boolean).join(" · ")}</span>
                </span>
                <${Icon} name="chevron" size=${16} class="row-chevron" />
              </button>`,
            )}
          </div>`}
  </div>`;
}
