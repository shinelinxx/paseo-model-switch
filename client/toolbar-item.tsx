import {
  useAgents,
  useComposer,
  usePaseo,
  useRpc,
  useSettings,
  type PluginComposer,
  type PluginComposerItemProps,
  type PluginComposerSelector,
} from "@getpaseo/plugin/client";
import { Combobox, type ComboboxItem, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect } from "react";
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
  return function ModelSwitchToolbarItem(_props: PluginComposerItemProps) {
    const composer = useComposer();
    const paseo = usePaseo();
    const toast = useToast();
    const settingsState = useSettings(modelSwitchSettings);
    const listCatalog = useRpc(listCatalogRpc);
    const invokeSwitch = useRpc(switchModelRpc);
    const recordRecent = useRpc(recordRecentRpc);
    const agentRefs = useAgents();

    const triggerStyle =
      settingsState.status === "ready"
        ? settingsState.values.composerTriggerStyle
        : DEFAULT_MODEL_SWITCH_SETTINGS.composerTriggerStyle;

    // Keep imperative pill manager synced with live settings
    useEffect(() => {
      if (settingsState.status === "ready") {
        setTriggerStyle(settingsState.values.composerTriggerStyle);
      }
    }, [settingsState]);

    const search = useCallback(
      async ({ query }: { query: string }): Promise<readonly SwitchComboboxItem[]> => {
        const catalog = await listCatalog({});
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

            const isSame = provider.id === composer.agent.provider;
            items.push({
              id: `${provider.id}/${model.id}`,
              label: `${provider.label} · ${model.label}`,
              description:
                composer.context === "agent"
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
      [listCatalog, composer.agent.provider, composer.context],
    );

    const handleSelect = useCallback(
      async ({ item }: { item: SwitchComboboxItem }) => {
        if (composer.context !== "agent") {
          // Draft or new-workspace composer: switch provider + model natively in place!
          if (composer.agent.provider !== item.providerId) {
            await composer.setProvider(item.providerId);
          }
          await composer.setModel(item.modelId);
          if (item.defaultThinkingOptionId) {
            try {
              await composer.setThinking(item.defaultThinkingOptionId);
            } catch {
              // Non-fatal
            }
          }
          return;
        }

        // Same-provider agent fast path
        if (composer.agent.provider === item.providerId) {
          await composer.setModel(item.modelId);
          void recordRecent({
            provider: item.providerId,
            model: item.modelId,
            label: item.modelLabel,
          }).catch(() => undefined);
          toast.show(`已原地切换至 ${item.modelLabel}`, { variant: "success" });
          return;
        }

        // Resolve exact agentId matching this composer handle (by identity first, then structural match)
        let matchedAgentId: string | null = null;
        const structuralCandidates: string[] = [];
        for (const ref of agentRefs) {
          const handle = getComposers({ agentId: ref.id })[0];
          if (!handle) continue;
          if (handle === composer) {
            matchedAgentId = ref.id;
            break;
          }
          if (
            handle.context === composer.context &&
            handle.agent.provider === composer.agent.provider &&
            handle.agent.model === composer.agent.model &&
            handle.prompt === composer.prompt
          ) {
            structuralCandidates.push(ref.id);
          }
        }
        if (!matchedAgentId && structuralCandidates.length === 1) {
          matchedAgentId = structuralCandidates[0];
        }
        if (!matchedAgentId && structuralCandidates.length > 1) {
          const focused = getComposers({ focused: true })[0];
          matchedAgentId =
            structuralCandidates.find((id) => getComposers({ agentId: id })[0] === focused) ??
            structuralCandidates[0];
        }
        if (!matchedAgentId) {
          toast.error("未能定位当前会话，请使用 /m 命令切换。");
          return;
        }

        const outcome = await executeModelSwitch(
          {
            agentId: matchedAgentId,
            currentProvider: composer.agent.provider ?? "",
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
      [composer, agentRefs, paseo, invokeSwitch, recordRecent, toast],
    );

    if (triggerStyle !== "toolbar") {
      return null;
    }

    const currentLabel = composer.agent.model
      ? composer.agent.model.split("/").pop() || composer.agent.model
      : composer.agent.provider || "切换模型";

    return (
      <Combobox<SwitchComboboxItem>
        title="切换模型 / 跨 Provider 续接"
        icon="ArrowLeftRight"
        value={{
          id: `${composer.agent.provider ?? ""}/${composer.agent.model ?? ""}`,
          label: currentLabel,
        }}
        search={search}
        onSelect={handleSelect}
      />
    );
  };
}
