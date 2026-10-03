import { useEffect } from 'react';
import { SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentStore } from '@/stores/agentStore';
import { useShellStore } from '@/stores/shellStore';
import { Composer } from './Composer';
import { Thread } from './Thread';
import { ASSISTANT_SUGGESTIONS, useAssistantDraft } from './useAssistantDraft';
import { PageTitle } from '@/components/app/PageTitle';

/** Full-page conversation (ChatGPT-style centered column). */
export function AssistantPage() {
  const timeline = useAgentStore((s) => s.timeline);
  const clear = useAgentStore((s) => s.clear);
  const setDocked = useShellStore((s) => s.setAssistantDocked);
  const { draft, setDraft, submit, busy } = useAssistantDraft();

  useEffect(() => setDocked(false), [setDocked]);

  return (
    <div className="flex h-full flex-col">
      <PageTitle title="Assistant" />
      <div className="flex h-12 shrink-0 items-center justify-end px-4">
        <Button variant="ghost" size="sm" onClick={clear} disabled={!timeline.length}>
          <SquarePen />
          New chat
        </Button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-8">
          {timeline.length === 0 ? (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-6 text-center">
              <h1 className="text-3xl font-semibold tracking-tight">What should we work on?</h1>
              <div className="flex flex-wrap justify-center gap-2">
                {ASSISTANT_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void submit(s)}
                    className="rounded-full border px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Thread />
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl">
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={(t) => void submit(t)}
            busy={busy}
            autoFocus
            placeholder="Ask about your jobs, or paste job links…"
            urlActionLabel={(n) => `Submit ${n} job${n === 1 ? '' : 's'}`}
          />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            The assistant can change filters and mark jobs — actions that modify data ask for confirmation.
          </p>
        </div>
      </div>
    </div>
  );
}
