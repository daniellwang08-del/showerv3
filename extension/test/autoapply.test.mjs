import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPageUrl, platformOfUrl, rankJobs } from "../src/autoapply/platforms.js";

test("ranks easy ATS first, then by match score", () => {
  const rows = [
    { id: 1, title: "A", source_url: "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1", match_overall_score: 99 },
    { id: 2, title: "B", source_url: "https://apply.workable.com/acme/j/ABC123/", match_overall_score: 90 },
    { id: 3, title: "C", source_url: "https://job-boards.greenhouse.io/acme/jobs/123", match_overall_score: 70 },
    { id: 4, title: "D", source_url: "https://jobs.lever.co/acme/abc-def", match_overall_score: 85 },
    { id: 5, title: "E", source_url: "https://www.linkedin.com/jobs/view/1", match_overall_score: 95 },
    { id: 6, title: "F", source_url: "https://jobs.ashbyhq.com/acme/uuid", match_overall_score: 60, applied_at: "2026-10-01" },
  ];
  const allowed = new Set(["greenhouse", "lever", "ashby", "workable"]);
  const ranked = rankJobs(rows, { allowed });
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["4", "3", "2"]
  );
  assert.equal(ranked[0].platform, "lever");
});

test("skips attempted jobs and allows opt-in account sites last", () => {
  const rows = [
    { id: 1, source_url: "https://boards.greenhouse.io/acme/jobs/1" },
    { id: 2, source_url: "https://boards.greenhouse.io/acme/jobs/2" },
    { id: 3, source_url: "https://acme.wd1.myworkdayjobs.com/x/job/3" },
  ];
  const ranked = rankJobs(rows, { allowed: new Set(["greenhouse", "workday"]), skip: new Set(["1"]) });
  assert.deepEqual(
    ranked.map((r) => [r.id, r.platform]),
    [
      ["2", "greenhouse"],
      ["3", "workday"],
    ]
  );
});

test("job board listings are their own platform", () => {
  assert.equal(platformOfUrl("https://www.indeed.com/viewjob?jk=1"), "board");
  assert.equal(platformOfUrl("https://jobright.ai/jobs/info/1"), "board");
  assert.equal(platformOfUrl("https://careers.example.com/jobs/1"), "generic");
});

test("listing URLs map to the application form", () => {
  assert.equal(applyPageUrl("lever", "https://jobs.lever.co/acme/abc-123"), "https://jobs.lever.co/acme/abc-123/apply");
  assert.equal(applyPageUrl("lever", "https://jobs.lever.co/acme/abc-123/apply"), "https://jobs.lever.co/acme/abc-123/apply");
  assert.equal(applyPageUrl("ashby", "https://jobs.ashbyhq.com/acme/uuid?src=x"), "https://jobs.ashbyhq.com/acme/uuid/application?src=x");
  assert.equal(applyPageUrl("workable", "https://apply.workable.com/acme/j/ABC123/"), "https://apply.workable.com/acme/j/ABC123/apply/");
  assert.equal(applyPageUrl("breezy", "https://acme.breezy.hr/p/abc-engineer"), "https://acme.breezy.hr/p/abc-engineer/apply");
  assert.equal(applyPageUrl("greenhouse", "https://boards.greenhouse.io/acme/jobs/1"), "https://boards.greenhouse.io/acme/jobs/1");
});
