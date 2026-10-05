// Messages from content scripts and the background worker.

import { handleApplicationSubmitted, handleAskSelection, onWebappOpenJob } from "./actions/job.js";
import { reloadSession } from "./actions/session.js";
import { handleAutofillMessage } from "./autofill/index.js";

export function installMessageRouter() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ASK_SELECTION":
        void handleAskSelection(msg);
        return;
      case "APP_SUBMITTED":
        // Raw page report; the background resolves its job and re-sends it.
        return;
      case "APP_SUBMITTED_RESOLVED":
        void handleApplicationSubmitted(msg);
        return;
      case "SESSION_CHANGED":
        void reloadSession();
        return;
      case "WEBAPP_OPEN_PENDING_JOB":
        if (msg.jobId) onWebappOpenJob(msg.jobId);
        return;
      default:
        handleAutofillMessage(msg, sender);
    }
  });
}
