import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  defineAgentTool,
  execCommand,
  type PluginServerContext,
  type PluginSettings,
} from "@getpaseo/plugin/server";
import type { AgentModelDefinition, AgentMode, JsonValue } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import {
  getSwitchRecordRpc,
  listCatalogRpc,
  recordRecentRpc,
  SWITCH_BANNER_KIND,
  SWITCH_FROM_AGENT_KEY,
  SWITCH_FROM_MODEL_KEY,
  SWITCH_FROM_PROVIDER_KEY,
  SWITCH_FROM_THINKING_KEY,
  SWITCH_HOP_META_KEY,
  SWITCH_META_KEY,
  switchModelRpc,
  togglePinRpc,
  type CatalogMode,
  type CatalogProvider,
  type SwitchBannerData,
} from "../shared/contracts";
import {
  DEFAULT_MODEL_SWITCH_SETTINGS,
  type ModelSwitchSettings,
  type ModelSwitchSettingsSchema,
} from "../shared/settings";
import { collectGitWorkspaceContext, compileContextFromEntries } from "./context";
import { resolveModeAndOptionsForTarget } from "./mode-map";
import {
  generateSwitchId,
  getDataRoot,
  loadPreferences,
  loadSwitchRecord,
  readAcrossHops,
  readTranscriptSlice,
  recordRecentModel,
  saveSwitchArtifacts,
  togglePinnedModel,
} from "./storage";
import type { IncrementalTimelineCache } from "./turn-cache";

async function readCurrentSettings(
  settingsHandle: PluginSettings<typeof ModelSwitchSettingsSchema>,
): Promise<ModelSwitchSettings> {
  try {
    const state = await settingsHandle.read();
    if (state.status === "ready") {
      return { ...DEFAULT_MODEL_SWITCH_SETTINGS, ...state.values };
    }
  } catch {
    // Fall back to defaults
  }
  return DEFAULT_MODEL_SWITCH_SETTINGS;
}

function extractContextWindowTokens(m: AgentModelDefinition): number | undefined {
  if (typeof m.contextWindowMaxTokens === "number" && m.contextWindowMaxTokens > 0) {
    return m.contextWindowMaxTokens;
  }
  const meta = m.metadata;
  if (meta && typeof meta === "object") {
    if (typeof meta.contextWindowMaxTokens === "number" && meta.contextWindowMaxTokens > 0) {
      return meta.contextWindowMaxTokens;
    }
    const limit = meta.limit;
    if (limit && typeof limit === "object" && "context" in limit) {
      const ctx = (limit as Record<string, unknown>).context;
      if (typeof ctx === "number" && ctx > 0) return ctx;
    }
  }
  return undefined;
}

function toCatalogModels(models: readonly AgentModelDefinition[] | undefined) {
  if (!models) return [];
  return models
    .filter((m) => m.isSelectable !== false)
    .map((m) => ({
      id: m.id,
      label: m.label || m.id,
      description: m.description,
      isDefault: m.isDefault,
      contextWindowMaxTokens: extractContextWindowTokens(m),
      defaultThinkingOptionId: m.defaultThinkingOptionId,
      thinkingOptions: m.thinkingOptions?.map((opt) => ({
        id: opt.id,
        label: opt.label,
        isDefault: opt.isDefault,
      })),
    }));
}

function toCatalogModes(modes: readonly AgentMode[] | undefined): CatalogMode[] {
  if (!modes) return [];
  return modes.map((m) => {
    const extra = m as AgentMode & { isUnattended?: boolean };
    return {
      id: m.id,
      label: m.label,
      description: m.description,
      colorTier: m.colorTier,
      isUnattended: typeof extra.isUnattended === "boolean" ? extra.isUnattended : undefined,
    };
  });
}

type ProviderSnapshot = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>;

const PROVIDER_SNAPSHOT_TTL_MS = 8_000;
const PROVIDER_SNAPSHOT_LOADING_TTL_MS = 1_000;
const MAX_PROVIDER_SNAPSHOT_CACHE = 16;

const providerSnapshotCache = new Map<string, { snapshot: ProviderSnapshot; expiresAt: number }>();
const providerSnapshotInFlight = new Map<string, Promise<ProviderSnapshot>>();

