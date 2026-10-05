import { useState } from 'react';
import { MoreHorizontal, Pencil, SquarePen, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentSessionSummary } from '@/api/agentApi';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/stores/agentStore';

const DAY_MS = 86_400_000;

/** Server timestamps are naive UTC. */
function parseUtc(value: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}

export function groupSessions(sessions: AgentSessionSummary[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: { label: string; items: AgentSessionSummary[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const s of sessions) {
    const t = parseUtc(s.updated_at);
    const idx =
      t >= startOfToday
        ? 0
        : t >= startOfToday - DAY_MS
          ? 1
          : t >= startOfToday - 7 * DAY_MS
            ? 2
            : t >= startOfToday - 30 * DAY_MS
              ? 3
              : 4;
    groups[idx].items.push(s);
  }
  return groups.filter((g) => g.items.length);
}

function SessionRow({
  session,
  active,
  onOpen,
  onDelete,
}: {
  session: AgentSessionSummary;
  active: boolean;
  onOpen: (id: string) => void;
  onDelete: (session: AgentSessionSummary) => void;
}) {
  const renameSession = useAgentStore((s) => s.renameSession);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);

  const commit = async () => {
    setEditing(false);
    const next = title.trim();
    if (!next || next === session.title) {
      setTitle(session.title);
      return;
    }
    try {
      await renameSession(session.id, next);
    } catch {
      setTitle(session.title);
      toast.error('Could not rename the chat.');
    }
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={title}
        aria-label="Chat name"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            setTitle(session.title);
            setEditing(false);
          }
        }}
        className="h-8 text-sm"
      />
    );
  }

  return (
    <div
      className={cn(
        'group flex h-8 items-center rounded-lg text-sm hover:bg-muted',
        active && 'bg-muted font-medium',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        aria-current={active ? 'page' : undefined}
        className="min-w-0 flex-1 truncate px-2.5 text-left"
        title={session.title}
      >
        {session.title}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Options for ${session.title}`}
              className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => onDelete(session)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Saved chats, newest first. Chats stay until the user deletes them. */
export function ChatHistory({
  onOpen,
  onNewChat,
  onDeleted,
  className,
}: {
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onDeleted?: (id: string, wasActive: boolean) => void;
  className?: string;
}) {
  const sessions = useAgentStore((s) => s.sessions);
  const loaded = useAgentStore((s) => s.sessionsLoaded);
  const activeId = useAgentStore((s) => s.sessionId);
  const deleteSession = useAgentStore((s) => s.deleteSession);
  const [pending, setPending] = useState<AgentSessionSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const confirmDelete = async () => {
    if (!pending) return;
    const wasActive = pending.id === activeId;
    setBusy(true);
    try {
      await deleteSession(pending.id);
      onDeleted?.(pending.id, wasActive);
      setPending(null);
    } catch {
      toast.error('Could not delete the chat. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <nav aria-label="Chat history" className={cn('flex min-h-0 flex-col', className)}>
      <div className="shrink-0 p-2">
        <Button variant="ghost" className="w-full justify-start" onClick={onNewChat}>
          <SquarePen />
          New chat
        </Button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!loaded ? (
          <div className="space-y-2 px-1 pt-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-6 w-3/5" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-2.5 pt-2 text-sm text-muted-foreground">Your chats are saved here.</p>
        ) : (
          groupSessions(sessions).map((group) => (
            <div key={group.label} className="mt-3 first:mt-1">
              <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeId}
                    onOpen={onOpen}
                    onDelete={setPending}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !busy && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pending?.title}" will be removed from your history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
