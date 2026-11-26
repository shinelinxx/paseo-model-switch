import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  modelSwitchSettings,
  type ComposerTriggerStyle,
  type ModelSwitchSettings,
} from "../shared/settings";
import { setTriggerStyle } from "./trigger-style-bus";

const TRIGGER_STYLE_OPTIONS: readonly { label: string; value: ComposerTriggerStyle }[] = [
  { value: "compact", label: "极简胶囊（推荐，仅 ⇄ 与接力次数）" },
  { value: "toolbar", label: "原生工具栏控件（窄屏自动收纳）" },
  { value: "when-switched", label: "仅跨 Provider 接力后显示" },
  { value: "hidden", label: "完全隐藏（仅用 /m 与 ⌘K）" },
];

export function ModelSwitchSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(modelSwitchSettings);

  const [turnsError, setTurnsError] = useState<string | null>(null);
  const [charsError, setCharsError] = useState<string | null>(null);

  const turnsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const charsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<{ values: ModelSwitchSettings; revision: string } | null>(null);

  const readyValues = settings.status === "ready" ? settings.values : null;
  const readyRevision = settings.status === "ready" ? settings.revision : null;

  useEffect(() => {
    if (readyValues && readyRevision !== null) {
      latestRef.current = { values: readyValues, revision: readyRevision };
    }
  }, [readyValues, readyRevision]);

  useEffect(() => {
    return () => {
      if (turnsTimerRef.current) clearTimeout(turnsTimerRef.current);
      if (charsTimerRef.current) clearTimeout(charsTimerRef.current);
    };
  }, []);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 16,
      },
      errorText: {
        color: theme.colors.statusDanger,
        fontSize: 13,
      },
    }),
    [theme, layout.compact],
  );

  if (settings.status === "loading") {
    return <Loading />;
  }

  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.errorText}>无法读取设置：{settings.error}</Text>
      </View>
    );
  }

  const values = settings.values;
  const revision = settings.revision;

  const updateImmediate = (patch: Partial<ModelSwitchSettings>) => {
    const next = { ...values, ...patch };
    if (patch.composerTriggerStyle) {
      setTriggerStyle(patch.composerTriggerStyle);
    }
    void settings.save(next, revision);
  };

  const handleTurnsChange = (text: string) => {
    if (turnsTimerRef.current) clearTimeout(turnsTimerRef.current);
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) {
      setTurnsError("请输入 1 到 30 之间的整数");
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed < 1 || parsed > 30) {
      setTurnsError("范围需在 1–30 之间");
      return;
    }
    setTurnsError(null);
    turnsTimerRef.current = setTimeout(() => {
      const snap = latestRef.current;
      if (!snap || snap.values.recentTurnsVerbatim === parsed) return;
      void settings.save({ ...snap.values, recentTurnsVerbatim: parsed }, snap.revision);
    }, 450);
  };

  const handleCharsChange = (text: string) => {
    if (charsTimerRef.current) clearTimeout(charsTimerRef.current);
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) {
      setCharsError("请输入 4000 到 160000 之间的整数");
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed < 4000 || parsed > 160000) {
      setCharsError("范围需在 4000–160000 之间");
      return;
    }
    setCharsError(null);
    charsTimerRef.current = setTimeout(() => {
      const snap = latestRef.current;
      if (!snap || snap.values.maxContextChars === parsed) return;
      void settings.save({ ...snap.values, maxContextChars: parsed }, snap.revision);
    }, 450);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SettingsSection title="输入栏与切换行为">
        <SettingsCard>
          <SettingsSelect<ComposerTriggerStyle>
            label="输入栏触发入口样式"
            hint="避免与 Paseo 原生模型选择器视觉重复，保持输入栏清爽。"
            value={values.composerTriggerStyle}
            options={TRIGGER_STYLE_OPTIONS}
            disabled={settings.saving}
            onValueChange={(style) => updateImmediate({ composerTriggerStyle: style })}
          />
          <SettingsSwitch
            label="跨 Provider 切换后自动归档旧会话"
            hint="开启后旧会话自动归档；若旧会话有活跃子 Agent 或后台任务会自动跳过以防级联中断。"
            value={values.archivePreviousAgent}
            disabled={settings.saving}
            onValueChange={(v) => updateImmediate({ archivePreviousAgent: v })}
          />
          <SettingsSwitch
            label="自动映射等价权限模式"
            hint="精确映射 full-access / auto / accept-edits / plan，并双向同步 OpenCode 的 auto_accept 选项。"
            value={values.autoMapMode}
            disabled={settings.saving}
            onValueChange={(v) => updateImmediate({ autoMapMode: v })}
          />
          <SettingsSwitch
            label="在新会话顶部显示切换分割卡片"
            hint="渲染一条可折叠卡片，支持查看多跳链路与搜索记录。"
            value={values.showSwitchBanner}
            disabled={settings.saving}
            onValueChange={(v) => updateImmediate({ showSwitchBanner: v })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="上下文保真策略">
        <SettingsCard>
          <SettingsSwitch
            label="附带工作区 Git 状态"
            hint="自动注入当前分支名、git status 和 diff stat。"
            value={values.includeGitContext}
            disabled={settings.saving}
            onValueChange={(v) => updateImmediate({ includeGitContext: v })}
          />
          <SettingsSwitch
            label="保留最近 3 轮的编辑 Diff 与报错输出"
            hint="当因构建/测试报错切换模型时，优先把完整报错栈、近期修改片段和中断时的思考摘要带给新模型。"
            value={values.includeRecentDiffs}
            disabled={settings.saving}
            onValueChange={(v) => updateImmediate({ includeRecentDiffs: v })}
          />
          <SettingsSwitch
            label="附带未提交 Git Patch 预览"
            hint="工作区有未提交修改时附带精简 diff 片段（上限 2400 字符）。"
            value={values.includeUncommittedPatch}
            disabled={settings.saving}
            onValueChange={(v) => updateImmediate({ includeUncommittedPatch: v })}
          />
          <SettingsInput
            label="最近原文保留轮数 (1–30)"
            hint="最近 N 轮完整保留对话原文，更早轮次自动压缩为结构化摘要（输入后自动保存）。"
            initialValue={String(values.recentTurnsVerbatim)}
            error={turnsError}
            onChangeText={handleTurnsChange}
          />
          <SettingsInput
            label="最大注入字符预算 (4000–160000)"
            hint="控制静默注入到 system prompt 的最大字符数，超出部分自动按需挂载检索工具。"
            initialValue={String(values.maxContextChars)}
            error={charsError}
            onChangeText={handleCharsChange}
          />
        </SettingsCard>
      </SettingsSection>

      {settings.saveError ? (
        <Text style={styles.errorText}>保存失败：{settings.saveError}</Text>
      ) : null}
    </ScrollView>
  );
}
