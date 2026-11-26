import type { PluginComposer, PluginComposerSelector, PluginPaseoApi } from "@getpaseo/plugin/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  CatalogModel,
  CatalogProvider,
  ModelRef,
  recordRecentRpc,
  switchModelRpc,
} from "../shared/contracts";

export interface SwitchExecutionDeps {
  paseo: PluginPaseoApi;
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[];
  invokeSwitch: (input: RpcInput<typeof switchModelRpc>) => Promise<RpcOutput<typeof switchModelRpc>>;
  recordRecent?: (input: RpcInput<typeof recordRecentRpc>) => Promise<unknown>;
  openAgent?: (input: { readonly agentId: string; readonly serverId?: string }) => void;
  /** Called right before focusing the new agent tab (e.g. close popover first so focus isn't stolen). */
  onBeforeFocus?: () => void;
}

export interface SwitchExecutionInput {
  agentId: string;
  currentProvider: string;
  targetProvider: string;
  targetModel: string;
  targetModelLabel?: string;
  targetThinkingOptionId?: string;
  followUpPrompt?: string;
  handoffNote?: string;
  stopRunning?: boolean;
  archivePreviousOverride?: boolean;
}

export type SwitchExecutionOutcome =
  | {
      kind: "in-place";
      agentId: string;
      provider: string;
      model: string;
      thinkingOptionId?: string;
      notePrefilled?: boolean;
    }
  | {
      kind: "migrated";
      newAgentId: string;
      previousAgentId: string;
      provider: string;
      model: string;
      turnsCarried: number;
      totalTurns: number;
      archivedPrevious: boolean;
      archiveSkippedReason?: string;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForComposer(
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[],
  agentId: string,
  timeoutMs = 3500,
): Promise<PluginComposer | null> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 25;
  while (Date.now() < deadline) {
    const found = getComposers({ agentId })[0];
    if (found) return found;
    await sleep(delayMs);
    if (delayMs < 100) {
      delayMs = Math.min(100, delayMs * 2);
    }
  }
  return getComposers({ agentId })[0] ?? null;
}

