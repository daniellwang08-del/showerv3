interface SourceFilterProps {
  sources: string[];
  selected: string;
  onChange: (source: string) => void;
}

const SOURCE_COLORS: Record<string, string> = {
  remoterocketship: 'bg-purple-100 text-purple-700 border-purple-200',
  jobright: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  welcometothejungle: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  adzuna: 'bg-cyan-100 text-cyan-700 border-cyan-200',
};

const SOURCE_SHORT_LABELS: Record<string, string> = {
  remoterocketship: 'RRS',
  jobright: 'JR.ai',
  welcometothejungle: 'WTTJ',
  adzuna: 'Aduna',
  ziprecruiter: 'ZR',
  manual: 'FM',
};

export function SourceFilter({ sources, selected, onChange }: SourceFilterProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => onChange('')}
        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
          !selected
            ? 'bg-slate-800 text-white border-slate-800'
            : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
        }`}
      >
        All
      </button>
      {sources.map((src) => {
        const isActive = selected === src;
        const key = src.toLowerCase();
        const colorCls = SOURCE_COLORS[key] || 'bg-slate-100 text-slate-700 border-slate-200';
        const label = SOURCE_SHORT_LABELS[key] || src;
        return (
          <button
            key={src}
            title={src}
            onClick={() => onChange(isActive ? '' : src)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              isActive ? colorCls : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
