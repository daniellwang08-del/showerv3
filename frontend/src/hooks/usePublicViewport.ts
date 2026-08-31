import { useLayoutEffect } from 'react';

/**
 * Opts a public page out of the app shell's viewport rules.
 *
 * The dashboard pins html/body to a 1400px minimum width and hands vertical
 * scrolling to inner panels. The landing page and the auth screens are ordinary
 * responsive documents, so they add `.public-viewport` to <html> while mounted
 * (rules live in style.css). Only <html> is allowed to scroll — clipping
 * overflow on body/#root creates a second scroller and jumps the page on Y.
 *
 * A layout effect, not an effect: the class has to land before the first paint,
 * otherwise the page briefly renders against the 1400px floor.
 */
export function usePublicViewport(extraClass?: string) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const classes = extraClass ? ['public-viewport', extraClass] : ['public-viewport'];
    root.classList.add(...classes);
    return () => root.classList.remove(...classes);
  }, [extraClass]);
}