export async function executeModelSwitch(
  input: SwitchExecutionInput,
  deps: SwitchExecutionDeps,
): Promise<SwitchExecutionOutcome> {
  const currentComposer = deps.getComposers({ agentId: input.agentId })[0] ?? null;

  // Fast path: same provider -> in-place hot-swap with zero session disruption
  if (input.targetProvider === input.currentProvider) {
    if (!currentComposer) {
      throw new Error("无法获取当前会话输入栏句柄，请重新聚焦会话后再试。");
    }
    await currentComposer.setModel(input.targetModel);
    if (input.targetThinkingOptionId) {
      try {
        await currentComposer.setThinking(input.targetThinkingOptionId);
      } catch {
        // Ignore if provider rejects thinking option on this model
      }
    }
    if (deps.recordRecent) {
      void deps
        .recordRecent({
          provider: input.targetProvider,
          model: input.targetModel,
          thinkingOptionId: input.targetThinkingOptionId,
          label: input.targetModelLabel ?? input.targetModel,
        })
        .catch(() => undefined);
    }

    const cleanNote = input.handoffNote?.trim();
    const followUp = input.followUpPrompt?.trim();
    let notePrefilled = false;

    if (followUp) {
      const payload = cleanNote ? `[指令备注：${cleanNote}]\n\n${followUp}` : followUp;
      await deps.paseo.agents.ref(input.agentId).send(payload);
    } else if (cleanNote) {
      const existingPrompt = currentComposer.prompt.trim();
      const nextDraft = existingPrompt
        ? `[指令备注：${cleanNote}]\n\n${existingPrompt}`
        : `[指令备注：${cleanNote}]\n`;
      currentComposer.setPrompt(nextDraft);
      notePrefilled = true;
    }

    deps.onBeforeFocus?.();
    return {
      kind: "in-place",
      agentId: input.agentId,
      provider: input.targetProvider,
      model: input.targetModel,
      thinkingOptionId: input.targetThinkingOptionId,
      notePrefilled,
    };
  }

  // Cross-provider path: capture unsent draft & plugin attachments, migrate context, close popover, focus new tab
  const unsentDraft = input.followUpPrompt?.trim() ? "" : (currentComposer?.prompt ?? "");
  const unsentAttachments = input.followUpPrompt?.trim()
    ? []
    : [...(currentComposer?.attachments ?? [])];

  const result = await deps.invokeSwitch({
    agentId: input.agentId,
    targetProvider: input.targetProvider,
    targetModel: input.targetModel,
    targetThinkingOptionId: input.targetThinkingOptionId,
    followUpPrompt: input.followUpPrompt?.trim() || undefined,
    handoffNote: input.handoffNote?.trim() || undefined,
    stopRunning: input.stopRunning,
    archivePreviousOverride: input.archivePreviousOverride,
  });

  // Close popover BEFORE navigating/focusing so unmount focus-restore never steals focus back
  deps.onBeforeFocus?.();

  if (deps.openAgent) {
    try {
      deps.openAgent({ agentId: result.newAgentId });
    } catch {
      // Fall through to composer.focus()
    }
  }

  const nextComposer = await waitForComposer(deps.getComposers, result.newAgentId);
  if (nextComposer) {
    if (unsentDraft) {
      nextComposer.setPrompt(unsentDraft);
      if (currentComposer) {
        try {
          currentComposer.setPrompt("");
        } catch {
          // Ignore if old composer already unmounted
        }
      }
    }
    for (const att of unsentAttachments) {
      try {
        nextComposer.addAttachment({ sourceId: att.sourceId, item: att.item });
      } catch {
        // Ignore unsupported attachment transfer
      }
    }
    try {
      await nextComposer.focus();
      // Secondary micro-recheck after popover exit animation settles
      await sleep(120);
      const settled = deps.getComposers({ agentId: result.newAgentId })[0];
      if (settled) {
        await settled.focus();
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    kind: "migrated",
    newAgentId: result.newAgentId,
    previousAgentId: result.previousAgentId,
    provider: result.provider,
    model: result.model,
    turnsCarried: result.turnsCarried,
    totalTurns: result.totalTurns,
    archivedPrevious: result.archivedPrevious,
    archiveSkippedReason: result.archiveSkippedReason,
  };
}

export interface SlashResolutionContext {
  currentProvider?: string;
  currentModel?: string | null;
  fromProvider?: string | null;
  fromModel?: string | null;
  fromThinkingOptionId?: string | null;
  recent?: readonly ModelRef[];
}

export interface ResolvedSlashTarget {
  provider: CatalogProvider;
  model: CatalogModel;
  thinkingOptionId?: string;
  followUpPrompt?: string;
  handoffNote?: string;
  stopRunning: boolean;
}

interface ParsedSlashArgs {
  spec: string;
  followUpPrompt?: string;
  stopRunning: boolean;
  handoffNote?: string;
}

function readQuotedOrWord(
  input: string,
  startIdx: number,
): { value: string; nextIdx: number } {
  let i = startIdx;
  while (i < input.length && /\s/.test(input[i])) i += 1;
  if (i >= input.length) return { value: "", nextIdx: i };

  const ch = input[i];
  if (ch === '"' || ch === "'") {
    const quote = ch;
    i += 1;
    let out = "";
    while (i < input.length) {
      if (input[i] === "\\" && i + 1 < input.length && (input[i + 1] === quote || input[i + 1] === "\\")) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (input[i] === quote) {
        i += 1;
        break;
      }
      out += input[i];
      i += 1;
    }
    return { value: out, nextIdx: i };
  }

  let end = i;
  while (end < input.length && !/\s/.test(input[end])) end += 1;
  return { value: input.slice(i, end), nextIdx: end };
}

function parseSlashTokens(raw: string): ParsedSlashArgs {
  const input = raw.trim();
  let i = 0;
  let stopRunning = false;
  let handoffNote: string | undefined;
  let spec = "";
  let followUpStart = -1;

  const consumeFlagAt = (pos: number): number | null => {
    const slice = input.slice(pos);
    if (slice.startsWith("--force") && (slice.length === 7 || /\s/.test(slice[7]))) {
      stopRunning = true;
      return pos + 7;
    }
    if (slice.startsWith("-f") && (slice.length === 2 || /\s/.test(slice[2]))) {
      stopRunning = true;
      return pos + 2;
    }
    if (slice.startsWith("--note=")) {
      const parsed = readQuotedOrWord(input, pos + 7);
      handoffNote = parsed.value.trim() || handoffNote;
      return parsed.nextIdx;
    }
    if (slice.startsWith("--note") && slice.length > 6 && /\s/.test(slice[6])) {
      const parsed = readQuotedOrWord(input, pos + 6);
      handoffNote = parsed.value.trim() || handoffNote;
      return parsed.nextIdx;
    }
    return null;
  };

  // Phase 1: Leading flags before target spec
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;
    const nextPos = consumeFlagAt(i);
    if (nextPos !== null) {
      i = nextPos;
      continue;
    }
    // Read target spec token
    let end = i;
    while (end < input.length && !/\s/.test(input[end])) end += 1;
    spec = input.slice(i, end);
    i = end;
    break;
  }

  // Phase 2: Optional flags immediately following target spec (e.g. `/m codex/gpt-6.2-sol --force --note="..."`)
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;
    const nextPos = consumeFlagAt(i);
    if (nextPos !== null) {
      i = nextPos;
      continue;
    }
    followUpStart = i;
    break;
  }

  // Phase 3: Check for trailing `--force` / `-f` at the very end of the command line
  let followUpPrompt =
    followUpStart >= 0 ? input.slice(followUpStart).trim() || undefined : undefined;
  if (followUpPrompt) {
    const trailingForce = followUpPrompt.match(/^(.*?)\s+(--force|-f)$/);
    if (trailingForce) {
      stopRunning = true;
      followUpPrompt = trailingForce[1].trim() || undefined;
    }
  }

  return { spec, followUpPrompt, stopRunning, handoffNote };
}

