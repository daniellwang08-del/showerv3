// Autofill engine routing layer.
//
// A job's application form is filled by a platform-specific "engine". Each ATS
// (Greenhouse, Workday, ...) renders its inputs with a static, consistent style,
// so a dedicated engine per platform fills it far more reliably than one generic
// engine. This module is the router: it detects the platform from the job URL
// and returns the engine descriptor that should run.
//
// An engine descriptor declares:
//   - id / label   : identity shown in the UI
//   - platform     : the detected platform it serves
//   - mode         : which side-panel orchestration to use
//                    ("select" = manual region selection + LLM, the current flow)
//   - scripts      : the content-script bundle id background.js injects
//   - available    : whether the engine is implemented and may run
//
// To add a dedicated engine later (e.g. Workday): register its bundle in
// background.js (ENGINE_SCRIPTS), add an ENGINES entry keyed by the platform id
// with available:true and its mode, and implement that mode in app.js. The
// router will pick it up automatically.

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

// Host -> platform id. Ordered, first match wins. Add new ATS hosts here.
const PLATFORM_MATCHERS = [
  ["greenhouse", (h) => h.includes("greenhouse.io") || h.includes("greenhouse-")],
  ["applytojob", (h) => h.includes("applytojob.com")],
  ["recruiterflow", (h) => h.includes("recruiterflow.com") || h.includes("rfcareers.")],
  ["workday", (h) => h.includes("myworkdayjobs.com") || h.endsWith(".workday.com")],
  ["lever", (h) => h.includes("lever.co")],
  ["ashby", (h) => h.includes("ashbyhq.com")],
  ["smartrecruiters", (h) => h.includes("smartrecruiters.com")],
  ["icims", (h) => h.includes("icims.com")],
  ["taleo", (h) => h.includes("taleo.net")],
  ["bamboohr", (h) => h.includes("bamboohr.com")],
  ["workable", (h) => h.includes("workable.com")],
];

// Detect the ATS platform for a job. Prefers the live page URL (the actual
// application page) and falls back to the job snapshot's source URL.
export function detectPlatform({ snapshot, pageUrl } = {}) {
  const candidates = [pageUrl, snapshot && snapshot.url, snapshot && snapshot.source].filter(Boolean);
  for (const u of candidates) {
    const h = hostOf(u);
    if (!h) continue;
    for (const [id, test] of PLATFORM_MATCHERS) {
      if (test(h)) return id;
    }
  }
  return "generic";
}

// Implemented engine descriptors, keyed by platform id. Platforms without an
// entry fall back to the generic best-effort select engine.
export const ENGINES = {
  greenhouse: {
    id: "greenhouse",
    label: "Greenhouse",
    mode: "select",
    scripts: "greenhouse",
    available: true,
    // Greenhouse renders the whole application inside one stable form container
    // (form#application-form). Instead of manual region tagging, the engine
    // auto-selects that single container and fills it on Start (no clicking).
    autoDiscover: true,
    note: "Finds the application form and fills it automatically.",
  },
  // ApplyToJob (JazzHR / "resumator"): the whole application is one native HTML
  // <form> (text/select/textarea/file — no custom widgets), so the generic
  // component drivers fill it directly. Reuses the greenhouse bundle and the
  // auto-discover flow; a small prep step reveals the hidden resume file input.
  applytojob: {
    id: "applytojob",
    label: "ApplyToJob",
    mode: "select",
    scripts: "greenhouse",
    available: true,
    autoDiscover: true,
    note: "Finds the application form and fills it automatically.",
  },
  // RecruiterFlow: one React <form> mixing native inputs, intl-tel-input phone,
  // react-select (single + multi), custom Yes/No buttons, and repeating
  // Experience/Education blocks. Reuses the greenhouse bundle + auto-discover;
  // a prep step adds a repeating row per work/education entry (Workday-style),
  // fills them deterministically, sets Country, and ticks the consent box.
  recruiterflow: {
    id: "recruiterflow",
    label: "RecruiterFlow",
    mode: "select",
    scripts: "greenhouse",
    available: true,
    autoDiscover: true,
    note: "Finds the application form and fills it automatically.",
  },
  // Ashby (jobs.ashbyhq.com): the application renders inside one stable container
  // (.ashby-application-form-container — a div, not a <form>) with standard
  // <label for> + native inputs and Ashby's own combobox/file widgets. Reuses the
  // greenhouse bundle + auto-discover flow; the platform-agnostic component
  // drivers fill text/email/tel/textarea/select/file and the LLM resolves values.
  ashby: {
    id: "ashby",
    label: "Ashby",
    mode: "select",
    scripts: "greenhouse",
    available: true,
    autoDiscover: true,
    note: "Finds the application form and fills it automatically.",
  },
  // SmartRecruiters (jobs.smartrecruiters.com): the application renders inside one
  // stable container (<oc-oneclick-form>) built entirely from SmartRecruiters'
  // "spl-*" Lit web components, so every real <input>/<textarea> lives inside a
  // declarative shadow root. Reuses the greenhouse bundle + auto-discover flow;
  // the engine pierces those shadow roots (gated to this platform) to fill the
  // personal-info / resume / consent fields via the LLM, and a prep step adds and
  // saves each Experience/Education entry (Workday-style: Add -> fill -> Save).
  smartrecruiters: {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    mode: "select",
    scripts: "greenhouse",
    available: true,
    autoDiscover: true,
    note: "Finds the application form and fills it automatically.",
  },
  generic: {
    id: "generic",
    label: "Generic (best-effort)",
    mode: "select",
    scripts: "greenhouse",
    available: true,
  },
  // Dedicated, deterministic engine: maps a canonical structured profile to
  // Workday's stable data-automation-id fields. No manual region selection and
  // no LLM for standard fields.
  workday: {
    id: "workday",
    label: "Workday",
    mode: "workday",
    scripts: "workday",
    available: true,
    note: "Deterministic auto-fill from your profile.",
  },
};

// Resolve the engine for a job. Returns a descriptor with the detected platform
// attached. Unknown / not-yet-dedicated platforms use the generic engine.
export function resolveEngine({ snapshot, pageUrl } = {}) {
  const platform = detectPlatform({ snapshot, pageUrl });
  const engine = ENGINES[platform] || ENGINES.generic;
  return { ...engine, platform };
}
