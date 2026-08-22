/**
 * Fleet IPC handlers — Electron main-process side of the Fleet Room + Infra
 * Monitor extension. Mirrors the existing handler patterns in
 * data-handlers.ts / hub-handlers.ts / ws-handlers.ts.
 *
 * See docs/SUPER_DASHBOARD_PLAN.md (cobalt-fleet repo) for design rationale.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { desc, eq } from 'drizzle-orm';
import { getDb, isDbReady } from '../db/index.js';
import { fleetMessages, fleetRuntimes, infraHosts } from '../db/schema.js';
import { createAgentNetAdapter } from '@clawwork/core';
import type { RuntimeAdapterPort, FleetMessage } from '@clawwork/core';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// Live adapter registry — created lazily per configured runtime, connected on demand.
const activeAdapters = new Map<string, RuntimeAdapterPort>();

function buildAdapter(row: {
  runtimeId: string;
  kind: string;
  label: string;
  baseUrl: string;
  apiKeyEncrypted: string | null;
}): RuntimeAdapterPort | null {
  switch (row.kind) {
    case 'agentnet':
      // NOTE: api key storage should move to Electron's safeStorage before
      // production use; plaintext column is a placeholder for scaffolding.
      return createAgentNetAdapter({
        runtimeId: row.runtimeId,
        label: row.label,
        baseUrl: row.baseUrl,
        apiKey: row.apiKeyEncrypted ?? '',
      });
    // TODO: 'swarmclaw' | 'tinyagi' | 'hermes' adapters — Phase 3.
    default:
      console.warn(`[fleet-handlers] unknown runtime kind "${row.kind}", skipping`);
      return null;
  }
}

export function registerFleetHandlers(): void {
  ipcMain.handle('fleet:runtimes-list', () => {
    if (!isDbReady()) return { ok: true, result: [] };
    try {
      const rows = getDb().select().from(fleetRuntimes).all();
      return { ok: true, result: rows };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'fleet:runtime-add',
    async (
      _event,
      params: { runtimeId: string; kind: string; label: string; baseUrl: string; apiKey?: string },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.insert(fleetRuntimes)
          .values({
            runtimeId: params.runtimeId,
            kind: params.kind,
            label: params.label,
            baseUrl: params.baseUrl,
            apiKeyEncrypted: params.apiKey ?? '',
            enabled: true,
            createdAt: new Date().toISOString(),
          })
          .run();

        const adapter = buildAdapter({
          runtimeId: params.runtimeId,
          kind: params.kind,
          label: params.label,
          baseUrl: params.baseUrl,
          apiKeyEncrypted: params.apiKey ?? '',
        });
        if (adapter) {
          const result = await adapter.connect();
          if (result.ok) {
            activeAdapters.set(params.runtimeId, adapter);
            adapter.onEvent((event) => {
              broadcastToRenderer('fleet:event', event);
            });
          }
        }
        return { ok: true };
      } catch (err) {
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('fleet:runtime-remove', async (_event, params: { runtimeId: string }) => {
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const adapter = activeAdapters.get(params.runtimeId);
      if (adapter) {
        await adapter.disconnect();
        activeAdapters.delete(params.runtimeId);
      }
      getDb().delete(fleetRuntimes).where(eq(fleetRuntimes.runtimeId, params.runtimeId)).run();
      return { ok: true };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle('fleet:agents-list', async () => {
    const results: unknown[] = [];
    for (const adapter of activeAdapters.values()) {
      try {
        const agents = await adapter.listAgents();
        results.push(
          ...agents.map((a) => ({
            ...a,
            runtimeId: adapter.runtimeId,
            runtimeKind: adapter.kind,
            runtimeLabel: adapter.label,
          })),
        );
      } catch (err) {
        console.warn(`[fleet-handlers] listAgents(${adapter.runtimeId}) failed:`, err);
      }
    }
    return { ok: true, result: results };
  });

  ipcMain.handle(
    'fleet:send-message',
    async (_event, params: { recipient: string; body: string; channel?: string }) => {
      const isChannel = params.recipient.startsWith('channel:');
      const channel = params.channel ?? (isChannel ? params.recipient.slice('channel:'.length) : undefined);
      const targets =
        params.recipient === 'all' || isChannel
          ? Array.from(activeAdapters.values())
          : Array.from(activeAdapters.values()); // agent-id routing resolved renderer-side via fleet-room-store; main fans out to all and lets adapters no-op on unknown agent

      const now = new Date().toISOString();
      if (isDbReady()) {
        try {
          getDb()
            .insert(fleetMessages)
            .values({
              id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              runtimeId: 'user',
              sender: 'user',
              recipient: params.recipient,
              channel: channel ?? null,
              body: params.body,
              fromUser: true,
              createdAt: now,
            })
            .run();
        } catch (err) {
          console.warn('[fleet-handlers] persist user message failed:', err);
        }
      }

      const outcomes = await Promise.all(
        targets.map((adapter) =>
          adapter
            .sendMessage({ sender: 'user', recipient: params.recipient, channel, body: params.body })
            .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) })),
        ),
      );
      const anyOk = outcomes.some((o) => o.ok);
      return anyOk ? { ok: true } : { ok: false, error: 'no runtime accepted the message' };
    },
  );

  ipcMain.handle('fleet:messages-history', (_event, params: { limit?: number } = {}) => {
    if (!isDbReady()) return { ok: true, result: [] };
    try {
      const rows = getDb()
        .select()
        .from(fleetMessages)
        .orderBy(desc(fleetMessages.createdAt))
        .limit(params.limit ?? 500)
        .all();
      const result: FleetMessage[] = rows.reverse().map((r) => ({
        id: r.id,
        runtimeId: r.runtimeId,
        sender: r.sender,
        recipient: r.recipient,
        channel: r.channel ?? undefined,
        body: r.body,
        createdAt: r.createdAt,
        fromUser: r.fromUser,
      }));
      return { ok: true, result };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle('fleet:infra-hosts-list', () => {
    if (!isDbReady()) return { ok: true, result: [] };
    try {
      const rows = getDb().select().from(infraHosts).all();
      return { ok: true, result: rows };
    } catch (err) {
      return ipcError(err);
    }
  });

  // NOTE: infra snapshot polling (docker/tailscale/systemd) is Phase 2 —
  // handlers registered here for the wiring shape; actual collector
  // implementation (packages/desktop/src/main/infra/collector.ts) lands
  // in the next scaffolding pass.
  ipcMain.handle('fleet:infra-snapshot', async (_event, _params: { hostId: string }) => {
    return { ok: true, result: null };
  });
}

/** Called on app quit to cleanly tear down live adapter connections. */
export async function shutdownFleetAdapters(): Promise<void> {
  await Promise.all(Array.from(activeAdapters.values()).map((a) => a.disconnect().catch(() => undefined)));
  activeAdapters.clear();
}

/** Called on app start to reconnect any runtimes persisted from a previous session. */
export async function initFleetAdapters(): Promise<void> {
  if (!isDbReady()) return;
  try {
    const rows = getDb().select().from(fleetRuntimes).where(eq(fleetRuntimes.enabled, true)).all();
    for (const row of rows) {
      const adapter = buildAdapter(row);
      if (!adapter) continue;
      const result = await adapter.connect();
      if (result.ok) {
        activeAdapters.set(row.runtimeId, adapter);
        adapter.onEvent((event) => broadcastToRenderer('fleet:event', event));
      } else {
        console.warn(`[fleet-handlers] failed to connect runtime ${row.runtimeId}: ${result.error}`);
      }
    }
  } catch (err) {
    console.warn('[fleet-handlers] initFleetAdapters failed:', err);
  }
}
