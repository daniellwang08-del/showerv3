import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../content/engine/dom.js", import.meta.url), "utf8");

function dom() {
  const window = { scrollX: 0, scrollY: 0 };
  vm.runInContext(SOURCE, vm.createContext({ window, console }));
  return window.__AF.dom;
}

test("male never matches female options", () => {
  const { textsMatch, containsWord } = dom();
  assert.equal(textsMatch("Female", "Male"), false);
  assert.equal(textsMatch("Cisgender/Female", "Male"), false);
  assert.equal(textsMatch("Woman", "Man"), false);
  assert.equal(containsWord("female", "male"), false);
});

test("word-start containment still matches real variants", () => {
  const { textsMatch } = dom();
  assert.equal(textsMatch("Cisgender/Male", "Male"), true);
  assert.equal(textsMatch("Male", "male"), true);
  assert.equal(textsMatch("Bachelors Degree", "Bachelor"), true);
  assert.equal(textsMatch("Asian (Not Hispanic or Latino)", "Asian"), true);
  assert.equal(textsMatch("I don\u2019t wish to answer", "I don't wish to answer"), true);
  assert.equal(textsMatch("University of Washington-Seattle Campus", "University of Washington"), true);
  assert.equal(textsMatch("", "Male"), false);
});
