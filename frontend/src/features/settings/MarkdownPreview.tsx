import ReactMarkdown from 'react-markdown';

export function MarkdownPreview({ value }: { value: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_hr]:border-border [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
      <ReactMarkdown>{value}</ReactMarkdown>
    </div>
  );
}
