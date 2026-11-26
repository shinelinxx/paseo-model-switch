import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LineageHop, ModelRef, SwitchBannerData } from "../shared/contracts";

export interface StoredHopEntry extends LineageHop {
  transcriptPath: string;
}

export type OutputFileOrigin =
  | "created"
  | "modified"
  | "artifact"
  | "scratch"
  | "uploaded"
  | "referenced";

export interface SessionOutputFile {
  path: string;
  origin: OutputFileOrigin;
  sizeBytes?: number;
  preview?: string;
}

export interface PersistedSwitchRecord {
  switchId: string;
  createdAt: string;
  fromAgentId: string;
  fromProvider: string;
  fromModel: string;
  fromThinkingOptionId?: string | null;
  toProvider: string;
  toModel: string;
  hopCount: number;
  totalTurns: number;
  turnsCarried: number;
  hasOmittedHistory?: boolean;
  filesTouched: string[];
  outputFiles?: SessionOutputFile[];
  gitBranch: string | null;
  transcriptPath: string;
  systemPromptBriefing: string;
  handoffNote?: string;
  priorTranscriptPaths: string[];
  hops: StoredHopEntry[];
  ancestorSummary?: string;
  initialTaskAnchor?: string;
  bannerData?: SwitchBannerData;
}

export interface UserModelPreferences {
  recent: ModelRef[];
  pinned: ModelRef[];
}

const VALID_SWITCH_ID = /^[a-zA-Z0-9_-]{4,64}$/;
const MAX_RECENT_MODELS = 8;
const MAX_PINNED_MODELS = 16;
const DEFAULT_MAX_RETAINED_RECORDS = 200;
const AUTO_PRUNE_HYSTERESIS = 20;
const MAX_RECORD_CACHE = 32;
const MAX_PREF_CACHE_ROOTS = 8;
const PRUNE_READ_CONCURRENCY = 16;

// In-process serial write queue per data root to eliminate preferences read-modify-write races
const preferenceWriteQueues = new Map<string, Promise<unknown>>();
// Bounded LRU cache for immutable PersistedSwitchRecord entries keyed by resolved record file path
const recordCache = new Map<string, PersistedSwitchRecord>();
// Bounded write-through cache for UserModelPreferences keyed by getDataRoot(root)
const preferencesCache = new Map<string, { prefs: UserModelPreferences; mtimeMs: number | null }>();
// Cache of initialized directory paths to avoid redundant fs.mkdir syscalls
const initializedDirs = new Set<string>();
// Per-root in-flight guard for pruneOldSwitchArtifacts
const pruningRoots = new Set<string>();
// Estimated record count per root to avoid unnecessary auto-prune readdir scans under hysteresis
const estimatedRecordCounts = new Map<string, number>();

function getCachedRecord(recordPath: string): PersistedSwitchRecord | undefined {
  const key = path.resolve(recordPath);
  const hit = recordCache.get(key);
  if (!hit) return undefined;
  recordCache.delete(key);
  recordCache.set(key, hit);
  return hit;
}

function setCachedRecord(recordPath: string, record: PersistedSwitchRecord): void {
  const key = path.resolve(recordPath);
  if (recordCache.has(key)) {
    recordCache.delete(key);
  }
  recordCache.set(key, record);
  if (recordCache.size > MAX_RECORD_CACHE) {
    const oldestKey = recordCache.keys().next().value;
    if (oldestKey !== undefined) recordCache.delete(oldestKey);
  }
}

function deleteCachedRecord(recordPath: string): void {
  recordCache.delete(path.resolve(recordPath));
}

function setCachedPreferences(
  rootKey: string,
  entry: { prefs: UserModelPreferences; mtimeMs: number | null },
): void {
  if (preferencesCache.has(rootKey)) {
    preferencesCache.delete(rootKey);
  }
  preferencesCache.set(rootKey, entry);
  if (preferencesCache.size > MAX_PREF_CACHE_ROOTS) {
    const oldestKey = preferencesCache.keys().next().value;
    if (oldestKey !== undefined) preferencesCache.delete(oldestKey);
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  const resolved = path.resolve(dirPath);
  if (initializedDirs.has(resolved)) return;
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  initializedDirs.add(resolved);
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        await worker(current);
      }
    }),
  );
}

function enqueuePrefWrite<T>(rootKey: string, task: () => Promise<T>): Promise<T> {
  const prev = preferenceWriteQueues.get(rootKey) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  preferenceWriteQueues.set(rootKey, next);
  void next.finally(() => {
    if (preferenceWriteQueues.get(rootKey) === next) {
      preferenceWriteQueues.delete(rootKey);
    }
  });
  return next;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    initializedDirs.delete(path.resolve(path.dirname(filePath)));
    throw error;
  }
}

