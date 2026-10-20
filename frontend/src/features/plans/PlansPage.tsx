import { useState, type ReactNode } from 'react';
import {
  Check,
  Coins,
  FileCheck2,
  Gift,
  Infinity as InfinityIcon,
  Radar,
  Receipt,
  Send,
  type LucideIcon,
} from 'lucide-react';
import { HeroStat, PageLayout } from '@/components/app/PageLayout';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { CheckoutPreviewDialog } from './CheckoutPreviewDialog';
import { PackageCard } from './PackageCard';
import { type CreditPackage, PACKAGES, SIGNUP_CREDITS, formatRate, recommendPackage } from './plansModel';
import { UsageEstimator } from './UsageEstimator';

const DEFAULT_PACE = 40;
const LOWEST_RATE = Math.min(...PACKAGES.map((p) => p.rateCents));

const STEPS: { icon: LucideIcon; title: string; body: string; cost: string }[] = [
  {
    icon: Radar,
    title: 'Find and score',
    body: 'Connected job sites sync on their own, and every new job gets a match score against your profile.',
    cost: 'Free',
  },
  {
    icon: FileCheck2,
    title: 'Prepare',
    body: 'NAO tailors your resume and writes a cover letter for the job, then builds the files you send.',
    cost: '1 credit',
  },
  {
    icon: Send,
    title: 'Apply',
    body: 'Open the job, review the documents, and apply yourself or with the extension.',
    cost: 'Included',
  },
];

const USES_CREDIT = [
  'Preparing a job: tailored resume, cover letter, and application files',
  'Preparing a job you add by link, from the extension, or through the assistant',
  'Tailoring a resume in Documents, Resume studio, or the assistant',
];

const ALWAYS_FREE = [
  'Syncing job sites and adding jobs to your list',
  'Match scores for every job',
  "Retrying a preparation that failed, or rebuilding a prepared job's files",
  'Interview tracking, insights, and your profile',
];

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: 'What does one credit buy?',
    a: 'One prepared job. A credit covers the full preparation for that job: the tailored resume, the cover letter, and the files you send with your application.',
  },
  {
    q: 'When is a credit used?',
    a: 'When NAO starts preparing a job. Finding, syncing, and scoring jobs never uses credits. If a preparation fails, the credit is returned automatically.',
  },
  {
    q: 'Can I choose which jobs use credits?',
    a: 'Yes. Set a minimum match score in Preferences and only jobs at or above it are prepared automatically. You can still prepare any other job by hand.',
  },
  {
    q: 'What happens when I run out?',
    a: 'New jobs keep arriving and getting scored, but preparation pauses and jobs that are not prepared yet stay locked until you add credits. Jobs you already prepared stay open with their documents.',
  },
  {
    q: 'Do credits expire?',
    a: 'No. Credits stay on your account until you use them, and packages add up when you buy more than one.',
  },
  {
    q: 'Is this a subscription?',
    a: 'No. Every package is a one-time payment. There is nothing to cancel, and you only buy again when you need more.',
  },
];

export function PlansPage() {
  const [jobsPerWeek, setJobsPerWeek] = useState(DEFAULT_PACE);
  const [buying, setBuying] = useState<CreditPackage | null>(null);
  const suggested = recommendPackage(jobsPerWeek);

  const meta = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <HeroStat icon={Gift} label="Free when you sign up" value={`${SIGNUP_CREDITS} credits`} />
      <HeroStat
        icon={Coins}
        label="Price per job"
        value={`From ${formatRate(LOWEST_RATE)}`}
        tone="bg-status-ready/15 text-status-ready"
      />
      <HeroStat icon={Receipt} label="Billing" value="One-time, no subscription" tone="bg-chart-2/10 text-chart-2" />
      <HeroStat icon={InfinityIcon} label="Credits" value="Never expire" tone="bg-chart-4/10 text-chart-4" />
    </div>
  );

  return (
    <PageLayout
      title="Plans"
      description="Pay for the jobs NAO prepares, nothing else. One credit takes one job from match to ready-to-apply."
      width="wide"
      variant="hero"
      icon={Coins}
      meta={meta}
    >
      <div className="space-y-10">
        <Group title="Credit packages" description="Bigger packages lower the price of every job.">
          <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2 xl:grid-cols-4">
            {PACKAGES.map((pkg) => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                jobsPerWeek={jobsPerWeek}
                fitsPace={pkg.id === suggested.id}
                onBuy={setBuying}
              />
            ))}
          </div>
          <p className="px-1 text-xs text-muted-foreground">Prices in USD. Taxes may apply at checkout.</p>
        </Group>

        <UsageEstimator jobsPerWeek={jobsPerWeek} onChange={setJobsPerWeek} />

        <Group title="How credits work" description="You only pay when a job is prepared for you.">
          <ol className="grid gap-3 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="relative rounded-2xl border bg-card/90 p-5 shadow-xs backdrop-blur-sm">
                <div className="flex items-center justify-between gap-3">
                  <span aria-hidden className="inline-flex size-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    <step.icon className="size-4" />
                  </span>
                  <span
                    className={
                      step.cost === '1 credit'
                        ? 'rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold text-brand-foreground'
                        : 'rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground'
                    }
                  >
                    {step.cost}
                  </span>
                </div>
                <h3 className="mt-4 text-sm font-semibold">
                  <span className="text-muted-foreground tabular-nums">{i + 1}.</span> {step.title}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>

          <div className="grid gap-3 md:grid-cols-2">
            <CheckList title="Uses a credit" items={USES_CREDIT} tone="brand" />
            <CheckList title="Always free" items={ALWAYS_FREE} tone="ready" />
          </div>
        </Group>

        <Group title="Questions" description="How credits behave day to day.">
          <div className="rounded-2xl border bg-card/90 px-5 py-2 shadow-xs backdrop-blur-sm">
            <Accordion>
              {FAQ.map((item) => (
                <AccordionItem key={item.q} value={item.q}>
                  <AccordionTrigger className="py-3.5">{item.q}</AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">{item.a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </Group>
      </div>

      <CheckoutPreviewDialog pkg={buying} onClose={() => setBuying(null)} />
    </PageLayout>
  );
}

function CheckList({ title, items, tone }: { title: string; items: string[]; tone: 'brand' | 'ready' }) {
  return (
    <section className="rounded-2xl border bg-card/90 p-5 shadow-xs backdrop-blur-sm" aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <Check
              aria-hidden
              className={tone === 'brand' ? 'mt-0.5 size-4 shrink-0 text-brand' : 'mt-0.5 size-4 shrink-0 text-status-ready'}
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const id = `plans-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-4">
      <div className="flex items-start gap-2.5 px-1">
        <span aria-hidden className="mt-1.5 h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-brand to-brand/30" />
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
