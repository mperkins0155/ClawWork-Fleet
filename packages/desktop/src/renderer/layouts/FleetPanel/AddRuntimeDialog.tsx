/**
 * Add Runtime Dialog — replaces the window.prompt() placeholder flow for
 * connecting a new AgentNet/SwarmClaw/TinyAGI/Hermes instance to the Fleet
 * Room. Matches TeamBuilderDialog's visual/structural conventions.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type RuntimeKind = 'agentnet' | 'swarmclaw' | 'tinyagi' | 'hermes';

interface RuntimeKindMeta {
  kind: RuntimeKind;
  label: string;
  description: string;
  baseUrlPlaceholder: string;
  keyLabel: string;
  keyRequired: boolean;
}

const RUNTIME_KINDS: RuntimeKindMeta[] = [
  {
    kind: 'agentnet',
    label: 'AgentNet',
    description: 'Fleet message bus — agent/all/channel addressing',
    baseUrlPlaceholder: 'https://vps-ovh.tail4f4e50.ts.net:8788',
    keyLabel: 'X-API-Key',
    keyRequired: true,
  },
  {
    kind: 'swarmclaw',
    label: 'SwarmClaw',
    description: 'Chatroom-based multi-agent runtime',
    baseUrlPlaceholder: 'http://100.108.164.113:3457',
    keyLabel: 'X-Access-Key',
    keyRequired: true,
  },
  {
    kind: 'tinyagi',
    label: 'TinyAGI',
    description: 'Team-based specialist agents (no auth by default)',
    baseUrlPlaceholder: 'http://127.0.0.1:3777',
    keyLabel: 'API key (optional)',
    keyRequired: false,
  },
  {
    kind: 'hermes',
    label: 'Hermes',
    description: 'Single-agent gateway — one entry per instance',
    baseUrlPlaceholder: 'http://127.0.0.1:8642',
    keyLabel: 'API_SERVER_KEY',
    keyRequired: true,
  },
];

export interface AddRuntimeParams {
  runtimeId: string;
  kind: RuntimeKind;
  label: string;
  baseUrl: string;
  apiKey?: string;
}

interface AddRuntimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (params: AddRuntimeParams) => Promise<void>;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export default function AddRuntimeDialog({ open, onOpenChange, onSubmit }: AddRuntimeDialogProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<RuntimeKind>('agentnet');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = RUNTIME_KINDS.find((k) => k.kind === kind)!;

  const reset = useCallback(() => {
    setKind('agentnet');
    setLabel('');
    setBaseUrl('');
    setApiKey('');
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleSubmit = useCallback(async () => {
    setError(null);
    const trimmedLabel = label.trim() || meta.label;
    const trimmedUrl = baseUrl.trim();
    if (!trimmedUrl) {
      setError(t('fleet.baseUrlRequired', 'Base URL is required.'));
      return;
    }
    if (meta.keyRequired && !apiKey.trim()) {
      setError(t('fleet.keyRequired', '{{label}} is required for this runtime.', { label: meta.keyLabel }));
      return;
    }
    const runtimeId = `${kind}-${slugify(trimmedLabel) || 'instance'}`;
    setSubmitting(true);
    try {
      await onSubmit({ runtimeId, kind, label: trimmedLabel, baseUrl: trimmedUrl, apiKey: apiKey.trim() || undefined });
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [apiKey, baseUrl, handleOpenChange, kind, label, meta, onSubmit, t]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fleet.addRuntimeTitle', 'Connect a runtime')}</DialogTitle>
          <DialogDescription>
            {t('fleet.addRuntimeDesc', 'Bring another agent runtime into the Fleet Room so you can talk to it here.')}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div>
            <div className="type-label mb-2 text-[var(--text-secondary)]">{t('fleet.runtimeType', 'Runtime type')}</div>
            <div className="grid grid-cols-2 gap-2">
              {RUNTIME_KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => setKind(k.kind)}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    kind === k.kind
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <div className="type-body font-medium text-[var(--text-primary)]">{k.label}</div>
                  <div className="type-caption text-[var(--text-muted)]">{k.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="type-label mb-1.5 block text-[var(--text-secondary)]" htmlFor="fleet-runtime-label">
              {t('fleet.displayLabel', 'Display label')}
            </label>
            <input
              id="fleet-runtime-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={meta.label}
              className="w-full h-[var(--density-control-height-sm)] rounded-md bg-[var(--bg-primary)] border border-[var(--border)] px-3 type-body glow-focus focus:border-transparent"
            />
          </div>

          <div>
            <label className="type-label mb-1.5 block text-[var(--text-secondary)]" htmlFor="fleet-runtime-url">
              {t('fleet.baseUrl', 'Base URL')}
            </label>
            <input
              id="fleet-runtime-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta.baseUrlPlaceholder}
              className="w-full h-[var(--density-control-height-sm)] rounded-md bg-[var(--bg-primary)] border border-[var(--border)] px-3 type-body glow-focus focus:border-transparent font-mono"
            />
          </div>

          <div>
            <label className="type-label mb-1.5 block text-[var(--text-secondary)]" htmlFor="fleet-runtime-key">
              {meta.keyLabel}
            </label>
            <input
              id="fleet-runtime-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={meta.keyRequired ? t('fleet.required', 'required') : t('fleet.optional', 'optional')}
              className="w-full h-[var(--density-control-height-sm)] rounded-md bg-[var(--bg-primary)] border border-[var(--border)] px-3 type-body glow-focus focus:border-transparent font-mono"
            />
          </div>

          {error && <div className="type-caption text-red-500">{error}</div>}
        </div>

        <DialogFooter className="mt-6">
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('fleet.connecting', 'Connecting…') : t('fleet.connect', 'Connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
