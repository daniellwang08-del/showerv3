// Public surface of the autofill feature for the rest of the panel.

import { state } from "../state.js";
import { handleFormMessage } from "./form.js";
import { handleWorkdayMessage } from "./workday.js";

export {
  blockStatus,
  cancelAutofill,
  removeAutofillField,
  resumePicking,
  runAutofill,
  startAutofill,
  teardownAutofill,
} from "./form.js";
export { rerunWorkday, stopWorkdayAutofill } from "./workday.js";
export { FIELD_STATUS_LABEL, wdStepLabel } from "./labels.js";

/**
 * Routes AF_* and WD_* content-script messages. Returns true when handled.
 * Content scripts broadcast to every extension page, so with parallel
 * auto-apply runs each page must only take messages from the tab it fills.
 */
export function handleAutofillMessage(msg, sender) {
  const ownTab = state.autofill && state.autofill.tabId;
  const fromTab = sender && sender.tab ? sender.tab.id : null;
  if (fromTab != null && ownTab != null && fromTab !== ownTab) return true;
  if (fromTab != null && ownTab == null && state.autoApply) return true;
  return handleFormMessage(msg, sender) || handleWorkdayMessage(msg);
}
