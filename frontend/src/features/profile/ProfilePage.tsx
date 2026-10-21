import { useEffect, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Award,
  BriefcaseBusiness,
  CircleCheck,
  FileStack,
  GraduationCap,
  IdCard,
  Loader2,
  type LucideIcon,
  NotebookPen,
  Pencil,
  Puzzle,
  UserRound,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchUserProfile, saveUserProfile } from '@/api/profileApi';
import { HeroStat, PageLayout, SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ProfileFormData, UserProfile } from '@/types/profile';
import { computeProfileCompletion } from '@/utils/profileCompletion';
import { profileErrorFromUnknown } from '@/utils/profileErrors';
import { profileToForm } from '@/utils/profileFormData';
import { BasicsEdit, BasicsView, SummaryEdit, SummaryView } from './BasicsSection';
import { CompletenessMeter } from './CompletenessMeter';
import { EducationEdit, EducationView, ExperienceEdit, ExperienceView } from './ExperienceSection';
import {
  AdditionalEdit,
  AdditionalView,
  CertificationsEdit,
  CertificationsView,
  SkillsEdit,
  SkillsView,
} from './ListSections';
import {
  FORM_SECTIONS,
  SECTIONS,
  SECTION_LABEL,
  copySections,
  isSectionDirty,
  normalizeFormDates,
  sectionDomId,
  sectionForErrorKey,
  validateProfile,
  type EditorProps,
  type FormSectionId,
  type SectionId,
} from './profileSections';
import { ProfilePhotoCard } from './ProfilePhotoCard';
import { PROFILE_QUERY_KEY, ResumeImportCard } from './ResumeImportCard';
import { SourceDocumentsSection } from './SourceDocumentsSection';

export type ProfilePageProps = {
  /** Called after every successful profile save (e.g. to refresh the signed-in user's display name). */
  onProfileSaved?: () => void;
  /** Account email, used as the fallback email when importing a résumé without one. */
  accountEmail?: string;
};

const SECTION_UI: Record<
  FormSectionId,
  { description: string; View: ComponentType<{ form: ProfileFormData }>; Edit: ComponentType<EditorProps> }
> = {
  basics: {
    description: 'Name and contact details used on every résumé and application.',
    View: BasicsView,
    Edit: BasicsEdit,
  },
  summary: { description: 'The short pitch at the top of your résumé.', View: SummaryView, Edit: SummaryEdit },
  skills: { description: 'Grouped skills, e.g. Languages → Python, TypeScript.', View: SkillsView, Edit: SkillsEdit },
  experience: {
    description: 'Most recent first. Contributions become résumé bullets.',
    View: ExperienceView,
    Edit: ExperienceEdit,
  },
  education: { description: 'Degrees and schools.', View: EducationView, Edit: EducationEdit },
  certifications: {
    description: 'Certifications and licenses.',
    View: CertificationsView,
    Edit: CertificationsEdit,
  },
  additional: {
    description: 'Languages, awards, and anything else worth mentioning.',
    View: AdditionalView,
    Edit: AdditionalEdit,
  },
};

const SECTION_ICON: Record<SectionId, LucideIcon> = {
  basics: IdCard,
  summary: NotebookPen,
  skills: Wrench,
  experience: BriefcaseBusiness,
  education: GraduationCap,
  certifications: Award,
  additional: Puzzle,
  documents: FileStack,
};

const PAGE_DESCRIPTION = 'The source of truth for every tailored résumé, cover letter and application.';
const LAYOUT = { title: 'Profile', description: PAGE_DESCRIPTION, width: 'wide', variant: 'hero', icon: UserRound } as const;

export function ProfilePage({ onProfileSaved, accountEmail }: ProfilePageProps) {
  const query = useQuery({ queryKey: PROFILE_QUERY_KEY, queryFn: fetchUserProfile });

  if (query.isPending) {
    return (
      <PageLayout {...LAYOUT}>
        <div className="flex flex-col gap-4" aria-label="Loading profile">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-48 w-full rounded-2xl" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
      </PageLayout>
    );
  }

  if (query.isError) {
    return (
      <PageLayout {...LAYOUT}>
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border bg-card/90 p-5 text-sm backdrop-blur-sm">
          <p className="text-destructive">{profileErrorFromUnknown(query.error, 'Could not load your profile.')}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      </PageLayout>
    );
  }

  return <ProfileEditor profile={query.data} onProfileSaved={onProfileSaved} accountEmail={accountEmail} />;
}

