import { ChevronDown, ChevronUp, Eye, EyeOff, ListOrdered } from 'lucide-react';
import type { ResumeDesign, SectionId } from '../../types/resumeDesign';
import { SECTION_LABELS } from '../../types/resumeDesign';
import { ControlCard } from './controls';

const LOCKED: SectionId[] = ['summary', 'experience'];

export function SectionManager({
  design,
  onToggle,
  onMove,
}: {
  design: ResumeDesign;
  onToggle: (id: SectionId) => void;
  onMove: (id: SectionId, dir: -1 | 1) => void;
}) {
  const order = design.layout.section_order;
  const hidden = new Set(design.layout.hidden_sections);

  return (
    <ControlCard icon={ListOrdered} title="Sections">
      <p className="-mt-1 text-xs text-slate-500">Reorder and toggle sections. Summary and experience are required.</p>
      <ul className="space-y-1.5">
        {order.map((id, idx) => {
          const isHidden = hidden.has(id);
          const locked = LOCKED.includes(id);
          return (
            <li
              key={id}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                isHidden ? 'border-slate-100 bg-slate-50' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => onMove(id, -1)}
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
                  aria-label="Move up"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  disabled={idx === order.length - 1}
                  onClick={() => onMove(id, 1)}
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
                  aria-label="Move down"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              <span className={`flex-1 text-sm font-medium ${isHidden ? 'text-slate-400' : 'text-slate-800'}`}>
                {SECTION_LABELS[id]}
              </span>
              <button
                type="button"
                disabled={locked}
                onClick={() => onToggle(id)}
                title={locked ? 'Required section' : isHidden ? 'Show section' : 'Hide section'}
                className={`rounded-md p-1 transition ${
                  locked
                    ? 'cursor-not-allowed text-slate-300'
                    : isHidden
                      ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                      : 'text-blue-600 hover:bg-blue-50'
                }`}
              >
                {isHidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </li>
          );
        })}
      </ul>
    </ControlCard>
  );
}
