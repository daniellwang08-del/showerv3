import { Link } from 'react-router-dom';
import { Maximize2, SquarePen, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAgentStore } from '@/stores/agentStore';
import { useShellStore } from '@/stores/shellStore';
import { Composer } from './Composer';
import { AssistantAvatar, Thread } from './Thread';
import { ToolsMenu } from './ToolsMenu';
import { ASSISTANT_SUGGESTIONS, useAssistantDraft } from './useAssistantDraft';

/** Copilot-style contextual assistant docked on the right of any page (⌘J). */
export function AssistantPanel() {
  const timeline = useAgentStore((s) => s.timeline);
  const sessionId = useAgentStore((s) => s.sessionId);
  const clear = useAgentStore((s) => s.clear);
  const setDocked = useShellStore((s) => s.setAssistantDocked);
  const { draft, setDraft, block, setBlock, submit, busy } = useAssistantDraft();

  return (
    <aside
      aria-label="Assistant"
      className="flex h-full w-full flex-col border-l bg-background lg:w-[400px] xl:w-[440px]"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <AssistantAvatar thinking={busy} />
        <p className="ml-1.5 flex-1 text-sm font-semibold">Assistant</p>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={clear} aria-label="New chat" disabled={!timeline.length} />
            }
          >
            <SquarePen />
          </TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to={sessionId ? `/app/assistant/${sessionId}` : '/app/assistant'}
                aria-label="Open full page"
                onClick={() => setDocked(false)}
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
              />
            }
          >
            <Maximize2 />
          </TooltipTrigger>
          <TooltipContent>Open full page</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" onClick={() => setDocked(false)} aria-label="Close" />}
          >
            <X />
          </TooltipTrigger>
          <TooltipContent>
            Close <Kbd>⌘J</Kbd>
          </TooltipContent>
        </Tooltip>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {timeline.length === 0 ? (
          <div className="flex h-full flex-col justify-end gap-3 pb-2">
            <p className="text-lg font-semibold tracking-tight">How can I help with your search?</p>
            <p className="text-sm text-muted-foreground">
              Filter and sort jobs, check stats, submit links, or mark applications, I can act on the page for you.
            </p>
            <div className="flex flex-col items-start gap-1.5 pt-2">
              {ASSISTANT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void submit(s)}
                  className="rounded-full border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Thread compact />
        )}
      </div>

      <div className="shrink-0 p-3 pt-0">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={(t) => void submit(t)}
          busy={busy}
          placeholder="Ask or paste job links…"
          urlActionLabel={(n) => `Submit ${n}`}
          block={block}
          onClearBlock={() => setBlock(null)}
          tools={
            <ToolsMenu
              disabled={busy}
              selectedId={block?.id}
              onPickBlock={(b) => setBlock(block?.id === b.id ? null : b)}
            />
          }
        />
      </div>
    </aside>
  );
}