const READ_PREVIOUS_SESSION_CONTEXT_INPUT_SCHEMA = z.object({
  action: z
    .enum(["read", "search", "list_hops"])
    .optional()
    .describe("Operation mode (default: 'search' when query is given, else 'read')."),
  hop: z
    .union([z.number().int().min(1), z.literal("all")])
    .optional()
    .describe("Which switch hop to inspect (default: latest hop; 'all' searches every hop)."),
  query: z
    .string()
    .optional()
    .describe("Case-insensitive keyword to search across transcript(s)."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character offset when paging through a transcript."),
  limit: z
    .number()
    .int()
    .min(500)
    .max(32000)
    .optional()
    .describe("Maximum characters to return (default 12000)."),
});

async function getCachedProviderSnapshot(
  paseo: PaseoApi,
  cwd?: string,
): Promise<ProviderSnapshot> {
  const key = cwd ?? "";
  const now = Date.now();
  const cached = providerSnapshotCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.snapshot;
  }

  const inFlight = providerSnapshotInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const cwdOpt = cwd ? { cwd } : undefined;
  const promise = paseo.providers
    .snapshot(cwdOpt)
    .then((snapshot) => {
      const hasLoading = snapshot.entries.some(
        (entry) => entry.enabled && entry.status === "loading",
      );
      const ttl = hasLoading ? PROVIDER_SNAPSHOT_LOADING_TTL_MS : PROVIDER_SNAPSHOT_TTL_MS;
      if (providerSnapshotCache.has(key)) {
        providerSnapshotCache.delete(key);
      }
      providerSnapshotCache.set(key, { snapshot, expiresAt: Date.now() + ttl });
      if (providerSnapshotCache.size > MAX_PROVIDER_SNAPSHOT_CACHE) {
        const oldestKey = providerSnapshotCache.keys().next().value;
        if (oldestKey !== undefined) providerSnapshotCache.delete(oldestKey);
      }
      return snapshot;
    })
    .finally(() => {
      if (providerSnapshotInFlight.get(key) === promise) {
        providerSnapshotInFlight.delete(key);
      }
    });

  providerSnapshotInFlight.set(key, promise);
  return promise;
}

async function resolveTargetProvider(
  paseo: PaseoApi,
  targetProvider: string,
  cwd?: string,
): Promise<CatalogProvider | null> {
  const cwdOpt = cwd ? { cwd } : undefined;
  const snapshot = await getCachedProviderSnapshot(paseo, cwd);
  const entry = snapshot.entries.find(
    (e) =>
      e.provider === targetProvider &&
      e.enabled &&
      (e.status === "ready" || e.status === "loading"),
  );
  if (!entry) return null;

  const [rawModels, rawModes] = await Promise.all([
    (entry.models?.length ?? 0) > 0 || entry.status !== "ready"
      ? Promise.resolve(entry.models ?? [])
      : paseo.providers
          .listModels(entry.provider, cwdOpt)
          .then((r) => r.models ?? [])
          .catch(() => []),
    (entry.modes?.length ?? 0) > 0 || entry.status !== "ready"
      ? Promise.resolve(entry.modes ?? [])
      : paseo.providers
          .listModes(entry.provider, cwdOpt)
          .then((r) => r.modes ?? [])
          .catch(() => []),
  ]);

  const models = toCatalogModels(rawModels);
  if (models.length === 0) return null;

  return {
    id: entry.provider,
    label: entry.label || entry.provider,
    status: entry.status,
    defaultModeId: entry.defaultModeId ?? null,
    modes: toCatalogModes(rawModes),
    models,
  };
}

