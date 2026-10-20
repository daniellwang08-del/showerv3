import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { updateInterviewEvent } from '@/api/interviewsApi';
import type { InterviewsOverview } from '@/types/interviews';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { needsUser } from './interviewsModel';
import { INTERVIEWS_KEY } from './queries';

type Vars = { ids: string[]; ignored: boolean };

function withIgnored(data: InterviewsOverview, ids: Set<string>, ignored: boolean): InterviewsOverview {
  const processes = data.processes.map((p) => {
    if (!p.events.some((e) => ids.has(e.id))) return p;
    const events = p.events.map((e) => (ids.has(e.id) ? { ...e, ignored } : e));
    return { ...p, events, needs_action: p.status === 'active' && events.some(needsUser) };
  });
  const needs = processes.filter((p) => p.status === 'active' && p.needs_action).length;
  return { ...data, processes, summary: { ...data.summary, needs_action: needs } };
}

/** Dismisses interview events from "needs your action", with an Undo toast. */
export function useIgnoreEvents() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ ids, ignored }: Vars) => Promise.all(ids.map((id) => updateInterviewEvent(id, { ignored }))),
    onMutate: async ({ ids, ignored }: Vars) => {
      await qc.cancelQueries({ queryKey: INTERVIEWS_KEY, exact: true });
      const previous = qc.getQueryData<InterviewsOverview>(INTERVIEWS_KEY);
      if (previous) qc.setQueryData(INTERVIEWS_KEY, withIgnored(previous, new Set(ids), ignored));
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(INTERVIEWS_KEY, ctx.previous);
      toast.error(extractApiErrorMessage(err, 'Could not update it. Try again.'));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: INTERVIEWS_KEY, exact: true }),
  });

  return (ids: string[], label?: string) => {
    if (!ids.length) return;
    mutation.mutate(
      { ids, ignored: true },
      {
        onSuccess: () =>
          toast.success(label ? `Ignored: ${label}` : 'Ignored', {
            action: { label: 'Undo', onClick: () => mutation.mutate({ ids, ignored: false }) },
          }),
      },
    );
  };
}