function workCompanies(form: ProfileFormData): string[] {
  return [...new Set(form.work_experience.map((w) => w.company_name.trim()).filter(Boolean))];
}

function skillCount(form: ProfileFormData): number {
  return form.technical_skills.reduce(
    (n, block) => n + (block.skills ?? '').split(/[,;\n]/).filter((s) => s.trim()).length,
    0,
  );
}

function filledSections(form: ProfileFormData): Set<SectionId> {
  const filled = new Set<SectionId>();
  if (form.name_first.trim() && form.email.trim()) filled.add('basics');
  if (form.profile_summary.trim()) filled.add('summary');
  if (skillCount(form) > 0) filled.add('skills');
  if (form.work_experience.length) filled.add('experience');
  if (form.education.length) filled.add('education');
  if (form.certificates.length) filled.add('certifications');
  if (form.extra.some((e) => e.trim())) filled.add('additional');
  return filled;
}

function ProfileEditor({
  profile,
  onProfileSaved,
  accountEmail,
}: {
  profile: UserProfile | null;
  onProfileSaved?: () => void;
  accountEmail?: string;
}) {
  const queryClient = useQueryClient();
  const isNew = profile === null;
  const saved = profileToForm(profile);

  const [draft, setDraft] = useState<ProfileFormData>(saved);
  const [editing, setEditing] = useState<Set<FormSectionId>>(() => new Set(isNew ? FORM_SECTIONS : []));
  const [submitted, setSubmitted] = useState<Set<FormSectionId>>(() => new Set());
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [savingSections, setSavingSections] = useState<Set<FormSectionId>>(() => new Set());
  const [active, setActive] = useState<SectionId>('basics');

  /** What the user sees: saved data, overlaid with drafts of sections in edit mode. */
  const effective = copySections(saved, draft, editing);
  const allErrors = validateProfile(effective);
  const completion = computeProfileCompletion(profile);
  const dirtySections = [...editing].filter((s) => isSectionDirty(effective, saved, s));

  const errorFor = (key: string): string | undefined => {
    const section = sectionForErrorKey(key);
    if (!editing.has(section)) return undefined;
    if (!submitted.has(section) && !touched.has(key)) return undefined;
    return allErrors[key];
  };

  const forgetSections = (sections: FormSectionId[]) => {
    const drop = new Set(sections);
    setSubmitted((prev) => new Set([...prev].filter((s) => !drop.has(s))));
    setTouched((prev) => new Set([...prev].filter((k) => !drop.has(sectionForErrorKey(k)))));
  };

  const scrollToSection = (id: SectionId, focus = false) => {
    setActive(id);
    const el = document.getElementById(sectionDomId(id));
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    if (focus) {
      requestAnimationFrame(() =>
        el?.querySelector<HTMLElement>('input:not([type=file]), textarea')?.focus({ preventScroll: true }),
      );
    }
  };

  const startEdit = (section: FormSectionId) => {
    if (editing.has(section)) return;
    setDraft((d) => copySections(d, saved, [section]));
    setEditing((prev) => new Set(prev).add(section));
  };

  const cancelEdit = (sections: FormSectionId[]) => {
    setDraft((d) => copySections(d, saved, sections));
    setEditing((prev) => new Set([...prev].filter((s) => !sections.includes(s))));
    forgetSections(sections);
  };

  const mutation = useMutation({ mutationFn: saveUserProfile });

  const save = (requested: FormSectionId[]) => {
    const sections = requested.filter((s) => editing.has(s));
    if (!sections.length || mutation.isPending) return;
    if (!isNew && !sections.some((s) => isSectionDirty(effective, saved, s))) {
      cancelEdit(sections);
      return;
    }

    const candidate = normalizeFormDates(copySections(saved, draft, sections));
    setDraft((d) => copySections(d, candidate, sections));
    const errors = validateProfile(candidate);
    const errorSections = [...new Set(Object.keys(errors).map(sectionForErrorKey))];
    if (errorSections.length) {
      const reopen = errorSections.filter((s) => !editing.has(s));
      if (reopen.length) {
        setDraft((d) => copySections(d, saved, reopen));
        setEditing((prev) => new Set([...prev, ...reopen]));
      }
      setSubmitted((prev) => new Set([...prev, ...sections, ...errorSections]));
      const count = Object.keys(errors).length;
      toast.error(
        `Fix ${count} field${count === 1 ? '' : 's'} in ${errorSections.map((s) => SECTION_LABEL[s]).join(', ')} before saving.`,
      );
      scrollToSection(errorSections[0]);
      return;
    }

    setSavingSections(new Set(sections));
    mutation.mutate(candidate, {
      onSuccess: (result) => {
        queryClient.setQueryData(PROFILE_QUERY_KEY, result);
        void queryClient.invalidateQueries({ queryKey: [...PROFILE_QUERY_KEY, 'form'] });
        setDraft((d) => copySections(d, profileToForm(result), sections));
        setEditing((prev) => new Set([...prev].filter((s) => !sections.includes(s))));
        forgetSections(sections);
        toast.success(
          sections.length === 1 ? `${SECTION_LABEL[sections[0]]} saved` : 'Profile saved',
        );
        onProfileSaved?.();
      },
      onError: (err) => toast.error(profileErrorFromUnknown(err, 'Could not save profile.')),
      onSettled: () => setSavingSections(new Set()),
    });
  };

  const onSuggestion = (section: FormSectionId) => {
    startEdit(section);
    scrollToSection(section, true);
  };

  const onImportApplied = (result: UserProfile) => {
    setDraft(profileToForm(result));
    setEditing(new Set());
    setSubmitted(new Set());
    setTouched(new Set());
    onProfileSaved?.();
  };

  const onImportNeedsReview = (merged: ProfileFormData) => {
    setDraft(merged);
    setEditing(new Set(FORM_SECTIONS));
    setSubmitted(new Set(FORM_SECTIONS));
  };

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.id.replace('profile-section-', '');
        if (id) setActive(id as SectionId);
      },
      { rootMargin: '-15% 0px -70% 0px' },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(sectionDomId(s.id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const filled = filledSections(saved);
  const meta = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <HeroStat icon={CircleCheck} label="Required fields" value={`${completion.requiredPercent}%`} tone="bg-match-strong/10 text-match-strong" />
      <HeroStat icon={BriefcaseBusiness} label="Roles" value={saved.work_experience.length} />
      <HeroStat icon={Wrench} label="Skills" value={skillCount(saved)} tone="bg-chart-4/10 text-chart-4" />
      <HeroStat
        icon={GraduationCap}
        label="Education & certs"
        value={saved.education.length + saved.certificates.length}
        tone="bg-chart-2/10 text-chart-2"
      />
    </div>
  );

  return (
    <PageLayout {...LAYOUT} meta={isNew ? undefined : meta}>
      <div className="flex flex-col gap-4">
        {isNew ? (
          <ResumeImportCard
            profile={profile}
            accountEmail={accountEmail}
            onApplied={onImportApplied}
            onNeedsReview={onImportNeedsReview}
          />
        ) : null}
        <CompletenessMeter completion={completion} onSuggestion={onSuggestion} />
      </div>

      <div className="mt-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6">
        <SectionNav active={active} editing={editing} filled={filled} onSelect={(id) => scrollToSection(id)} />

        <div className="flex min-w-0 flex-col gap-4">
          {isNew ? null : <ProfilePhotoCard name={`${saved.name_first} ${saved.name_last}`} />}
          {FORM_SECTIONS.map((id) => {
            const { description, View, Edit } = SECTION_UI[id];
            const isEditing = editing.has(id);
            const isSaving = savingSections.has(id);
            return (
              <SectionCard
                key={id}
                id={sectionDomId(id)}
                title={SECTION_LABEL[id]}
                description={description}
                icon={SECTION_ICON[id]}
                className={cn(isEditing && 'border-brand/40 ring-2 ring-brand/10')}
                actions={
                  isEditing ? (
                    <>
                      <Button variant="ghost" size="sm" disabled={isSaving} onClick={() => cancelEdit([id])}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => save(isNew ? [...editing] : [id])}
                        aria-label={`Save ${SECTION_LABEL[id]}`}
                      >
                        {isSaving ? <Loader2 className="animate-spin" /> : null}
                        Save
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(id)}
                      aria-label={`Edit ${SECTION_LABEL[id]}`}
                    >
                      <Pencil />
                      Edit
                    </Button>
                  )
                }
              >
                {isEditing ? (
                  <Edit
                    form={effective}
                    update={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                    err={errorFor}
                    touch={(key) => setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))}
                  />
                ) : (
                  <View form={saved} />
                )}
              </SectionCard>
            );
          })}

          <SectionCard
            id={sectionDomId('documents')}
            title={SECTION_LABEL.documents}
            description="Project write-ups used to tailor résumés."
            icon={SECTION_ICON.documents}
          >
            <div className="flex flex-col gap-5">
              {!isNew ? (
                <ResumeImportCard
                  compact
                  profile={profile}
                  accountEmail={accountEmail}
                  onApplied={onImportApplied}
                  onNeedsReview={onImportNeedsReview}
                  className="border-none bg-transparent p-0"
                />
              ) : null}
              <SourceDocumentsSection companies={workCompanies(saved)} />
            </div>
          </SectionCard>

          <SaveBar
            dirty={dirtySections.length > 0}
            saving={mutation.isPending}
            onSave={() => save([...editing])}
            onDiscard={() => cancelEdit([...editing])}
            message={`Unsaved changes in ${dirtySections.map((s) => SECTION_LABEL[s]).join(', ')}`}
            saveLabel={editing.size > 1 ? 'Save all' : 'Save'}
          />
        </div>
      </div>
    </PageLayout>
  );
}

