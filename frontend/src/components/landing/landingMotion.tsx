import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCountUp } from '../../hooks/useCountUp';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

const HEADLINE_ACCENT = 'bg-gradient-to-r from-white via-[#BFD6FF] to-[#8FB2FF] bg-clip-text text-transparent';

export function HeadlineCycle({ words }: { words: string[] }) {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduced || words.length < 2) return;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % words.length);
    }, 2800);
    return () => window.clearInterval(id);
  }, [reduced, words.length]);

  const active = words[reduced ? 0 : index];

  // Every phrase occupies the same grid cell so swapping "matching" for
  // "filling" cannot change the heading height or shove the page down.
  return (
    <span className="landing-headline-cycle mt-1">
      {words.map((word) => (
        <span key={word} className={`invisible block whitespace-pre-wrap ${HEADLINE_ACCENT}`} aria-hidden="true">
          {word}
        </span>
      ))}
      <span key={active} className={`landing-word-swap block ${HEADLINE_ACCENT}`}>
        {active}
      </span>
    </span>
  );
}

export function CountStat({
  value,
  label,
  hint,
}: {
  value: string;
  label: string;
  hint: string;
}) {
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const numeric = Number.parseInt(value, 10);
  const counted = useCountUp(Number.isFinite(numeric) ? numeric : 0, active);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="border-l border-white/15 pl-3 sm:pl-3.5">
      <dt className="text-2xl font-black tabular-nums text-white sm:text-3xl">
        <span className="inline-block min-w-[2ch]">
          {Number.isFinite(numeric) ? counted : value}
        </span>
      </dt>
      <dd className="mt-1 text-[13px] font-bold text-white/85">{label}</dd>
      <dd className="text-[11px] font-semibold leading-snug text-white/55">{hint}</dd>
    </div>
  );
}

export function PromoRibbon({ children }: { children: ReactNode }) {
  return (
    <div className="landing-ribbon relative border-b border-white/8 bg-[#070B1C]">
      <p className="relative px-4 py-2 text-center text-[11px] font-bold uppercase tracking-[0.18em] text-white/70 sm:text-[12px]">
        {children}
      </p>
    </div>
  );
}
