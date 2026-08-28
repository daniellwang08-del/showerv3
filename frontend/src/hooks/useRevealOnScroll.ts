import { useEffect } from 'react';

/**
 * Reveals elements carrying `.landing-reveal` as they enter the viewport by
 * adding `.is-visible` (the transition itself lives in style.css).
 *
 * Elements are observed once and then released, so scrolling back up does not
 * replay the animation. Without IntersectionObserver support, or when the
 * visitor prefers reduced motion, everything is shown immediately.
 */
export function useRevealOnScroll(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.landing-reveal'));
    if (nodes.length === 0) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof IntersectionObserver === 'undefined') {
      nodes.forEach((node) => node.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [enabled]);
}
