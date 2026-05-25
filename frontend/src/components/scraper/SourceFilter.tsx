interface SourceFilterProps {
  sources: string[];
  selected: string;
  onChange: (source: string) => void;
}

const SOURCE_COLORS: Record<string, string> = {
  adzuna: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  remoterocketship: 'bg-purple-100 text-purple-700 border-purple-200',
  jobright: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  welcometothejungle: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  ziprecruiter: 'bg-amber-100 text-amber-700 border-amber-200',
  indeed: 'bg-blue-100 text-blue-700 border-blue-200',
  glassdoor: 'bg-orange-100 text-orange-700 border-orange-200',
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
        const colorCls = SOURCE_COLORS[src.toLowerCase()] || 'bg-slate-100 text-slate-700 border-slate-200';
        return (
          <button
            key={src}
            onClick={() => onChange(isActive ? '' : src)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              isActive ? colorCls : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
            }`}
          >
            {src}
          </button>
        );
      })}
    </div>
  );
}
