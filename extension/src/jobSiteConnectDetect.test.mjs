/**
 * Pure-logic checks mirroring jobSiteConnect.js sign-in detection.
 * Run: node extension/src/jobSiteConnectDetect.test.mjs
 */

function urlMatchesAny(url, patterns) {
  if (!url || !patterns || !patterns.length) return false;
  const lower = String(url).toLowerCase();
  return patterns.some((p) => p && lower.includes(String(p).toLowerCase()));
}

function cookieKey(cookie) {
  return String(cookie.name || "") + "=" + String(cookie.value == null ? "" : cookie.value);
}

function sessionNamedCookies(cookies, names) {
  const keys = names.map((n) => String(n).toLowerCase());
  return (cookies || []).filter((c) =>
    keys.some((k) => String(c.name || "").toLowerCase().includes(k)),
  );
}

function cookieSignatureChanged(pending, authed) {
  const initial = new Set(pending.initialCookieSignature || []);
  return authed.some((c) => !initial.has(cookieKey(c)));
}

function isSignedIn(pending, tab, cookies) {
  const url = (tab && tab.url) || "";
  if (!url || /^(chrome|chrome-extension|about|edge|devtools):/i.test(url)) return false;
  if (!String(url).toLowerCase().includes("jobright.ai")) return false;
  if (urlMatchesAny(url, pending.loginPathPatterns)) return false;
  const authed = sessionNamedCookies(cookies, pending.sessionCookieNames);
  if (!authed.length) return false;
  const urlSignedIn = urlMatchesAny(url, pending.signedInUrlPatterns);
  const complete = !tab || tab.status === "complete";
  if (!complete) return false;
  if (urlSignedIn) {
    if (pending.requireFreshSession) return cookieSignatureChanged(pending, authed);
    return true;
  }
  if ((pending.signedInUrlPatterns || []).length) {
    return false;
  }
  return cookieSignatureChanged(pending, authed);
}

const JOBRIGHT = {
  signedInUrlPatterns: ["jobright.ai/jobs/recommend"],
  sessionCookieNames: ["SESSION_ID", "jwt"],
  loginPathPatterns: ["/login", "/signin", "/sign-in", "/auth"],
  initialCookieSignature: ["SESSION_ID=abc"],
  requireFreshSession: false,
};

const session = [{ name: "SESSION_ID", value: "abc" }];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  isSignedIn(JOBRIGHT, { url: "https://jobright.ai/jobs/recommend", status: "complete" }, session),
  "recommend + session should be signed in",
);

assert(
  !isSignedIn(JOBRIGHT, { url: "https://jobright.ai/", status: "complete" }, session),
  "homepage must not count as signed in even with session cookies",
);

assert(
  !urlMatchesAny("https://jobright.ai/jobs/123", JOBRIGHT.signedInUrlPatterns),
  "job detail URL should not match recommend pattern",
);

assert(
  isSignedIn(
    { ...JOBRIGHT, initialCookieSignature: ["SESSION_ID=stale"] },
    { url: "https://jobright.ai/jobs/recommend", status: "complete" },
    [{ name: "SESSION_ID", value: "fresh" }],
  ),
  "recommend after re-login should count",
);

const force = {
  ...JOBRIGHT,
  requireFreshSession: true,
  initialCookieSignature: ["SESSION_ID=abc"],
};
assert(
  !isSignedIn(force, { url: "https://jobright.ai/jobs/recommend", status: "complete" }, session),
  "forceLogin must not accept unchanged session on recommend",
);
assert(
  isSignedIn(force, { url: "https://jobright.ai/jobs/recommend", status: "complete" }, [
    { name: "SESSION_ID", value: "new" },
  ]),
  "forceLogin accepts refreshed session on recommend",
);

assert(
  urlMatchesAny("https://jobright.ai/jobs/recommend", JOBRIGHT.signedInUrlPatterns),
  "loginUrl probes auth destination",
);

console.log("jobSiteConnectDetect tests passed");