export async function handleListCatalog(
  input: RpcInput<typeof listCatalogRpc>,
  paseo: PaseoApi,
): Promise<RpcOutput<typeof listCatalogRpc>> {
  const cwdOpt = input.cwd ? { cwd: input.cwd } : undefined;
  const [snapshot, prefs] = await Promise.all([
    getCachedProviderSnapshot(paseo, input.cwd),
    loadPreferences(),
  ]);

  const eligible = snapshot.entries.filter(
    (entry) => entry.enabled && (entry.status === "ready" || entry.status === "loading"),
  );

  // Resolve any missing models/modes across providers in parallel
  const resolved = await Promise.all(
    eligible.map(async (entry): Promise<CatalogProvider | null> => {
      const [rawModels, rawModes] = await Promise.all([
        (entry.models?.length ?? 0) > 0 || entry.status !== "ready"
          ? Promise.resolve(entry.models ?? [])
          : paseo.providers
              .listModels(entry.provider, cwdOpt)
              .then((r) => r.models ?? [])
              .catch(() => []),
        (entry.modes?.length ?? 0) > 0 || entry.status !== "ready"
          ? Promise.resolve(entry.modes ?? [])
          : paseo.providers
              .listModes(entry.provider, cwdOpt)
              .then((r) => r.modes ?? [])
              .catch(() => []),
      ]);

      const models = toCatalogModels(rawModels);
      if (models.length === 0) return null;

      return {
        id: entry.provider,
        label: entry.label || entry.provider,
        status: entry.status,
        defaultModeId: entry.defaultModeId ?? null,
        modes: toCatalogModes(rawModes),
        models,
      };
    }),
  );

  const providers = resolved.filter((p): p is CatalogProvider => p !== null);
  providers.sort((a, b) => {
    if (a.status === "ready" && b.status !== "ready") return -1;
    if (a.status !== "ready" && b.status === "ready") return 1;
    return a.label.localeCompare(b.label);
  });

  return {
    providers,
    recent: prefs.recent,
    pinned: prefs.pinned,
  };
}

export async function handleTogglePin(
  input: RpcInput<typeof togglePinRpc>,
): Promise<RpcOutput<typeof togglePinRpc>> {
  return togglePinnedModel(input);
}

export async function handleRecordRecent(
  input: RpcInput<typeof recordRecentRpc>,
): Promise<RpcOutput<typeof recordRecentRpc>> {
  const items = await recordRecentModel(input);
  return { items };
}

function readStringMeta(
  metadata: Readonly<Record<string, JsonValue>> | null | undefined,
  labels: Readonly<Record<string, string>> | null | undefined,
  key: string,
): string | null {
  const fromMeta = metadata?.[key];
  if (typeof fromMeta === "string" && fromMeta.trim().length > 0) {
    return fromMeta.trim();
  }
  const fromLabel = labels?.[key];
  if (typeof fromLabel === "string" && fromLabel.trim().length > 0) {
    return fromLabel.trim();
  }
  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let cachedPaseoCliBinary: string | null = null;
let cachedPaseoCliEnv: string | undefined;

async function resolvePaseoCliBinary(): Promise<string> {
  const envCli = process.env.PASEO_CLI?.trim();
  if (cachedPaseoCliBinary && cachedPaseoCliEnv === envCli) {
    return cachedPaseoCliBinary;
  }

  const candidates: string[] = [];
  if (envCli) {
    candidates.push(envCli);
  }
  const appMarker = ".app/Contents/";
  const appIdx = process.execPath.indexOf(appMarker);
  if (appIdx > 0) {
    const contentsDir = process.execPath.slice(0, appIdx + appMarker.length);
    candidates.push(path.join(contentsDir, "Resources", "bin", "paseo"));
  }
  candidates.push("/Applications/Paseo.app/Contents/Resources/bin/paseo");
  candidates.push(path.join(os.homedir(), ".local", "bin", "paseo"));

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedPaseoCliBinary = candidate;
      cachedPaseoCliEnv = envCli;
      return candidate;
    }
  }
  cachedPaseoCliBinary = "paseo";
  cachedPaseoCliEnv = envCli;
  return "paseo";
}

async function stopRunningAgentGracefully(
  paseo: PaseoApi,
  agentId: string,
  timeoutMs = 6000,
): Promise<boolean> {
  const cliBin = await resolvePaseoCliBinary();
  try {
    await execCommand(cliBin, ["agent", "stop", agentId], { timeout: 4000 });
  } catch (error) {
    console.error(`[model-switch] ${cliBin} agent stop failed:`, error);
    return false;
  }

  const handle = paseo.agents.ref(agentId);
  try {
    const res = await handle.waitForFinish(timeoutMs);
    if (res.status !== "timeout") {
      return true;
    }
  } catch {
    // Fallback to direct snapshot check
  }

  const refreshed = await handle.refresh();
  return (refreshed?.agent.status ?? handle.status) !== "running";
}

