/**
 * Infra store (renderer-side) — thin zustand wrapper over the
 * window.clawwork fleet:infra-* IPC bridge (see preload/index.ts,
 * main/ipc/fleet-handlers.ts, main/infra/collector.ts).
 *
 * See docs/SUPER_DASHBOARD_PLAN.md (cobalt-fleet repo) for design rationale.
 */

import { create } from 'zustand';

export type ContainerState = 'running' | 'exited' | 'restarting' | 'paused' | 'dead' | 'unknown';

export interface ContainerStatus {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  since: string;
  ports: Array<{ containerPort: number; hostPort?: number; protocol: 'tcp' | 'udp' }>;
  cpuPercent?: number;
  memUsageBytes?: number;
  memLimitBytes?: number;
}

export interface TailscalePeer {
  hostname: string;
  tailscaleIp: string;
  online: boolean;
  os?: string;
  lastSeen?: string;
  isSelf: boolean;
}

export interface TailscaleStatus {
  connected: boolean;
  tailnet?: string;
  selfHostname?: string;
  peers: TailscalePeer[];
}

export interface VpsResourceSnapshot {
  hostId: string;
  hostname: string;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  loadAvg1m: number;
  uptimeSeconds: number;
  capturedAt: string;
}

export type SystemdUnitState = 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'unknown';

export interface SystemdUnitStatus {
  unit: string;
  description?: string;
  state: SystemdUnitState;
  subState?: string;
  activeSince?: string;
}

export interface InfraSnapshot {
  hostId: string;
  capturedAt: string;
  containers: ContainerStatus[];
  tailscale?: TailscaleStatus;
  resources?: VpsResourceSnapshot;
  systemdUnits: SystemdUnitStatus[];
}

export interface InfraHostConfig {
  hostId: string;
  label: string;
  systemdUnitsJson: string;
}

interface InfraStoreState {
  hosts: InfraHostConfig[];
  snapshots: Record<string, InfraSnapshot>;
  loading: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  addHost: (params: { hostId: string; label: string; systemdUnits?: string[] }) => Promise<void>;
  removeHost: (hostId: string) => Promise<void>;
}

let unsubscribeSnapshot: (() => void) | null = null;

export const useInfraStore = create<InfraStoreState>((set) => ({
  hosts: [],
  snapshots: {},
  loading: false,
  error: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const hostsRes = await window.clawwork.fleetListInfraHosts();
      const hosts = hostsRes.ok ? ((hostsRes.result as unknown as InfraHostConfig[]) ?? []) : [];
      set({ hosts, loading: false });

      // Fetch an initial snapshot for every configured host so the panel
      // isn't empty while waiting for the first background push.
      await Promise.all(
        hosts.map(async (h) => {
          const snap = await window.clawwork.fleetInfraSnapshot(h.hostId);
          if (snap.ok && snap.result) {
            set((s) => ({ snapshots: { ...s.snapshots, [h.hostId]: snap.result as unknown as InfraSnapshot } }));
          }
        }),
      );

      if (!unsubscribeSnapshot) {
        unsubscribeSnapshot = window.clawwork.onFleetInfraSnapshot((snapshot) => {
          const s = snapshot as unknown as InfraSnapshot;
          set((state) => ({ snapshots: { ...state.snapshots, [s.hostId]: s } }));
        });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  addHost: async (params) => {
    const res = await window.clawwork.fleetAddInfraHost(params);
    if (res.ok) {
      set((s) => ({
        hosts: [
          ...s.hosts,
          { hostId: params.hostId, label: params.label, systemdUnitsJson: JSON.stringify(params.systemdUnits ?? []) },
        ],
      }));
    } else {
      set({ error: res.error ?? 'add host failed' });
    }
  },

  removeHost: async (hostId) => {
    const res = await window.clawwork.fleetRemoveInfraHost(hostId);
    if (res.ok) {
      set((s) => {
        const snapshots = { ...s.snapshots };
        delete snapshots[hostId];
        return { hosts: s.hosts.filter((h) => h.hostId !== hostId), snapshots };
      });
    } else {
      set({ error: res.error ?? 'remove host failed' });
    }
  },
}));
