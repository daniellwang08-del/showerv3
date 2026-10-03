// Messages from content scripts and the background worker.

import { handleApplicationSubmitted, handleAskSelection, onWebappOpenJob } from "./actions/job.js";
import { handleAutofillMessage } from "./autofill/index.js";

export function installMessageRouter() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ASK_SELECTION":
        void handleAskSelection(msg);
        return;
      case "APP_SUBMITTED":
        void handleApplicationSubmitted(msg);
        return;
      case "WEBAPP_OPEN_PENDING_JOB":
        if (msg.jobId) onWebappOpenJob(msg.jobId);
        return;
      default:
        handleAutofillMessage(msg, sender);
    }
  });
}