async function detectArchiveProtectionReason(
  paseo: PaseoApi,
  sourceAgent: {
    id: string;
    cwd: string;
    labels?: Readonly<Record<string, string>>;
    backgroundWork?: { count: number };
    parentAgentId?: string | null;
  },
): Promise<string | null> {
  if (sourceAgent.parentAgentId || sourceAgent.labels?.["paseo.parent-agent-id"]) {
    return "当前为子 Agent 会话，已保留旧会话以免破坏父会话追踪";
  }
  if ((sourceAgent.backgroundWork?.count ?? 0) > 0) {
    return "旧会话仍有后台任务运行中，已自动保留旧会话";
  }
  try {
    const list = await paseo.agents.list({
      scope: "active",
      filter: {
        labels: { "paseo.parent-agent-id": sourceAgent.id },
      },
    });
    const hasActiveChild = list.entries.some(({ agent }) => !agent.archivedAt);
    if (hasActiveChild) {
      return "旧会话存在活跃子 Agent，已跳过归档以避免级联中断子任务";
    }
  } catch {
    // Best-effort check
  }
  return null;
}

export async function handleSwitchModel(
  input: RpcInput<typeof switchModelRpc>,
  paseo: PaseoApi,
  settingsHandle: PluginSettings<typeof ModelSwitchSettingsSchema>,
  turnCache: IncrementalTimelineCache,
): Promise<RpcOutput<typeof switchModelRpc>> {
  const sourceHandle = paseo.agents.ref(input.agentId);
  const [settings, refreshed] = await Promise.all([
    readCurrentSettings(settingsHandle),
    sourceHandle.refresh(),
  ]);
  let sourceAgent = refreshed?.agent ?? sourceHandle.current();

  if (!sourceAgent) {
    throw new Error(`Agent not found: ${input.agentId}`);
  }

  if (sourceAgent.status === "running") {
    if (!input.stopRunning) {
      throw new Error(
        "当前会话正在执行中，请等待本轮结束，或使用“停止并切换” / `/m --force` 立即中断并切换。",
      );
    }
    const stopped = await stopRunningAgentGracefully(paseo, sourceAgent.id);
    if (!stopped) {
      throw new Error("尝试停止当前会话超时，请先手动停止后再切换。");
    }
    const afterStop = await sourceHandle.refresh();
    sourceAgent = afterStop?.agent ?? sourceAgent;
  }

  const cwd = sourceAgent.cwd;
  const workspaceId = sourceAgent.workspaceId ?? null;
  const sourceProvider = sourceAgent.provider;
  const sourceModel = sourceAgent.model || sourceAgent.runtimeInfo?.model || "default";
  const sourceThinkingOptionId =
    sourceAgent.thinkingOptionId ?? sourceAgent.runtimeInfo?.thinkingOptionId ?? null;

  const ancestorSwitchId = readStringMeta(sourceAgent.metadata, sourceAgent.labels, SWITCH_META_KEY);

  const [targetProviderEntry, ancestor, entries, git] = await Promise.all([
    resolveTargetProvider(paseo, input.targetProvider, cwd),
    ancestorSwitchId ? loadSwitchRecord(ancestorSwitchId) : Promise.resolve(null),
    turnCache.fetchFullTimeline(paseo, sourceAgent.id),
    collectGitWorkspaceContext(
      cwd,
      settings.includeGitContext,
      settings.includeUncommittedPatch,
    ),
  ]);

  if (!targetProviderEntry) {
    throw new Error(`目标 Provider 不可用或未就绪: ${input.targetProvider}`);
  }
  const targetModelEntry = targetProviderEntry.models.find((m) => m.id === input.targetModel);
  const resolvedTargetModel = targetModelEntry?.id ?? input.targetModel;

  const hopCount = (ancestor?.hopCount ?? 0) + 1;

  const switchId = generateSwitchId();
  const plannedTranscriptPath = path.join(getDataRoot(), "transcripts", `${switchId}.md`);
  const cleanNote = input.handoffNote?.trim() || undefined;

  const compiled = compileContextFromEntries({
    entries,
    git,
    cwd,
    sourceProvider,
    sourceModel,
    targetContextWindowTokens: targetModelEntry?.contextWindowMaxTokens,
    settings,
    handoffNote: cleanNote,
    ancestor,
    transcriptPathPlaceholder: plannedTranscriptPath,
  });

  // Resolve permission mode & provider options (including opencode auto_accept)
  let mappedModeId: string | undefined = input.targetModeId;
  let mappedProviderOptions: Record<string, unknown> | undefined;
  if (!mappedModeId && settings.autoMapMode) {
    const mapped = resolveModeAndOptionsForTarget({
      sourceProvider,
      sourceModeId: sourceAgent.currentModeId ?? sourceAgent.runtimeInfo?.modeId,
      sourceOptions: sourceAgent.options ?? null,
      targetProvider: input.targetProvider,
      targetModes: targetProviderEntry.modes,
      targetDefaultModeId: targetProviderEntry.defaultModeId,
    });
    mappedModeId = mapped.modeId;
    mappedProviderOptions = mapped.providerOptions;
  }

  // Carry user labels while stripping plugin-internal & Paseo parent-child control labels
  const nextLabels: Record<string, string> = {};
  if (sourceAgent.labels) {
    for (const [k, v] of Object.entries(sourceAgent.labels)) {
      if (!k.startsWith("modelSwitch.") && !k.startsWith("paseo.")) {
        nextLabels[k] = v;
      }
    }
  }

  const nextMetadata: Record<string, JsonValue> = {
    ...(sourceAgent.metadata ?? {}),
    [SWITCH_FROM_AGENT_KEY]: sourceAgent.id,
    [SWITCH_FROM_PROVIDER_KEY]: sourceProvider,
    [SWITCH_FROM_MODEL_KEY]: sourceModel,
    [SWITCH_FROM_THINKING_KEY]: sourceThinkingOptionId,
  };

  let savedTranscriptPath = "";
  let savedBannerData: SwitchBannerData | undefined;
  let turnsCarried = 0;

  const recordRecentTask = recordRecentModel({
    provider: input.targetProvider,
    model: resolvedTargetModel,
    thinkingOptionId: input.targetThinkingOptionId ?? targetModelEntry?.defaultThinkingOptionId,
    label: targetModelEntry?.label ?? resolvedTargetModel,
  });

  // Zero-noise fast path: empty unstarted session needs no synthetic briefing, file artifact, or "0 turns" banner
  if (!compiled.isEmptySession) {
    const priorTranscriptPaths = [
      ...(ancestor?.priorTranscriptPaths ?? []),
      ...(ancestor?.transcriptPath ? [ancestor.transcriptPath] : []),
    ];

    turnsCarried = Math.min(compiled.turns.length, settings.recentTurnsVerbatim);
    const baseBannerData: SwitchBannerData = {
      switchId,
      fromProvider: sourceProvider,
      fromModel: sourceModel,
      fromThinkingOptionId: sourceThinkingOptionId,
      toProvider: input.targetProvider,
      toModel: resolvedTargetModel,
      turnsCarried,
      totalTurns: compiled.turns.length,
      hopCount,
      filesTouched: compiled.filesTouched.slice(0, 12),
      gitBranch: compiled.git.branch,
      modeMapped: mappedModeId ?? null,
      transcriptPath: plannedTranscriptPath,
      handoffNote: cleanNote,
      previewTurns: compiled.previewTurns,
    };

    const [savedRecord] = await Promise.all([
      saveSwitchArtifacts({
        record: {
          switchId,
          createdAt: new Date().toISOString(),
          fromAgentId: sourceAgent.id,
          fromProvider: sourceProvider,
          fromModel: sourceModel,
          fromThinkingOptionId: sourceThinkingOptionId,
          toProvider: input.targetProvider,
          toModel: resolvedTargetModel,
          hopCount,
          totalTurns: compiled.turns.length,
          turnsCarried,
          hasOmittedHistory: compiled.hasOmittedHistory,
          filesTouched: compiled.filesTouched,
          gitBranch: compiled.git.branch,
          systemPromptBriefing: compiled.systemPromptBriefing,
          handoffNote: cleanNote,
          priorTranscriptPaths,
          priorHops: ancestor?.hops ?? [],
          ancestorSummary: compiled.ancestorSummary,
          bannerData: baseBannerData,
        },
        transcriptMarkdown: compiled.transcriptMarkdown,
      }),
      recordRecentTask,
    ]);

    savedTranscriptPath = savedRecord.transcriptPath;
    savedBannerData = savedRecord.bannerData;
    nextLabels[SWITCH_META_KEY] = switchId;
    nextMetadata[SWITCH_META_KEY] = switchId;
    nextMetadata[SWITCH_HOP_META_KEY] = hopCount;
  } else {
    await recordRecentTask;
  }

  const thinkingOptionId =
    input.targetThinkingOptionId ?? targetModelEntry?.defaultThinkingOptionId ?? undefined;

  const createConfig = {
    provider: `${input.targetProvider}/${resolvedTargetModel}`,
    modeId: mappedModeId,
    thinkingOptionId,
    options: mappedProviderOptions,
    toolPolicy:
      !compiled.isEmptySession && compiled.hasOmittedHistory
        ? {
            preapproved: [
              {
                kind: "mcp" as const,
                server: "paseo",
                tool: "read_previous_session_context",
              },
            ],
          }
        : undefined,
  };

  const cleanFollowUp = input.followUpPrompt?.trim() || undefined;
  const inheritedTitle = sourceAgent.title || undefined;

  const newAgentHandle = workspaceId
    ? await paseo.workspaces.ref(workspaceId).agents.create({
        config: createConfig,
        title: inheritedTitle,
        labels: nextLabels,
        metadata: nextMetadata,
        prompt: cleanFollowUp,
      })
    : await paseo.agents.create({
        cwd,
        config: createConfig,
        title: inheritedTitle,
        labels: nextLabels,
        metadata: nextMetadata,
        prompt: cleanFollowUp,
      });

  const bannerTask =
    settings.showSwitchBanner && savedBannerData
      ? newAgentHandle.timeline
          .append({
            type: "plugin",
            id: `model-switch-${switchId}`,
            kind: SWITCH_BANNER_KIND,
            version: 1,
            data: savedBannerData as unknown as JsonValue,
          })
          .catch((error) => {
            console.error("[model-switch] Failed to append timeline banner:", error);
          })
      : Promise.resolve();

  const shouldArchive = input.archivePreviousOverride ?? settings.archivePreviousAgent;
  const archiveTask: Promise<{ archivedPrevious: boolean; archiveSkippedReason?: string }> =
    shouldArchive
      ? (async () => {
          const protectionReason = await detectArchiveProtectionReason(paseo, sourceAgent);
          if (protectionReason) {
            return { archivedPrevious: false, archiveSkippedReason: protectionReason };
          }
          try {
            await sourceHandle.archive();
            return { archivedPrevious: true };
          } catch (error) {
            console.error("[model-switch] Failed to archive previous agent:", error);
            return { archivedPrevious: false };
          }
        })()
      : Promise.resolve({ archivedPrevious: false });

  const [, archiveResult] = await Promise.all([bannerTask, archiveTask]);
  const { archivedPrevious, archiveSkippedReason } = archiveResult;

  return {
    kind: "migrated",
    switchId,
    newAgentId: newAgentHandle.id,
    previousAgentId: sourceAgent.id,
    workspaceId: newAgentHandle.workspaceId ?? workspaceId,
    provider: input.targetProvider,
    model: resolvedTargetModel,
    turnsCarried,
    totalTurns: compiled.turns.length,
    archivedPrevious,
    archiveSkippedReason,
    modeMapped: mappedModeId ?? null,
    transcriptPath: savedTranscriptPath,
  };
}

