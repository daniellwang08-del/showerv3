import "./chrome-stub.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { glassdoorJobUrl, glassdoorSearchUrl } = await import("../src/jobSiteBrowserSync.js");

const base = {
  origin: "https://www.glassdoor.com",
  path: "/Job/united-states-software-engineer-jobs-SRCH_IL.0,13_KO14,31.htm",
  search: "?sc.keyword=software%2520engineer",
};

test("a Glassdoor job opens on the canonical search page with the start URL's filters", () => {
  const url = glassdoorJobUrl(base, "https://www.glassdoor.com/Job/jobs.htm?sc.keyword=software+engineer&fromAge=3", "101");
  const parsed = new URL(url);
  assert.equal(parsed.pathname, base.path);
  assert.equal(parsed.searchParams.get("fromAge"), "3");
  assert.equal(parsed.searchParams.get("jl"), "101");
  assert.equal(parsed.searchParams.has("sc.keyword"), false);
});

test("the filtered search page drops the keyword and any selected job", () => {
  const url = glassdoorSearchUrl({ ...base, search: "?sc.keyword=x&jl=9" }, "https://www.glassdoor.com/Job/jobs.htm?sc.keyword=x&fromAge=3");
  assert.equal(url, `https://www.glassdoor.com${base.path}?fromAge=3`);
});

test("filters already on the canonical page win over the start URL", () => {
  const url = glassdoorJobUrl({ ...base, search: "?fromAge=1&jl=5" }, "https://www.glassdoor.com/Job/x.htm?fromAge=3", "7");
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("fromAge"), "1");
  assert.equal(parsed.searchParams.get("jl"), "7");
});
