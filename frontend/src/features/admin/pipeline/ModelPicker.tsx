import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setActiveLlmModel } from '@/api/settingsApi';
import { errorMessage } from './pipelineApi';
import { pipelineKeys, useLlmModels, useLlmSettings } from './queries';

const DEFAULT = '__system_default__';

/** Dashboard fallback model; admin per-stage bindings in System Settings override it. */
export function ModelPicker() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const settings = useLlmSettings();
  const models = useLlmModels(open || settings.isSuccess);
  const userModel = settings.data?.llm_model ?? null;
  const defaultModel = settings.data?.default_llm_model ?? '';
  const active = userModel || defaultModel || '—';

  const save = useMutation({
    mutationFn: (model: string | null) => setActiveLlmModel(model),
    onSuccess: (data) => qc.setQueryData(pipelineKeys.settings(), data),
    onError: (err) => toast.error(errorMessage(err, 'Failed to switch model.')),
  });

  const list = models.data?.models ?? [];
  const missing = userModel && list.length > 0 && !list.some((m) => m.id === userModel);
  const emptyMessage = models.isError
    ? errorMessage(models.error, 'Failed to discover models.')
    : models.data?.message || 'No chat models discovered for this key.';

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={settings.isPending}
            aria-label={`AI model: ${active}`}
            title="Dashboard fallback model. Admin job bindings override this per pipeline stage."
            className="max-w-56"
          />
        }
      >
        {save.isPending || settings.isPending ? <Loader2 className="animate-spin" /> : <Bot />}
        <span className="text-muted-foreground max-sm:hidden">Model</span>
        <span className="truncate font-medium">{active}</span>
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>AI model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={userModel ?? DEFAULT}
            onValueChange={(value) => {
              const next = value === DEFAULT ? null : String(value);
              if (next !== userModel) save.mutate(next);
            }}
          >
            <DropdownMenuRadioItem value={DEFAULT}>
              <span className="min-w-0">
                <span className="block">System default</span>
                {defaultModel && <span className="block truncate text-xs text-muted-foreground">{defaultModel}</span>}
              </span>
            </DropdownMenuRadioItem>
            {missing && <DropdownMenuRadioItem value={userModel}>{userModel}</DropdownMenuRadioItem>}
            {list.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                <span className="truncate">{m.id}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {models.isPending && open && (
            <p className="flex items-center gap-2 px-1.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Discovering models…
            </p>
          )}
          {!models.isPending && list.length === 0 && (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          closeOnClick={false}
          disabled={models.isFetching}
          onClick={() => void qc.invalidateQueries({ queryKey: pipelineKeys.models() })}
        >
          <RefreshCw className={models.isFetching ? 'animate-spin' : undefined} /> Refresh models
        </DropdownMenuItem>
        <p className="px-1.5 pt-1 pb-1.5 text-xs text-muted-foreground">
          Fallback when a job has no Admin → System Settings model binding.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
