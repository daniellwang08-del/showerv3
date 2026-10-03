import { useEffect } from 'react';

/** Sets `document.title` for the current page. */
export function PageTitle({ title }: { title: string }) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} · NAO`;
    return () => {
      document.title = prev;
    };
  }, [title]);
  return null;
}
