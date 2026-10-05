import { useEffect, useRef } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Loader2,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useAgentStore, type TimelineItem } from '@/stores/agentStore';
import type { AgentJobCard } from '@/api/agentApi';
import { MatchScore } from '@/components/app/MatchScore';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
type ConfirmItem = Extract<TimelineItem, { kind: 'confirm' }>;

export function AssistantAvatar({ thinking }: { thinking?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground',
        thinking && 'animate-pulse',
      )}
      aria-hidden
    >
      <Sparkles className="size-3.5" />
    </span>
  );
}

function JobCardRow({ job }: { job: AgentJobCard }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{job.title || 'Untitled role'}</p>
        <p className="truncate text-xs text-muted-foreground">
          {job.company || 'Unknown company'}
          {job.location ? ` · ${job.location}` : ''}
        </p>
      </div>
      {typeof job.match_overall_score === 'number' ? <MatchScore score={job.match_overall_score} /> : null}
      {job.applied_at ? <CheckCircle2 className="size-4 text-status-ready" aria-label="Applied" /> : null}
      {job.source_url ? (
        <a
          href={job.source_url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Open posting"
        >
          <ExternalLink className="size-4" />
        </a>
      ) : null}
    </div>
  );
}

function discardLabel(discard: NonNullable<ToolItem['discard']>): string {
  if (discard.kind === 'dashboard') return 'Undo filter change';
  if (discard.kind === 'applied') return discard.wasApplied ? 'Undo applied' : 'Restore applied';
  return 'Remove submitted job';
}

/** Consecutive tool calls render as one collapsible "steps" group, like a research trace. */
function StepsGroup({ items }: { items: ToolItem[] }) {
  const discardAction = useAgentStore((s) => s.discardAction);
  const sending = useAgentStore((s) => s.sending);
  const running = items.some((i) => i.status === 'running');
  const failed = items.some((i) => i.status === 'error');
  const jobs = items.flatMap((i) => i.jobs ?? []);

  return (
    <div className="space-y-2 pl-10">
      <Collapsible defaultOpen={running}>
        <CollapsibleTrigger className="group/steps inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          {running ? (
            <Loader2 className="size-3.5 animate-spin text-brand" />
          ) : failed ? (
            <AlertCircle className="size-3.5 text-destructive" />
          ) : (
            <Check className="size-3.5 text-status-ready" />
          )}
          {running ? items[items.length - 1].title : `${items.length} step${items.length === 1 ? '' : 's'}`}
          <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]/steps:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="mt-1 ml-3 space-y-1 border-l pl-3">
            {items.map((i) => (
              <li key={i.id} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{i.title}</span>
                {i.summary && i.status !== 'running' ? <span>, {i.summary}</span> : null}
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
      {items
        .filter((i) => i.discard && !i.discarded && i.status === 'ok')
        .map((i) => (
          <Button
            key={i.id}
            variant="outline"
            size="xs"
            disabled={sending}
            onClick={() => void discardAction(i.id)}
          >
            <Undo2 />
            {discardLabel(i.discard!)}
          </Button>
        ))}
      {jobs.length > 0 ? (
        <div className="grid gap-1.5">
          {jobs.slice(0, 8).map((job) => (
            <JobCardRow key={job.id} job={job} />
          ))}
          {jobs.length > 8 ? (
            <p className="px-1 text-xs text-muted-foreground">+{jobs.length - 8} more in Jobs</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConfirmCard({ item }: { item: ConfirmItem }) {
  const confirmAction = useAgentStore((s) => s.confirmAction);
  const cancelAction = useAgentStore((s) => s.cancelAction);
  const sending = useAgentStore((s) => s.sending);
  return (
    <div className="ml-10 rounded-2xl border bg-muted/50 p-3.5">
      <p className="text-sm font-medium">{item.title}</p>
      <p className="mt-1 text-sm whitespace-pre-line text-muted-foreground">{item.summary}</p>
      {item.resolved ? (
        <p className="mt-2 text-xs font-medium text-muted-foreground">
          {item.resolved === 'confirmed' ? 'Confirmed' : 'Cancelled'}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={sending} onClick={() => void confirmAction(item.id)}>
            Confirm
          </Button>
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => cancelAction(item.id)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

type Block =
  | { kind: 'item'; item: TimelineItem }
  | { kind: 'steps'; id: string; items: ToolItem[] };

function toBlocks(timeline: TimelineItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of timeline) {
    if (item.kind === 'tool') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'steps') last.items.push(item);
      else blocks.push({ kind: 'steps', id: item.id, items: [item] });
    } else {
      blocks.push({ kind: 'item', item });
    }
  }
  return blocks;
}

export function Thread({ className, compact }: { className?: string; compact?: boolean }) {
  const timeline = useAgentStore((s) => s.timeline);
  const sending = useAgentStore((s) => s.sending && s.sendingSessionId === s.sessionId);
  const endRef = useRef<HTMLDivElement>(null);
  const last = timeline[timeline.length - 1];
  const waiting = sending && (!last || (last.kind === 'assistant' && !last.text.trim()) || last.kind === 'user');

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [timeline, sending]);

  return (
    <div className={cn('flex flex-col gap-5', compact ? 'text-sm' : 'text-[15px]', className)}>
      {toBlocks(timeline).map((block) => {
        if (block.kind === 'steps') return <StepsGroup key={block.id} items={block.items} />;
        const item = block.item;
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 whitespace-pre-line">{item.text}</div>
              </div>
            );
          case 'assistant':
            if (!item.text.trim()) return null;
            return (
              <div key={item.id} className="flex items-start gap-3">
                <AssistantAvatar />
                <div className="min-w-0 flex-1 pt-0.5 leading-relaxed whitespace-pre-line">{item.text}</div>
              </div>
            );
          case 'confirm':
            return <ConfirmCard key={item.id} item={item} />;
          case 'error':
            return (
              <div
                key={item.id}
                className="ml-10 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{item.text}</span>
              </div>
            );
          default:
            return null;
        }
      })}
      {waiting ? (
        <div className="flex items-center gap-3">
          <AssistantAvatar thinking />
          <span className="flex gap-1">
            {[0, 150, 300].map((d) => (
              <span
                key={d}
                className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
                style={{ animationDelay: `${d}ms` }}
              />
            ))}
          </span>
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
