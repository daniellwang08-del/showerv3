import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

globalThis.window ??= { screen: { width: 1920, height: 1080 } };
globalThis.navigator ??= { userAgent: "node", language: "en-US" };
let objectUrls = 0;
URL.createObjectURL = () => `blob:test/${++objectUrls}`;
URL.revokeObjectURL = () => {};

const storage = await import("../src/storage.js");
const { emptyReport, setState, state } = await import("../src/panel/state.js");
const report = await import("../src/panel/actions/report.js");
const { addFiles, attachmentKind, formatBytes, removeFile, submitReport } = report;

const MB = 1024 * 1024;
const file = (name, size, type = "") => new File([new Uint8Array(size)], name, { type });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setState({ report: emptyReport(), toast: null });
});

test("attachmentKind accepts screenshots and resume-like files only", () => {
  assert.equal(attachmentKind(file("shot.PNG", 1)), "image");
  assert.equal(attachmentKind(file("", 1, "image/png")), "image");
  assert.equal(attachmentKind(file("Resume.pdf", 1, "application/pdf")), "file");
  assert.equal(attachmentKind(file("cv.docx", 1)), "file");
  assert.equal(attachmentKind(file("console.log", 1)), "file");
  assert.equal(attachmentKind(file("vector.svg", 1, "image/svg+xml")), null);
  assert.equal(attachmentKind(file("setup.exe", 1)), null);
  assert.equal(attachmentKind(file("page.html", 1, "text/html")), null);
});

test("formatBytes reads naturally", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(2.4 * MB), "2.4 MB");
  assert.equal(formatBytes(25 * MB), "25 MB");
});

test("pasted images get a readable name and a preview; real names are kept", () => {
  const added = addFiles([file("image.png", 10, "image/png"), file("My resume.pdf", 20, "application/pdf")]);
  assert.equal(added, 2);
  const [shot, resume] = state.report.files;
  assert.match(shot.file.name, /^Screenshot \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
  assert.equal(shot.kind, "image");
  assert.ok(shot.url.startsWith("blob:"));
  assert.equal(resume.file.name, "My resume.pdf");
  assert.equal(resume.kind, "file");
  assert.equal(resume.url, null);
  assert.notEqual(shot.id, resume.id);

  removeFile(shot.id);
  assert.deepEqual(state.report.files.map((f) => f.file.name), ["My resume.pdf"]);
});

test("addFiles explains every rejected file and enforces the limits", () => {
  assert.equal(addFiles([file("a.exe", 5), file("empty.png", 0, "image/png"), file("big.pdf", 11 * MB)]), 0);
  assert.equal(state.report.files.length, 0);
  assert.match(state.toast.text, /a\.exe is not a supported file type\./);
  assert.match(state.toast.text, /empty\.png is empty\./);
  assert.match(state.toast.text, /big\.pdf is larger than 10 MB\./);

  assert.equal(addFiles(Array.from({ length: 12 }, (_, i) => file(`s${i}.png`, 10, "image/png"))), 10);
  assert.match(state.toast.text, /up to 10 files/);

  setState({ report: emptyReport() });
  assert.equal(addFiles([file("a.pdf", 9 * MB), file("b.pdf", 9 * MB), file("c.pdf", 9 * MB)]), 2);
  assert.match(state.toast.text, /add up to 25 MB/);

  setState({ report: { ...emptyReport(), options: { max_attachments: 1 } } });
  assert.equal(addFiles([file("a.png", 1, "image/png"), file("b.png", 1, "image/png")]), 1);
});

test("submitReport needs a real description before calling the server", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}");
  };
  setState({ report: { ...emptyReport(), description: "  broken  " } });
  assert.equal(await submitReport(), false);
  assert.match(state.report.error, /at least 10 characters/);
  assert.equal(called, false);
});

test("submitReport posts multipart with files, page, and job context, then resets the draft", async () => {
  await storage.setToken("tok");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ id: "r1", number: 7, status: "open", attachments: [] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } });
  };
  setState({
    report: {
      ...emptyReport(),
      category: "autofill",
      title: " Resume missing ",
      description: "  The resume field stayed empty after Autofill.  ",
      includePage: true,
      page: { url: "https://apply.workable.com/acme/j/1/apply", title: "Apply" },
      origin: { view: "job", job_id: "j1", job_title: "Backend Engineer", company: "Acme" },
    },
  });
  addFiles([file("image.png", 10, "image/png"), file("cv.pdf", 20, "application/pdf")]);

  assert.equal(await submitReport(), true);
  const post = calls.find((c) => c.init?.method === "POST");
  assert.match(post.url, /\/api\/v1\/issues$/);
  assert.equal(post.init.headers.Authorization, "Bearer tok");
  assert.equal(post.init.headers["Content-Type"], undefined, "the browser sets the multipart boundary");
  const form = post.init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("category"), "autofill");
  assert.equal(form.get("title"), "Resume missing");
  assert.equal(form.get("description"), "The resume field stayed empty after Autofill.");
  assert.equal(form.get("page_url"), "https://apply.workable.com/acme/j/1/apply");
  assert.equal(form.get("source"), "extension");
  const ctx = JSON.parse(form.get("context"));
  assert.equal(ctx.panel_view, "job");
  assert.equal(ctx.job_id, "j1");
  assert.equal(ctx.company, "Acme");
  assert.equal(ctx.extension_version, "test");
  const files = form.getAll("files");
  assert.equal(files.length, 2);
  assert.match(files[0].name, /^Screenshot /);
  assert.equal(files[1].name, "cv.pdf");

  assert.equal(state.report.sent.number, 7);
  assert.equal(state.report.files.length, 0);
  assert.equal(state.report.description, "");
  assert.equal(state.report.page.url, "https://apply.workable.com/acme/j/1/apply", "page stays for the next report");
  await flush();
});

test("a server rejection keeps the draft and shows the reason", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "evil.svg is not a supported file." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  setState({ report: { ...emptyReport(), description: "Something went wrong here." } });
  addFiles([file("cv.pdf", 20)]);
  assert.equal(await submitReport(), false);
  assert.equal(state.report.error, "evil.svg is not a supported file.");
  assert.equal(state.report.sending, false);
  assert.equal(state.report.files.length, 1);
});

test("leaving out the page sends no page fields", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ id: "r2", number: 8, items: [] }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  setState({
    report: {
      ...emptyReport(),
      description: "Credits did not update after redeeming.",
      includePage: false,
      page: { url: "https://example.com/private", title: "Private" },
    },
  });
  assert.equal(await submitReport(), true);
  const form = calls.find((c) => c?.method === "POST").body;
  assert.equal(form.get("page_url"), null);
  assert.equal(form.get("page_title"), null);
  await flush();
});
