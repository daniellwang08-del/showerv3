import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PER_PAGE_OPTIONS } from './logFilters';

const ITEMS = PER_PAGE_OPTIONS.map((n) => ({ value: String(n), label: `${n} / page` }));

interface Props {
  page: number;
  pages: number;
  total: number;
  perPage: number;
  disabled?: boolean;
  onPage: (page: number) => void;
  onPerPage: (perPage: number) => void;
}

export function LogsPagination({ page, pages, total, perPage, disabled, onPage, onPerPage }: Props) {
  const last = Math.max(1, pages);
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const items = ITEMS.some((o) => o.value === String(perPage))
    ? ITEMS
    : [...ITEMS, { value: String(perPage), label: `${perPage} / page` }];

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2.5 text-sm text-muted-foreground"
    >
      <span className="tabular-nums">
        {total > 0 ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : 'No events'}
      </span>
      <div className="flex items-center gap-1.5">
        <Select value={String(perPage)} items={items} onValueChange={(v) => onPerPage(Number(v) || perPage)}>
          <SelectTrigger size="sm" aria-label="Rows per page" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="px-1 tabular-nums">
          Page {page} of {last}
        </span>
        <Button variant="outline" size="icon-sm" aria-label="First page" disabled={disabled || page <= 1} onClick={() => onPage(1)}>
          <ChevronsLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={disabled || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={disabled || page >= last}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Last page"
          disabled={disabled || page >= last}
          onClick={() => onPage(last)}
        >
          <ChevronsRight />
        </Button>
      </div>
    </nav>
  );
}
