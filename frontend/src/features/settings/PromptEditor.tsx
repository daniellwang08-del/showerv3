import { lazy, Suspense, useState } from 'react';
import { Eye, PencilLine } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

const MarkdownPreview = lazy(() => import('./MarkdownPreview').then((m) => ({ default: m.MarkdownPreview })));

export function PromptEditor({
  id,
  label,
  value,
  onChange,
  maxLength,
  invalid,
  disabled,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
}) {
  const [tab, setTab] = useState('write');
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-0 overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-2 py-1.5">
        <TabsList aria-label={`${label} editor`}>
          <TabsTrigger value="write" className="px-2.5">
            <PencilLine />
            Write
          </TabsTrigger>
          <TabsTrigger value="preview" className="px-2.5">
            <Eye />
            Preview
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="write">
        <Textarea
          id={id}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          spellCheck={false}
          rows={16}
          onChange={(e) => onChange(e.target.value)}
          className="field-sizing-fixed min-h-80 resize-y rounded-none border-0 font-mono text-xs leading-relaxed focus-visible:ring-0 md:text-xs dark:bg-transparent"
          placeholder="Write markdown instructions…"
        />
      </TabsContent>
      <TabsContent value="preview" className="min-h-80 overflow-y-auto px-4 py-3">
        {value.trim() ? (
          <Suspense fallback={<Skeleton className="h-40" />}>
            <MarkdownPreview value={value} />
          </Suspense>
        ) : (
          <p className="text-sm text-muted-foreground italic">Nothing to preview yet.</p>
        )}
      </TabsContent>
    </Tabs>
  );
}
