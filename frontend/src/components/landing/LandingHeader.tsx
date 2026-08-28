import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu, X, ArrowRight } from 'lucide-react';
import { NAV_LINKS } from './landingData';
import { PromoRibbon } from './landingMotion';
import {
  CTA_SIZE_LG,
  CTA_SIZE_SM,
  LANDING_CONTAINER,
  ctaGhostClass,
  ctaPrimaryClass,
} from './landingUi';

/**
 * Public site header: brand on the left, section links in the middle, and the
 * Sign in / Sign up entry points on the right. It stays fixed at the top and
 * gains a glass background once the visitor scrolls past the hero fold.
 */
export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Freeze the page behind the open sheet. The landing page scrolls on <html>
  // (see `.public-viewport` in style.css), so both elements are locked rather
  // than relying on overflow propagating from <body>.
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

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-500 ${
        scrolled
          ? 'border-b border-white/10 bg-[#05070f]/85 backdrop-blur-xl'
          : 'border-b border-transparent'
      }`}
    >
      <div
        className={`overflow-hidden transition-all duration-500 ${
          scrolled ? 'max-h-0 opacity-0' : 'max-h-12 opacity-100'
        }`}
      >
        <PromoRibbon>
          Now live · 5 job networks · 14 ATS engines · you keep the final click
        </PromoRibbon>
      </div>
      <div className={`${LANDING_CONTAINER} flex h-16 items-center justify-between gap-6 sm:h-18`}>
        <Link to="/" className="group flex items-center gap-2.5" aria-label="Atomspace home">
          <span className="relative flex h-9 w-9 items-center justify-center">
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full bg-sky-400/25 blur-lg transition group-hover:bg-sky-300/40"
            />
            <img
              src="/atomspace-logo.png"
              alt=""
              className="relative h-8 w-8 object-contain drop-shadow-[0_2px_10px_rgba(56,189,248,0.5)]"
            />
          </span>
          <span className="text-[17px] font-black tracking-tight text-white">Atomspace</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
          {NAV_LINKS.map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              className="rounded-full px-4 py-2 text-sm font-semibold text-white/65 transition hover:bg-white/5 hover:text-white"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2.5 sm:flex">
          <Link to="/login" className={`${ctaGhostClass} ${CTA_SIZE_SM}`}>
            Sign in
          </Link>
          <Link to="/signup" className={`${ctaPrimaryClass} ${CTA_SIZE_SM}`}>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full"
            />
            <span className="relative flex items-center gap-1.5">
              Sign up
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
                href={`#${link.id}`}
                onClick={() => setMenuOpen(false)}
                className="rounded-xl px-3 py-3 text-sm font-semibold text-white/75 transition hover:bg-white/5 hover:text-white"
              >
                {link.label}
              </a>
            ))}
            {/* The header already shows both CTAs from the sm breakpoint up. */}
            <div className="mt-3 flex flex-col gap-2.5 sm:hidden">
              <Link
                to="/login"
                onClick={() => setMenuOpen(false)}
                className={`${ctaGhostClass} ${CTA_SIZE_LG}`}
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                onClick={() => setMenuOpen(false)}
                className={`${ctaPrimaryClass} ${CTA_SIZE_LG}`}
              >
                <span className="relative flex items-center gap-1.5">
                  Sign up
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
