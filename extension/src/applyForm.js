// Job links often open the description page, not the form: Workable's
// jobs.workable.com shows the form only after "Apply now", career sites link
// out to their ATS. Before filling, click through to the application and
// confirm a form is on screen.

// Button or link text that opens an application (lowercase, spaces collapsed).
export const APPLY_TEXT =
  "^(apply|apply now|apply here|apply online|apply today|easy apply|quick apply|" +
  "apply for (this|the) (job|position|role|opening)|apply (to|for) (this )?(job|position|role|opening)|apply for job|" +
  "start (your |my )?application|begin (your )?application|i'?m interested|apply on (the )?company (site|website))$";
// Apply buttons that lead to a sign-in or another site's profile instead.
export const NOT_APPLY_TEXT = "linkedin|indeed|google|facebook|seek|sign in|log in|login|register|create account";
// Stable markers on apply buttons whose text may vary or be an icon.
export const APPLY_ATTR = "overview-apply-now|apply-now|apply-button|applybutton|btn-apply|job-apply|apply_button";
// Visible fields that make a page an application form rather than a listing.
export const MIN_FORM_FIELDS = 3;

export function isApplyText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  return !!t && new RegExp(APPLY_TEXT).test(t) && !new RegExp(NOT_APPLY_TEXT).test(t);
}

/**
 * Runs in the page (chrome.scripting, so it must stay self-contained): reports
 * whether a form is showing and, when `act` is set and none is, opens the
 * application. Links are returned for the caller to load in the same tab, so
 * target=_blank does not scatter tabs.
 */
export function probeApplyPage(rules, act) {
  const visible = (el) => {
    try {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  };
  const text = (el) => String(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
  const fieldSel = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=search]), textarea, select";
  const fields = Array.from(document.querySelectorAll(fieldSel)).filter(
    (el) => visible(el) && !el.closest("header, nav, footer, [role=search], [role=dialog][data-ui=cookie-consent]") && !/search|newsletter|subscribe/i.test(`${el.name} ${el.id} ${el.placeholder || ""}`)
  ).length;
  const fileInForm = !!document.querySelector("form input[type=file]");
  const ready = fields >= rules.minFields || (fileInForm && fields >= 1);
  if (ready || !act) return { ready, fields };

  const applyText = new RegExp(rules.applyText);
  const notApply = new RegExp(rules.notApplyText);
  const applyAttr = new RegExp(rules.applyAttr);
  const candidates = Array.from(document.querySelectorAll("a, button, [role=button], input[type=button], input[type=submit]"))
    .filter((el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true")
    .map((el) => {
      const t = text(el);
      const attrs = [el.id, el.className && String(el.className), el.getAttribute("data-ui"), el.getAttribute("data-testid"), el.getAttribute("data-qa")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!t || notApply.test(t) || t.length > 60) return null;
      const score = applyText.test(t) ? 2 : applyAttr.test(attrs) && /apply/.test(t) ? 1 : 0;
      return score ? { el, t, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const hit = candidates[0];
  if (!hit) return { ready: false, fields };
  const href = hit.el.tagName === "A" ? hit.el.getAttribute("href") || "" : "";
  if (href && !/^(#|javascript:|mailto:)/i.test(href)) {
    try {
      const url = new URL(href, location.href);
      if (url.href.split("#")[0] !== location.href.split("#")[0]) return { ready: false, fields, label: hit.t, href: url.href };
    } catch {
      /* fall through to a click */
    }
  }
  try {
    hit.el.scrollIntoView({ block: "center" });
  } catch {
    /* ignore */
  }
  hit.el.click();
  return { ready: false, fields, label: hit.t, clicked: true };
}

const RULES = { applyText: APPLY_TEXT, notApplyText: NOT_APPLY_TEXT, applyAttr: APPLY_ATTR, minFields: MIN_FORM_FIELDS };
const HOPS = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probe(tabId, act) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: !act },
      func: probeApplyPage,
      args: [RULES, act],
    });
    return (results || []).map((r) => r && r.result).filter(Boolean);
  } catch {
    return [];
  }
}

async function settled(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === "complete") return true;
    await sleep(400);
  }
  return true;
}

// Pages that mount the form on an animation frame (Workable) do nothing in a
// hidden tab, so after this long the tab is shown once.
const FOCUS_AFTER_MS = 3000;

/**
 * Make sure the tab shows an application form, clicking through "Apply" up to
 * a few times. A click that opens a new tab is folded back into this one.
 * `focus(tabId)` brings a background tab to the front when the form is slow.
 * Returns { ready, steps: [labels clicked], tab }.
 */
export async function reachApplicationForm(tabId, { onStep = () => {}, waitMs = 15_000, focus = null } = {}) {
  const steps = [];
  for (let hop = 0; hop <= HOPS; hop++) {
    const frames = await probe(tabId, false);
    if (frames.some((f) => f.ready)) return { ready: true, steps, tab: await chrome.tabs.get(tabId) };
    if (hop === HOPS) break;

    const opened = [];
    const onCreated = (t) => {
      if (t.openerTabId === tabId) opened.push(t.id);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    let action;
    try {
      [action] = await probe(tabId, true);
    } finally {
      setTimeout(() => chrome.tabs.onCreated.removeListener(onCreated), 3000);
    }
    if (!action || !(action.href || action.clicked)) break;
    steps.push(action.label || "Apply");
    onStep(`Opening the application ("${action.label || "Apply"}")…`);
    if (action.href) {
      await chrome.tabs.update(tabId, { url: action.href });
      await sleep(500);
      await settled(tabId, 45_000);
    }

    // A form mounted in place, a page load, or a new tab: wait for whichever comes.
    const clickedAt = Date.now();
    const end = clickedAt + waitMs;
    let focused = false;
    while (Date.now() < end) {
      await sleep(700);
      if (focus && !focused && Date.now() - clickedAt >= FOCUS_AFTER_MS) {
        focused = true;
        await Promise.resolve(focus(tabId)).catch(() => {});
      }
      if (opened.length) {
        const extra = await chrome.tabs.get(opened[0]).catch(() => null);
        const url = extra && (extra.pendingUrl || extra.url);
        if (url && /^https?:/i.test(url)) {
          await chrome.tabs.remove(opened[0]).catch(() => {});
          opened.length = 0;
          await chrome.tabs.update(tabId, { url });
          await sleep(500);
          await settled(tabId, 45_000);
        }
      }
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { ready: false, steps, tab: null };
      if (tab.status !== "complete") continue;
      if ((await probe(tabId, false)).some((f) => f.ready)) break;
    }
  }
  return { ready: false, steps, tab: await chrome.tabs.get(tabId).catch(() => null) };
}
