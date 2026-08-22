/**
 * InfraMonitorPort — observability for the boxes ClawWork's agents actually
 * run on: Docker containers, Tailscale network status, VPS resource usage,
 * systemd unit health. Nothing in ClawWork does this today; this is a wholly
 * new capability.
 *
 * Design intent: the collector implementation lives in
 * packages/desktop/src/main/ (Electron main already owns OS integration —
 * natural home for shelling out to `docker`, `tailscale status`, systemd
 * queries, etc.) and polls on a short server-side interval, pushing diffs to
 * the renderer over the existing IPC/event bridge. The renderer/PWA never
 * polls directly — this port is intentionally read-only + event-driven from
 * the UI's perspective, matching the "one socket, no polling" performance
 * goal from the Super Dashboard plan.
 *
 * Implementation patterns to borrow (see docs/SUPER_DASHBOARD_PLAN.md and
 * cobalt-fleet's dashboard-references for source):
 * - Docker: DockerContainerManager pattern (agent-zero, cobalt-mcp composite 7.8)
 * - Health checks: ServerCheckJob/ServerStatusJob pattern (coolify)
 * - Tailscale: tailscale-client pattern (pocketdev, Go — reference only, this is TS)
 */

export type ContainerState = 'running' | 'exited' | 'restarting' | 'paused' | 'dead' | 'unknown';

export interface ContainerStatus {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  /** ISO timestamp the container entered its current state. */
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
  /** True if this peer is the machine ClawWork itself is running on. */
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

export interface InfraMonitorPort {
  /** Register a host to monitor. `hostId` matches the id used in InfraSnapshot. */
  registerHost: (params: { hostId: string; label: string; systemdUnits?: string[] }) => Promise<{ ok: boolean; error?: string }>;
  unregisterHost: (hostId: string) => Promise<void>;

  /** One-shot fetch — used for initial render / manual refresh. */
  getSnapshot: (hostId: string) => Promise<InfraSnapshot | null>;
  listHosts: () => Promise<Array<{ hostId: string; label: string }>>;

  /** Live diffs, pushed server-side on a fixed interval (target: 2-5s). */
  onSnapshot: (callback: (snapshot: InfraSnapshot) => void) => () => void;
}
