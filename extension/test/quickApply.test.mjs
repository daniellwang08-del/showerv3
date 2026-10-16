import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { readJobPostingInPage } = await import("../src/panel/pageJob.js");
const { isPastedJobUrl } = await import("../src/panel/format.js");
const api = await import("../src/api.js");
const storage = await import("../src/storage.js");

const LONG = "You will design and build Python services on AWS, own the data platform, and mentor engineers. ".repeat(4);

/** Minimal DOM for the injected reader: selector -> [{ innerText }], plus JSON-LD blocks. */
function withPage({ nodes = {}, ld = [], selection = "", href = "https://www.linkedin.com/jobs/view/123/" }, fn) {
  const saved = { document: globalThis.document, window: globalThis.window, location: globalThis.location };
  const scripts = ld.map((obj) => ({ textContent: typeof obj === "string" ? obj : JSON.stringify(obj) }));
  globalThis.document = {
    querySelectorAll: (sel) => (sel === 'script[type="application/ld+json"]' ? scripts : (nodes[sel] || []).map((t) => ({ innerText: t }))),
    body: { innerText: nodes.body ? nodes.body[0] : "" },
  };
  globalThis.window = { getSelection: () => selection };
  globalThis.location = { href };
  try {
    return fn();
  } finally {
    Object.assign(globalThis, saved);
  }
}

test("reader prefers schema.org JobPosting data", () => {
  const out = withPage(
    {
      ld: [
        "{ not json",
        { "@graph": [{ "@type": "Organization" }, { "@type": "JobPosting", title: "Data Engineer", hiringOrganization: { name: "Acme" }, description: `<p>About the role</p><ul><li>Python &amp; SQL</li></ul><p>${LONG}</p>` }] },
      ],
      nodes: { h1: ["Something else"] },
    },
    () => readJobPostingInPage(),
  );
  assert.equal(out.source, "structured");
  assert.equal(out.title, "Data Engineer");
  assert.equal(out.company, "Acme");
  assert.match(out.description, /^Data Engineer at Acme\n\nAbout the role\n+- Python & SQL\n/);
  assert.ok(!out.description.includes("<"));
  assert.equal(out.url, "https://www.linkedin.com/jobs/view/123/");
});

test("reader uses the job board container on LinkedIn", () => {
  const out = withPage(
    {
      nodes: {
        ".job-details-jobs-unified-top-card__job-title": ["  Senior   Backend Engineer "],
        ".job-details-jobs-unified-top-card__company-name": ["Globex"],
        ".jobs-description__content": [`About the job\n\n\n\nSenior Backend Engineer\n${LONG}`],
      },
    },
    () => readJobPostingInPage(),
  );
  assert.equal(out.source, "section");
  assert.equal(out.title, "Senior Backend Engineer");
  assert.equal(out.company, "Globex");
  assert.ok(out.description.startsWith("About the job\n\nSenior Backend Engineer"), "keeps text, collapses blank runs, no duplicate header");
});

test("a long selection wins over everything else", () => {
  const out = withPage(
    { selection: `Picked text. ${LONG}`, nodes: { ".jobs-description__content": [LONG] } },
    () => readJobPostingInPage(),
  );
  assert.equal(out.source, "selection");
  assert.ok(out.description.startsWith("Picked text."));
});

test("falls back to the main content and respects the size cap", () => {
  const out = withPage({ nodes: { main: [LONG.repeat(20)] } }, () => readJobPostingInPage(500));
  assert.equal(out.source, "page");
  assert.equal(out.description.length, 500);
});

test("pasted stand-in URLs are recognised", () => {
  assert.ok(isPastedJobUrl("https://nao.it.com/app/jobs?pasted=0123456789abcdef01234567"));
  assert.ok(!isPastedJobUrl("https://www.linkedin.com/jobs/view/123/"));
  assert.ok(!isPastedJobUrl("https://x.com/a?pasted=short"));
  assert.ok(!isPastedJobUrl(null));
});

test("only real posting pages become the job link", async () => {
  const { postingUrlFromTab } = await import("../src/panel/actions/quickApply.js");
  const backend = "https://api.example.com";
  assert.equal(postingUrlFromTab("https://www.linkedin.com/jobs/view/1/", backend), "https://www.linkedin.com/jobs/view/1/");
  assert.equal(postingUrlFromTab("chrome://newtab/", backend), "");
  assert.equal(postingUrlFromTab("https://api.example.com/app/jobs", backend), "");
  assert.equal(postingUrlFromTab("https://www.nao.it.com/app", backend), "");
  assert.equal(postingUrlFromTab("https://nao.it.com/app/jobs?pasted=0123456789abcdef01234567", ""), "");
  assert.equal(postingUrlFromTab(undefined, backend), "");
});

test("a pasted job has no posting link and waits for its documents", async () => {
  const { isPreparing, jobFromSession } = await import("../src/panel/actions/job.js");
  const job = jobFromSession({
    job_id: 7,
    job_snapshot: { url: "https://nao.it.com/app/jobs?pasted=0123456789abcdef01234567", title: "Engineer", ready: true },
    docs: {},
  });
  assert.equal(job.url, "");
  assert.equal(job.job_id, "7");
  const now = 1_000_000;
  assert.equal(isPreparing({ ...job, preparingUntil: now + 1 }, now), true);
  assert.equal(isPreparing({ ...job, preparingUntil: now - 1 }, now), false);
  assert.equal(isPreparing({ ...job, preparingUntil: now + 1, docs: { ...job.docs, resumePdf: true, coverPdf: true } }, now), false);
  assert.equal(isPreparing(job, now), false);
});

test("quickApply posts the description and optional fields", async () => {
  await storage.setToken("tok");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ job_id: "j1", reused: false, title: "T", company: "C", analysis: "queued" }), { status: 200 });
  };
  const res = await api.quickApply({ description: LONG, url: null, title: "T", company: null });
  assert.equal(res.job_id, "j1");
  assert.match(calls[0].url, /\/api\/v1\/jobs\/quick-apply$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { description: LONG, url: null, title: "T", company: null });
});
