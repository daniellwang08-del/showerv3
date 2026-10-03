import type { ComponentType, ReactNode } from 'react';
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu';
import type { JobActionId, JobMenuEntry } from './jobMenu';
import type { DashboardJob } from '@/types/scraper';

interface ItemProps {
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'destructive';
  children?: ReactNode;
}

interface Parts {
  Group: ComponentType<{ children?: ReactNode }>;
  Item: ComponentType<ItemProps>;
  Separator: ComponentType;
  Label: ComponentType<{ children?: ReactNode; className?: string }>;
  Shortcut: ComponentType<{ children?: ReactNode }>;
}

const dropdownParts: Parts = {
  Group: DropdownMenuGroup,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Label: DropdownMenuLabel,
  Shortcut: DropdownMenuShortcut,
};

const contextParts: Parts = {
  Group: ContextMenuGroup,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Label: ContextMenuLabel,
  Shortcut: ContextMenuShortcut,
};

interface Props {
  kind: 'dropdown' | 'context';
  entries: JobMenuEntry[];
  title?: string;
  onAction: (id: JobActionId, targets: DashboardJob[]) => void;
}

export function JobMenuItems({ kind, entries, title, onAction }: Props) {
  const { Group, Item, Separator, Label, Shortcut } = kind === 'dropdown' ? dropdownParts : contextParts;
  return (
    // Base UI requires labels to live inside a group.
    <Group>
      {title && <Label className="max-w-64 truncate text-xs text-muted-foreground">{title}</Label>}
      {entries.map((entry, i) => {
        if (entry === 'separator') {
          const prev = entries[i - 1];
          if (i === 0 || prev === 'separator') return null;
          return <Separator key={`sep-${i}`} />;
        }
        const Icon = entry.icon;
        return (
          <Item
            key={entry.id}
            disabled={entry.disabled}
            variant={entry.destructive ? 'destructive' : 'default'}
            onClick={() => onAction(entry.id, entry.targets)}
          >
            <Icon />
            {entry.label}
            {entry.shortcut && <Shortcut>{entry.shortcut}</Shortcut>}
          </Item>
        );
      })}
    </Group>
  );
}
