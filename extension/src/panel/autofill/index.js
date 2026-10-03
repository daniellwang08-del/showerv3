// Public surface of the autofill feature for the rest of the panel.

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

/** Routes AF_* and WD_* content-script messages. Returns true when handled. */
export function handleAutofillMessage(msg, sender) {
  return handleFormMessage(msg, sender) || handleWorkdayMessage(msg);
}