export function getDataRoot(overrideRoot?: string): string {
  if (overrideRoot) return overrideRoot;
  const paseoHome = process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
  return path.join(paseoHome, "plugin-data", "model-switch");
}

function recordsDir(root?: string): string {
  return path.join(getDataRoot(root), "records");
}

function transcriptsDir(root?: string): string {
  return path.join(getDataRoot(root), "transcripts");
}

function preferencesPath(root?: string): string {
  return path.join(getDataRoot(root), "preferences.json");
}

export function generateSwitchId(): string {
  return `sw_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function assertValidSwitchId(switchId: string): void {
  if (!VALID_SWITCH_ID.test(switchId)) {
    throw new Error(`Invalid switchId: ${switchId}`);
  }
}

const MAX_BANNER_LINEAGE_HOPS = 24;
const MAX_BANNER_HANDOFF_NOTE_CHARS = 1500;

export function resolveDefaultHop(hops: readonly StoredHopEntry[]): StoredHopEntry | undefined {
  if (hops.length === 0) return undefined;
  for (let i = hops.length - 1; i >= 0; i--) {
    if (hops[i].turnsInSegment > 0) return hops[i];
  }
  return hops[hops.length - 1];
}

export async function saveSwitchArtifacts(
  input: {
    record: Omit<PersistedSwitchRecord, "transcriptPath" | "hops"> & {
      priorHops: StoredHopEntry[];
      turnsInSegment?: number;
    };
    transcriptMarkdown: string;
  },
  root?: string,
): Promise<PersistedSwitchRecord> {
  assertValidSwitchId(input.record.switchId);
  const rDir = recordsDir(root);
  const tDir = transcriptsDir(root);
  await Promise.all([ensureDir(rDir), ensureDir(tDir)]);

  const transcriptPath = path.join(tDir, `${input.record.switchId}.md`);
  const segmentTurns = input.record.turnsInSegment ?? input.record.totalTurns;
  const currentHop: StoredHopEntry = {
    switchId: input.record.switchId,
    hop: input.record.hopCount,
    fromProvider: input.record.fromProvider,
    fromModel: input.record.fromModel,
    fromThinkingOptionId: input.record.fromThinkingOptionId ?? null,
    toProvider: input.record.toProvider,
    toModel: input.record.toModel,
    createdAt: input.record.createdAt,
    turnsInSegment: segmentTurns,
    transcriptPath,
  };

  const { priorHops, turnsInSegment: _tis, ...rest } = input.record;
  const hops = [...priorHops, currentHop];
  const defaultHop = resolveDefaultHop(hops) ?? currentHop;
  const cappedLineage = hops
    .slice(-MAX_BANNER_LINEAGE_HOPS)
    .map(({ transcriptPath: _tp, ...pub }) => pub);
  const safeBannerNote =
    rest.bannerData?.handoffNote &&
    rest.bannerData.handoffNote.length > MAX_BANNER_HANDOFF_NOTE_CHARS
      ? `${rest.bannerData.handoffNote.slice(0, MAX_BANNER_HANDOFF_NOTE_CHARS - 1)}…`
      : rest.bannerData?.handoffNote;

  const fullRecord: PersistedSwitchRecord = {
    ...rest,
    transcriptPath,
    hops,
    bannerData: rest.bannerData
      ? {
          ...rest.bannerData,
          handoffNote: safeBannerNote,
          transcriptPath: defaultHop.transcriptPath,
          lineage: cappedLineage,
        }
      : undefined,
  };

  const recordPath = path.join(rDir, `${input.record.switchId}.json`);
  await Promise.all([
    writeFileAtomic(transcriptPath, input.transcriptMarkdown),
    writeFileAtomic(recordPath, JSON.stringify(fullRecord, null, 2)),
  ]);

  setCachedRecord(recordPath, fullRecord);

  // Fire-and-forget lightweight GC with hysteresis so disk usage stays bounded without per-save churn
  const rootKey = getDataRoot(root);
  const prevEstimate = estimatedRecordCounts.get(rootKey);
  if (prevEstimate !== undefined) {
    const nextEstimate = prevEstimate + 1;
    estimatedRecordCounts.set(rootKey, nextEstimate);
    if (nextEstimate > DEFAULT_MAX_RETAINED_RECORDS + AUTO_PRUNE_HYSTERESIS) {
      void pruneOldSwitchArtifactsInternal(
        DEFAULT_MAX_RETAINED_RECORDS,
        root,
        AUTO_PRUNE_HYSTERESIS,
      ).catch(() => undefined);
    }
  } else {
    void pruneOldSwitchArtifactsInternal(
      DEFAULT_MAX_RETAINED_RECORDS,
      root,
      AUTO_PRUNE_HYSTERESIS,
    ).catch(() => undefined);
  }

  return fullRecord;
}

function collectProtectedTranscripts(
  rec: Partial<PersistedSwitchRecord>,
  protectedTranscripts: Set<string>,
): void {
  if (rec.transcriptPath) protectedTranscripts.add(path.resolve(rec.transcriptPath));
  if (Array.isArray(rec.priorTranscriptPaths)) {
    for (const p of rec.priorTranscriptPaths) protectedTranscripts.add(path.resolve(p));
  }
  if (Array.isArray(rec.hops)) {
    for (const h of rec.hops) {
      if (h.transcriptPath) protectedTranscripts.add(path.resolve(h.transcriptPath));
    }
  }
}

async function pruneOldSwitchArtifactsInternal(
  maxRetained: number,
  root: string | undefined,
  hysteresis: number,
): Promise<{ deletedRecords: number; deletedTranscripts: number }> {
  const rootKey = getDataRoot(root);
  const rDir = recordsDir(root);
  const tDir = transcriptsDir(root);
  let recordFiles: string[];
  try {
    recordFiles = (await fs.readdir(rDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { deletedRecords: 0, deletedTranscripts: 0 };
  }

  estimatedRecordCounts.set(rootKey, recordFiles.length);

  if (recordFiles.length <= maxRetained + hysteresis) {
    return { deletedRecords: 0, deletedTranscripts: 0 };
  }

  if (pruningRoots.has(rootKey)) {
    return { deletedRecords: 0, deletedTranscripts: 0 };
  }

  pruningRoots.add(rootKey);
  try {
    const withMtime: Array<{ file: string; fullPath: string; mtimeMs: number }> = [];
    await runWithConcurrency(recordFiles, PRUNE_READ_CONCURRENCY, async (file) => {
      const fullPath = path.join(rDir, file);
      try {
        const st = await fs.stat(fullPath);
        withMtime.push({ file, fullPath, mtimeMs: st.mtimeMs });
      } catch {
        withMtime.push({ file, fullPath, mtimeMs: 0 });
      }
    });

    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = withMtime.slice(0, maxRetained);
    const drop = withMtime.slice(maxRetained);

    // Protect all transcripts referenced by kept records (including multi-hop ancestors)
    const protectedTranscripts = new Set<string>();
    const uncachedKeep: Array<{ file: string; fullPath: string; mtimeMs: number }> = [];
    for (const entry of keep) {
      const cached = getCachedRecord(entry.fullPath);
      if (cached) {
        collectProtectedTranscripts(cached, protectedTranscripts);
      } else {
        uncachedKeep.push(entry);
      }
    }

    await runWithConcurrency(uncachedKeep, PRUNE_READ_CONCURRENCY, async (entry) => {
      try {
        const raw = await fs.readFile(entry.fullPath, "utf8");
        const rec = JSON.parse(raw) as Partial<PersistedSwitchRecord>;
        collectProtectedTranscripts(rec, protectedTranscripts);
      } catch {
        // Ignore corrupt record
      }
    });

    let deletedRecords = 0;
    await runWithConcurrency(drop, PRUNE_READ_CONCURRENCY, async (entry) => {
      deleteCachedRecord(entry.fullPath);
      try {
        await fs.unlink(entry.fullPath);
        deletedRecords += 1;
      } catch {
        // Ignore already-removed file
      }
    });

    let deletedTranscripts = 0;
    try {
      const transcriptFiles = (await fs.readdir(tDir)).filter((f) => f.endsWith(".md"));
      const toDelete = transcriptFiles
        .map((file) => path.resolve(path.join(tDir, file)))
        .filter((fullPath) => !protectedTranscripts.has(fullPath));
      await runWithConcurrency(toDelete, PRUNE_READ_CONCURRENCY, async (fullPath) => {
        try {
          await fs.unlink(fullPath);
          deletedTranscripts += 1;
        } catch {
          // Ignore
        }
      });
    } catch {
      // Ignore missing dir
    }

    estimatedRecordCounts.set(rootKey, Math.max(0, recordFiles.length - deletedRecords));
    return { deletedRecords, deletedTranscripts };
  } finally {
    pruningRoots.delete(rootKey);
  }
}

export async function pruneOldSwitchArtifacts(
  maxRetained = DEFAULT_MAX_RETAINED_RECORDS,
  root?: string,
): Promise<{ deletedRecords: number; deletedTranscripts: number }> {
  return pruneOldSwitchArtifactsInternal(maxRetained, root, 0);
}

export async function loadSwitchRecord(
  switchId: string,
  root?: string,
): Promise<PersistedSwitchRecord | null> {
  if (!VALID_SWITCH_ID.test(switchId)) return null;
  const recordPath = path.join(recordsDir(root), `${switchId}.json`);
  const cached = getCachedRecord(recordPath);
  if (cached) return cached;
  try {
    const raw = await fs.readFile(recordPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedSwitchRecord;
    if (!Array.isArray(parsed.hops)) {
      parsed.hops = [
        {
          switchId: parsed.switchId,
          hop: parsed.hopCount ?? 1,
          fromProvider: parsed.fromProvider,
          fromModel: parsed.fromModel,
          fromThinkingOptionId: parsed.fromThinkingOptionId ?? null,
          toProvider: parsed.toProvider,
          toModel: parsed.toModel,
          createdAt: parsed.createdAt,
          turnsInSegment: parsed.totalTurns ?? 0,
          transcriptPath: parsed.transcriptPath,
        },
      ];
    }
    setCachedRecord(recordPath, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function readTranscriptSlice(
  transcriptPath: string,
  options?: { query?: string; offset?: number; limit?: number },
): Promise<{ text: string; totalChars: number; truncated: boolean }> {
  const content = await fs.readFile(transcriptPath, "utf8");
  const totalChars = content.length;
  const limit = Math.max(500, Math.min(options?.limit ?? 12000, 32000));

  if (options?.query && options.query.trim().length > 0) {
    const needle = options.query.trim().toLowerCase();
    const lines = content.split("\n");
    const out: string[] = [];
    let lastEmitted = -2;
    let chars = 0;
    let truncated = false;
    let foundAny = false;

    for (let i = 0; i < lines.length && !truncated; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      foundAny = true;
      const winStart = Math.max(0, i - 3);
      const winEnd = Math.min(lines.length - 1, i + 6);
      const start = Math.max(winStart, lastEmitted + 1);
      for (let j = start; j <= winEnd; j++) {
        const line = `[L${j + 1}] ${lines[j]}`;
        if (chars + line.length + 1 > limit) {
          truncated = true;
          break;
        }
        if (j > lastEmitted + 1 && out.length > 0) {
          out.push("...");
        }
        out.push(line);
        chars += line.length + 1;
        lastEmitted = j;
      }
    }

    if (!foundAny) {
      return {
        text: `No matches found for "${options.query}" in transcript (${totalChars} chars).`,
        totalChars,
        truncated: false,
      };
    }
    return { text: out.join("\n"), totalChars, truncated };
  }

  const offset = Math.max(0, Math.min(options?.offset ?? 0, totalChars));
  const slice = content.slice(offset, offset + limit);
  return {
    text: slice,
    totalChars,
    truncated: offset + slice.length < totalChars,
  };
}

export async function readAcrossHops(
  record: PersistedSwitchRecord,
  options: {
    action?: "read" | "search" | "list_hops";
    hop?: number | "all";
    query?: string;
    offset?: number;
    limit?: number;
  },
): Promise<{ text: string; isError?: boolean }> {
  const hops = record.hops;
  if (options.action === "list_hops") {
    const lines = hops.map(
      (h) =>
        `- Hop #${h.hop} (${h.switchId}): ${h.fromProvider}/${h.fromModel} -> ${h.toProvider}/${h.toModel} | ${h.turnsInSegment} turns | ${h.createdAt}`,
    );
    return {
      text: `Session switch chain (${hops.length} hop${hops.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
    };
  }

  const limit = Math.max(500, Math.min(options.limit ?? 12000, 32000));

  if (options.hop === "all" && options.query && options.query.trim().length > 0) {
    const perHopLimit = Math.min(limit, Math.floor(limit / Math.max(1, hops.length)) + 1500);
    const reversedHops = [...hops].reverse();
    const hopBlocks = await Promise.all(
      reversedHops.map(async (h) => {
        try {
          const res = await readTranscriptSlice(h.transcriptPath, {
            query: options.query,
            limit: perHopLimit,
          });
          if (!res.text.startsWith("No matches found")) {
            return `### Hop #${h.hop}: ${h.fromProvider}/${h.fromModel} (${h.turnsInSegment} turns)\n${res.text}`;
          }
        } catch {
          // Ignore missing historical transcript
        }
        return null;
      }),
    );

    const sections: string[] = [];
    let remaining = limit;
    for (const block of hopBlocks) {
      if (!block) continue;
      if (remaining <= 400 && sections.length > 0) break;
      if (block.length > remaining && sections.length > 0) {
        sections.push(block.slice(0, remaining));
        remaining = 0;
        break;
      }
      sections.push(block);
      remaining -= block.length + 2;
    }
    if (sections.length === 0) {
      return {
        text: `No matches found for "${options.query}" across ${hops.length} hop(s).`,
      };
    }
    return { text: sections.join("\n\n") };
  }

  const targetHop =
    typeof options.hop === "number"
      ? hops.find((h) => h.hop === options.hop)
      : resolveDefaultHop(hops);

  if (!targetHop) {
    return {
      isError: true,
      text: `Hop #${options.hop} not found. Available hops: ${hops.map((h) => h.hop).join(", ")}`,
    };
  }

  try {
    const res = await readTranscriptSlice(targetHop.transcriptPath, {
      query: options.query,
      offset: options.offset,
      limit,
    });
    const header = `[Hop #${targetHop.hop} Transcript: ${targetHop.fromProvider}/${targetHop.fromModel} | total ${res.totalChars} chars${res.truncated ? " | truncated" : ""}]\n\n`;
    return { text: `${header}${res.text}` };
  } catch (error) {
    return {
      isError: true,
      text: `Failed to read hop #${targetHop.hop} transcript: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadPreferences(root?: string): Promise<UserModelPreferences> {
  const rootKey = getDataRoot(root);
  const filePath = preferencesPath(root);
  const cached = preferencesCache.get(rootKey);
  try {
    if (cached) {
      const st = await fs.stat(filePath).catch(() => null);
      if ((st ? st.mtimeMs : null) === cached.mtimeMs) {
        setCachedPreferences(rootKey, cached);
        return {
          recent: [...cached.prefs.recent],
          pinned: [...cached.prefs.pinned],
        };
      }
    }
    const [raw, st] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath).catch(() => null),
    ]);
    const parsed = JSON.parse(raw) as Partial<UserModelPreferences>;
    const prefs: UserModelPreferences = {
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, MAX_RECENT_MODELS) : [],
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.slice(0, MAX_PINNED_MODELS) : [],
    };
    setCachedPreferences(rootKey, { prefs, mtimeMs: st ? st.mtimeMs : null });
    return {
      recent: [...prefs.recent],
      pinned: [...prefs.pinned],
    };
  } catch {
    const empty: UserModelPreferences = { recent: [], pinned: [] };
    setCachedPreferences(rootKey, { prefs: empty, mtimeMs: null });
    return { recent: [], pinned: [] };
  }
}

async function savePreferencesAtomic(
  prefs: UserModelPreferences,
  root?: string,
): Promise<number | null> {
  await ensureDir(getDataRoot(root));
  const filePath = preferencesPath(root);
  await writeFileAtomic(filePath, JSON.stringify(prefs, null, 2));
  const st = await fs.stat(filePath).catch(() => null);
  return st ? st.mtimeMs : null;
}

export function recordRecentModel(item: ModelRef, root?: string): Promise<ModelRef[]> {
  const rootKey = getDataRoot(root);
  return enqueuePrefWrite(rootKey, async () => {
    const prefs = await loadPreferences(root);
    const filtered = prefs.recent.filter(
      (entry) => !(entry.provider === item.provider && entry.model === item.model),
    );
    const next: ModelRef[] = [
      { ...item, usedAt: new Date().toISOString() },
      ...filtered,
    ].slice(0, MAX_RECENT_MODELS);
    const updated: UserModelPreferences = { ...prefs, recent: next };
    const mtimeMs = await savePreferencesAtomic(updated, root);
    setCachedPreferences(rootKey, { prefs: updated, mtimeMs });
    return next;
  });
}

export function togglePinnedModel(
  item: { provider: string; model: string; label?: string },
  root?: string,
): Promise<{ pinned: boolean; items: ModelRef[] }> {
  const rootKey = getDataRoot(root);
  return enqueuePrefWrite(rootKey, async () => {
    const prefs = await loadPreferences(root);
    const exists = prefs.pinned.some(
      (entry) => entry.provider === item.provider && entry.model === item.model,
    );
    const next: ModelRef[] = exists
      ? prefs.pinned.filter(
          (entry) => !(entry.provider === item.provider && entry.model === item.model),
        )
      : [{ ...item, usedAt: new Date().toISOString() }, ...prefs.pinned].slice(0, MAX_PINNED_MODELS);

    const updated: UserModelPreferences = { ...prefs, pinned: next };
    const mtimeMs = await savePreferencesAtomic(updated, root);
    setCachedPreferences(rootKey, { prefs: updated, mtimeMs });
    return { pinned: !exists, items: next };
  });
}
