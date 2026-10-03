import { html, useEffect } from "../../../lib/preact.js";
import { loadStats } from "../../actions/tools.js";
import { formatCount, platformLabel } from "../../format.js";
import { Section, Segmented, Spinner } from "../components.js";

const PERIODS = [
  { value: "day", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "month", label: "30 days" },
];

function Chart({ series }) {
  const max = Math.max(1, ...series.map((d) => Math.max(d.recommended, d.applied)));
  const showEvery = series.length > 14 ? 5 : 1;
  return html`<div class="chart" role="img" aria-label="Matched and applied jobs per day">
    <div class="chart-bars">
      ${series.map(
        (d) => html`<div class="chart-col" title=${`${d.label}: ${d.recommended} matched, ${d.applied} applied`}>
          <span class="bar bar-matched" style=${`height:${(d.recommended / max) * 100}%`}></span>
          <span class="bar bar-applied" style=${`height:${(d.applied / max) * 100}%`}></span>
        </div>`,
      )}
    </div>
    <div class="chart-axis">
      ${series.map((d, i) => html`<span>${i % showEvery === 0 || i === series.length - 1 ? d.label : ""}</span>`)}
    </div>
    <div class="chart-legend">
      <span><i class="bar-matched"></i>Matched</span>
      <span><i class="bar-applied"></i>Applied</span>
    </div>
  </div>`;
}

function Metric({ label, value, hint }) {
  return html`<div class="metric">
    <span class="metric-value">${value}</span>
    <span class="metric-label">${label}</span>
    ${hint ? html`<span class="metric-hint">${hint}</span>` : null}
  </div>`;
}

export function StatsView({ s }) {
  const { period, progress, scraper, loading } = s.stats;
  useEffect(() => {
    void loadStats(period);
  }, []);
  const totals = progress && progress.totals;
  const rate = totals && totals.recommended ? Math.round((totals.applied / totals.recommended) * 100) : null;
  const sources = ((scraper && scraper.sources) || []).slice().sort((a, b) => b.count - a.count).slice(0, 6);
  const maxSource = Math.max(1, ...sources.map((x) => x.count));
  return html`<div class="stack">
    <${Segmented} label="Period" value=${period} options=${PERIODS} onChange=${(p) => loadStats(p)} />
    ${loading && !progress ? html`<div class="center-fill"><${Spinner} size=${20} /></div>` : null}
    ${totals
      ? html`<div class=${`metrics${loading ? " is-refreshing" : ""}`}>
          <${Metric} label="Applied" value=${formatCount(totals.applied)} />
          <${Metric} label="Matched" value=${formatCount(totals.recommended)} hint=${progress.min_match_score ? `Score ${progress.min_match_score}+` : "Any score"} />
          <${Metric} label="Apply rate" value=${rate == null ? "-" : `${rate}%`} hint="Of matched jobs" />
        </div>`
      : null}
    ${progress && progress.series.length > 1 ? html`<${Section} title="By day"><div class="card"><${Chart} series=${progress.series} /></div></${Section}>` : null}
    ${scraper
      ? html`<${Section} title="Job pool">
          <div class="card">
            <div class="metrics metrics-inline">
              <${Metric} label="Jobs" value=${formatCount(scraper.total_jobs)} />
              <${Metric} label="Remote" value=${formatCount(scraper.total_remote)} />
              <${Metric} label="Analyzed" value=${formatCount(scraper.extracted_jobs)} />
            </div>
            ${sources.length
              ? html`<ul class="sources">
                  ${sources.map(
                    (x) => html`<li>
                      <span class="sources-name">${platformLabel(x.source) || "Other"}</span>
                      <span class="sources-bar"><span style=${`width:${(x.count / maxSource) * 100}%`}></span></span>
                      <span class="sources-count">${formatCount(x.count)}</span>
                    </li>`,
                  )}
                </ul>`
              : null}
          </div>
        </${Section}>`
      : null}
  </div>`;
}
