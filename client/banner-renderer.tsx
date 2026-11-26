import type { PluginTheme } from "@getpaseo/plugin";
import {
  useAgent,
  usePaseo,
  useRpc,
  type PluginComposer,
  type PluginComposerSelector,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { copyText, Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  getSwitchRecordRpc,
  recordRecentRpc,
  switchModelRpc,
  type LineageHop,
  type SwitchBannerData,
} from "../shared/contracts";
import { executeModelSwitch } from "./switch-runner";

const EMPTY_LINEAGE: readonly LineageHop[] = [];
const MAX_TRANSCRIPT_CACHE_ENTRIES = 16;

function shortModel(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

interface SwitchBannerExpandedBodyProps {
  theme: PluginTheme;
  agentId: string;
  data: SwitchBannerData;
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[];
}

const SwitchBannerExpandedBody = memo(function SwitchBannerExpandedBody({
  theme,
  agentId,
  data,
  getComposers,
}: SwitchBannerExpandedBodyProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const loadRecord = useRpc(getSwitchRecordRpc);
  const invokeSwitch = useRpc(switchModelRpc);
  const recordRecent = useRpc(recordRecentRpc);

  const currentAgent = useAgent(agentId, (a) => ({
    provider: a.provider,
    status: a.status,
  }));

  const [activeHopId, setActiveHopId] = useState<string>(data.switchId);
  const [searchQuery, setSearchQuery] = useState("");
  const [transcriptText, setTranscriptText] = useState<string | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [switchingBack, setSwitchingBack] = useState(false);

  const mountedRef = useRef(true);
  const transcriptCacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const lineage: readonly LineageHop[] = data.lineage ?? EMPTY_LINEAGE;

  const styles = useMemo(
    () => ({
      subMeta: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      body: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 8,
        gap: 8,
      },
      noteBanner: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.accent,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
      },
      noteText: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 12,
      },
      lineageRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 5,
      },
      hopChip: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      hopChipActive: {
        borderColor: theme.colors.accent,
      },
      hopChipText: {
        color: theme.colors.foreground,
        fontSize: 11,
      },
      metaRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      chip: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 7,
        paddingVertical: 3,
      },
      chipText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      turnBox: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 8,
        gap: 3,
      },
      turnRole: {
        fontSize: 11,
        fontWeight: "600" as const,
      },
      turnText: {
        color: theme.colors.foreground,
        fontSize: 12,
        lineHeight: 17,
      },
      searchRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      searchInputWrap: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        gap: 5,
      },
      searchInput: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 12,
        paddingVertical: 1,
      },
      actionsRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      actionBtn: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
      },
      actionText: {
        color: theme.colors.foreground,
        fontSize: 11,
      },
      transcriptBox: {
        maxHeight: 260,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 8,
      },
    }),
    [theme],
  );

  const fetchHopTranscript = useCallback(
    async (hopSwitchId: string, query?: string) => {
      if (loadingTranscript) return;
      const normalizedQuery = query?.trim() || "";
      const cacheKey = `${hopSwitchId}\0${normalizedQuery}`;
      const cached = transcriptCacheRef.current.get(cacheKey);
      if (cached !== undefined) {
        setActiveHopId(hopSwitchId);
        setTranscriptText(cached);
        return;
      }

      setLoadingTranscript(true);
      setActiveHopId(hopSwitchId);
      try {
        const res = await loadRecord({
          switchId: data.switchId,
          hopSwitchId,
          query: normalizedQuery || undefined,
        });
        if (!mountedRef.current) return;
        if (res.found && res.transcriptPreview) {
          const cache = transcriptCacheRef.current;
          if (cache.size >= MAX_TRANSCRIPT_CACHE_ENTRIES) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey !== undefined) cache.delete(oldestKey);
          }
          cache.set(cacheKey, res.transcriptPreview);
          setTranscriptText(res.transcriptPreview);
        } else {
          toast.show("未找到本地完整记录文件", { variant: "warning" });
        }
      } catch {
        if (mountedRef.current) {
          toast.error("读取历史记录失败");
        }
      } finally {
        if (mountedRef.current) {
          setLoadingTranscript(false);
        }
      }
    },
    [loadingTranscript, loadRecord, data.switchId, toast],
  );

  const handleSwitchBack = useCallback(async () => {
    if (switchingBack || !currentAgent) return;
    if (currentAgent.status === "running") {
      toast.show("当前会话运行中，请等待本轮结束后再切回", { variant: "warning" });
      return;
    }
    setSwitchingBack(true);
    try {
      const outcome = await executeModelSwitch(
        {
          agentId,
          currentProvider: currentAgent.provider,
          targetProvider: data.fromProvider,
          targetModel: data.fromModel,
          targetThinkingOptionId: data.fromThinkingOptionId ?? undefined,
        },
        {
          paseo,
          getComposers,
          invokeSwitch,
          recordRecent,
        },
      );
      if (!mountedRef.current) return;
      const skipTag =
        outcome.kind === "migrated" && outcome.archiveSkippedReason
          ? ` · ${outcome.archiveSkippedReason}`
          : "";
      toast.show(
        `已切回 ${data.fromProvider}/${shortModel(data.fromModel)}${data.fromThinkingOptionId ? ` @${data.fromThinkingOptionId}` : ""}${skipTag}`,
        { variant: "success" },
      );
    } catch (error) {
      if (mountedRef.current) {
        toast.error(`切回失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (mountedRef.current) {
        setSwitchingBack(false);
      }
    }
  }, [
    switchingBack,
    currentAgent,
    toast,
    agentId,
    data.fromProvider,
    data.fromModel,
    data.fromThinkingOptionId,
    paseo,
    getComposers,
    invokeSwitch,
    recordRecent,
  ]);

  const handleCopyPath = useCallback(async () => {
    try {
      await copyText(data.transcriptPath);
      if (mountedRef.current) {
        toast.show("已复制完整记录路径", { variant: "info" });
      }
    } catch {
      if (mountedRef.current) {
        toast.error("复制失败");
      }
    }
  }, [data.transcriptPath, toast]);

  return (
    <View style={styles.body}>
      {data.handoffNote ? (
        <View style={styles.noteBanner}>
          <Icon name="StickyNote" size={13} color={theme.colors.accent} />
          <Text style={styles.noteText}>交接指令：{data.handoffNote}</Text>
        </View>
      ) : null}

      {lineage.length > 1 ? (
        <View style={styles.lineageRow}>
          <Text style={styles.subMeta}>接力链路：</Text>
          {lineage.map((hop, idx) => {
            const isActive = activeHopId === hop.switchId && transcriptText !== null;
            return (
              <View key={hop.switchId} style={styles.lineageRow}>
                {idx > 0 ? (
                  <Icon name="ArrowRight" size={11} color={theme.colors.foregroundMuted} />
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void fetchHopTranscript(hop.switchId, searchQuery)}
                  style={[styles.hopChip, isActive ? styles.hopChipActive : null]}
                >
                  <Text style={styles.hopChipText}>
                    #{hop.hop} {hop.fromProvider}/{shortModel(hop.fromModel)} ({hop.turnsInSegment}轮)
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}

      <View style={styles.metaRow}>
        {data.modeMapped ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>权限模式: {data.modeMapped}</Text>
          </View>
        ) : null}
        {data.filesTouched.slice(0, 6).map((file) => (
          <View key={file} style={styles.chip}>
            <Text style={styles.chipText} numberOfLines={1}>
              {file}
            </Text>
          </View>
        ))}
      </View>

      {data.previewTurns.length > 0 ? (
        <View style={{ gap: 6 }}>
          {data.previewTurns.map((turn, idx) => (
            <View key={`${turn.turnIndex}-${turn.role}-${idx}`} style={styles.turnBox}>
              <Text
                style={[
                  styles.turnRole,
                  {
                    color:
                      turn.role === "user"
                        ? theme.colors.accent
                        : theme.colors.statusSuccess,
                  },
                ]}
              >
                {turn.role === "user"
                  ? `User · Turn ${turn.turnIndex}`
                  : `Assistant · Turn ${turn.turnIndex}`}
              </Text>
              <Text style={styles.turnText}>{turn.text}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.subMeta}>切换前暂无已完成的对话轮次。</Text>
      )}

      <View style={styles.searchRow}>
        <View style={styles.searchInputWrap}>
          <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="在完整交接记录中搜索关键词…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            onSubmitEditing={() => void fetchHopTranscript(activeHopId, searchQuery)}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => void fetchHopTranscript(activeHopId, searchQuery)}
          style={styles.actionBtn}
        >
          {loadingTranscript ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <Icon name="FileText" size={12} color={theme.colors.foreground} />
          )}
          <Text style={styles.actionText}>
            {searchQuery.trim() ? "搜索" : "完整记录"}
          </Text>
        </Pressable>
      </View>

      {transcriptText !== null ? (
        <ScrollView style={styles.transcriptBox} nestedScrollEnabled>
          <Text style={styles.turnText}>{transcriptText}</Text>
        </ScrollView>
      ) : null}

      <View style={styles.actionsRow}>
        <Pressable
          accessibilityRole="button"
          disabled={switchingBack}
          onPress={() => void handleSwitchBack()}
          style={styles.actionBtn}
        >
          {switchingBack ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            <Icon name="Undo2" size={12} color={theme.colors.accent} />
          )}
          <Text style={styles.actionText}>
            切回 {data.fromProvider}/{shortModel(data.fromModel)}
            {data.fromThinkingOptionId ? ` @${data.fromThinkingOptionId}` : ""}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => void handleCopyPath()}
          style={styles.actionBtn}
        >
          <Icon name="Copy" size={12} color={theme.colors.foreground} />
          <Text style={styles.actionText}>复制记录路径</Text>
        </Pressable>
      </View>
    </View>
  );
});

export function createBannerRenderer(
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[],
) {
  const SwitchBannerInner = memo(function SwitchBannerInner({
    theme,
    layout,
    agentId,
    item,
  }: PluginTimelineItemProps<SwitchBannerData>) {
    const data = item.data;
    const [expanded, setExpanded] = useState(false);

    const styles = useMemo(
      () => ({
        card: {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: layout.compact ? 10 : 12,
          paddingVertical: 8,
          gap: 8,
        },
        header: {
          flexDirection: "row" as const,
          alignItems: "center" as const,
          justifyContent: "space-between" as const,
          gap: 8,
        },
        headerLeft: {
          flex: 1,
          flexDirection: "row" as const,
          alignItems: "center" as const,
          gap: 7,
        },
        headline: {
          flex: 1,
          color: theme.colors.foreground,
          fontSize: 12,
          fontWeight: "500" as const,
        },
        subMeta: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
        },
        toggleBtn: {
          flexDirection: "row" as const,
          alignItems: "center" as const,
          gap: 4,
          paddingHorizontal: 7,
          paddingVertical: 3,
          borderRadius: 6,
          backgroundColor: theme.colors.surface2,
        },
        toggleText: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
        },
      }),
      [theme, layout.compact],
    );

    const handleToggleExpanded = useCallback(() => {
      setExpanded((prev) => !prev);
    }, []);

    const hopTag = data.hopCount > 1 ? ` · 第 ${data.hopCount} 次接力` : "";

    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Icon name="ArrowLeftRight" size={14} color={theme.colors.accent} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.headline} numberOfLines={2}>
                已从 {data.fromProvider}/{shortModel(data.fromModel)} 切换至 {data.toProvider}/{shortModel(data.toModel)}
              </Text>
              <Text style={styles.subMeta} numberOfLines={1}>
                已静默继承 {data.totalTurns} 轮上下文（最近 {data.turnsCarried} 轮原文）{hopTag}
                {data.gitBranch ? ` · ${data.gitBranch}` : ""}
              </Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "收起切换前上下文" : "展开切换前上下文"}
            onPress={handleToggleExpanded}
            style={styles.toggleBtn}
          >
            <Text style={styles.toggleText}>{expanded ? "收起" : "历史"}</Text>
            <Icon
              name={expanded ? "ChevronUp" : "ChevronDown"}
              size={12}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>

        {expanded ? (
          <SwitchBannerExpandedBody
            theme={theme}
            agentId={agentId}
            data={data}
            getComposers={getComposers}
          />
        ) : null}
      </View>
    );
  });

  return function SwitchBannerRenderer(props: PluginTimelineItemProps<SwitchBannerData>) {
    return <SwitchBannerInner {...props} />;
  };
}
