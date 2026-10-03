import { useState } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';
import { submitJobUrls } from '@/features/jobs/submitJobUrls';

export const ASSISTANT_SUGGESTIONS = [
  "Show today's new remote jobs",
  'Which jobs match me best?',
  'Sort my jobs by match score',
  'What did I apply to this week?',
];

/**
 * One composer, two intents: text that is only job links is submitted to the
 * pipeline; anything else is a question for the assistant.
 */
export function useAssistantDraft(opts?: { onAsk?: () => void; onSubmitUrls?: () => void }) {
  const [draft, setDraft] = useState('');
  const send = useAgentStore((s) => s.send);
  const sending = useAgentStore((s) => s.sending);
  const [submittingUrls, setSubmittingUrls] = useState(false);

  const isUrlOnly = (text: string) => {
    const urls = extractHttpUrlsFromText(text);
    if (urls.length === 0) return false;
    const rest = urls.reduce((acc, u) => acc.replace(u, ' '), text).replace(/[\s,;]+/g, '');
    return rest.length < 12;
  };

  const submit = async (text: string) => {
    if (isUrlOnly(text)) {
      setSubmittingUrls(true);
      setDraft('');
      opts?.onSubmitUrls?.();
      try {
        await submitJobUrls(text);
      } finally {
        setSubmittingUrls(false);
      }
      return;
    }
    setDraft('');
    opts?.onAsk?.();
    await send(text);
  };

  return { draft, setDraft, submit, busy: sending || submittingUrls, sending, submittingUrls };
}