export async function handleGetSwitchRecord(
  input: RpcInput<typeof getSwitchRecordRpc>,
): Promise<RpcOutput<typeof getSwitchRecordRpc>> {
  const record = await loadSwitchRecord(input.switchId);
  if (!record) return { found: false };

  const targetHop = input.hopSwitchId
    ? record.hops.find((h) => h.switchId === input.hopSwitchId)
    : record.hops[record.hops.length - 1];
  const targetPath = targetHop?.transcriptPath ?? record.transcriptPath;
  const publicLineage = record.hops.map(({ transcriptPath: _tp, ...pub }) => pub);

  try {
    const slice = await readTranscriptSlice(targetPath, {
      query: input.query,
      offset: 0,
      limit: 16000,
    });
    return {
      found: true,
      transcriptPreview: slice.text,
      transcriptPath: targetPath,
      totalChars: slice.totalChars,
      lineage: publicLineage,
    };
  } catch {
    return {
      found: true,
      transcriptPath: targetPath,
      lineage: publicLineage,
    };
  }
}

async function rehydrateBannerIfEmptyTimeline(
  paseo: PaseoApi,
  agentId: string,
  switchId: string,
  bannerData: SwitchBannerData,
): Promise<void> {
  try {
    const handle = paseo.agents.ref(agentId);
    const tail = await handle.timeline.refetch({
      direction: "tail",
      limit: 20,
      projection: "projected",
    });
    const bannerId = `model-switch-${switchId}`;
    const alreadyPresent = tail.entries.some(
      (e) => e.item.type === "plugin" && e.item.id === bannerId,
    );
    if (alreadyPresent) return;

    const hasConversationTurns = tail.entries.some(
      (e) => e.item.type === "user_message" || e.item.type === "assistant_message",
    );
    if (hasConversationTurns || tail.hasOlder) return;

    await handle.timeline.append({
      type: "plugin",
      id: bannerId,
      kind: SWITCH_BANNER_KIND,
      version: 1,
      data: bannerData as unknown as JsonValue,
    });
  } catch {
    // Non-fatal
  }
}

