import { usePublicViewport } from '../hooks/usePublicViewport';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { LandingHeader } from '../components/landing/LandingHeader';
import { HeroSection } from '../components/landing/HeroSection';
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

  return (
    <div className="min-h-dvh w-full overflow-x-hidden bg-[#05070f] text-white antialiased">
      <LandingHeader />
      <main>
        <HeroSection />
        <HowItWorksSection />
        <FeaturesSection />
        <AutofillSection />
        <FaqSection />
        <ClosingSection />
      </main>
    </div>
  );
}