function scoreFuzzyMatch(needleLower: string, boundaryRe: RegExp, model: CatalogModel): number {
  const idLower = model.id.toLowerCase();
  const labelLower = model.label.toLowerCase();
  const tailLower = idLower.split("/").pop() ?? idLower;

  if (idLower === needleLower || tailLower === needleLower || labelLower === needleLower) return 100;
  if (tailLower.startsWith(needleLower) || idLower.startsWith(needleLower)) return 80;
  if (labelLower.startsWith(needleLower)) return 75;
  // Word/delimiter boundary match (e.g. `-sol`, `/deepseek`)
  if (boundaryRe.test(idLower) || boundaryRe.test(labelLower)) return 60;
  if (idLower.includes(needleLower) || labelLower.includes(needleLower)) return 40;
  return 0;
}

function pickBestModelMatch(
  needleLower: string,
  candidates: Array<{ provider: CatalogProvider; model: CatalogModel }>,
): { match?: { provider: CatalogProvider; model: CatalogModel }; ambiguous?: Array<{ provider: CatalogProvider; model: CatalogModel }> } {
  const boundaryRe = new RegExp(
    `(?:^|[/\\-_\\s])${needleLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  const scored = candidates
    .map((c) => ({ ...c, score: scoreFuzzyMatch(needleLower, boundaryRe, c.model) }))
    .filter((c) => c.score > 0);

  if (scored.length === 0) return {};
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.model.id.length - b.model.id.length;
  });

  const topScore = scored[0].score;
  const topTier = scored.filter((s) => s.score === topScore);
  if (topTier.length === 1) {
    return { match: { provider: topTier[0].provider, model: topTier[0].model } };
  }
  // If multiple exact/prefix matches share the exact same top score, report ambiguity cleanly
  return {
    ambiguous: topTier.map((t) => ({ provider: t.provider, model: t.model })),
  };
}

function resolveThinkingSuffix(
  model: CatalogModel,
  thinkingQuery: string | undefined,
  fallbackThinkingId?: string | null,
): { thinkingOptionId?: string; error?: string } {
  if (!thinkingQuery) {
    if (fallbackThinkingId && model.thinkingOptions?.some((o) => o.id === fallbackThinkingId)) {
      return { thinkingOptionId: fallbackThinkingId };
    }
    return { thinkingOptionId: model.defaultThinkingOptionId };
  }
  const options = model.thinkingOptions ?? [];
  if (options.length === 0) {
    return { error: `模型 ${model.label} 不支持自定义思考档位（@${thinkingQuery}）。` };
  }
  const needle = thinkingQuery.toLowerCase();
  const exact = options.find(
    (o) => o.id.toLowerCase() === needle || o.label.toLowerCase() === needle,
  );
  if (exact) return { thinkingOptionId: exact.id };
  const fuzzy = options.find(
    (o) => o.id.toLowerCase().includes(needle) || o.label.toLowerCase().includes(needle),
  );
  if (fuzzy) return { thinkingOptionId: fuzzy.id };

  return {
    error: `模型 ${model.label} 未找到思考档位 "${thinkingQuery}"。可选：${options.map((o) => o.id).join(", ")}`,
  };
}

export function resolveTargetFromSlashArgs(
  rawArgs: string,
  providers: readonly CatalogProvider[],
  ctx: SlashResolutionContext = {},
): ResolvedSlashTarget | { error: string } {
  const { spec: rawSpec, followUpPrompt, stopRunning, handoffNote } = parseSlashTokens(rawArgs);
  if (!rawSpec) {
    return { error: "empty" };
  }

  // Support optional `@thinking` suffix (e.g. codex/gpt-6.2-sol@high or back@medium)
  const atIdx = rawSpec.lastIndexOf("@");
  const spec = atIdx > 0 ? rawSpec.slice(0, atIdx) : rawSpec;
  const thinkingQuery = atIdx > 0 ? rawSpec.slice(atIdx + 1).trim() || undefined : undefined;
  const specLower = spec.toLowerCase();

  const finalize = (
    provider: CatalogProvider,
    model: CatalogModel,
    fallbackThinkingId?: string | null,
  ): ResolvedSlashTarget | { error: string } => {
    const t = resolveThinkingSuffix(model, thinkingQuery, fallbackThinkingId);
    if (t.error) return { error: t.error };
    return {
      provider,
      model,
      thinkingOptionId: t.thinkingOptionId,
      followUpPrompt,
      handoffNote,
      stopRunning,
    };
  };

  // 0. Special keyword: `back` / `-` -> restore previous model AND its thinking level
  if (specLower === "back" || specLower === "-") {
    let targetProviderId = ctx.fromProvider ?? null;
    let targetModelId = ctx.fromModel ?? null;
    let targetThinkingId = ctx.fromThinkingOptionId ?? null;

    if (!targetProviderId && ctx.recent && ctx.recent.length > 0) {
      const alt = ctx.recent.find(
        (r) => !(r.provider === ctx.currentProvider && r.model === ctx.currentModel),
      );
      if (alt) {
        targetProviderId = alt.provider;
        targetModelId = alt.model;
        targetThinkingId = alt.thinkingOptionId ?? null;
      }
    }

    if (!targetProviderId) {
      return { error: "当前会话没有可切回的上一个模型记录。" };
    }
    const prov = providers.find((p) => p.id === targetProviderId);
    if (!prov) {
      return { error: `上一个 Provider (${targetProviderId}) 当前不可用。` };
    }
    const mod =
      (targetModelId ? prov.models.find((m) => m.id === targetModelId) : undefined) ??
      prov.models.find((m) => m.isDefault) ??
      prov.models[0];
    if (!mod) {
      return { error: `上一个 Provider (${prov.label}) 没有可用模型。` };
    }
    return finalize(prov, mod, targetThinkingId);
  }

  // 1. Direct full model ID match across all providers (handles e.g. `tencent/deepseek/deepseek-flash` or `opencode/deepseek-v4.1-flash-free`)
  const directFullMatches: Array<{ provider: CatalogProvider; model: CatalogModel }> = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.id.toLowerCase() === specLower) {
        directFullMatches.push({ provider, model });
      }
    }
  }
  if (directFullMatches.length === 1) {
    return finalize(directFullMatches[0].provider, directFullMatches[0].model);
  }

  // 2. Explicit `provider/model` form (supports models whose own ID also contains `/`, e.g. `opencode/tencent/deepseek/deepseek-flash`)
  const slashIdx = spec.indexOf("/");
  if (slashIdx > 0) {
    const providerNeedle = spec.slice(0, slashIdx).toLowerCase();
    const modelNeedle = spec.slice(slashIdx + 1).toLowerCase();
    const provider = providers.find(
      (p) => p.id.toLowerCase() === providerNeedle || p.label.toLowerCase() === providerNeedle,
    );
    if (provider) {
      const exactModel = provider.models.find((m) => {
        const idL = m.id.toLowerCase();
        return (
          idL === modelNeedle ||
          idL === `${provider.id.toLowerCase()}/${modelNeedle}` ||
          m.label.toLowerCase() === modelNeedle
        );
      });
      if (exactModel) return finalize(provider, exactModel);

      const scored = pickBestModelMatch(
        modelNeedle,
        provider.models.map((model) => ({ provider, model })),
      );
      if (scored.match) return finalize(scored.match.provider, scored.match.model);
      if (scored.ambiguous) {
        const hints = scored.ambiguous
          .slice(0, 4)
          .map((m) => `${m.provider.id}/${m.model.id}`)
          .join(", ");
        return { error: `在 ${provider.label} 中匹配到多个模型，请更具体一些：${hints}` };
      }

      return {
        error: `在 ${provider.label} 中未找到匹配 "${spec.slice(slashIdx + 1)}" 的模型。`,
      };
    }
  }

  // 3. Provider ID alone -> pick default (or first) model
  const exactProvider = providers.find(
    (p) => p.id.toLowerCase() === specLower || p.label.toLowerCase() === specLower,
  );
  if (exactProvider) {
    const model = exactProvider.models.find((m) => m.isDefault) ?? exactProvider.models[0];
    if (model) return finalize(exactProvider, model);
  }

  // 4. Scored cross-provider lookup (exact > prefix > boundary > substring)
  const allCandidates: Array<{ provider: CatalogProvider; model: CatalogModel }> = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      allCandidates.push({ provider, model });
    }
  }

  const best = pickBestModelMatch(specLower, allCandidates);
  if (best.match) {
    return finalize(best.match.provider, best.match.model);
  }
  if (best.ambiguous) {
    const hints = best.ambiguous
      .slice(0, 4)
      .map((m) => `${m.provider.id}/${m.model.id}`)
      .join(", ");
    return { error: `匹配到多个模型，请指定 Provider 或更完整名称：${hints}` };
  }

  const availableProviders = providers.map((p) => p.id).join(", ");
  return {
    error: `未找到匹配 "${spec}" 的模型。当前可用 Provider：${availableProviders || "无"}`,
  };
}
