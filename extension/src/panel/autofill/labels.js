// User-facing names for autofill states.

const WD_STEP_LABELS = {
  myInfo: "My information",
  experience: "My experience",
  voluntary: "Voluntary disclosures",
  selfid: "Self identify",
  questions: "Application questions",
  generic: "Current step",
  review: "Review",
  unknown: "Current step",
};

/** questions_1_of_2 -> "Application questions 1 of 2". */
export function wdStepLabel(step) {
  if (!step) return "Current step";
  if (WD_STEP_LABELS[step]) return WD_STEP_LABELS[step];
  const m = /^questions_(\d+)_of_(\d+)$/i.exec(String(step));
  if (m) return `Application questions ${m[1]} of ${m[2]}`;
  return String(step);
}

export const FIELD_STATUS_LABEL = {
  filled: "Filled",
  attached: "Attached",
  partial: "Partly filled",
  needs_user: "Needs you",
  skipped: "Skipped",
  not_found: "Not found",
};
