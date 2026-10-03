import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractHttpUrls,
  formatCount,
  markdownToPlain,
  matchTone,
  platformFromUrl,
  renderMarkdown,
  resumeStage,
  timeAgo,
  toJobCard,
  workMode,
} from "../src/panel/format.js";

test("matchTone uses one scale", () => {
  assert.equal(matchTone(92), "strong");
  assert.equal(matchTone(80), "strong");
  assert.equal(matchTone(65), "good");
  assert.equal(matchTone(50), "fair");
  assert.equal(matchTone(12), "weak");
  assert.equal(matchTone(null), null);
});

test("timeAgo buckets", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(timeAgo("2026-10-03T11:59:40Z", now), "just now");
  assert.equal(timeAgo("2026-10-03T11:15:00Z", now), "45m ago");
  assert.equal(timeAgo("2026-10-03T06:00:00Z", now), "6h ago");
  assert.equal(timeAgo("2026-09-30T12:00:00Z", now), "3d ago");
  assert.equal(timeAgo(null, now), null);
  assert.equal(timeAgo("not a date", now), null);
});

test("formatCount abbreviates large numbers", () => {
  assert.equal(formatCount(3868), "3,868");
  assert.equal(formatCount(12_400), "12.4k");
  assert.equal(formatCount(250_000), "250k");
  assert.equal(formatCount(undefined), "0");
});

test("platform and work mode detection", () => {
  assert.equal(platformFromUrl("https://boards.greenhouse.io/acme/jobs/1"), "greenhouse");
  assert.equal(platformFromUrl("https://acme.wd5.myworkdayjobs.com/x"), "workday");
  assert.equal(platformFromUrl("https://example.com/careers"), null);
  assert.equal(workMode("Remote (US)"), "remote");
  assert.equal(workMode("hybrid, 2 days"), "hybrid");
  assert.equal(workMode("", true), "remote");
  assert.equal(workMode("On-site"), "onsite");
});

test("resumeStage reads build statuses", () => {
  assert.equal(resumeStage({ resume_pdf_status: "completed" }).id, "ready");
  assert.equal(resumeStage({ content_generation_status: "failed" }).id, "failed");
  assert.equal(resumeStage({ content_generation_status: "processing" }).id, "building");
  assert.equal(resumeStage({}).id, "none");
});

test("toJobCard normalizes a dashboard row", () => {
  const card = toJobCard({
    id: 7,
    title: "  Staff Engineer ",
    company: "Acme",
    match_overall_score: 81.6,
    source_url: "https://jobs.lever.co/acme/1",
    applied_at: null,
    is_remote: true,
  });
  assert.equal(card.id, "7");
  assert.equal(card.title, "Staff Engineer");
  assert.equal(card.score, 82);
  assert.equal(card.platformLabel, "Lever");
  assert.equal(card.mode, "remote");
  assert.equal(card.applied, false);
});

test("renderMarkdown escapes model output", () => {
  const out = renderMarkdown('**Yes**. <script>alert(1)</script>\n- one\n- two');
  assert.ok(out.includes("<strong>Yes</strong>"));
  assert.ok(out.includes("&lt;script&gt;"));
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("<ul><li>one</li><li>two</li></ul>"));
});

test("markdownToPlain strips formatting for copy", () => {
  assert.equal(markdownToPlain("## Title\n**bold** and `code`\n* item"), "Title\nbold and code\n- item");
});

test("extractHttpUrls dedupes and trims punctuation", () => {
  const urls = extractHttpUrls("See https://a.com/x, and https://a.com/x. Also (https://b.io/y)");
  assert.deepEqual(urls, ["https://a.com/x", "https://b.io/y"]);
});
