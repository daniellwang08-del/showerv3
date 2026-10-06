import { useQuery } from '@tanstack/react-query';
import { Blocks, Check, Loader2 } from 'lucide-react';
import { fetchAgentTools, type AgentToolInfo } from '@/api/agentApi';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { PROMPT_BLOCKS, categoryIcon, toolBlock, type PromptBlock } from './promptBlocks';

/** Tools the prompt blocks already cover; listing them twice would only confuse. */
const COVERED_BY_BLOCKS = new Set(PROMPT_BLOCKS.map((b) => b.tool?.tool));

function groupByCategory(tools: AgentToolInfo[]): [string, AgentToolInfo[]][] {
  const groups = new Map<string, AgentToolInfo[]>();
  for (const t of tools) {
    if (COVERED_BY_BLOCKS.has(t.name)) continue;
    const list = groups.get(t.category) ?? [];
    list.push(t);
    groups.set(t.category, list);
  }
  return [...groups.entries()];
}

function ItemText({ label, description }: { label: string; description: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-sm">{label}</span>
      <span className="line-clamp-2 block text-xs text-muted-foreground">{description}</span>
    </span>
  );
}

/**
 * Everything the assistant can do. Picking an entry pins it to the composer as a chip,
 * so the next message is handled by that tool; with nothing picked it is a normal chat.
 */
export function ToolsMenu({
  onPickBlock,
  selectedId,
  disabled,
}: {
  onPickBlock: (block: PromptBlock) => void;
  selectedId?: string | null;
  disabled?: boolean;
}) {
  const tools = useQuery({ queryKey: ['agent-tools'], queryFn: fetchAgentTools, staleTime: 10 * 60_000 });
  const groups = groupByCategory(tools.data ?? []);

  const item = (block: PromptBlock, description: string) => {
    const selected = selectedId === block.id;
    return (
      <DropdownMenuItem
        key={block.id}
        className={cn('items-start py-1.5', selected && 'bg-brand-soft/60')}
        onClick={() => onPickBlock(block)}
      >
        <block.icon className="mt-0.5 text-brand" />
        <ItemText label={block.label} description={description} />
        {selected ? <Check className="mt-0.5 text-brand" aria-label="Selected" /> : null}
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 data-popup-open:bg-muted data-popup-open:text-foreground"
        aria-label="Tools"
      >
        <Blocks className="size-4" />
        Tools
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Resume and cover letter</DropdownMenuLabel>
          {PROMPT_BLOCKS.map((block) => item(block, block.description))}
        </DropdownMenuGroup>
        {tools.isPending ? (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading tools…
            </div>
          </>
        ) : null}
        {groups.map(([category, list]) => {
          const Icon = categoryIcon(category);
          return (
            <div key={category}>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <Icon className="size-3.5" />
                  {category}
                </DropdownMenuLabel>
                {list.map((t) => item(toolBlock(t), t.example ? `Try: "${t.example}"` : t.description))}
              </DropdownMenuGroup>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
