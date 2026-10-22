import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function source(path) {
  const lines = readFileSync(new URL(path, import.meta.url), "utf8").split(/\r?\n/).map((l) => l.trim());
  const start = lines.indexOf("function answerCategory(label) {");
  const end = lines.indexOf("}", start);
  assert.ok(start >= 0 && end > start, `answerCategory not found in ${path}`);
  return lines.slice(start, end + 1).join("\n");
}

const panel = source("../src/panel/autofill/form.js");
const picker = source("../content/picker.js");
const answerCategory = vm.runInNewContext(`(${panel})`);

test("panel and picker copies of answerCategory are identical", () => {
  assert.equal(panel, picker);
});

test("citizenship and export-control status are never cached as work authorization", () => {
  for (const label of [
    "This position may require access to information and technology that is subject to export controls, such as EAR. Are you any of the following?",
    "Are you a U.S. citizen?",
    "Are you a US person as defined by ITAR?",
    "Are you a lawful permanent resident (green card holder)?",
    "Citizenship status",
  ]) {
    assert.equal(answerCategory(label), null, label);
  }
});

test("work authorization and other categories still cache", () => {
  assert.equal(answerCategory("Are you legally authorized to work in the United States?"), "work_auth");
  assert.equal(answerCategory("Do you have the right to work in the UK?"), "work_auth");
  assert.equal(answerCategory("Will you now or in the future require sponsorship?"), "sponsorship");
  assert.equal(answerCategory("Graduation year"), null);
  assert.equal(answerCategory("Gender"), "gender");
});
