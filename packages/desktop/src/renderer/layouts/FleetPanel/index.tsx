/**
 * Fleet Panel — the "talk to all agents at once" surface. Opt-in view,
 * reached via the left nav (does not replace the task-first chat workflow).
 *
 * See docs/SUPER_DASHBOARD_PLAN.md (cobalt-fleet repo) for design rationale.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Radio, Send, Plus, Trash2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFleetStore } from '@/stores/fleetStore';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import EmptyState from '@/components/semantic/EmptyState';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import InfraMonitor from './InfraMonitor';

function AgentPill({
  online,
  name,
  emoji,
  runtimeLabel,
}: {
  online: boolean;
  name: string;
  emoji?: string;
  runtimeLabel: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm',
        online
          ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--text-primary)]'
          : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)]',
      )}
      title={runtimeLabel}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', online ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]')} />
      {emoji && <span>{emoji}</span>}
      <span className="truncate max-w-[10rem]">{name}</span>
    </div>
  );
}

function MessageRow({ msg }: { msg: ReturnType<typeof useFleetStore.getState>['messages'][number] }) {
  const label = msg.fromUser ? 'You' : msg.sender;
  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 px-4 py-2 rounded-lg',
        msg.fromUser ? 'bg-[var(--accent)]/10 self-end' : 'bg-[var(--bg-secondary)]',
      )}
    >
      <div className="flex items-center gap-2 type-caption text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text-primary)]">{label}</span>
        <span>→</span>
        <span>{msg.recipient}</span>
        <span className="ml-auto">{new Date(msg.createdAt).toLocaleTimeString()}</span>
      </div>
      <div className="type-body whitespace-pre-wrap break-words">{msg.body}</div>
    </div>
  );
}

export default function FleetPanel() {
  const { t } = useTranslation();
  const agents = useFleetStore((s) => s.agents);
  const messages = useFleetStore((s) => s.messages);
  const runtimes = useFleetStore((s) => s.runtimes);
  const loading = useFleetStore((s) => s.loading);
  const error = useFleetStore((s) => s.error);
  const hydrate = useFleetStore((s) => s.hydrate);
  const sendMessage = useFleetStore((s) => s.sendMessage);
  const addRuntime = useFleetStore((s) => s.addRuntime);
  const removeRuntime = useFleetStore((s) => s.removeRuntime);

  const [recipient, setRecipient] = useState('all');
  const [draft, setDraft] = useState('');
  const [addingRuntime, setAddingRuntime] = useState(false);
  const [infraOpen, setInfraOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const onlineCount = useMemo(() => agents.filter((a) => a.online).length, [agents]);

  const handleSend = useCallback(() => {
    const body = draft.trim();
    if (!body) return;
    sendMessage(recipient, body);
    setDraft('');
  }, [draft, recipient, sendMessage]);

  const handleAddRuntime = useCallback(() => {
    // Minimal inline flow for the scaffold; a proper dialog (matching
    // TeamBuilderDialog patterns) is Phase 2 UI polish.
    const runtimeId = window.prompt('Runtime id (e.g. agentnet-vps-ovh):');
    if (!runtimeId) return;
    const label = window.prompt('Display label:', runtimeId) ?? runtimeId;
    const baseUrl = window.prompt('Base URL (e.g. https://vps-ovh.tail4f4e50.ts.net:8788):');
    if (!baseUrl) return;
    const apiKey = window.prompt('API key (X-API-Key for this adapter identity):') ?? '';
    setAddingRuntime(true);
    addRuntime({ runtimeId, kind: 'agentnet', label, baseUrl, apiKey }).finally(() => setAddingRuntime(false));
  }, [addRuntime]);

  return (
    <div className="flex flex-col h-full">
      <WindowTitlebar
        left={
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-[var(--accent)]" />
            <span className="type-heading">{t('fleet.title', 'Fleet Room')}</span>
            <span className="type-caption text-[var(--text-muted)]">
              {onlineCount}/{agents.length} {t('fleet.online', 'online')}
            </span>
          </div>
        }
        right={
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={handleAddRuntime}
              disabled={addingRuntime}
              aria-label={t('fleet.addRuntime', 'Add runtime')}
            >
              <Plus size={16} />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setInfraOpen((v) => !v)}
              aria-label={t('fleet.toggleInfra', 'Toggle infrastructure panel')}
            >
              {infraOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </Button>
          </div>
        }
      />

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          {runtimes.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] overflow-x-auto">
              {runtimes.map((r) => (
                <div
                  key={r.runtimeId}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-secondary)] type-caption"
                >
                  <span>{r.label}</span>
                  <button
                    onClick={() => removeRuntime(r.runtimeId)}
                    className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {agents.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-3 flex-wrap border-b border-[var(--border)]">
              {agents.map((a) => (
                <AgentPill
                  key={`${a.runtimeId}:${a.id}`}
                  online={a.online}
                  name={a.name}
                  emoji={a.emoji}
                  runtimeLabel={a.runtimeLabel}
                />
              ))}
            </div>
          )}

          <ScrollArea className="flex-1 min-h-0" viewportRef={scrollRef}>
            <div className="flex flex-col gap-2 p-4">
              {messages.length === 0 && !loading ? (
                <EmptyState
                  icon={<Radio size={24} className="text-[var(--text-muted)]" />}
                  title={t('fleet.empty', 'No fleet connected yet')}
                  description={t(
                    'fleet.emptyDesc',
                    'Add a runtime (AgentNet, SwarmClaw, TinyAGI, Hermes) to talk to your agents from one place.',
                  )}
                  action={
                    <Button size="sm" onClick={handleAddRuntime}>
                      {t('fleet.addRuntime', 'Add runtime')}
                    </Button>
                  }
                />
              ) : (
                messages.map((m) => <MessageRow key={m.id} msg={m} />)
              )}
            </div>
          </ScrollArea>

          {error && <div className="px-4 py-2 text-sm text-red-500 border-t border-[var(--border)]">{error}</div>}

          <div className="flex items-center gap-2 p-3 border-t border-[var(--border)]">
            <select
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="h-[var(--density-control-height-sm)] rounded-md bg-[var(--bg-primary)] border border-[var(--border)] px-2 type-body"
            >
              <option value="all">{t('fleet.all', 'All agents')}</option>
              {agents.map((a) => (
                <option key={`${a.runtimeId}:${a.id}`} value={a.id}>
                  {a.emoji ? `${a.emoji} ` : ''}
                  {a.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t('fleet.placeholder', 'Message the fleet…')}
              className="flex-1 h-[var(--density-control-height-sm)] rounded-md bg-[var(--bg-primary)] border border-[var(--border)] px-3 type-body glow-focus focus:border-transparent"
            />
            <Button size="icon-sm" onClick={handleSend} disabled={!draft.trim()} aria-label={t('fleet.send', 'Send')}>
              <Send size={16} />
            </Button>
          </div>
        </div>

        {infraOpen && (
          <div className="w-[22rem] flex-shrink-0 border-l border-[var(--border)] overflow-y-auto p-3">
            <InfraMonitor />
          </div>
        )}
      </div>
    </div>
  );
}
