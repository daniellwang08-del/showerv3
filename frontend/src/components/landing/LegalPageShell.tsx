import type { ReactNode } from 'react';
import { useLayoutEffect } from 'react';
import { Link } from 'react-router-dom';
import { usePublicViewport } from '@/hooks/usePublicViewport';
import { PageTitle } from '@/components/app/PageTitle';
import { LandingHeader } from './LandingHeader';
import { SiteFooter } from './SiteFooter';
import { Eyebrow, LANDING_CONTAINER } from './landingUi';

export function LegalPageShell({
  title,
  description,
  updated,
  children,
}: {
  title: string;
  description: string;
  updated: string;
  children: ReactNode;
}) {
  usePublicViewport('landing-theme');

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [title]);

  return (
    <div className="w-full bg-[#04060F] text-white antialiased">
      <PageTitle title={title} />
      <LandingHeader />
      <main className={`${LANDING_CONTAINER} pb-20 pt-12 sm:pb-28 sm:pt-16`}>
        <div className="mx-auto max-w-3xl">
          <Eyebrow>Legal</Eyebrow>
          <h1 className="mt-5 text-balance text-3xl font-black tracking-tight text-white sm:text-4xl lg:text-5xl">
            {title}
          </h1>
          <p className="mt-4 text-pretty text-base leading-relaxed text-white/65 sm:text-lg">{description}</p>
          <p className="mt-3 text-sm font-semibold text-white/45">Last updated: {updated}</p>
          <p className="mt-2 text-sm text-white/45">
            Product:{' '}
            <Link to="/" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
              NAO
            </Link>{' '}
            ·{' '}
            <a href="https://nao.it.com" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
              https://nao.it.com
            </a>
          </p>
          <div className="prose-legal mt-12 space-y-10 text-[15px] leading-relaxed text-white/75">{children}</div>
        </div>
      </main>
      <SiteFooter showSectionLinks={false} />
    </div>
  );
}

export function LegalSection({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28">
      <h2 className="text-xl font-bold tracking-tight text-white sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 marker:text-[#6F9BFF]">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