export function registerSessionOpenHook(
  server: PluginServerContext,
  settingsHandle: PluginSettings<typeof ModelSwitchSettingsSchema>,
): () => void {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  const removeHook = server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    if (request.purpose !== "interactive") return;

    const switchId = readStringMeta(request.metadata, request.labels, SWITCH_META_KEY);
    if (!switchId) return;

    const record = await loadSwitchRecord(switchId);
    if (!record || !record.systemPromptBriefing) return;

    if (request.reason === "resume" && record.bannerData) {
      const bannerData = record.bannerData;
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (disposed) return;
        void readCurrentSettings(settingsHandle).then((settings) => {
          if (disposed || !settings.showSwitchBanner) return;
          return rehydrateBannerIfEmptyTimeline(paseo, request.agentId, switchId, bannerData);
        });
      }, 400);
      pendingTimers.add(timer);
    }

    const shouldAttachTool = record.hasOmittedHistory !== false;
    const nextTools = [...request.tools];

    if (shouldAttachTool) {
      const readerTool = defineAgentTool({
        name: "read_previous_session_context",
        title: "Read Previous Session Context",
        description:
          "Inspect or search full verbatim conversation transcripts from before this session switched models (supports multi-hop chains). Use action='list_hops' to view all prior model segments, action='search' with query and optional hop='all', or action='read' with offset/limit.",
        input: READ_PREVIOUS_SESSION_CONTEXT_INPUT_SCHEMA,
        async execute(args) {
          const effectiveAction =
            args.action ?? (args.query && args.query.trim().length > 0 ? "search" : "read");
          return readAcrossHops(record, {
            action: effectiveAction,
            hop: args.hop,
            query: args.query,
            offset: args.offset,
            limit: args.limit,
          });
        },
      });
      nextTools.push(readerTool);
    }

    return {
      ...request,
      appendSystemPrompt: [...(request.appendSystemPrompt ?? []), record.systemPromptBriefing],
      tools: nextTools,
    };
  });

  return () => {
    disposed = true;
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    removeHook();
  };
}
