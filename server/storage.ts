import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LineageHop, ModelRef, SwitchBannerData } from "../shared/contracts";

export interface StoredHopEntry extends LineageHop {
  transcriptPath: string;
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
  gitBranch: string | null;
  transcriptPath: string;
  systemPromptBriefing: string;
  handoffNote?: string;
  priorTranscriptPaths: string[];
  hops: StoredHopEntry[];
  ancestorSummary?: string;
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

// In-process serial write queue per data root to eliminate preferences read-modify-write races
const preferenceWriteQueues = new Map<string, Promise<unknown>>();

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
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
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

export async function saveSwitchArtifacts(
  input: {
    record: Omit<PersistedSwitchRecord, "transcriptPath" | "hops"> & {
      priorHops: StoredHopEntry[];
    };
    transcriptMarkdown: string;
  },
  root?: string,
): Promise<PersistedSwitchRecord> {
  assertValidSwitchId(input.record.switchId);
  await Promise.all([
    fs.mkdir(recordsDir(root), { recursive: true }),
    fs.mkdir(transcriptsDir(root), { recursive: true }),
  ]);

  const transcriptPath = path.join(transcriptsDir(root), `${input.record.switchId}.md`);
  const currentHop: StoredHopEntry = {
    switchId: input.record.switchId,
    hop: input.record.hopCount,
    fromProvider: input.record.fromProvider,
    fromModel: input.record.fromModel,
    fromThinkingOptionId: input.record.fromThinkingOptionId ?? null,
    toProvider: input.record.toProvider,
    toModel: input.record.toModel,
    createdAt: input.record.createdAt,
    turnsInSegment: input.record.totalTurns,
    transcriptPath,
  };

  const { priorHops, ...rest } = input.record;
  const hops = [...priorHops, currentHop];

  const fullRecord: PersistedSwitchRecord = {
    ...rest,
    transcriptPath,
    hops,
    bannerData: rest.bannerData
      ? {
          ...rest.bannerData,
          transcriptPath,
          lineage: hops.map(({ transcriptPath: _tp, ...pub }) => pub),
        }
      : undefined,
  };

  const recordPath = path.join(recordsDir(root), `${input.record.switchId}.json`);
  await Promise.all([
    writeFileAtomic(transcriptPath, input.transcriptMarkdown),
    writeFileAtomic(recordPath, JSON.stringify(fullRecord, null, 2)),
  ]);

  // Fire-and-forget lightweight GC so disk usage stays bounded
  void pruneOldSwitchArtifacts(DEFAULT_MAX_RETAINED_RECORDS, root).catch(() => undefined);

  return fullRecord;
}

export async function pruneOldSwitchArtifacts(
  maxRetained = DEFAULT_MAX_RETAINED_RECORDS,
  root?: string,
): Promise<{ deletedRecords: number; deletedTranscripts: number }> {
  const rDir = recordsDir(root);
  const tDir = transcriptsDir(root);
  let recordFiles: string[];
  try {
    recordFiles = (await fs.readdir(rDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { deletedRecords: 0, deletedTranscripts: 0 };
  }

  if (recordFiles.length <= maxRetained) {
    return { deletedRecords: 0, deletedTranscripts: 0 };
  }

  const withMtime = await Promise.all(
    recordFiles.map(async (file) => {
      const fullPath = path.join(rDir, file);
      try {
        const st = await fs.stat(fullPath);
        return { file, fullPath, mtimeMs: st.mtimeMs };
      } catch {
        return { file, fullPath, mtimeMs: 0 };
      }
    }),
  );

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = withMtime.slice(0, maxRetained);
  const drop = withMtime.slice(maxRetained);

  // Protect all transcripts referenced by kept records (including multi-hop ancestors)
  const protectedTranscripts = new Set<string>();
  for (const entry of keep) {
    try {
      const raw = await fs.readFile(entry.fullPath, "utf8");
      const rec = JSON.parse(raw) as Partial<PersistedSwitchRecord>;
      if (rec.transcriptPath) protectedTranscripts.add(path.resolve(rec.transcriptPath));
      if (Array.isArray(rec.priorTranscriptPaths)) {
        for (const p of rec.priorTranscriptPaths) protectedTranscripts.add(path.resolve(p));
      }
      if (Array.isArray(rec.hops)) {
        for (const h of rec.hops) {
          if (h.transcriptPath) protectedTranscripts.add(path.resolve(h.transcriptPath));
        }
      }
    } catch {
      // Ignore corrupt record
    }
  }

  let deletedRecords = 0;
  for (const entry of drop) {
    try {
      await fs.unlink(entry.fullPath);
      deletedRecords += 1;
    } catch {
      // Ignore already-removed file
    }
  }

  let deletedTranscripts = 0;
  try {
    const transcriptFiles = (await fs.readdir(tDir)).filter((f) => f.endsWith(".md"));
    for (const file of transcriptFiles) {
      const fullPath = path.resolve(path.join(tDir, file));
      if (!protectedTranscripts.has(fullPath)) {
        try {
          await fs.unlink(fullPath);
          deletedTranscripts += 1;
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore missing dir
  }

  return { deletedRecords, deletedTranscripts };
}

export async function loadSwitchRecord(
  switchId: string,
  root?: string,
): Promise<PersistedSwitchRecord | null> {
  if (!VALID_SWITCH_ID.test(switchId)) return null;
  const recordPath = path.join(recordsDir(root), `${switchId}.json`);
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
    const matchedIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 6); j++) {
          matchedIndices.add(j);
        }
      }
    }
    if (matchedIndices.size === 0) {
      return {
        text: `No matches found for "${options.query}" in transcript (${totalChars} chars).`,
        totalChars,
        truncated: false,
      };
    }
    const sorted = Array.from(matchedIndices).sort((a, b) => a - b);
    const out: string[] = [];
    let prev = -2;
    let chars = 0;
    let truncated = false;
    for (const idx of sorted) {
      if (idx > prev + 1 && out.length > 0) out.push("...");
      const line = `[L${idx + 1}] ${lines[idx]}`;
      if (chars + line.length + 1 > limit) {
        truncated = true;
        break;
      }
      out.push(line);
      chars += line.length + 1;
      prev = idx;
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
    const sections: string[] = [];
    let remaining = limit;
    for (let i = hops.length - 1; i >= 0 && remaining > 400; i--) {
      const h = hops[i];
      try {
        const res = await readTranscriptSlice(h.transcriptPath, {
          query: options.query,
          limit: Math.min(remaining, Math.floor(limit / Math.max(1, hops.length)) + 1500),
        });
        if (!res.text.startsWith("No matches found")) {
          const block = `### Hop #${h.hop}: ${h.fromProvider}/${h.fromModel} (${h.turnsInSegment} turns)\n${res.text}`;
          sections.push(block);
          remaining -= block.length + 2;
        }
      } catch {
        // Ignore missing historical transcript
      }
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
      : hops[hops.length - 1];

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
  try {
    const raw = await fs.readFile(preferencesPath(root), "utf8");
    const parsed = JSON.parse(raw) as Partial<UserModelPreferences>;
    return {
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, MAX_RECENT_MODELS) : [],
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.slice(0, MAX_PINNED_MODELS) : [],
    };
  } catch {
    return { recent: [], pinned: [] };
  }
}

async function savePreferencesAtomic(prefs: UserModelPreferences, root?: string): Promise<void> {
  await fs.mkdir(getDataRoot(root), { recursive: true });
  await writeFileAtomic(preferencesPath(root), JSON.stringify(prefs, null, 2));
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
    await savePreferencesAtomic({ ...prefs, recent: next }, root);
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

    await savePreferencesAtomic({ ...prefs, pinned: next }, root);
    return { pinned: !exists, items: next };
  });
}
