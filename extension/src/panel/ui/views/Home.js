import { html, useState } from "../../../lib/preact.js";
import { loadHome, openList, showView, startApplying } from "../../actions/home.js";
import { openFromSessions } from "../../actions/job.js";
import { refreshAccount } from "../../actions/session.js";
import { addJobs, clearAddJobs } from "../../actions/tools.js";
import { formatCount, plural, timeAgo } from "../../format.js";
import { LISTS } from "../../lists.js";
import { Badge, Banner, Button, Count, Section } from "../components.js";
import { Icon } from "../icons.js";

function TodayCard({ data, loading, target }) {
  const applied = data ? data.counts.applied_today : null;
  const pct = applied != null && target ? Math.min(100, Math.round((applied / target) * 100)) : 0;
  const series = (data && data.weekly && data.weekly.series) || [];
  const max = Math.max(1, ...series.map((d) => d.applied));
  return html`<button type="button" class="card today" onClick=${() => showView("stats")}>
    <div class="today-head">
      <span class="eyebrow">Applied today</span>
      <span class="today-goal">Goal ${target}</span>
    </div>
    <div class="today-value">
      <span class="today-number"><${Count} value=${applied} loading=${loading} /></span>
      <span class="today-of">of ${target}</span>
    </div>
    <div class="progress" aria-label=${`${pct}% of today's goal`}><span style=${`width:${pct}%`}></span></div>
    ${series.length
      ? html`<div class="spark" aria-hidden="true">
          ${series.map((d, i) => html`<span class=${i === series.length - 1 ? "is-today" : ""} title=${`${d.label}: ${d.applied} applied`} style=${`height:${Math.max(8, (d.applied / max) * 100)}%`}></span>`)}
        </div>`
      : null}
  </button>`;
}

function ReadyCard({ count, loading }) {
  return html`<div class="card ready">
    <button type="button" class="ready-main" onClick=${() => openList("ready")}>
      <span class="eyebrow">Ready to apply</span>
      <span class="ready-count"><${Count} value=${count} loading=${loading} /></span>
      <span class="ready-hint">${LISTS.ready.hint}</span>
    </button>
    <${Button} variant="primary" icon="bolt" disabled=${!count} onClick=${() => startApplying("ready")}>Start</${Button}>
  </div>`;
}

function InProgress({ data }) {
  const rows = (data && data.in_progress) || [];
  if (!rows.length) return null;
  const ids = rows.map((r) => r.job_id);
  return html`<${Section}
    title="Continue"
    meta=${formatCount(data.in_progress_count)}
    action=${data.in_progress_count > 3 ? html`<button type="button" class="link" onClick=${() => showView("progress")}>See all</button>` : null}
  >
    <div class="rows rows-card">
      ${rows.slice(0, 3).map(
        (r) => html`<button type="button" class="row" onClick=${() => openFromSessions(r.job_id, ids)}>
          <span class="row-body">
            <span class="row-title">${r.title || "Untitled role"}</span>
            <span class="row-sub">${[r.company, timeAgo(r.updated_at)].filter(Boolean).join(" · ")}</span>
          </span>
          <${Icon} name="chevron" size=${16} class="row-chevron" />
        </button>`,
      )}
    </div>
  </${Section}>`;
}

const TILES = ["today", "needs", "remote", "mine", "all", "applied"];

function ListTiles({ counts, loading }) {
  return html`<${Section} title="Jobs">
    <div class="tiles">
      ${TILES.map((id) => {
        const def = LISTS[id];
        return html`<button type="button" class="tile" onClick=${() => openList(id)} title=${def.hint}>
          <span class="tile-count"><${Count} value=${counts ? counts[def.count] : null} loading=${loading} /></span>
          <span class="tile-label">${def.title}</span>
        </button>`;
      })}
    </div>
  </${Section}>`;
}

function AddJobs({ result }) {
  const [text, setText] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    if (await addJobs(text)) setText("");
  };
  const running = result && result.running;
  return html`<${Section} title="Add jobs">
    <form class="card add-jobs" onSubmit=${submit}>
      <textarea class="input" rows="3" placeholder="Paste one or more job links" value=${text} onInput=${(e) => setText(e.currentTarget.value)} disabled=${running}></textarea>
      <div class="add-jobs-foot">
        ${result
          ? html`<span class="add-jobs-result" role="status">
              ${running ? html`Adding ${result.done} of ${result.total}` : null}
              ${!running
                ? html`${result.added ? html`<${Badge} tone="ok">${result.added} added</${Badge}>` : null}
                    ${result.duplicate ? html`<${Badge} tone="muted">${result.duplicate} already in your pool</${Badge}>` : null}
                    ${result.failed.length ? html`<${Badge} tone="danger">${result.failed.length} failed</${Badge}>` : null}
                    <button type="button" class="link" onClick=${clearAddJobs}>Clear</button>`
                : null}
            </span>`
          : html`<span class="muted small">New links are analyzed and scored automatically.</span>`}
        <${Button} variant="secondary" size="sm" icon="plus" type="submit" busy=${running} disabled=${!text.trim()}>Add</${Button}>
      </div>
      ${result && !running && result.failed.length
        ? html`<ul class="add-jobs-failed">
            ${result.failed.slice(0, 5).map((f) => html`<li title=${f.url}><span>${f.url}</span> ${f.reason}</li>`)}
          </ul>`
        : null}
    </form>
  </${Section}>`;
}

export function HomeView({ s }) {
  const { data, loading, error } = s.home;
  const counts = data && data.counts;
  return html`<div class="stack">
    ${s.profileChanged.length
      ? html`<${Banner} tone="info" action=${html`<${Button} size="sm" variant="secondary" onClick=${() => refreshAccount()}>Refresh</${Button}>`}>
          Your ${s.profileChanged.join(", ")} changed in the web app.
        </${Banner}>`
      : null}
    ${error
      ? html`<${Banner} tone="danger" action=${html`<${Button} size="sm" variant="secondary" onClick=${() => loadHome()}>Retry</${Button}>`}>${error}</${Banner}>`
      : null}
    <div class="hero">
      <${ReadyCard} count=${counts ? counts.ready : null} loading=${loading} />
      <${TodayCard} data=${data} loading=${loading} target=${s.dailyApplyTarget} />
    </div>
    <${InProgress} data=${data} />
    <${ListTiles} counts=${counts} loading=${loading} />
    <${AddJobs} result=${s.addJobs} />
    ${data && data.in_progress_count === 0 && counts && !counts.ready
      ? html`<p class="muted small center">${plural(counts.available || 0, "job")} still need a tailored resume.</p>`
      : null}
  </div>`;
}