function SectionNav({
  active,
  editing,
  filled,
  onSelect,
}: {
  active: SectionId;
  editing: Set<FormSectionId>;
  filled: Set<SectionId>;
  onSelect: (id: SectionId) => void;
}) {
  const formFilled = FORM_SECTIONS.filter((id) => filled.has(id)).length;
  const item = (id: SectionId, label: string, chip: boolean) => {
    const isActive = active === id;
    const isEditing = editing.has(id as FormSectionId);
    const Icon = SECTION_ICON[id];
    return (
      <button
        key={id}
        type="button"
        aria-current={isActive ? 'true' : undefined}
        onClick={() => onSelect(id)}
        className={cn(
          'group flex items-center gap-2 text-sm transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          chip
            ? 'shrink-0 rounded-full border px-3 py-1'
            : 'relative w-full rounded-lg px-2.5 py-2 text-left',
          isActive
            ? chip
              ? 'border-brand/40 bg-brand/10 font-medium text-foreground'
              : 'bg-brand/10 font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        {!chip && isActive ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" /> : null}
        <Icon
          aria-hidden
          className={cn('size-4 shrink-0', isActive ? 'text-brand' : 'text-muted-foreground/70 group-hover:text-foreground')}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {isEditing ? (
          <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-label="editing" />
        ) : !chip && filled.has(id) ? (
          <CircleCheck aria-hidden className="size-3.5 shrink-0 text-match-strong" />
        ) : null}
      </button>
    );
  };
  return (
    <>
      <nav
        aria-label="Profile sections"
        className="sticky top-0 z-10 -mx-4 mb-4 flex gap-1.5 overflow-x-auto bg-background/80 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden"
      >
        {SECTIONS.map((s) => item(s.id, s.label, true))}
      </nav>
      <nav
        aria-label="Profile sections"
        className="sticky top-6 hidden self-start rounded-2xl border bg-card/80 p-2 shadow-xs backdrop-blur-sm lg:flex lg:flex-col lg:gap-0.5"
      >
        <p className="px-2.5 pt-1.5 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Sections
        </p>
        {SECTIONS.map((s) => item(s.id, s.label, false))}
        <div className="mt-2 border-t border-border/60 px-2.5 pt-2.5 pb-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>Filled</span>
            <span className="font-medium text-foreground">
              {formFilled}/{FORM_SECTIONS.length}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand to-match-strong transition-[width] duration-700"
              style={{ width: `${(formFilled / FORM_SECTIONS.length) * 100}%` }}
            />
          </div>
        </div>
      </nav>
    </>
  );
}
