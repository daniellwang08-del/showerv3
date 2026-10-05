import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { History, SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentStore } from '@/stores/agentStore';
import { useShellStore } from '@/stores/shellStore';
import { ChatHistory } from './ChatHistory';
import { Composer } from './Composer';
import { Thread } from './Thread';
import { ASSISTANT_SUGGESTIONS, useAssistantDraft } from './useAssistantDraft';
import { PageTitle } from '@/components/app/PageTitle';

/**
 * Full-page conversation (ChatGPT-style centered column) with saved chats.
 * `/app/assistant` is a new chat; `/app/assistant/:sessionId` is a saved one.
 */
export function AssistantPage() {
  const { sessionId: routeId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const timeline = useAgentStore((s) => s.timeline);
  const sessionId = useAgentStore((s) => s.sessionId);
  const sessionLoad = useAgentStore((s) => s.sessionLoad);
  const saveFailed = useAgentStore((s) => s.saveFailed);
  const title = useAgentStore((s) => s.sessions.find((x) => x.id === s.sessionId)?.title);
  const openSession = useAgentStore((s) => s.openSession);
  const clear = useAgentStore((s) => s.clear);
  const setDocked = useShellStore((s) => s.setAssistantDocked);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { draft, setDraft, submit, busy } = useAssistantDraft(
    routeId ? undefined : { onStartChat: (id) => navigate(`/app/assistant/${id}`, { replace: true }) },
  );

  useEffect(() => setDocked(false), [setDocked]);

  useEffect(() => {
    if (routeId) {
      if (routeId !== useAgentStore.getState().sessionId) void openSession(routeId);
    } else if (useAgentStore.getState().sessionId) {
      clear();
    }
  }, [routeId, openSession, clear]);

  const goTo = (id: string) => {
    setHistoryOpen(false);
    navigate(`/app/assistant/${id}`);
  };

  const newChat = () => {
    setHistoryOpen(false);
    clear();
    navigate('/app/assistant');
  };

  const history = (
    <ChatHistory
      onOpen={goTo}
      onNewChat={newChat}
      onDeleted={(_, wasActive) => {
        if (wasActive) navigate('/app/assistant', { replace: true });
      }}
      className="h-full"
    />
  );

  const showingRoute = !routeId || routeId === sessionId;
  const loading = !!routeId && (sessionLoad === 'loading' || !showingRoute);

  return (
    <div className="flex h-full">
      <PageTitle title={title && routeId ? title : 'Assistant'} />
      <aside className="hidden w-64 shrink-0 border-r lg:flex lg:flex-col">{history}</aside>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="border-b">
            <SheetTitle>Chats</SheetTitle>
          </SheetHeader>
          {history}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            onClick={() => setHistoryOpen(true)}
            aria-label="Chat history"
          >
            <History />
            Chats
          </Button>
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
            {routeId && title ? title : ''}
          </p>
          {saveFailed ? <span className="text-xs text-destructive">Not saved yet. Retrying on the next change.</span> : null}
          <Button variant="ghost" size="sm" onClick={newChat} disabled={!routeId && !timeline.length}>
            <SquarePen />
            New chat
          </Button>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-8">
            {loading ? (
              <div className="space-y-4 pt-6" aria-label="Loading chat">
                <Skeleton className="ml-auto h-10 w-1/2 rounded-3xl" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : routeId && sessionLoad === 'not_found' ? (
              <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
                <h1 className="text-xl font-semibold">This chat no longer exists</h1>
                <p className="text-sm text-muted-foreground">It may have been deleted.</p>
                <Button onClick={newChat}>Start a new chat</Button>
              </div>
            ) : routeId && sessionLoad === 'error' ? (
              <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
                <h1 className="text-xl font-semibold">Could not load this chat</h1>
                <Button onClick={() => void openSession(routeId)}>Try again</Button>
              </div>
            ) : timeline.length === 0 ? (
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
              busy={busy || loading || (!!routeId && sessionLoad !== 'idle')}
              autoFocus
              placeholder="Ask about your jobs, or paste job links…"
              urlActionLabel={(n) => `Submit ${n} job${n === 1 ? '' : 's'}`}
            />
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Chats are saved until you delete them. Actions that change data ask for confirmation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
