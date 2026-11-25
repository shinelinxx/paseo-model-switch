import type { PluginTheme } from "@getpaseo/plugin";
import {
  useAgent,
  usePaseo,
  useRpc,
  useSettings,
  type PluginAgentPanelProps,
  type PluginButtonContentProps,
  type PluginComposer,
  type PluginComposerSelector,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  listCatalogRpc,
  recordRecentRpc,
  SWITCH_FROM_MODEL_KEY,
  SWITCH_FROM_PROVIDER_KEY,
  SWITCH_FROM_THINKING_KEY,
  switchModelRpc,
  togglePinRpc,
  type CatalogModel,
  type CatalogProvider,
  type ModelRef,
} from "../shared/contracts";
import { DEFAULT_MODEL_SWITCH_SETTINGS, modelSwitchSettings } from "../shared/settings";
import { executeModelSwitch } from "./switch-runner";

export interface ModelSwitcherBodyProps {
  agentId: string;
  theme: PluginTheme;
  compact: boolean;
  isPopover: boolean;
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[];
  openAgent?: (input: { readonly agentId: string; readonly serverId?: string }) => void;
  onDone?: () => void;
}

function shortModelName(model: string | null | undefined): string {
  if (!model) return "default";
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

export function ModelSwitcherBody({
  agentId,
  theme,
  compact,
  isPopover,
  getComposers,
  openAgent,
  onDone,
}: ModelSwitcherBodyProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const listCatalog = useRpc(listCatalogRpc);
  const invokeSwitch = useRpc(switchModelRpc);
  const togglePin = useRpc(togglePinRpc);
  const recordRecent = useRpc(recordRecentRpc);
  const settingsState = useSettings(modelSwitchSettings);

  const agentInfo = useAgent(agentId, (a) => ({
    provider: a.provider,
    model: a.model,
    thinkingOptionId: a.thinkingOptionId,
    cwd: a.cwd,
    status: a.status,
    fromProvider:
      typeof a.metadata?.[SWITCH_FROM_PROVIDER_KEY] === "string"
        ? (a.metadata[SWITCH_FROM_PROVIDER_KEY] as string)
        : null,
    fromModel:
      typeof a.metadata?.[SWITCH_FROM_MODEL_KEY] === "string"
        ? (a.metadata[SWITCH_FROM_MODEL_KEY] as string)
        : null,
    fromThinkingOptionId:
      typeof a.metadata?.[SWITCH_FROM_THINKING_KEY] === "string"
        ? (a.metadata[SWITCH_FROM_THINKING_KEY] as string)
        : null,
  }));

  const defaultArchive =
    settingsState.status === "ready"
      ? settingsState.values.archivePreviousAgent
      : DEFAULT_MODEL_SWITCH_SETTINGS.archivePreviousAgent;

  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [archiveOverride, setArchiveOverride] = useState<boolean | null>(null);
  const [forceStopRunning, setForceStopRunning] = useState(false);
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [handoffNote, setHandoffNote] = useState("");
  const [expandedThinkingKey, setExpandedThinkingKey] = useState<string | null>(null);
  const [switchingTarget, setSwitchingTarget] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const archivePrevious = archiveOverride ?? defaultArchive;

  const catalogQueryKey = ["model-switch", "catalog", agentInfo?.cwd ?? ""] as const;
  const catalogQuery = useQuery({
    queryKey: catalogQueryKey,
    queryFn: () => listCatalog({ cwd: agentInfo?.cwd }),
    staleTime: 20_000,
  });

  const allProviders = catalogQuery.data?.providers ?? [];
  const pinnedList = catalogQuery.data?.pinned ?? [];
  const recentList = catalogQuery.data?.recent ?? [];

  const pinnedSet = useMemo(() => {
    const s = new Set<string>();
    for (const p of pinnedList) s.add(`${p.provider}/${p.model}`);
    return s;
  }, [pinnedList]);

  const quickEntries = useMemo(() => {
    if (query.trim().length > 0 || providerFilter !== "all") return [];
    const lookup = new Map<string, { provider: CatalogProvider; model: CatalogModel }>();
    for (const provider of allProviders) {
      for (const model of provider.models) {
        lookup.set(`${provider.id}/${model.id}`, { provider, model });
      }
    }
    const seen = new Set<string>();
    const combined: Array<{
      ref: ModelRef;
      provider: CatalogProvider;
      model: CatalogModel;
      isPinned: boolean;
    }> = [];

    for (const ref of pinnedList) {
      const key = `${ref.provider}/${ref.model}`;
      const match = lookup.get(key);
      if (match && !seen.has(key)) {
        seen.add(key);
        combined.push({ ref, provider: match.provider, model: match.model, isPinned: true });
      }
    }
    for (const ref of recentList) {
      const key = `${ref.provider}/${ref.model}`;
      const match = lookup.get(key);
      if (match && !seen.has(key)) {
        seen.add(key);
        combined.push({ ref, provider: match.provider, model: match.model, isPinned: false });
      }
    }
    return combined.slice(0, 6);
  }, [allProviders, pinnedList, recentList, query, providerFilter]);

  const switchBackTarget = useMemo(() => {
    if (!agentInfo?.fromProvider) return null;
    const prov = allProviders.find((p) => p.id === agentInfo.fromProvider);
    if (!prov) return null;
    const mod =
      (agentInfo.fromModel
        ? prov.models.find((m) => m.id === agentInfo.fromModel)
        : undefined) ??
      prov.models.find((m) => m.isDefault) ??
      prov.models[0];
    if (!mod) return null;
    if (prov.id === agentInfo.provider && mod.id === agentInfo.model) return null;
    return {
      provider: prov,
      model: mod,
      thinkingOptionId: agentInfo.fromThinkingOptionId ?? undefined,
    };
  }, [
    allProviders,
    agentInfo?.fromProvider,
    agentInfo?.fromModel,
    agentInfo?.fromThinkingOptionId,
    agentInfo?.provider,
    agentInfo?.model,
  ]);

  const filteredProviders = useMemo(() => {
    const scoped =
      providerFilter === "all"
        ? allProviders
        : allProviders.filter((p) => p.id === providerFilter);
    const needle = query.trim().toLowerCase();
    if (!needle) return scoped;

    const result: CatalogProvider[] = [];
    for (const provider of scoped) {
      const providerMatches =
        provider.id.toLowerCase().includes(needle) ||
        provider.label.toLowerCase().includes(needle);
      const matchingModels = providerMatches
        ? provider.models
        : provider.models.filter(
            (m) =>
              m.id.toLowerCase().includes(needle) ||
              m.label.toLowerCase().includes(needle) ||
              (m.description?.toLowerCase().includes(needle) ?? false),
          );
      if (matchingModels.length > 0) {
        result.push({ ...provider, models: matchingModels });
      }
    }
    return result;
  }, [allProviders, providerFilter, query]);

  const topSearchMatch = useMemo(() => {
    if (!query.trim()) return null;
    for (const provider of filteredProviders) {
      for (const model of provider.models) {
        const isSame =
          provider.id === agentInfo?.provider &&
          (model.id === agentInfo?.model || (!agentInfo?.model && Boolean(model.isDefault)));
        if (!isSame) return { provider, model };
      }
    }
    return null;
  }, [filteredProviders, query, agentInfo?.provider, agentInfo?.model]);

  const styles = useMemo(
    () => ({
      root: {
        width: isPopover ? (compact ? undefined : 390) : undefined,
        maxHeight: isPopover ? (compact ? 500 : 540) : undefined,
        flex: isPopover ? undefined : 1,
        backgroundColor: theme.colors.surface0,
        padding: compact ? 12 : 14,
        gap: 9,
      },
      headerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
      },
      currentPill: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
        maxWidth: 210,
      },
      currentPillText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      switchBackBtn: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.accent,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        gap: 8,
      },
      switchBackText: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 12,
        fontWeight: "500" as const,
      },
      searchBox: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        gap: 6,
      },
      searchInput: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 13,
        paddingVertical: 2,
      },
      filterRow: {
        flexDirection: "row" as const,
        gap: 6,
      },
      filterChip: {
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      filterChipActive: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
      filterChipText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "500" as const,
      },
      filterChipTextActive: {
        color: theme.colors.accentForeground,
      },
      runningBanner: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.statusWarning,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        gap: 6,
      },
      runningText: {
        color: theme.colors.statusWarning,
        fontSize: 12,
      },
      errorBanner: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.statusDanger,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
      },
      errorText: {
        color: theme.colors.statusDanger,
        fontSize: 12,
      },
      list: {
        flexGrow: 0,
        maxHeight: isPopover ? 290 : undefined,
      },
      providerHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingTop: 8,
        paddingBottom: 4,
        paddingHorizontal: 4,
      },
      providerLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        textTransform: "uppercase" as const,
      },
      modeBadge: {
        fontSize: 10,
        fontWeight: "500" as const,
      },
      modelRowWrap: {
        marginBottom: 2,
      },
      modelRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderRadius: 8,
        gap: 6,
      },
      modelRowActive: {
        backgroundColor: theme.colors.surface2,
      },
      modelName: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "500" as const,
      },
      modelSub: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      iconBtn: {
        padding: 4,
        borderRadius: 6,
      },
      thinkingRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
        paddingLeft: 12,
        paddingRight: 8,
        paddingBottom: 6,
        paddingTop: 2,
      },
      thinkingChip: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      thinkingChipActive: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface2,
      },
      thinkingChipText: {
        color: theme.colors.foreground,
        fontSize: 11,
      },
      noteBox: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      footer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 8,
        gap: 8,
      },
      toggleButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
      },
      footerText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      emptyWrap: {
        paddingVertical: 20,
        alignItems: "center" as const,
        gap: 6,
      },
      switchingOverlay: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
      },
    }),
    [theme, compact, isPopover],
  );

  const handleTogglePin = async (provider: CatalogProvider, model: CatalogModel) => {
    try {
      const res = await togglePin({
        provider: provider.id,
        model: model.id,
        label: model.label,
      });
      queryClient.setQueryData(catalogQueryKey, (old: typeof catalogQuery.data) => {
        if (!old) return old;
        return { ...old, pinned: res.items };
      });
    } catch {
      toast.error("更新收藏状态失败");
    }
  };

  const handleSelectModel = async (
    provider: CatalogProvider,
    model: CatalogModel,
    thinkingOptionId?: string,
  ) => {
    if (!agentInfo || switchingTarget) return;
    const isSameProvider = provider.id === agentInfo.provider;
    const chosenThinking = thinkingOptionId ?? model.defaultThinkingOptionId;
    const isCurrentSameModel =
      isSameProvider &&
      (model.id === agentInfo.model || (!agentInfo.model && Boolean(model.isDefault)));
    const isSameThinking =
      !thinkingOptionId || thinkingOptionId === agentInfo.thinkingOptionId;

    if (isCurrentSameModel && isSameThinking) {
      onDone?.();
      return;
    }

    if (!isSameProvider && agentInfo.status === "running" && !forceStopRunning) {
      setErrorText("当前会话运行中：可勾选上方「停止并切换」立即中断，或等待本轮结束。");
      return;
    }

    const targetKey = `${provider.id}/${model.id}`;
    setSwitchingTarget(targetKey);
    setErrorText(null);

    try {
      const outcome = await executeModelSwitch(
        {
          agentId,
          currentProvider: agentInfo.provider,
          targetProvider: provider.id,
          targetModel: model.id,
          targetModelLabel: model.label,
          targetThinkingOptionId: chosenThinking,
          handoffNote: handoffNote.trim() || undefined,
          stopRunning: !isSameProvider && agentInfo.status === "running" && forceStopRunning,
          archivePreviousOverride: archivePrevious,
        },
        {
          paseo,
          getComposers,
          invokeSwitch,
          recordRecent,
          openAgent,
          // Close popover BEFORE focusing new composer so unmount doesn't steal focus
          onBeforeFocus: onDone,
        },
      );

      void queryClient.invalidateQueries({ queryKey: catalogQueryKey });

      if (outcome.kind === "in-place") {
        const noteTag = outcome.notePrefilled ? "（已将备注填入输入框）" : "";
        toast.show(
          `已原地切换至 ${model.label}${thinkingOptionId ? ` (${thinkingOptionId})` : ""}${noteTag}`,
          { variant: "success" },
        );
      } else {
        const turnTag = outcome.totalTurns > 0 ? `（继承 ${outcome.totalTurns} 轮上下文）` : "";
        const skipTag = outcome.archiveSkippedReason ? ` · ${outcome.archiveSkippedReason}` : "";
        toast.show(
          `已切换至 ${provider.label} / ${model.label}${turnTag}${skipTag}`,
          { variant: "success" },
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorText(msg);
      toast.error(`切换失败：${msg}`);
    } finally {
      setSwitchingTarget(null);
    }
  };

  const renderModelRow = (
    provider: CatalogProvider,
    model: CatalogModel,
    keyPrefix: string,
    showProviderTag: boolean,
  ) => {
    const isSameProvider = provider.id === agentInfo?.provider;
    const isCurrent =
      isSameProvider &&
      (model.id === agentInfo?.model || (!agentInfo?.model && Boolean(model.isDefault)));
    const disabled =
      Boolean(switchingTarget) ||
      (!isSameProvider && agentInfo?.status === "running" && !forceStopRunning);
    const fullKey = `${provider.id}/${model.id}`;
    const rowKey = `${keyPrefix}:${fullKey}`;
    const isPinned = pinnedSet.has(fullKey);
    const hasThinking = (model.thinkingOptions?.length ?? 0) > 1;
    const thinkingExpanded = expandedThinkingKey === rowKey;

    return (
      <View key={rowKey} style={styles.modelRowWrap}>
        <View style={[styles.modelRow, isCurrent ? styles.modelRowActive : null]}>
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => void handleSelectModel(provider, model)}
            style={({ pressed }) => [
              { flex: 1, gap: 2, opacity: disabled && !isCurrent ? 0.45 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text numberOfLines={1} style={styles.modelName}>
              {model.label}
            </Text>
            <Text numberOfLines={1} style={styles.modelSub}>
              {showProviderTag ? `${provider.label} · ${model.id}` : model.id}
            </Text>
          </Pressable>

          {hasThinking ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择思考档位"
              disabled={disabled}
              onPress={() => setExpandedThinkingKey(thinkingExpanded ? null : rowKey)}
              style={styles.iconBtn}
            >
              <Icon
                name="Sparkles"
                size={13}
                color={thinkingExpanded ? theme.colors.accent : theme.colors.foregroundMuted}
              />
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPinned ? "取消置顶" : "置顶模型"}
            onPress={() => void handleTogglePin(provider, model)}
            style={styles.iconBtn}
          >
            <Icon
              name="Star"
              size={13}
              color={isPinned ? theme.colors.statusWarning : theme.colors.foregroundMuted}
            />
          </Pressable>

          {isCurrent ? (
            <Icon name="Check" size={14} color={theme.colors.statusSuccess} />
          ) : topSearchMatch &&
            topSearchMatch.provider.id === provider.id &&
            topSearchMatch.model.id === model.id ? (
            <Text style={[styles.modeBadge, { color: theme.colors.accent }]}>↵</Text>
          ) : (
            <Icon
              name={isSameProvider ? "Zap" : "ArrowRight"}
              size={13}
              color={theme.colors.foregroundMuted}
            />
          )}
        </View>

        {hasThinking && thinkingExpanded ? (
          <View style={styles.thinkingRow}>
            {model.thinkingOptions!.map((opt) => {
              const activeOpt = isCurrent && agentInfo?.thinkingOptionId === opt.id;
              return (
                <Pressable
                  key={opt.id}
                  accessibilityRole="button"
                  disabled={disabled}
                  onPress={() => void handleSelectModel(provider, model, opt.id)}
                  style={[styles.thinkingChip, activeOpt ? styles.thinkingChipActive : null]}
                >
                  <Text style={styles.thinkingChipText}>
                    {opt.label}
                    {opt.isDefault ? " · 默认" : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>切换模型</Text>
        {agentInfo ? (
          <View style={styles.currentPill}>
            <Text numberOfLines={1} style={styles.currentPillText}>
              {agentInfo.provider} / {shortModelName(agentInfo.model)}
            </Text>
          </View>
        ) : null}
      </View>

      {switchBackTarget ? (
        <Pressable
          accessibilityRole="button"
          disabled={Boolean(switchingTarget)}
          onPress={() =>
            void handleSelectModel(
              switchBackTarget.provider,
              switchBackTarget.model,
              switchBackTarget.thinkingOptionId,
            )
          }
          style={styles.switchBackBtn}
        >
          <Icon name="Undo2" size={14} color={theme.colors.accent} />
          <Text numberOfLines={1} style={styles.switchBackText}>
            一键切回 {switchBackTarget.provider.label} / {switchBackTarget.model.label}
            {switchBackTarget.thinkingOptionId ? ` @${switchBackTarget.thinkingOptionId}` : ""}
          </Text>
          <Text style={[styles.modeBadge, { color: theme.colors.accent }]}>/m back</Text>
        </Pressable>
      ) : null}

      <View style={styles.searchBox}>
        <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索 Provider 或模型名（回车直切）…"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.searchInput}
          autoFocus={isPopover && !compact}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="go"
          onSubmitEditing={() => {
            if (topSearchMatch) {
              void handleSelectModel(topSearchMatch.provider, topSearchMatch.model);
            }
          }}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清除搜索"
            onPress={() => setQuery("")}
          >
            <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      {allProviders.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.filterRow}>
            {[
              { id: "all", label: "全部" },
              ...allProviders.map((p) => ({ id: p.id, label: p.label })),
            ].map((tab) => {
              const active = providerFilter === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  accessibilityRole="button"
                  onPress={() => setProviderFilter(tab.id)}
                  style={[styles.filterChip, active ? styles.filterChipActive : null]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      active ? styles.filterChipTextActive : null,
                    ]}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : null}

      {agentInfo?.status === "running" ? (
        <View style={styles.runningBanner}>
          <Text style={styles.runningText}>
            会话正在运行中：同 Provider 可直接切；跨 Provider 可勾选下方立即中断并切换。
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setForceStopRunning((prev) => !prev)}
            style={styles.toggleButton}
          >
            <Icon
              name={forceStopRunning ? "CheckSquare" : "Square"}
              size={13}
              color={theme.colors.statusWarning}
            />
            <Text style={styles.runningText}>停止当前输出并强制切换</Text>
          </Pressable>
        </View>
      ) : null}

      {errorText ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorText}</Text>
        </View>
      ) : null}

      {switchingTarget ? (
        <View style={styles.switchingOverlay}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.modelName}>正在切换至 {switchingTarget}…</Text>
        </View>
      ) : null}

      {catalogQuery.isLoading ? (
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.modelSub}>正在加载可用模型目录…</Text>
        </View>
      ) : catalogQuery.isError ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.errorText}>无法加载模型列表，请稍后重试</Text>
        </View>
      ) : filteredProviders.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.modelSub}>没有匹配的模型</Text>
        </View>
      ) : (
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {quickEntries.length > 0 ? (
            <View>
              <View style={styles.providerHeader}>
                <Text style={styles.providerLabel}>置顶与最近使用</Text>
                <Text style={[styles.modeBadge, { color: theme.colors.foregroundMuted }]}>
                  点击星标可固定
                </Text>
              </View>
              {quickEntries.map((entry) =>
                renderModelRow(entry.provider, entry.model, "quick", true),
              )}
            </View>
          ) : null}

          {filteredProviders.map((provider) => {
            const isSameProvider = provider.id === agentInfo?.provider;
            return (
              <View key={provider.id}>
                <View style={styles.providerHeader}>
                  <Text style={styles.providerLabel}>{provider.label}</Text>
                  <Text
                    style={[
                      styles.modeBadge,
                      {
                        color: isSameProvider
                          ? theme.colors.statusSuccess
                          : theme.colors.accent,
                      },
                    ]}
                  >
                    {isSameProvider ? "原地热切" : "跨 Provider 无感续接"}
                  </Text>
                </View>

                {provider.models.map((model) =>
                  renderModelRow(provider, model, "all", false),
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {showNoteInput ? (
        <View style={styles.noteBox}>
          <TextInput
            value={handoffNote}
            onChangeText={setHandoffNote}
            placeholder="附带静默交接指令（例如：只做代码审查，不要改文件）"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.searchInput}
          />
        </View>
      ) : null}

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setArchiveOverride(!archivePrevious)}
          style={styles.toggleButton}
        >
          <Icon
            name={archivePrevious ? "CheckSquare" : "Square"}
            size={13}
            color={archivePrevious ? theme.colors.accent : theme.colors.foregroundMuted}
          />
          <Text style={styles.footerText}>归档旧会话</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => setShowNoteInput((prev) => !prev)}
          style={styles.toggleButton}
        >
          <Icon
            name="StickyNote"
            size={13}
            color={handoffNote.trim() ? theme.colors.accent : theme.colors.foregroundMuted}
          />
          <Text style={styles.footerText}>
            {handoffNote.trim() ? "已填交接备注" : "交接备注"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function createPopoverComponent(
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[],
) {
  return function ModelSwitcherPopover(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null;
    return (
      <ModelSwitcherBody
        agentId={props.agentId}
        theme={props.theme}
        compact={props.layout.compact}
        isPopover={true}
        getComposers={getComposers}
        onDone={props.close}
      />
    );
  };
}

export function createAgentPanelComponent(
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[],
) {
  return function ModelSwitcherPanel(props: PluginAgentPanelProps) {
    return (
      <ModelSwitcherBody
        agentId={props.params.agentId}
        theme={props.theme}
        compact={props.layout.compact}
        isPopover={false}
        getComposers={getComposers}
        openAgent={props.navigation?.openAgent}
      />
    );
  };
}
