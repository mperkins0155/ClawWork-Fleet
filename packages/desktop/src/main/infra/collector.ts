/**
 * Infra Collector — Electron-main-side implementation of InfraMonitorPort.
 *
 * Polls docker, tailscale, and systemd on a fixed server-side interval and
 * pushes snapshots to the renderer over IPC. The renderer/PWA never polls
 * directly — this matches the "one socket, no polling" performance goal
 * from docs/SUPER_DASHBOARD_PLAN.md (cobalt-fleet repo).
 *
 * Implementation notes:
 * - Uses `execFile` (not `exec`) throughout — no shell interpolation, so
 *   there's no injection surface even though inputs here are all
 *   operator-controlled (host config), not user/agent-controlled.
 * - `docker` and `tailscale` CLIs are optional; a missing binary degrades
 *   that section to an empty array rather than failing the whole snapshot.
 * - systemd unit health uses `systemctl show` per configured unit (not
 *   `systemctl list-units`) so we only ever query units this specific
 *   ClawWork install was told to care about — avoids leaking full host
 *   process list to the renderer.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, loadavg, totalmem, freemem, uptime, cpus } from 'node:os';
import { statfs } from 'node:fs/promises';
import type {
  ContainerStatus,
  ContainerState,
  TailscaleStatus,
  TailscalePeer,
  VpsResourceSnapshot,
  SystemdUnitStatus,
  SystemdUnitState,
  InfraSnapshot,
} from '@clawwork/core';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 5000;

interface MonitoredHost {
  hostId: string;
  label: string;
  systemdUnits: string[];
}

const hosts = new Map<string, MonitoredHost>();
const listeners = new Set<(snapshot: InfraSnapshot) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 4000;

function emit(snapshot: InfraSnapshot): void {
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch (err) {
      console.warn('[infra-collector] listener error', err);
    }
  }
}

async function safeExec(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // ENOENT (binary not installed) and non-zero exit are both expected in
    // some environments; log at debug level only.
    console.debug(`[infra-collector] ${cmd} ${args.join(' ')} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function mapDockerState(state: string): ContainerState {
  const s = state.toLowerCase();
  if (s.includes('running')) return 'running';
  if (s.includes('restart')) return 'restarting';
  if (s.includes('pause')) return 'paused';
  if (s.includes('exited')) return 'exited';
  if (s.includes('dead')) return 'dead';
  return 'unknown';
}

async function collectContainers(): Promise<ContainerStatus[]> {
  // docker ps --format '{{json .}}' emits one JSON object per line.
  const stdout = await safeExec('docker', ['ps', '-a', '--format', '{{json .}}']);
  if (!stdout) return [];

  const containers: ContainerStatus[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as {
        ID: string;
        Names: string;
        Image: string;
        State: string;
        Status: string;
        Ports: string;
        CreatedAt: string;
      };
      const ports: ContainerStatus['ports'] = [];
      for (const portSpec of (row.Ports ?? '').split(',')) {
        const m = portSpec.trim().match(/(?:[\d.]+:)?(\d+)->(\d+)\/(tcp|udp)/);
        if (m) {
          ports.push({ hostPort: Number(m[1]), containerPort: Number(m[2]), protocol: m[3] as 'tcp' | 'udp' });
        }
      }
      containers.push({
        id: row.ID,
        name: row.Names,
        image: row.Image,
        state: mapDockerState(row.State),
        since: row.CreatedAt || new Date().toISOString(),
        ports,
      });
    } catch (err) {
      console.debug('[infra-collector] failed to parse docker ps line:', err);
    }
  }

  // Best-effort resource stats — separate call since `docker ps` doesn't carry them.
  const statsOut = await safeExec('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{json .}}',
  ]);
  if (statsOut) {
    const byId = new Map<string, { cpu?: number; memUsed?: number; memLimit?: number }>();
    for (const line of statsOut.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { Container: string; CPUPerc: string; MemUsage: string };
        const cpu = parseFloat(row.CPUPerc.replace('%', ''));
        const memMatch = row.MemUsage.match(/([\d.]+)([A-Za-z]+)\s*\/\s*([\d.]+)([A-Za-z]+)/);
        const toBytes = (val: string, unit: string): number => {
          const n = parseFloat(val);
          const u = unit.toLowerCase();
          if (u.startsWith('gi') || u === 'gb') return n * 1024 ** 3;
          if (u.startsWith('mi') || u === 'mb') return n * 1024 ** 2;
          if (u.startsWith('ki') || u === 'kb') return n * 1024;
          return n;
        };
        byId.set(row.Container, {
          cpu: Number.isFinite(cpu) ? cpu : undefined,
          memUsed: memMatch ? toBytes(memMatch[1], memMatch[2]) : undefined,
          memLimit: memMatch ? toBytes(memMatch[3], memMatch[4]) : undefined,
        });
      } catch (err) {
        console.debug('[infra-collector] failed to parse docker stats line:', err);
      }
    }
    for (const c of containers) {
      const stats = byId.get(c.id) ?? byId.get(c.name);
      if (stats) {
        c.cpuPercent = stats.cpu;
        c.memUsageBytes = stats.memUsed;
        c.memLimitBytes = stats.memLimit;
      }
    }
  }

  return containers;
}

async function collectTailscale(): Promise<TailscaleStatus | undefined> {
  const stdout = await safeExec('tailscale', ['status', '--json']);
  if (!stdout) return undefined;
  try {
    const data = JSON.parse(stdout) as {
      Self?: { HostName?: string; TailscaleIPs?: string[]; Online?: boolean; OS?: string };
      Peer?: Record<string, { HostName?: string; TailscaleIPs?: string[]; Online?: boolean; OS?: string; LastSeen?: string }>;
      MagicDNSSuffix?: string;
      BackendState?: string;
    };
    const peers: TailscalePeer[] = [];
    if (data.Self) {
      peers.push({
        hostname: data.Self.HostName ?? 'self',
        tailscaleIp: data.Self.TailscaleIPs?.[0] ?? '',
        online: data.Self.Online ?? true,
        os: data.Self.OS,
        isSelf: true,
      });
    }
    for (const peer of Object.values(data.Peer ?? {})) {
      peers.push({
        hostname: peer.HostName ?? 'unknown',
        tailscaleIp: peer.TailscaleIPs?.[0] ?? '',
        online: peer.Online ?? false,
        os: peer.OS,
        lastSeen: peer.LastSeen,
        isSelf: false,
      });
    }
    return {
      connected: data.BackendState === 'Running',
      tailnet: data.MagicDNSSuffix,
      selfHostname: data.Self?.HostName,
      peers,
    };
  } catch (err) {
    console.debug('[infra-collector] failed to parse tailscale status:', err);
    return undefined;
  }
}

async function collectResources(hostId: string, label: string): Promise<VpsResourceSnapshot | undefined> {
  try {
    const memTotal = totalmem();
    const memFree = freemem();
    let diskUsed = 0;
    let diskTotal = 0;
    try {
      const fsStats = await statfs('/');
      diskTotal = fsStats.blocks * fsStats.bsize;
      diskUsed = diskTotal - fsStats.bfree * fsStats.bsize;
    } catch (err) {
      console.debug('[infra-collector] statfs failed:', err);
    }

    // CPU percent isn't directly available from node:os; approximate via
    // load average relative to core count (good enough for a dashboard
    // gauge, not a precision instrument).
    const cores = cpus().length || 1;
    const cpuPercent = Math.min(100, (loadavg()[0] / cores) * 100);

    return {
      hostId,
      hostname: label,
      cpuPercent,
      memUsedBytes: memTotal - memFree,
      memTotalBytes: memTotal,
      diskUsedBytes: diskUsed,
      diskTotalBytes: diskTotal,
      loadAvg1m: loadavg()[0],
      uptimeSeconds: uptime(),
      capturedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.debug('[infra-collector] collectResources failed:', err);
    return undefined;
  }
}

function mapSystemdState(activeState: string): SystemdUnitState {
  switch (activeState) {
    case 'active':
      return 'active';
    case 'inactive':
      return 'inactive';
    case 'failed':
      return 'failed';
    case 'activating':
      return 'activating';
    case 'deactivating':
      return 'deactivating';
    default:
      return 'unknown';
  }
}

async function collectSystemdUnits(units: string[]): Promise<SystemdUnitStatus[]> {
  if (platform() !== 'linux' || units.length === 0) return [];
  const results: SystemdUnitStatus[] = [];
  for (const unit of units) {
    const stdout = await safeExec('systemctl', [
      'show',
      unit,
      '--no-page',
      '--property=Description,ActiveState,SubState,ActiveEnterTimestamp',
    ]);
    if (!stdout) continue;
    const fields: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      fields[line.slice(0, idx)] = line.slice(idx + 1);
    }
    results.push({
      unit,
      description: fields.Description,
      state: mapSystemdState(fields.ActiveState ?? 'unknown'),
      subState: fields.SubState,
      activeSince: fields.ActiveEnterTimestamp || undefined,
    });
  }
  return results;
}

async function collectSnapshot(host: MonitoredHost): Promise<InfraSnapshot> {
  const [containers, tailscale, resources, systemdUnits] = await Promise.all([
    collectContainers(),
    collectTailscale(),
    collectResources(host.hostId, host.label),
    collectSystemdUnits(host.systemdUnits),
  ]);
  return {
    hostId: host.hostId,
    capturedAt: new Date().toISOString(),
    containers,
    tailscale,
    resources,
    systemdUnits,
  };
}

async function pollAll(): Promise<void> {
  for (const host of hosts.values()) {
    try {
      const snapshot = await collectSnapshot(host);
      emit(snapshot);
    } catch (err) {
      console.warn(`[infra-collector] poll failed for host ${host.hostId}:`, err);
    }
  }
}

export function registerHost(hostId: string, label: string, systemdUnits: string[] = []): void {
  hosts.set(hostId, { hostId, label, systemdUnits });
  if (!pollTimer) {
    pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  }
  // Fire once immediately so the UI isn't stuck empty for a full interval.
  collectSnapshot({ hostId, label, systemdUnits })
    .then(emit)
    .catch((err) => console.warn(`[infra-collector] initial snapshot failed for ${hostId}:`, err));
}

export function unregisterHost(hostId: string): void {
  hosts.delete(hostId);
  if (hosts.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function listMonitoredHosts(): Array<{ hostId: string; label: string }> {
  return Array.from(hosts.values()).map((h) => ({ hostId: h.hostId, label: h.label }));
}

export async function getSnapshotOnce(hostId: string): Promise<InfraSnapshot | null> {
  const host = hosts.get(hostId);
  if (!host) return null;
  return collectSnapshot(host);
}

export function onSnapshot(callback: (snapshot: InfraSnapshot) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function shutdownCollector(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  hosts.clear();
  listeners.clear();
}
