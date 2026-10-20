import { Crown, UserRound, UsersRound } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  initialsOf,
  parseSubject,
  subjectValue,
  type InsightsSubject,
  type RosterMember,
  type RosterSpace,
} from './insightsSubject';

const AVATAR_TONES = [
  'bg-chart-1/15 text-chart-1',
  'bg-chart-2/15 text-chart-2',
  'bg-chart-3/15 text-chart-3',
  'bg-chart-4/15 text-chart-4',
  'bg-chart-5/15 text-chart-5',
  'bg-status-ready/15 text-status-ready',
];

export function avatarTone(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}

export function MemberAvatar({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
        avatarTone(id),
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Lets a team lead switch Insights between themselves, a whole team, and each member. */
export function SubjectPicker({
  value,
  spaces,
  member,
  onChange,
}: {
  value: InsightsSubject;
  spaces: RosterSpace[];
  member: RosterMember | null;
  onChange: (next: InsightsSubject) => void;
}) {
  const items = [
    { value: 'me', label: 'You' },
    ...spaces.flatMap(({ space, members }) => [
      { value: `team:${space.id}`, label: `${space.name}: whole team` },
      ...members.map((m) => ({ value: `member:${m.id}`, label: m.name })),
    ]),
  ];
  const current = subjectValue(value);
  const team = value.kind === 'team' ? spaces.find((s) => s.space.id === value.spaceId)?.space : null;

  return (
    <Select
      items={items}
      value={current}
      onValueChange={(next) => {
        if (next != null && next !== current) onChange(parseSubject(String(next)));
      }}
    >
      <SelectTrigger
        aria-label="Show insights for"
        className="h-9 max-w-full min-w-52 gap-2 rounded-full bg-background/70 pl-1.5 backdrop-blur"
      >
        {member ? (
          <>
            <MemberAvatar id={member.member.id} name={member.member.name} />
            <span className="min-w-0 truncate font-medium">{member.member.name}</span>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">{member.space.name}</span>
          </>
        ) : team ? (
          <>
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand/12 text-brand" aria-hidden>
              <UsersRound className="size-3.5" />
            </span>
            <span className="min-w-0 truncate font-medium">{team.name}</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">whole team</span>
          </>
        ) : (
          <>
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-foreground/[0.06]" aria-hidden>
              <UserRound className="size-3.5" />
            </span>
            <span className="font-medium">You</span>
          </>
        )}
        <span className="flex-1" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="end" className="max-h-[min(70vh,28rem)] min-w-72">
        <SelectGroup>
          <SelectItem value="me">
            <UserRound className="text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span>You</span>
              <span className="text-xs text-muted-foreground">Your own search</span>
            </span>
          </SelectItem>
        </SelectGroup>
        {spaces.map(({ space, members, loading }) => (
          <SelectGroup key={space.id}>
            <SelectSeparator />
            <SelectLabel className="flex items-center gap-1.5 font-medium">
              <Crown className="size-3 text-amber-500" fill="currentColor" aria-hidden />
              {space.name}
              <span className="ml-auto font-mono text-[10px] font-normal">{space.public_id}</span>
            </SelectLabel>
            <SelectItem value={`team:${space.id}`}>
              <UsersRound className="text-brand" />
              <span className="flex min-w-0 flex-col">
                <span>Whole team</span>
                <span className="text-xs text-muted-foreground">
                  Compare {members.length} member{members.length === 1 ? '' : 's'} side by side
                </span>
              </span>
            </SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={`member:${m.id}`}>
                <MemberAvatar id={m.id} name={m.name} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{m.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {m.stats.applied} applied, {m.stats.jobs_added} jobs added (30 days)
                  </span>
                </span>
              </SelectItem>
            ))}
            {!loading && members.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No members yet</p>
            ) : null}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
