// Reads a job posting out of the open tab for quick apply. Injected with
// chrome.scripting.executeScript, so it must stay self-contained: no imports,
// no outer variables. Order of trust: the user's selection, the page's
// schema.org JobPosting data, known job board containers, then the main content.

export function readJobPostingInPage(maxChars = 60000) {
  const MIN = 200;
  const one = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const tidy = (s) =>
    String(s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxChars);
  const htmlToText = (html) =>
    String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>|<\/(p|div|li|ul|ol|h[1-6]|section|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  const textOf = (el) => (el ? el.innerText || el.textContent || "" : "");
  const first = (selectors, minLen = 1) => {
    for (const sel of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch {
        continue;
      }
      for (const el of nodes) {
        const text = textOf(el);
        if (one(text).length >= minLen) return text;
      }
    }
    return "";
  };

  const postings = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = node["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) postings.push(node);
    if (node["@graph"]) visit(node["@graph"]);
  };
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      visit(JSON.parse(script.textContent || ""));
    } catch {
      /* malformed block */
    }
  }
  const ld = postings[0] || null;
  const org = ld && ld.hiringOrganization;

  const title = one(
    (ld && ld.title) ||
      first([
        ".job-details-jobs-unified-top-card__job-title",
        ".jobs-unified-top-card__job-title",
        ".top-card-layout__title",
        '[data-testid="jobsearch-JobInfoHeader-title"]',
        '[data-test="job-title"]',
        "h1",
      ]),
  ).slice(0, 300);
  const company = one(
    (org && (typeof org === "string" ? org : org.name)) ||
      first([
        ".job-details-jobs-unified-top-card__company-name",
        ".jobs-unified-top-card__company-name",
        ".topcard__org-name-link",
        '[data-testid="inlineHeader-companyName"]',
        '[data-company-name="true"]',
        '[data-test="employer-name"]',
      ]),
  ).slice(0, 300);

  const selection = window.getSelection ? String(window.getSelection() || "") : "";
  let description = "";
  let source = "";
  if (one(selection).length >= MIN) {
    description = selection;
    source = "selection";
  }
  if (!description && ld && one(htmlToText(ld.description)).length >= MIN) {
    description = htmlToText(ld.description);
    source = "structured";
  }
  if (!description) {
    description = first(
      [
        ".jobs-description__content",
        ".jobs-box__html-content",
        "#job-details",
        ".show-more-less-html__markup",
        ".description__text",
        "#jobDescriptionText",
        '[class*="JobDetails_jobDescription"]',
        '[data-automation-id="jobPostingDescription"]',
        ".job-description",
        "#job-description",
        '[class*="job-description"]',
        '[id*="job-description"]',
        '[class*="jobDescription"]',
        '[class*="posting-description"]',
      ],
      MIN,
    );
    if (description) source = "section";
  }
  if (!description) {
    description = first(["main", '[role="main"]', "article"], MIN) || textOf(document.body);
    source = "page";
  }
  const lead = [title, company].filter(Boolean).join(" at ");
  const text = tidy(description);
  return {
    description: lead && !one(text).toLowerCase().includes(title.toLowerCase()) ? tidy(`${lead}\n\n${text}`) : text,
    title,
    company,
    url: String(location.href || ""),
    source,
  };
}
