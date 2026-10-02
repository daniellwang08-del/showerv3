import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, ArrowRight } from 'lucide-react';
import { NAV_LINKS } from './landingData';
import { PromoRibbon } from './landingMotion';
import {
  CTA_SIZE_LG,
  CTA_SIZE_SM,
  LANDING_CONTAINER,
  ctaPrimaryClass,
} from './landingUi';

/**
 * Public site header shared by the landing page and auth screens.
 * Section links always resolve against the landing page (`/#…` when off-home).
 */
export function LandingHeader() {
  const location = useLocation();
  const onLanding = location.pathname === '/';
  const onSignup = location.pathname === '/signup';

  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!onLanding) {
      setActiveId('');
      return;
    }
    const nodes = NAV_LINKS.map((link) => document.getElementById(link.id)).filter(
      (node): node is HTMLElement => Boolean(node),
    );
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveId(visible.target.id);
      },
      { rootMargin: '-28% 0px -58% 0px', threshold: [0.12, 0.4] },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [onLanding]);

  useEffect(() => {
    if (!menuOpen) return;
    const root = document.documentElement;
    const previousRoot = root.style.overflow;
    const previousBody = document.body.style.overflow;
    root.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previousRoot;
      document.body.style.overflow = previousBody;
    };
  }, [menuOpen]);

  const sectionHref = (id: string) => (onLanding ? `#${id}` : `/#${id}`);

  return (
    <header
      className={`sticky top-0 z-50 shrink-0 transition-[background-color,border-color,box-shadow] duration-300 ${
        scrolled
          ? 'border-b border-white/10 bg-[#05070f]/85 shadow-[0_10px_40px_-20px_rgba(2,6,23,0.9)] backdrop-blur-xl'
          : 'border-b border-white/5 bg-[#05070f]/55 backdrop-blur-md'
      }`}
    >
      <PromoRibbon>
        Now live · 5 job networks · 14 ATS engines · you keep the final click
      </PromoRibbon>
      <div className={`${LANDING_CONTAINER} flex h-16 items-center justify-between gap-6 sm:h-18`}>
        <Link to="/" className="group flex items-center gap-2.5" aria-label="NAO home">
          <span className="relative flex h-9 w-9 items-center justify-center">
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full bg-sky-400/25 blur-lg transition group-hover:bg-sky-300/40"
            />
            <img
              src="/nao-logo.png"
              alt=""
              className="relative h-8 w-8 object-contain drop-shadow-[0_2px_10px_rgba(56,189,248,0.5)]"
            />
          </span>
          <span className="text-[17px] font-black tracking-tight text-white">NAO</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
          {NAV_LINKS.map((link) => {
            const active = onLanding && activeId === link.id;
            return (
              <a
                key={link.id}
                href={sectionHref(link.id)}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  active
                    ? 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]'
                    : 'text-white/65 hover:bg-white/5 hover:text-white'
                }`}
              >
                {link.label}
              </a>
            );
          })}
        </nav>

        <div className="hidden items-center gap-2.5 sm:flex">
          <Link
            to="/signup"
            className={`${ctaPrimaryClass} ${CTA_SIZE_SM}`}
            aria-current={onSignup ? 'page' : undefined}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full"
            />
            <span className="relative flex items-center gap-1.5">
              Get started
              <ArrowRight size={15} strokeWidth={2.75} />
            </span>
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white transition hover:bg-white/10 lg:hidden"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {menuOpen ? (
        <div className="border-t border-white/10 bg-[#05070f]/95 backdrop-blur-xl lg:hidden">
          <div className={`${LANDING_CONTAINER} flex flex-col gap-1 py-4`}>
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href={sectionHref(link.id)}
                onClick={() => setMenuOpen(false)}
                className="rounded-xl px-3 py-3 text-sm font-semibold text-white/75 transition hover:bg-white/5 hover:text-white"
              >
                {link.label}
              </a>
            ))}
            <div className="mt-3 flex flex-col gap-2.5 sm:hidden">
              <Link
                to="/signup"
                onClick={() => setMenuOpen(false)}
                className={`${ctaPrimaryClass} ${CTA_SIZE_LG}`}
              >
                <span className="relative flex items-center gap-1.5">
                  Get started
                  <ArrowRight size={15} strokeWidth={2.75} />
                </span>
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
