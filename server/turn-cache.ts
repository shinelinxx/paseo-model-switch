import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export interface CachedTimelineEntry {
  item: AgentTimelineItem;
  timestamp: string;
  seqStart: number;
}

interface AgentTimelineCacheRecord {
  epoch: string;
  startCursor: { epoch: string; seq: number } | null;
  endCursor: { epoch: string; seq: number } | null;
  hasOlder: boolean;
  entriesBySeq: Map<number, CachedTimelineEntry>;
  updatedAt: number;
}

const MAX_CACHED_AGENTS = 24;
const MAX_DELTA_PAGES = 10;
const MAX_ENTRIES_PER_AGENT = 960;

export class IncrementalTimelineCache {
  private readonly cache = new Map<string, AgentTimelineCacheRecord>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  attachHooks(server: PluginServerContext): () => void {
    const unsubTurn = server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
      if (agent.background) return;
      try {
        await this.withAgentLock(agent.id, () => this.syncLatestLocked(paseo, agent.id));
      } catch {
        // Non-fatal background warmup
      }
    });

    const unsubArchive = server.addHook("agent.archive.after", async ({ agent }) => {
      this.cache.delete(agent.id);
    });

    const unsubClose = server.addHook("agent.close.after", async ({ agent }) => {
      this.cache.delete(agent.id);
    });

    return () => {
      unsubTurn();
      unsubArchive();
      unsubClose();
      this.cache.clear();
      this.inFlight.clear();
    };
  }

  private withAgentLock<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(agentId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.inFlight.set(agentId, next);
    void next.finally(() => {
      if (this.inFlight.get(agentId) === next) {
        this.inFlight.delete(agentId);
      }
    });
    return next;
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= MAX_CACHED_AGENTS) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of this.cache.entries()) {
      if (v.updatedAt < oldestTime) {
        oldestTime = v.updatedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }

  private trimEntriesIfNeeded(record: AgentTimelineCacheRecord): void {
    if (record.entriesBySeq.size <= MAX_ENTRIES_PER_AGENT) return;
    const sortedSeqs = Array.from(record.entriesBySeq.keys()).sort((a, b) => a - b);
    const removeCount = sortedSeqs.length - MAX_ENTRIES_PER_AGENT;
    for (let i = 0; i < removeCount; i++) {
      record.entriesBySeq.delete(sortedSeqs[i]);
    }
    const newOldestSeq = sortedSeqs[removeCount];
    if (newOldestSeq !== undefined) {
      record.startCursor = { epoch: record.epoch, seq: newOldestSeq };
      record.hasOlder = true;
    }
  }

  private async catchUpDeltaLocked(
    paseo: PaseoApi,
    agentId: string,
    record: AgentTimelineCacheRecord,
  ): Promise<boolean> {
    const handle = paseo.agents.ref(agentId);
    let cursor = record.endCursor;
    let pages = 0;

    while (cursor && pages < MAX_DELTA_PAGES) {
      const delta = await handle.timeline.refetch({
        direction: "after",
        cursor,
        limit: 120,
        projection: "projected",
      });
      if (delta.reset || delta.staleCursor || delta.epoch !== record.epoch) {
        this.cache.delete(agentId);
        return false;
      }
      for (const entry of delta.entries) {
        record.entriesBySeq.set(entry.seqStart, {
          item: entry.item,
          timestamp: entry.timestamp,
          seqStart: entry.seqStart,
        });
      }
      if (!record.startCursor && delta.startCursor) {
        record.startCursor = delta.startCursor;
      }
      if (delta.endCursor) {
        record.endCursor = delta.endCursor;
      }
      record.updatedAt = Date.now();
      pages += 1;

      if (!delta.hasNewer || !delta.endCursor || delta.entries.length === 0) {
        this.trimEntriesIfNeeded(record);
        return true;
      }
      if (delta.endCursor.seq === cursor.seq) {
        this.trimEntriesIfNeeded(record);
        return true;
      }
      cursor = delta.endCursor;
    }

    // If still hasNewer after MAX_DELTA_PAGES, invalidate so full fetch rebuilds cleanly
    this.cache.delete(agentId);
    return false;
  }

  private async syncLatestLocked(paseo: PaseoApi, agentId: string): Promise<void> {
    const existing = this.cache.get(agentId);
    if (existing?.endCursor) {
      await this.catchUpDeltaLocked(paseo, agentId, existing);
      return;
    }

    const handle = paseo.agents.ref(agentId);
    const page = await handle.timeline.refetch({
      direction: "tail",
      limit: 120,
      wholeTurns: true,
      projection: "projected",
    });
    const entriesBySeq = new Map<number, CachedTimelineEntry>();
    for (const entry of page.entries) {
      entriesBySeq.set(entry.seqStart, {
        item: entry.item,
        timestamp: entry.timestamp,
        seqStart: entry.seqStart,
      });
    }
    const record: AgentTimelineCacheRecord = {
      epoch: page.epoch,
      startCursor: page.startCursor ?? null,
      endCursor: page.endCursor ?? null,
      hasOlder: Boolean(page.hasOlder),
      entriesBySeq,
      updatedAt: Date.now(),
    };
    this.trimEntriesIfNeeded(record);
    this.cache.set(agentId, record);
    this.evictIfNeeded();
  }

  async syncLatest(paseo: PaseoApi, agentId: string): Promise<void> {
    return this.withAgentLock(agentId, () => this.syncLatestLocked(paseo, agentId));
  }

  async fetchFullTimeline(
    paseo: PaseoApi,
    agentId: string,
    maxPages = 8,
  ): Promise<CachedTimelineEntry[]> {
    return this.withAgentLock(agentId, async () => {
      const existing = this.cache.get(agentId);
      if (existing?.endCursor) {
        try {
          let ok = await this.catchUpDeltaLocked(paseo, agentId, existing);
          if (ok && existing.hasOlder && existing.startCursor) {
            const handle = paseo.agents.ref(agentId);
            let backfillPages = 0;
            while (existing.hasOlder && existing.startCursor && backfillPages < maxPages) {
              const beforePage = await handle.timeline.refetch({
                direction: "before",
                cursor: existing.startCursor,
                limit: 120,
                wholeTurns: true,
                projection: "projected",
              });
              if (
                beforePage.reset ||
                beforePage.staleCursor ||
                beforePage.epoch !== existing.epoch
              ) {
                this.cache.delete(agentId);
                ok = false;
                break;
              }
              if (beforePage.entries.length === 0) {
                existing.hasOlder = false;
                break;
              }
              for (const entry of beforePage.entries) {
                if (!existing.entriesBySeq.has(entry.seqStart)) {
                  existing.entriesBySeq.set(entry.seqStart, {
                    item: entry.item,
                    timestamp: entry.timestamp,
                    seqStart: entry.seqStart,
                  });
                }
              }
              const prevSeq = existing.startCursor.seq;
              existing.startCursor = beforePage.startCursor ?? existing.startCursor;
              existing.hasOlder = Boolean(beforePage.hasOlder);
              existing.updatedAt = Date.now();
              backfillPages += 1;
              if (existing.startCursor && existing.startCursor.seq === prevSeq) {
                break;
              }
            }
          }
          if (ok) {
            const result = Array.from(existing.entriesBySeq.values()).sort(
              (a, b) => a.seqStart - b.seqStart,
            );
            this.trimEntriesIfNeeded(existing);
            return result;
          }
        } catch {
          this.cache.delete(agentId);
        }
      }

      const handle = paseo.agents.ref(agentId);
      const entriesBySeq = new Map<number, CachedTimelineEntry>();
      let page = await handle.timeline.refetch({
        direction: "tail",
        limit: 120,
        wholeTurns: true,
        projection: "projected",
      });

      const epoch = page.epoch;
      const endCursor = page.endCursor ?? null;
      let startCursor = page.startCursor ?? null;
      let hasOlder = Boolean(page.hasOlder);

      const pushEntries = (entries: typeof page.entries) => {
        for (const entry of entries) {
          if (!entriesBySeq.has(entry.seqStart)) {
            entriesBySeq.set(entry.seqStart, {
              item: entry.item,
              timestamp: entry.timestamp,
              seqStart: entry.seqStart,
            });
          }
        }
      };

      pushEntries(page.entries);

      let pageCount = 1;
      while (hasOlder && startCursor && pageCount < maxPages) {
        page = await handle.timeline.refetch({
          direction: "before",
          cursor: startCursor,
          limit: 120,
          wholeTurns: true,
          projection: "projected",
        });
        if (page.entries.length === 0) {
          hasOlder = false;
          break;
        }
        pushEntries(page.entries);
        const prevSeq = startCursor.seq;
        startCursor = page.startCursor ?? startCursor;
        hasOlder = Boolean(page.hasOlder);
        pageCount += 1;
        if (startCursor && startCursor.seq === prevSeq) {
          break;
        }
      }

      const result = Array.from(entriesBySeq.values()).sort((a, b) => a.seqStart - b.seqStart);
      const record: AgentTimelineCacheRecord = {
        epoch,
        startCursor,
        endCursor,
        hasOlder,
        entriesBySeq,
        updatedAt: Date.now(),
      };
      this.trimEntriesIfNeeded(record);
      this.cache.set(agentId, record);
      this.evictIfNeeded();

      return result;
    });
  }
}
