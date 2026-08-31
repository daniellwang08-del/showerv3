import { useLayoutEffect } from 'react';
import { usePublicViewport } from '../hooks/usePublicViewport';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { LandingHeader } from '../components/landing/LandingHeader';
import { HeroSection } from '../components/landing/HeroSection';
import { ProofStrip } from '../components/landing/ProofStrip';
import { FilmStrip } from '../components/landing/FilmStrip';
import { HowItWorksSection } from '../components/landing/HowItWorksSection';
import { FeaturesSection } from '../components/landing/FeaturesSection';
import { AutofillSection } from '../components/landing/AutofillSection';
import { FaqSection } from '../components/landing/FaqSection';
import { ClosingSection } from '../components/landing/ClosingSection';

/** Public marketing page shown to visitors before they sign in or sign up. */
export function LandingPage() {
  // `landing-theme` paints the document dark so overscroll never flashes the
  // app's light background behind this page.
  usePublicViewport('landing-theme');
  useRevealOnScroll();

  // Pin the document to the top unless the visitor arrived on a real section
  // hash. Nested scrollers and scroll anchoring were sliding this page on Y
  // as images, counters and the headline cycle finished loading.
  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';

    const id = window.location.hash.replace(/^#/, '');
    const target = id ? document.getElementById(id) : null;
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
    } else {
      window.scrollTo(0, 0);
    }

    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  return (
    <div className="w-full bg-[#05070f] text-white antialiased">
      <div className="flex min-h-dvh flex-col">
        <LandingHeader />
        <HeroSection />
        <ProofStrip />
      </div>
      <main>
        <FilmStrip />
        <HowItWorksSection />
        <FeaturesSection />
        <AutofillSection />
        <FaqSection />
        <ClosingSection />
      </main>
    </div>
  );
}
