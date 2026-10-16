import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Mail,
  MoreHorizontal,
  RotateCcw,
  ShieldCheck,
  Timer,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { createReportShares, deleteReportShare, fetchReportShares, updateReportShare } from '@/api/reportShareApi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ReportShare, ShareChanges } from '@/types/reportShare';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { SELECT_CLASS } from '../interviews/interviewsModel';
import {
  accessLabel,
  EXPIRY_OPTIONS,
  initials,
  isEmail,
  mailtoLink,
  parseEmails,
  REPORT_SHARES_KEY,
  shareUrl,
  viewLabel,
} from './shareModel';

const SHARED_ITEMS = [
  'Interview processes, stages and every round',
  'Upcoming interviews and what needs action',
  'Job posts and applications per day',
  'Every application with its current status',
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareReportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: REPORT_SHARES_KEY, queryFn: fetchReportShares, enabled: open });
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [showMessage, setShowMessage] = useState(false);
  const [expires, setExpires] = useState<number | null>(30);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [fresh, setFresh] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const shares = list.data?.shares ?? [];
  const pending = [...emails, ...parseEmails(draft).valid.filter((e) => !emails.includes(e))];
  const draftInvalid = draft.trim() !== '' && !isEmail(draft) && !parseEmails(draft).valid.length;

  const create = useMutation({
    mutationFn: () =>
      createReportShares({
        emails: pending,
        expires_in_days: expires,
        include_notes: includeNotes,
        message: message.trim() || null,
      }),
    onSuccess: async ({ shares: created }) => {
      void qc.invalidateQueries({ queryKey: REPORT_SHARES_KEY });
      setEmails([]);
      setDraft('');
      setFresh(created.map((s) => s.id));
      const only = created.length === 1 ? created[0] : null;
      if (only?.token && (await copyText(shareUrl(only.token)))) {
        toast.success(`Link for ${only.email} copied. Paste it in a message or send the email draft.`);
      } else {
        toast.success(`${created.length} links ready. Copy each one or send the email drafts below.`);
      }
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not create the links.')),
  });

  const addFrom = (text: string) => {
    const { valid, invalid } = parseEmails(text);
    if (valid.length) setEmails((prev) => [...prev, ...valid.filter((e) => !prev.includes(e))]);
    setDraft(invalid.join(' '));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', ' ', 'Tab'].includes(e.key) && draft.trim()) {
      if (e.key !== 'Tab' || isEmail(draft)) e.preventDefault();
      addFrom(draft);
    } else if (e.key === 'Enter' && !draft.trim() && pending.length) {
      e.preventDefault();
      create.mutate();
    } else if (e.key === 'Backspace' && !draft && emails.length) {
      setEmails((prev) => prev.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault();
      addFrom(`${draft} ${text}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <div className="flex items-center gap-3 pr-6">
            <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <UserPlus className="size-4.5" />
            </span>
            <div className="min-w-0">
              <DialogTitle>Share your job search report</DialogTitle>
              <DialogDescription className="mt-0.5">
                People you invite get a live, read-only view that updates as your search moves.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 px-5 py-4">
          <form
            aria-label="Invite people"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (pending.length) create.mutate();
            }}
          >
            <div
              className={cn(
                'flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
                draftInvalid && 'border-destructive/60',
              )}
              onClick={() => inputRef.current?.focus()}
            >
              {emails.map((email) => (
                <span
                  key={email}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand/10 py-0.5 pr-1 pl-2.5 text-xs font-medium text-brand"
                >
                  <span className="truncate">{email}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${email}`}
                    className="rounded-full p-0.5 hover:bg-brand/15"
                    onClick={() => setEmails((prev) => prev.filter((x) => x !== email))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                aria-label="Email addresses"
                type="text"
                inputMode="email"
                autoComplete="off"
                autoFocus
                className="min-w-40 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
                placeholder={emails.length ? 'Add another' : 'Add emails, separated by commas'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onBlur={() => draft.trim() && addFrom(draft)}
              />
            </div>
            {draftInvalid ? <p className="text-xs text-destructive">Check that address: it does not look like an email.</p> : null}

            {showMessage ? (
              <Textarea
                aria-label="Message"
                rows={2}
                maxLength={500}
                placeholder="Add a short note, shown at the top of the report"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Timer className="size-3.5" aria-hidden />
                Access lasts
                <select
                  className={cn(SELECT_CLASS, 'h-7 text-xs text-foreground')}
                  value={expires ?? ''}
                  onChange={(e) => setExpires(e.target.value ? Number(e.target.value) : null)}
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.label} value={o.value ?? ''}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Switch size="sm" checked={includeNotes} onCheckedChange={setIncludeNotes} aria-labelledby="share-notes-label" />
                <span id="share-notes-label" className="cursor-pointer select-none" onClick={() => setIncludeNotes((v) => !v)}>
                  Include my private notes
                </span>
              </div>
              {!showMessage ? (
                <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => setShowMessage(true)}>
                  Add a note
                </button>
              ) : null}
              <Button type="submit" size="sm" className="ml-auto" disabled={!pending.length || create.isPending}>
                {create.isPending ? <Loader2 className="animate-spin" /> : <Link2 />}
                {pending.length > 1 ? `Share with ${pending.length} people` : 'Share'}
              </Button>
            </div>
          </form>

          <div className="grid gap-3 rounded-xl border bg-muted/25 p-3 text-xs sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div>
              <p className="mb-1.5 font-semibold">They will see</p>
              <ul className="space-y-1 text-muted-foreground">
                {SHARED_ITEMS.map((item) => (
                  <li key={item} className="flex gap-1.5">
                    <Check className="mt-px size-3.5 shrink-0 text-status-ready" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1.5 flex items-center gap-1 font-semibold">
                <ShieldCheck className="size-3.5 text-brand" aria-hidden />
                Kept private
              </p>
              <p className="text-muted-foreground">
                Links into your mailbox, recruiter email addresses, meeting join links
                {includeNotes ? '' : ' and your notes'}. They cannot change anything.
              </p>
            </div>
          </div>

          <section aria-label="People with access" className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                People with access{shares.length ? ` · ${shares.length}` : ''}
              </h3>
              <a
                href={`/app/interviews/report-preview${includeNotes ? '?notes=1' : ''}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                <Eye className="size-3.5" aria-hidden />
                Preview what they see
              </a>
            </div>
            {list.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full rounded-xl" />
                <Skeleton className="h-12 w-full rounded-xl" />
              </div>
            ) : shares.length ? (
              <ul className="-mx-1 max-h-72 space-y-1 overflow-y-auto px-1">
                {shares.map((share) => (
                  <ShareRow key={share.id} share={share} highlight={fresh.includes(share.id)} />
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                Nobody has access yet. Each person you add gets their own private link you can remove at any time.
              </p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShareRow({ share, highlight }: { share: ReportShare; highlight: boolean }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const url = share.token ? shareUrl(share.token) : null;

  const update = useMutation({
    mutationFn: (changes: ShareChanges) => updateReportShare(share.id, changes),
    onSuccess: (_, changes) => {
      void qc.invalidateQueries({ queryKey: REPORT_SHARES_KEY });
      if (changes.reset_link) toast.success(`New link for ${share.email}. The old one stops working now.`);
      else toast.success('Access updated');
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not update access.')),
  });
  const remove = useMutation({
    mutationFn: () => deleteReportShare(share.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: REPORT_SHARES_KEY });
      toast.success(`${share.email} can no longer open your report`);
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not remove access.')),
  });

  const copy = async () => {
    if (!url) return;
    if (await copyText(url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error('Could not copy. Select the link in the email draft instead.');
    }
  };

  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-card px-2.5 py-2 transition-colors',
        highlight && 'border-brand/40 bg-brand/[0.04]',
        !share.active && 'opacity-70',
      )}
    >
      <span
        aria-hidden
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand/20 to-brand/5 text-[11px] font-semibold text-brand"
      >
        {initials(share.email)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{share.email}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span className={cn(!share.active && 'font-medium text-destructive')}>{accessLabel(share)}</span>
          <span aria-hidden>·</span>
          <span>{viewLabel(share)}</span>
          {share.include_notes ? (
            <>
              <span aria-hidden>·</span>
              <span>Notes shared</span>
            </>
          ) : null}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => void copy()}
        disabled={!url || !share.active}
        aria-label={`Copy link for ${share.email}`}
      >
        {copied ? <Check className="text-status-ready" /> : <Copy />}
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      {url && share.active ? (
        <a
          href={mailtoLink({ email: share.email, url, message: share.message })}
          aria-label={`Email the link to ${share.email}`}
          title="Open an email draft with the link"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Mail className="size-4" />
        </a>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Access options for ${share.email}`} />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Access lasts</DropdownMenuLabel>
            {EXPIRY_OPTIONS.map((o) => (
              <DropdownMenuItem key={o.label} onClick={() => update.mutate({ expires_in_days: o.value })}>
                <Timer />
                {o.value ? `${o.label} from today` : o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => update.mutate({ include_notes: !share.include_notes })}>
            {share.include_notes ? <EyeOff /> : <Eye />}
            {share.include_notes ? 'Hide my notes' : 'Show my notes'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => update.mutate({ reset_link: true })}>
            <RotateCcw />
            Reset link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => remove.mutate()}>
            <Trash2 />
            Remove access
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
