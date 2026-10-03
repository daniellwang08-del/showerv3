import { useEffect, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { fetchUserProfile, saveUserProfile } from '@/api/profileApi';
import { PageLayout, SectionCard } from '@/components/app/PageLayout';
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

const PAGE_DESCRIPTION = 'The source of truth for every tailored résumé, cover letter and application.';

export function ProfilePage({ onProfileSaved, accountEmail }: ProfilePageProps) {
  const query = useQuery({ queryKey: PROFILE_QUERY_KEY, queryFn: fetchUserProfile });

  if (query.isPending) {
    return (
      <PageLayout title="Profile" description={PAGE_DESCRIPTION} width="wide">
        <div className="flex flex-col gap-4" aria-label="Loading profile">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </PageLayout>
    );
  }

  if (query.isError) {
    return (
      <PageLayout title="Profile" description={PAGE_DESCRIPTION} width="wide">
        <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border bg-card p-5 text-sm">
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

  return (
    <PageLayout title="Profile" description={PAGE_DESCRIPTION} width="wide">
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

      <div className="mt-6 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <SectionNav active={active} editing={editing} onSelect={(id) => scrollToSection(id)} />

        <div className="flex min-w-0 flex-col gap-4">
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
  onSelect,
}: {
  active: SectionId;
  editing: Set<FormSectionId>;
  onSelect: (id: SectionId) => void;
}) {
  const item = (id: SectionId, label: string, chip: boolean) => {
    const isActive = active === id;
    const isEditing = editing.has(id as FormSectionId);
    return (
      <button
        key={id}
        type="button"
        aria-current={isActive ? 'true' : undefined}
        onClick={() => onSelect(id)}
        className={cn(
          'flex items-center gap-2 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          chip
            ? 'shrink-0 rounded-full border px-3 py-1'
            : 'w-full rounded-lg px-2.5 py-1.5 text-left',
          isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <span className="truncate">{label}</span>
        {isEditing ? <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-label="editing" /> : null}
      </button>
    );
  };
  return (
    <>
      <nav
        aria-label="Profile sections"
        className="sticky top-0 z-10 -mx-4 mb-4 flex gap-1.5 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden"
      >
        {SECTIONS.map((s) => item(s.id, s.label, true))}
      </nav>
      <nav aria-label="Profile sections" className="sticky top-6 hidden self-start lg:flex lg:flex-col lg:gap-0.5">
        {SECTIONS.map((s) => item(s.id, s.label, false))}
      </nav>
    </>
  );
}
