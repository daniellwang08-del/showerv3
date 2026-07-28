/**
 * Native PDF viewer for the builder — shows the actual generated PDF bytes
 * (not rasterized page images). Uses the browser's built-in PDF plugin.
 */
export function ResumePdfEmbed({
  url,
  title = 'Resume PDF preview',
  className = 'h-full w-full border-0 bg-white',
}: {
  /** Object URL for an application/pdf Blob. */
  url: string;
  title?: string;
  className?: string;
}) {
  // FitH asks Chromium/Edge PDF viewer to fit page width when supported.
  const src = `${url}#view=FitH`;
  return (
    <iframe title={title} src={src} className={className} />
  );
}
