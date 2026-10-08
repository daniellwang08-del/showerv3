import { html } from "../../../lib/preact.js";
import {
  completeJob,
  dismissReportNotice,
  docsResumeSource,
  downloadDoc,
  openJob,
  refreshDocs,
  reportExpired,
  runAnalysis,
  skipJob,
} from "../../actions/job.js";
import { buildForJob, openMatchingPreferences } from "../../actions/tailor.js";
import { WORK_MODE_LABEL, timeAgo, workMode } from "../../format.js";
import { openInWorkTab } from "../../tabs.js";
import { AutofillCard } from "../Autofill.js";
import { Chat } from "../Chat.js";
import { Avatar, Badge, Banner, Button, IconButton, Score, Spinner } from "../components.js";
import { Icon } from "../icons.js";

function ResumeMode({ original }) {
  return html`<${Badge}
    tone=${original ? "muted" : "brand"}
    title=${`Applications use your ${original ? "original" : "tailored"} resume. Change it in Preferences under Matching.`}
  >
    <${Icon} name=${original ? "file" : "sparkles"} size=${11} />${original ? "Original resume" : "Tailored resume"}
  </${Badge}>`;
}

function Header({ job, original }) {
  const snap = job.snapshot || {};
  const mode = workMode(snap.remote_policy);
  const facts = [
    job.location ? { icon: "pin", text: job.location } : null,
    mode && !String(job.location).toLowerCase().includes(mode) ? { icon: "globe", text: WORK_MODE_LABEL[mode] } : null,
    snap.salary_range ? { icon: "briefcase", text: snap.salary_range } : null,
    snap.posted_date ? { icon: "clock", text: `Posted ${timeAgo(snap.posted_date) || snap.posted_date}` } : null,
  ].filter(Boolean);
  return html`<div class="card job-head">
    <div class="job-head-main">
      <${Avatar} label=${job.company || job.title} />
      <div class="job-head-text">
        <h2 class="job-title">${job.title}</h2>
        <p class="job-company">${job.company || "Company not listed"}</p>
      </div>
      ${job.url ? html`<${IconButton} icon="external" size=${15} label="Open posting" onClick=${() => openInWorkTab(job.url)} />` : null}
      <${Score} value=${job.score} size="lg" />
    </div>
    <ul class="job-facts">
      <li><${ResumeMode} original=${original} /></li>
      ${job.applied ? html`<li><${Badge} tone="ok" dot>Applied ${timeAgo(job.appliedAt) || ""}</${Badge}></li>` : null}
      ${facts.map((f) => html`<li><${Icon} name=${f.icon} size=${13} />${f.text}</li>`)}
    </ul>
  </div>`;
}

function DocFile({ ready, kind, type, name, source, hint }) {
  return html`<button
    type="button"
    class=${`doc-file doc-${kind}`}
    disabled=${!ready}
    title=${ready ? hint || `Download ${name}` : `${name} not ready`}
    aria-label=${ready ? `Download ${name}` : `${name} not ready`}
    onClick=${() => downloadDoc(type, name, source ? { source } : undefined)}
  >
    <${Icon} name="file" size=${20} />
    <span class="doc-tag">${kind === "pdf" ? "PDF" : "W"}</span>
  </button>`;
}

/** Original resume mode: the imported file goes out unchanged; NAO writes only the cover letter. */
function OriginalDocuments({ job, d, building, failed, build }) {
  const hasCover = d.coverPdf || d.coverDocx;
  const file = d.originalFilename;
  const isDocx = /\.docx$/i.test(file || "");
  const hint = file ? `Download ${file}, the resume applications upload` : "";
  let cover;
  if (hasCover) {
    cover = html`
      <${DocFile} ready=${d.coverPdf} kind="pdf" type="cover_letter_pdf" name="Cover letter PDF" />
      <${DocFile} ready=${d.coverDocx} kind="word" type="cover_letter_docx" name="Cover letter Word file" />`;
  } else if (building) {
    cover = html`<span class="docs-status"><${Spinner} size=${13} />Writing</span>`;
  } else if (!job.ready) {
    cover = html`<${Button} size="sm" variant="secondary" icon="sparkles" busy=${job.analyzing} onClick=${runAnalysis}>${job.analyzing ? "Analyzing" : "Analyze"}</${Button}>`;
  } else {
    cover = html`<${Button} size="sm" variant="secondary" icon="sparkles" title="Write a cover letter for this job" onClick=${build}>${failed ? "Try again" : "Write"}</${Button}>`;
  }
  return html`<div class="card docs">
    <div class="docs-row">
      <div class="docs-files">
        <span class="docs-label">Resume</span>
        <${DocFile} ready=${!!file} kind="pdf" type="resume_pdf" name="Original resume PDF" source="original" hint=${hint} />
        <${DocFile} ready=${!!file && isDocx} kind="word" type="resume_docx" name="Original resume Word file" source="original" hint=${hint} />
        <span class="docs-sep" aria-hidden="true"></span>
        <span class="docs-label">Cover letter</span>
        ${cover}
      </div>
      ${hasCover || building ? html`<${IconButton} icon="refresh" size=${14} label="Check documents again" onClick=${() => refreshDocs()} />` : null}
    </div>
    ${file
      ? html`<p class="docs-note"><${Icon} name="file" size=${12} />Applications upload ${file} as is.</p>`
      : html`<p class="docs-note is-danger"><${Icon} name="alert" size=${13} />No resume file on record.
          <button type="button" class="link" onClick=${() => openMatchingPreferences()}>Add your resume file</button></p>`}
    ${failed && !building ? html`<p class="docs-note is-danger"><${Icon} name="alert" size=${13} />The cover letter failed${d.buildError ? `: ${d.buildError}` : "."}</p>` : null}
  </div>`;
}

