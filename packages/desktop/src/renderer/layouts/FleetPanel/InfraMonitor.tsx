/**
 * Infra Monitor — docker/tailscale/VPS-resource/systemd observability panel.
 * Rendered inside FleetPanel as a section below the chat. Read-only, driven
 * entirely by server-pushed snapshots (useInfraStore) — no client polling.
 *
 * See docs/SUPER_DASHBOARD_PLAN.md (cobalt-fleet repo) for design rationale.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Network, Cpu, Activity, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useInfraStore } from '@/stores/infraStore';
import type { ContainerState, SystemdUnitState } from '@/stores/infraStore';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function gaugeColor(percent: number): string {
  if (percent >= 90) return 'var(--red, #ef4444)';
  if (percent >= 75) return 'var(--yellow, #eab308)';
  return 'var(--accent)';
}

function Gauge({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="type-caption text-[var(--text-muted)]">{label}</span>
        <span className="type-caption text-[var(--text-primary)]">{clamped.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${clamped}%`, backgroundColor: gaugeColor(clamped) }}
        />
      </div>
      <span className="type-caption text-[var(--text-muted)]">{detail}</span>
    </div>
  );
}

const CONTAINER_STATE_DOT: Record<ContainerState, string> = {
  running: 'bg-[var(--accent)]',
  exited: 'bg-[var(--text-muted)]',
  restarting: 'bg-yellow-500',
  paused: 'bg-yellow-500',
  dead: 'bg-red-500',
  unknown: 'bg-[var(--text-muted)]',
};

const SYSTEMD_STATE_DOT: Record<SystemdUnitState, string> = {
  active: 'bg-[var(--accent)]',
  inactive: 'bg-[var(--text-muted)]',
  failed: 'bg-red-500',
  activating: 'bg-yellow-500',
  deactivating: 'bg-yellow-500',
  unknown: 'bg-[var(--text-muted)]',
};

function HostSection({ hostId, label }: { hostId: string; label: string }) {
  const { t } = useTranslation();
  const snapshot = useInfraStore((s) => s.snapshots[hostId]);
  const removeHost = useInfraStore((s) => s.removeHost);
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Activity size={14} className="text-[var(--accent)]" />
        <span className="type-body font-medium text-[var(--text-primary)]">{label}</span>
        {snapshot && (
          <span className="type-caption text-[var(--text-muted)] ml-auto">
            {new Date(snapshot.capturedAt).toLocaleTimeString()}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeHost(hostId);
          }}
          className="text-[var(--text-muted)] hover:text-red-500 ml-2"
          aria-label={t('fleet.removeHost', 'Remove host')}
        >
          <Trash2 size={13} />
        </button>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {!snapshot ? (
            <div className="type-caption text-[var(--text-muted)] py-2">
              {t('fleet.waitingForSnapshot', 'Waiting for first snapshot…')}
            </div>
          ) : (
            <>
              {snapshot.resources && (
                <div className="grid grid-cols-3 gap-4 pt-1">
                  <Gauge
                    label="CPU"
                    percent={snapshot.resources.cpuPercent}
                    detail={`load ${snapshot.resources.loadAvg1m.toFixed(2)}`}
                  />
                  <Gauge
                    label={t('fleet.memory', 'Memory')}
                    percent={(snapshot.resources.memUsedBytes / snapshot.resources.memTotalBytes) * 100}
                    detail={`${formatBytes(snapshot.resources.memUsedBytes)} / ${formatBytes(snapshot.resources.memTotalBytes)}`}
                  />
                  <Gauge
                    label={t('fleet.disk', 'Disk')}
                    percent={(snapshot.resources.diskUsedBytes / snapshot.resources.diskTotalBytes) * 100}
                    detail={`${formatBytes(snapshot.resources.diskUsedBytes)} / ${formatBytes(snapshot.resources.diskTotalBytes)}`}
                  />
                  <div className="col-span-3 type-caption text-[var(--text-muted)]">
                    {t('fleet.uptime', 'Uptime')}: {formatUptime(snapshot.resources.uptimeSeconds)}
                  </div>
                </div>
              )}

              {snapshot.containers.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Container size={13} className="text-[var(--text-muted)]" />
                    <span className="type-caption uppercase tracking-wider text-[var(--text-muted)]">
                      {t('fleet.containers', 'Containers')} ({snapshot.containers.length})
                    </span>
                  </div>
                  <div className="space-y-1">
                    {snapshot.containers.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 type-caption">
                        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', CONTAINER_STATE_DOT[c.state])} />
                        <span className="text-[var(--text-primary)] truncate max-w-[10rem]">{c.name}</span>
                        <span className="text-[var(--text-muted)] truncate">{c.image}</span>
                        {c.cpuPercent != null && (
                          <span className="text-[var(--text-muted)] ml-auto flex-shrink-0">
                            {c.cpuPercent.toFixed(0)}% CPU
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {snapshot.tailscale && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Network size={13} className="text-[var(--text-muted)]" />
                    <span className="type-caption uppercase tracking-wider text-[var(--text-muted)]">
                      {t('fleet.tailscale', 'Tailscale')} ({snapshot.tailscale.peers.filter((p) => p.online).length}/
                      {snapshot.tailscale.peers.length} {t('fleet.online', 'online')})
                    </span>
                  </div>
                  <div className="space-y-1">
                    {snapshot.tailscale.peers.map((p) => (
                      <div key={p.hostname} className="flex items-center gap-2 type-caption">
                        <span
                          className={cn(
                            'w-1.5 h-1.5 rounded-full flex-shrink-0',
                            p.online ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]',
                          )}
                        />
                        <span className="text-[var(--text-primary)] truncate max-w-[10rem]">
                          {p.hostname}
                          {p.isSelf ? ` (${t('fleet.self', 'this machine')})` : ''}
                        </span>
                        <span className="text-[var(--text-muted)]">{p.tailscaleIp}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {snapshot.systemdUnits.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Cpu size={13} className="text-[var(--text-muted)]" />
                    <span className="type-caption uppercase tracking-wider text-[var(--text-muted)]">
                      {t('fleet.systemdUnits', 'Services')}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {snapshot.systemdUnits.map((u) => (
                      <div key={u.unit} className="flex items-center gap-2 type-caption">
                        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', SYSTEMD_STATE_DOT[u.state])} />
                        <span className="text-[var(--text-primary)] truncate max-w-[12rem]">{u.unit}</span>
                        <span className="text-[var(--text-muted)] ml-auto">{u.state}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function InfraMonitor() {
  const { t } = useTranslation();
  const hosts = useInfraStore((s) => s.hosts);
  const hydrate = useInfraStore((s) => s.hydrate);
  const addHost = useInfraStore((s) => s.addHost);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const handleAddHost = useCallback(() => {
    const hostId = window.prompt(t('fleet.hostIdPrompt', 'Host id (e.g. vps-ovh, gateway-01):'));
    if (!hostId) return;
    const label = window.prompt(t('fleet.hostLabelPrompt', 'Display label:'), hostId) ?? hostId;
    addHost({ hostId, label });
  }, [addHost, t]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="type-caption uppercase tracking-wider text-[var(--text-muted)]">
          {t('fleet.infraMonitor', 'Infrastructure')}
        </span>
        <Button size="icon-sm" variant="ghost" onClick={handleAddHost} aria-label={t('fleet.addHost', 'Add host')}>
          <Plus size={14} />
        </Button>
      </div>
      {hosts.length === 0 ? (
        <div className="type-caption text-[var(--text-muted)] px-1 py-2">
          {t('fleet.noHosts', 'No hosts monitored yet.')}
        </div>
      ) : (
        hosts.map((h) => <HostSection key={h.hostId} hostId={h.hostId} label={h.label} />)
      )}
    </div>
  );
}
