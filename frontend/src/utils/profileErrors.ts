import { useUIStore, type NotificationKind } from '../stores/uiStore';

/** Extract a renderable string from an Axios / FastAPI error payload. */
export function extractApiErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const rec = err as {
    code?: string;
    message?: string;
    response?: { data?: { detail?: unknown }; status?: number };
  };
  if (rec.code === 'ERR_NETWORK') return 'Network error. Is the server running?';
  const detail = rec.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length > 0) {
    const bits: string[] = [];
    for (const item of detail.slice(0, 6)) {
      if (typeof item === 'string' && item.trim()) {
        bits.push(item.trim());
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const row = item as { loc?: unknown[]; msg?: string; type?: string };
      const locParts = (row.loc ?? []).filter((p) => p !== 'body' && p !== '__root__');
      const loc = locParts.map(String).join('.');
      const msg = (row.msg || 'Invalid value').replace(/\.$/, '');
      if (row.type === 'extra_forbidden' || /extra inputs are not permitted/i.test(msg)) {
        bits.push(`Unexpected field '${loc || 'unknown'}'`);
        continue;
      }
      bits.push(loc ? `${loc}: ${msg}` : msg);
    }
    if (bits.length) {
      const more = detail.length > 6 ? ` (+${detail.length - 6} more)` : '';
      return bits.join('; ') + more;
    }
  }
  if (typeof rec.message === 'string' && rec.message && rec.message !== 'Error') return rec.message;
  return fallback;
}

const API_KEY_RE =
  /api key|invalid_api_key|incorrect api key|authenticationerror|unauthorized|no llm provider/i;

export function friendlyProfileError(raw: string, fallback: string): string {
  const text = (raw || '').trim();
  if (!text) return fallback;
  if (API_KEY_RE.test(text) && /invalid|incorrect|401|missing|deactivat|unauthorized|no llm|no api/i.test(text)) {
    return 'AI request failed: invalid or missing API key. Update your key in My Preferences and try again.';
  }
  if (/extra_forbidden|extra inputs are not permitted|unexpected field/i.test(text)) {
    return text.length > 280 ? `${text.slice(0, 277)}…` : text;
  }
  if (/failed to parse extracted profile json|could not parse the (ai|extracted)/i.test(text)) {
    return 'Could not parse the extracted résumé. Please try again, or fill the profile manually.';
  }
  if (text.length > 280) return `${text.slice(0, 277)}…`;
  return text;
}

export function profileErrorFromUnknown(err: unknown, fallback: string): string {
  return friendlyProfileError(extractApiErrorMessage(err, fallback), fallback);
}

export function notifyProfileError(
  err: unknown,
  fallback: string,
  autoDismissMs = 10_000,
): string {
  const message = profileErrorFromUnknown(err, fallback);
  useUIStore.getState().notify('error', message, autoDismissMs);
  return message;
}

export function notifyProfileMessage(
  kind: NotificationKind,
  message: string,
  autoDismissMs = 8000,
): void {
  if (!message.trim()) return;
  useUIStore.getState().notify(kind, message, autoDismissMs);
}
