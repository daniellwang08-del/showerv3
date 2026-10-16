import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createInterview } from '@/api/interviewsApi';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { InterviewStage } from '@/types/interviews';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { PIPELINE_STAGES, SELECT_CLASS, STAGE_META } from './interviewsModel';
import { INTERVIEWS_KEY } from './queries';

export function AddInterviewDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [stage, setStage] = useState<InterviewStage>('screening');
  const [notes, setNotes] = useState('');

  const create = useMutation({
    mutationFn: () =>
      createInterview({ company: company.trim(), role_title: role.trim() || null, stage, notes: notes.trim() || null }),
    onSuccess: ({ id }) => {
      void qc.invalidateQueries({ queryKey: INTERVIEWS_KEY });
      toast.success(`${company.trim()} added`);
      setCompany('');
      setRole('');
      setNotes('');
      setStage('screening');
      onOpenChange(false);
      onCreated(id);
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not add the process.')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add interview process</DialogTitle>
          <DialogDescription>
            Track a process that is not in your email yet. Later emails from this company are added to it.
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-interview"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (company.trim()) create.mutate();
          }}
        >
          <label className="block space-y-1 text-sm font-medium">
            Company
            <Input required autoFocus value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Inc." />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Role
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Senior Software Engineer" />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Current stage
            <select
              className={`${SELECT_CLASS} w-full`}
              value={stage}
              onChange={(e) => setStage(e.target.value as InterviewStage)}
            >
              {PIPELINE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_META[s].label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Notes
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-interview" disabled={!company.trim() || create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : null}
            Add process
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
