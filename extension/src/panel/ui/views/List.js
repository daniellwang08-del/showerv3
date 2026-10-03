import { html } from "../../../lib/preact.js";
import { loadList, setFilters } from "../../actions/home.js";
import { openFromList } from "../../actions/job.js";
import { buildForJob } from "../../actions/tailor.js";
import { WORK_MODE_LABEL, formatCount, timeAgo, toJobCard } from "../../format.js";
import { LISTS, MIN_SCORES, SORTS } from "../../lists.js";
import { Avatar, Badge, Banner, Button, Empty, Pager, Score, Select, SkeletonRows } from "../components.js";
import { Icon } from "../icons.js";

function JobRow({ job, showBuild, run }) {
  const sub = [job.company, job.location || (job.mode && WORK_MODE_LABEL[job.mode])].filter(Boolean).join(" · ");
  const modeLabel = job.mode && job.location && !job.location.toLowerCase().includes(job.mode) ? WORK_MODE_LABEL[job.mode] : null;
  const posted = timeAgo(job.postedAt);
  const when = posted ? `Posted ${posted}` : timeAgo(job.addedAt);
  return html`<div class="row row-job" role="listitem">
    <button type="button" class="row-hit" onClick=${() => openFromList(job.id)} aria-label=${`Open ${job.title}`}></button>
    <${Avatar} label=${job.company || job.title} />
    <span class="row-body">
      <span class="row-title">${job.title}</span>
      ${sub ? html`<span class="row-sub">${sub}</span>` : null}
      <span class="row-meta">
        ${job.applied ? html`<${Badge} tone="ok" dot>Applied</${Badge}>` : null}
        ${!job.applied && job.stage.id !== "none" && job.stage.id !== "ready" ? html`<${Badge} tone=${job.stage.tone} dot>${job.stage.label}</${Badge}>` : null}
        ${modeLabel ? html`<span>${modeLabel}</span>` : null}
        ${job.platformLabel ? html`<span>${job.platformLabel}</span>` : null}
        ${when ? html`<span>${when}</span>` : null}
      </span>
    </span>
    <span class="row-side">
      <${Score} value=${job.score} matching=${job.matching} />
      ${showBuild && job.stage.id === "none"
        ? run && run.status === "done"
          ? html`<${Badge} tone="warn" dot>Queued</${Badge}>`
          : html`<${Button} size="sm" variant="secondary" icon="sparkles" busy=${run && run.status === "running"} onClick=${() => buildForJob(job)} title="Build a tailored resume">Build</${Button}>`
        : null}
    </span>
  </div>`;
}

function Filters({ s, def }) {
  const f = s.filters;
  return html`<div class="filters">
    <label class="search">
      <${Icon} name="search" size=${15} />
      <input type="search" class="input" placeholder="Search title, company, or link" value=${f.q} onInput=${(e) => setFilters({ q: e.currentTarget.value })} aria-label="Search jobs" />
    </label>
    <div class="filter-row">
      <${Select} label="Sort" value=${f.sort} options=${SORTS} onChange=${(v) => setFilters({ sort: v })} />
      <${Select} label="Minimum match" value=${f.minScore} options=${MIN_SCORES} onChange=${(v) => setFilters({ minScore: Number(v) })} />
      ${def.remoteOnly
        ? null
        : html`<button type="button" class=${`chip-toggle${f.remoteOnly ? " is-on" : ""}`} aria-pressed=${f.remoteOnly} onClick=${() => setFilters({ remoteOnly: !f.remoteOnly })}>
            <${Icon} name="globe" size=${14} /> Remote
          </button>`}
    </div>
  </div>`;
}

export function ListView({ s }) {
  const def = LISTS[s.listId] || LISTS.all;
  const list = s.list;
  const filtered = !!(s.filters.q || s.filters.minScore || s.filters.remoteOnly);
  const runs = s.tailor.runs;
  const cards = list.items.map(toJobCard);
  return html`<div class="stack list-view">
    <div class="list-head">
      <p class="muted small">${def.hint}</p>
      <span class="list-total">${list.loading && !list.items.length ? "" : formatCount(list.total)}</span>
    </div>
    <${Filters} s=${s} def=${def} />
    ${list.error
      ? html`<${Banner} tone="danger" action=${html`<${Button} size="sm" variant="secondary" onClick=${() => loadList(list.page)}>Retry</${Button}>`}>${list.error}</${Banner}>`
      : null}
    ${list.loading && !list.items.length
      ? html`<${SkeletonRows} count=${6} />`
      : !cards.length && !list.error
        ? html`<${Empty} icon=${filtered ? "search" : "inbox"} title=${filtered ? "No matches" : "Nothing here yet"}>
            ${filtered ? "Try a different search or loosen the filters." : def.empty}
          </${Empty}>`
        : html`<div class=${`rows${list.loading ? " is-refreshing" : ""}`} role="list">
            ${cards.map(
              (job) => html`<${JobRow}
                key=${job.id}
                job=${job}
                showBuild=${!!def.tailor}
                run=${runs.find((r) => r.jobId === job.id)}
              />`,
            )}
          </div>`}
    <${Pager} page=${list.page} pages=${list.pages} total=${list.total} perPage=${s.pageSize} loading=${list.loading} onPage=${(p) => loadList(p)} />
  </div>`;
}