function Documents({ job, s }) {
  const d = job.docs;
  const hasResume = d.resumePdf || d.resumeDocx;
  const hasCover = d.coverPdf || d.coverDocx;
  const status = String(d.contentStatus || "").toLowerCase();
  const building = ["queued", "pending", "processing", "running", "generating"].includes(status) || s.tailor.runs.some((r) => r.jobId === job.job_id && r.status !== "error");
  const failed = status === "failed" || !!d.buildError;
  const build = () => buildForJob({ id: job.job_id, title: job.title, company: job.company });
  if (docsResumeSource(d) === "original") {
    return html`<${OriginalDocuments} job=${job} d=${d} building=${building} failed=${failed} build=${build} />`;
  }

  let body;
  if (hasResume || hasCover) {
    body = html`<div class="docs-files">
      <span class="docs-label">Resume</span>
      <${DocFile} ready=${d.resumePdf} kind="pdf" type="resume_pdf" name="Resume PDF" />
      <${DocFile} ready=${d.resumeDocx} kind="word" type="resume_docx" name="Resume Word file" />
      <span class="docs-sep" aria-hidden="true"></span>
      <span class="docs-label">Cover letter</span>
      <${DocFile} ready=${d.coverPdf} kind="pdf" type="cover_letter_pdf" name="Cover letter PDF" />
      <${DocFile} ready=${d.coverDocx} kind="word" type="cover_letter_docx" name="Cover letter Word file" />
    </div>`;
  } else if (building) {
    body = html`<p class="docs-status"><${Spinner} size=${13} />Writing your tailored resume.</p>`;
  } else if (!job.ready) {
    body = html`<p class="docs-status">${job.analyzing ? "Scoring your fit." : "Not analyzed yet."}</p>
      <${Button} size="sm" variant="secondary" icon="sparkles" busy=${job.analyzing} onClick=${runAnalysis}>${job.analyzing ? "Analyzing" : "Analyze"}</${Button}>`;
  } else {
    body = html`<p class="docs-status" title="Until it is built, autofill uploads your original resume.">No tailored resume yet.</p>
      <${Button} size="sm" variant="secondary" icon="sparkles" onClick=${build}>${failed ? "Try again" : "Build"}</${Button}>`;
  }

  return html`<div class="card docs">
    <div class="docs-row">
      ${body}
      ${hasResume || building ? html`<${IconButton} icon="refresh" size=${14} label="Check documents again" onClick=${() => refreshDocs()} />` : null}
    </div>
    ${building && hasResume && !hasCover
      ? html`<p class="docs-note"><${Spinner} size=${12} />Writing your cover letter.</p>`
      : null}
    ${failed && !building ? html`<p class="docs-note is-danger"><${Icon} name="alert" size=${13} />The last build failed${d.buildError ? `: ${d.buildError}` : "."}</p>` : null}
  </div>`;
}

function ActionBar({ job, s }) {
  return html`<footer class="actionbar">
    <${Button} variant="secondary" icon="clock" disabled=${s.skipping} title="Skip for now. It stays in In progress so you can apply later." onClick=${skipJob}>Skip</${Button}>
    <${Button} variant="ghost" icon="flag" title="Report this posting as expired" onClick=${reportExpired}>Expired</${Button}>
    <${Button} variant="primary" icon=${job.applied ? "chevron" : "check"} block onClick=${() => completeJob({ next: true })}>
      ${job.applied ? "Next job" : "Applied, next"}
    </${Button}>
  </footer>`;
}

export function JobView({ s }) {
  const job = s.job;
  if (s.jobError) {
    return html`<div class="stack">
      <${Banner} tone="danger">${s.jobError}</${Banner}>
      ${s.applyContext && s.applyContext.seen.length
        ? html`<${Button} variant="secondary" icon="refresh" onClick=${() => openJob(s.applyContext.seen[s.applyContext.seen.length - 1])}>Try again</${Button}>`
        : null}
    </div>`;
  }
  if (!job) return html`<div class="center-fill"><${Spinner} size=${22} /></div>`;
  return html`<div class="job">
    <div class="job-top">
      ${s.reportNotice
        ? html`<${Banner} tone="ok" onDismiss=${dismissReportNotice}>
            Reported ${s.reportNotice.title}${s.reportNotice.company ? ` at ${s.reportNotice.company}` : ""} as expired.
          </${Banner}>`
        : null}
      <${Header} job=${job} original=${docsResumeSource(job.docs) === "original"} />
      <${AutofillCard} s=${s} />
      <${Documents} job=${job} s=${s} />
    </div>
    <div class="job-chat"><${Chat} s=${s} /></div>
    <${ActionBar} job=${job} s=${s} />
  </div>`;
}
