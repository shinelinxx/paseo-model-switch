import {
  useComposer,
  usePaseo,
  useRpc,
  useSettings,
  type PluginComposer,
  type PluginComposerItemProps,
  type PluginComposerSelector,
} from "@getpaseo/plugin/client";
import { Combobox, type ComboboxItem, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { listCatalogRpc, recordRecentRpc, switchModelRpc } from "../shared/contracts";
import { DEFAULT_MODEL_SWITCH_SETTINGS, modelSwitchSettings } from "../shared/settings";
import { executeModelSwitch } from "./switch-runner";
import { setTriggerStyle } from "./trigger-style-bus";

interface SwitchComboboxItem extends ComboboxItem {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  defaultThinkingOptionId?: string;
}

export function createToolbarComposerItem(
  getComposers: (selector: PluginComposerSelector) => readonly PluginComposer[],
) {
  const ToolbarCombobox = memo(function ToolbarCombobox() {
    const composer = useComposer();
    const composerRef = useRef(composer);
    useEffect(() => {
      composerRef.current = composer;
    }, [composer]);

    const paseo = usePaseo();
    const toast = useToast();
    const queryClient = useQueryClient();
    const listCatalog = useRpc(listCatalogRpc);
    const invokeSwitch = useRpc(switchModelRpc);
    const recordRecent = useRpc(recordRecentRpc);

    const currentProvider = composer.agent.provider ?? "";
    const currentModel = composer.agent.model ?? "";
    const composerContext = composer.context;

    const search = useCallback(
      async ({ query }: { query: string }): Promise<readonly SwitchComboboxItem[]> => {
        const catalog = await queryClient.fetchQuery({
          queryKey: ["model-switch", "catalog", ""],
          queryFn: () => listCatalog({}),
          staleTime: 20_000,
        });
        const needle = query.trim().toLowerCase();
        const items: SwitchComboboxItem[] = [];

        for (const provider of catalog.providers) {
          for (const model of provider.models) {
            const matches =
              !needle ||
              provider.id.toLowerCase().includes(needle) ||
              provider.label.toLowerCase().includes(needle) ||
              model.id.toLowerCase().includes(needle) ||
              model.label.toLowerCase().includes(needle);
            if (!matches) continue;

            const isSame = provider.id === currentProvider;
            items.push({
              id: `${provider.id}/${model.id}`,
              label: `${provider.label} · ${model.label}`,
              description:
                composerContext === "agent"
                  ? isSame
                    ? "原地热切"
                    : "跨 Provider 无感续接"
                  : model.id,
              providerId: provider.id,
              providerLabel: provider.label,
              modelId: model.id,
              modelLabel: model.label,
              defaultThinkingOptionId: model.defaultThinkingOptionId,
            });
          }
        }
        return items;
      },
      [queryClient, listCatalog, currentProvider, composerContext],
    );

    const handleSelect = useCallback(
      async ({ item }: { item: SwitchComboboxItem }) => {
        const currentComposer = composerRef.current;
        if (currentComposer.context !== "agent") {
          // Draft or new-workspace composer: switch provider + model natively in place!
          if (currentComposer.agent.provider !== item.providerId) {
            await currentComposer.setProvider(item.providerId);
          }
          await currentComposer.setModel(item.modelId);
          if (item.defaultThinkingOptionId) {
            try {
              await currentComposer.setThinking(item.defaultThinkingOptionId);
            } catch {
              // Non-fatal
            }
          }
          return;
        }

        // Same-provider agent fast path
        if (currentComposer.agent.provider === item.providerId) {
          await currentComposer.setModel(item.modelId);
          void recordRecent({
            provider: item.providerId,
            model: item.modelId,
            label: item.modelLabel,
          }).catch(() => undefined);
          toast.show(`已原地切换至 ${item.modelLabel}`, { variant: "success" });
          return;
        }

        // Resolve exact agentId matching this composer handle lazily (capture focused composer first)
        const focused = getComposers({ focused: true })[0];
        const { entries } = await paseo.agents.list({ scope: "active" });

        let matchedAgentId: string | null = null;
        let focusedCandidateId: string | null = null;
        const structuralCandidates: string[] = [];
        for (const { agent } of entries) {
          const handle = getComposers({ agentId: agent.id })[0];
          if (!handle) continue;
          if (handle === currentComposer) {
            matchedAgentId = agent.id;
            break;
          }
          if (focused && handle === focused) {
            focusedCandidateId = agent.id;
          }
          if (
            handle.context === currentComposer.context &&
            handle.agent.provider === currentComposer.agent.provider &&
            handle.agent.model === currentComposer.agent.model &&
            handle.prompt === currentComposer.prompt
          ) {
            structuralCandidates.push(agent.id);
          }
        }
        if (!matchedAgentId && structuralCandidates.length === 1) {
          matchedAgentId = structuralCandidates[0];
        }
        if (!matchedAgentId && structuralCandidates.length > 1) {
          matchedAgentId =
            (focusedCandidateId && structuralCandidates.includes(focusedCandidateId)
              ? focusedCandidateId
              : undefined) ??
            structuralCandidates.find((id) => getComposers({ agentId: id })[0] === focused) ??
            structuralCandidates[0];
        }
        if (!matchedAgentId && focusedCandidateId) {
          matchedAgentId = focusedCandidateId;
        }
        if (!matchedAgentId) {
          toast.error("未能定位当前会话，请使用 /m 命令切换。");
          return;
        }

        const outcome = await executeModelSwitch(
          {
            agentId: matchedAgentId,
            currentProvider: currentComposer.agent.provider ?? "",
            targetProvider: item.providerId,
            targetModel: item.modelId,
            targetModelLabel: item.modelLabel,
            targetThinkingOptionId: item.defaultThinkingOptionId,
          },
          {
            paseo,
            getComposers,
            invokeSwitch,
            recordRecent,
          },
        );

        if (outcome.kind === "migrated") {
          const extra = outcome.archiveSkippedReason ? `（${outcome.archiveSkippedReason}）` : "";
          toast.show(
            `已切换至 ${item.providerLabel} / ${item.modelLabel}（继承 ${outcome.totalTurns} 轮上下文）${extra}`,
            { variant: "success" },
          );
        }
      },
      [paseo, invokeSwitch, recordRecent, toast],
    );

    const value = useMemo(() => {
      const currentLabel = currentModel
        ? currentModel.split("/").pop() || currentModel
        : currentProvider || "切换模型";
      return {
        id: `${currentProvider}/${currentModel}`,
        label: currentLabel,
      };
    }, [currentProvider, currentModel]);

    return (
      <Combobox<SwitchComboboxItem>
        title="切换模型 / 跨 Provider 续接"
        icon="ArrowLeftRight"
        value={value}
        search={search}
        onSelect={handleSelect}
      />
    );
  });

  return function ModelSwitchToolbarItem(_props: PluginComposerItemProps) {
    const settingsState = useSettings(modelSwitchSettings);

    const triggerStyle =
      settingsState.status === "ready"
        ? settingsState.values.composerTriggerStyle
        : DEFAULT_MODEL_SWITCH_SETTINGS.composerTriggerStyle;

    // Keep imperative pill manager synced with live settings
    useEffect(() => {
      if (settingsState.status === "ready") {
        setTriggerStyle(triggerStyle);
      }
    }, [settingsState.status, triggerStyle]);

    if (triggerStyle !== "toolbar") {
      return null;
    }

    return <ToolbarCombobox />;
  };
}
