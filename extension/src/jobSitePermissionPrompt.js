// Cookie-access grant for the job-site connect flow.
//
// WHY THIS LIVES IN THE SIDE PANEL:
//   The dashboard's "Connect" button runs in a content script, and Chrome does
//   not expose chrome.permissions to content scripts -- the isolated world only
//   gets dom, i18n, storage and part of runtime. Relaying to the service worker
//   does not help either: a user gesture only survives a sendMessage hop when it
//   originates in an extension UI context. The side panel IS such a context, so
//   it has both the API and a real click. The worker opens this panel using the
//   gesture from the dashboard click, parks the request under GRANT_KEY, and we
//   finish the handshake here.
//
// The prompt is deliberately plain DOM appended to <body> rather than part of
// app.js's render loop, so it cannot disturb the panel's existing state.

const GRANT_KEY = "pendingJobSiteGrant";
const HOST_ID = "atomspace-job-site-permission";

function readGrant() {
  return chrome.storage.session.get(GRANT_KEY).then(
    (data) => data[GRANT_KEY] || null,
    () => null,
  );
}

function remove() {
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();
}

function notifyWorker(message) {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch (err) {
    console.warn("job site permission prompt: sendMessage failed", err);
  }
}

function render(grant) {
  remove();
  if (!grant) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:16px",
    "background:rgba(15,23,42,.62)",
    "backdrop-filter:blur(2px)",
    "font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif",
  ].join(";");

  const card = document.createElement("div");
  card.style.cssText = [
    "width:100%",
    "max-width:320px",
    "background:#0f172a",
    "color:#e2e8f0",
    "border:1px solid #1e293b",
    "border-radius:12px",
    "padding:16px",
    "box-shadow:0 18px 40px rgba(0,0,0,.45)",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "Allow cookie access";
  title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:6px;color:#f8fafc";

  const body = document.createElement("div");
  body.textContent =
    "To capture your " +
    grant.name +
    " session after you sign in, Atomspace needs permission to read cookies for that site.";
  body.style.cssText = "color:#94a3b8;margin-bottom:14px";

  const error = document.createElement("div");
  error.style.cssText = "color:#fca5a5;margin-bottom:10px;display:none";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Not now";
  cancel.style.cssText =
    "padding:7px 12px;border-radius:8px;border:1px solid #334155;background:transparent;color:#cbd5e1;cursor:pointer";

  const allow = document.createElement("button");
  allow.type = "button";
  allow.textContent = "Allow & continue";
  allow.style.cssText =
    "padding:7px 12px;border-radius:8px;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer";

  cancel.addEventListener("click", () => {
    remove();
    notifyWorker({
      type: "ABORT_JOB_SITE_CONNECT",
      requestId: grant.requestId || null,
      error: "permission_denied",
    });
  });

  allow.addEventListener("click", () => {
    // Called as the very first statement of the click handler: chrome drops the
    // gesture at the first await, and permissions.request() requires it.
    try {
      chrome.permissions.request(
        { permissions: ["cookies"], origins: grant.origins || [] },
        (granted) => {
          const failure = chrome.runtime.lastError;
          if (failure || !granted) {
            error.textContent = failure
              ? "Chrome refused the request: " + failure.message
              : "Permission was declined.";
            error.style.display = "block";
            if (!failure) {
              remove();
              notifyWorker({
                type: "ABORT_JOB_SITE_CONNECT",
                requestId: grant.requestId || null,
                error: "permission_denied",
              });
            }
            return;
          }
          remove();
          notifyWorker({
            type: "RESUME_JOB_SITE_CONNECT",
            requestId: grant.requestId || null,
          });
        },
      );
    } catch (err) {
      error.textContent = "Could not open the permission prompt: " + (err && err.message);
      error.style.display = "block";
    }
  });

  row.append(cancel, allow);
  card.append(title, body, error, row);
  host.append(card);
  document.body.append(host);
  allow.focus();
}

function sync() {
  void readGrant().then(render);
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (!Object.prototype.hasOwnProperty.call(changes, GRANT_KEY)) return;
  render(changes[GRANT_KEY].newValue || null);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", sync, { once: true });
} else {
  sync();
}
