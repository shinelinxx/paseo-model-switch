import { settingsRpc } from "@getpaseo/plugin";
import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import {
  listCatalogRpc,
  recordRecentRpc,
  SWITCH_BANNER_KIND,
  SWITCH_FROM_MODEL_KEY,
  SWITCH_FROM_PROVIDER_KEY,
  SWITCH_FROM_THINKING_KEY,
  SWITCH_HOP_META_KEY,
  SwitchBannerDataSchema,
  switchModelRpc,
} from "./shared/contracts";
import { ComposerTriggerStyleSchema, type ComposerTriggerStyle } from "./shared/settings";
import { createBannerRenderer } from "./client/banner-renderer";
import { ModelSwitchSettingsScreen } from "./client/settings-screen";
import { executeModelSwitch, resolveTargetFromSlashArgs } from "./client/switch-runner";
import { createAgentPanelComponent, createPopoverComponent } from "./client/switcher-popover";
import { createToolbarComposerItem } from "./client/toolbar-item";
import { getTriggerStyle, setTriggerStyle, subscribeTriggerStyle } from "./client/trigger-style-bus";

interface TrackedAgentInfo {
  id: string;
  workspaceId: string | null;
  provider: string;
  model: string | null;
  archivedAt: string | null;
  background: boolean;
  hopCount: number | undefined;
}

interface PillEntry {
  reg: PluginButtonRegistration;
  title: string;
  label: string;
  workspaceId: string;
}

function projectTrackedAgent(agent: {
  id: string;
  workspaceId?: string | null;
  provider: string;
  model?: string | null;
  archivedAt?: string | null;
  background?: boolean;
  metadata?: Readonly<Record<string, JsonValue>> | null;
}): TrackedAgentInfo {
  const rawHop = agent.metadata?.[SWITCH_HOP_META_KEY];
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    provider: agent.provider,
    model: agent.model ?? null,
    archivedAt: agent.archivedAt ?? null,
    background: Boolean(agent.background),
    hopCount: typeof rawHop === "number" ? rawHop : undefined,
  };
}

function formatCompactPillLabel(hopCount?: number): string {
  // Paseo already shows the active model name natively; keep the pill ultra-slim (~75% narrower)
  return hopCount && hopCount >= 1 ? `×${hopCount}` : "切";
}

export default function contribute(client: PluginClientContext) {
  const getComposers = client.composers.bind(client);
  const SwitcherPopover = createPopoverComponent(getComposers);
  const SwitcherPanel = createAgentPanelComponent(getComposers);
  const SwitchBannerRenderer = createBannerRenderer(getComposers);
  const ToolbarComposerItem = createToolbarComposerItem(getComposers);

  const removeTimelineRenderer = client.addTimelineRenderer({
    kind: SWITCH_BANNER_KIND,
    version: 1,
    schema: SwitchBannerDataSchema,
    Component: SwitchBannerRenderer,
  });

  const removeSettings = client.addSettingsScreen({
    id: "model-switch-settings",
    title: "Model Switch",
    icon: "ArrowLeftRight",
    Component: ModelSwitchSettingsScreen,
  });

  const removeComposerItem = client.addComposerItem({
    id: "model-switch-toolbar",
    Component: ToolbarComposerItem,
  });

  const removePanel = client.addAgentPanel({
    id: "model-switch-panel",
    title: "切换模型",
    icon: "ArrowLeftRight",
    Component: SwitcherPanel,
  });

  const removeCommand = client.addCommandCenterItem({
    id: "model-switch-command",
    title: "切换模型 / 跨 Provider 续接会话",
    icon: "ArrowLeftRight",
    keywords: ["model", "provider", "switch", "handoff", "back", "切换", "模型"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("model-switch-panel");
    },
  });

  const handleSlashSubmit = async ({
    args,
    agent,
    paseo,
    rpc,
    openPanel,
    composers,
  }: {
    args: string;
    agent: {
      id: string;
      provider: string;
      model: string | null;
      cwd: string;
      status: string;
      metadata: Readonly<Record<string, JsonValue>>;
    };
    paseo: PluginClientContext["paseo"];
    rpc: PluginClientContext["rpc"];
    openPanel: (id: string) => void;
    composers: PluginClientContext["composers"];
  }) => {
    const trimmed = args.trim();
    if (!trimmed) {
      openPanel("model-switch-panel");
      return;
    }

    const catalog = await rpc(listCatalogRpc, { cwd: agent.cwd });
    const fromProvider =
      typeof agent.metadata?.[SWITCH_FROM_PROVIDER_KEY] === "string"
        ? (agent.metadata[SWITCH_FROM_PROVIDER_KEY] as string)
        : null;
    const fromModel =
      typeof agent.metadata?.[SWITCH_FROM_MODEL_KEY] === "string"
        ? (agent.metadata[SWITCH_FROM_MODEL_KEY] as string)
        : null;
    const fromThinkingOptionId =
      typeof agent.metadata?.[SWITCH_FROM_THINKING_KEY] === "string"
        ? (agent.metadata[SWITCH_FROM_THINKING_KEY] as string)
        : null;

    const resolved = resolveTargetFromSlashArgs(trimmed, catalog.providers, {
      currentProvider: agent.provider,
      currentModel: agent.model,
      fromProvider,
      fromModel,
      fromThinkingOptionId,
      recent: catalog.recent,
    });

    if ("error" in resolved) {
      if (resolved.error === "empty") {
        openPanel("model-switch-panel");
        return;
      }
      throw new Error(resolved.error);
    }

    await executeModelSwitch(
      {
        agentId: agent.id,
        currentProvider: agent.provider,
        targetProvider: resolved.provider.id,
        targetModel: resolved.model.id,
        targetModelLabel: resolved.model.label,
        targetThinkingOptionId: resolved.thinkingOptionId,
        followUpPrompt: resolved.followUpPrompt,
        handoffNote: resolved.handoffNote,
        stopRunning: resolved.stopRunning,
      },
      {
        paseo,
        getComposers: composers,
        invokeSwitch: (input) => rpc(switchModelRpc, input),
        recordRecent: (input) => rpc(recordRecentRpc, input),
      },
    );
  };

  const removeSlashM = client.addSlashCommand({
    name: "m",
    description: "无感切换模型（支持 back、@思考档位、--force、--note 与附带下一句消息）",
    argumentHint: "<provider/model[@thinking] | back> [--force] [--note=\"备注\"] [继续说的话]",
    context: "agent",
    onSubmit: handleSlashSubmit,
  });

  const removeSlashSwitch = client.addSlashCommand({
    name: "switch",
    description: "无感切换当前会话模型或跨 Provider 续接",
    argumentHint: "<provider/model[@thinking] | back> [--force] [继续说的话]",
    context: "agent",
    onSubmit: handleSlashSubmit,
  });

  const pills = new Map<string, PillEntry>();
  const trackedAgents = new Map<string, TrackedAgentInfo>();
  const lifetime = new AbortController();
  let styleReady = false;
  let unsubscribeAgents: (() => void) | null = null;

  const syncPillForAgent = (agent: TrackedAgentInfo, style: ComposerTriggerStyle) => {
    if (lifetime.signal.aborted || !styleReady) return;

    const hopCount = agent.hopCount;
    const shouldShow =
      Boolean(agent.workspaceId) &&
      !agent.archivedAt &&
      !agent.background &&
      (style === "compact" || (style === "when-switched" && Boolean(hopCount && hopCount >= 1)));

    const existing = pills.get(agent.id);
    if (!shouldShow || !agent.workspaceId) {
      if (existing) {
        existing.reg.remove();
        pills.delete(agent.id);
      }
      return;
    }

    const label = formatCompactPillLabel(hopCount);
    const title = `切换模型（当前：${agent.provider}/${agent.model || "default"}${hopCount ? ` · 第 ${hopCount} 次接力` : ""}）`;

    if (existing) {
      if (existing.workspaceId === agent.workspaceId) {
        if (existing.title !== title || existing.label !== label) {
          existing.reg.update({ title, label });
          existing.title = title;
          existing.label = label;
        }
        return;
      }
      existing.reg.remove();
      pills.delete(agent.id);
    }

    const reg = client.addComposerPill({
      id: "model-switch-pill",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title,
        label,
        icon: "ArrowLeftRight",
        behavior: {
          kind: "popover",
          Content: SwitcherPopover,
        },
      },
    });
    pills.set(agent.id, { reg, title, label, workspaceId: agent.workspaceId });
  };

  const syncAllPills = (style: ComposerTriggerStyle) => {
    if (lifetime.signal.aborted || !styleReady) return;
    for (const agent of trackedAgents.values()) {
      syncPillForAgent(agent, style);
    }
  };

  const removeAllPills = () => {
    for (const pill of pills.values()) {
      pill.reg.remove();
    }
    pills.clear();
  };

  const unsubscribeStyle = subscribeTriggerStyle((style) => {
    styleReady = true;
    syncAllPills(style);
  });

  // Gate initial pill creation on startup settings read so pills never mount-then-unmount flicker
  void client
    .rpc(settingsRpc("model-switch").read, {})
    .then((res) => {
      if (lifetime.signal.aborted) return;
      if (res.status === "ready") {
        const values = res.values as Record<string, unknown> | null;
        const parsed = ComposerTriggerStyleSchema.safeParse(values?.composerTriggerStyle);
        if (parsed.success) {
          setTriggerStyle(parsed.data);
        }
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (lifetime.signal.aborted) return;
      if (!styleReady) {
        styleReady = true;
        syncAllPills(getTriggerStyle());
      }
    });

  void client.paseo.agents
    .list({ scope: "active", subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) {
        void subscription.release().catch(() => undefined);
        return undefined;
      }
      unsubscribeAgents = subscription.subscribe({
        snapshot: ({ entries }) => {
          const nextIds = new Set<string>();
          const style = getTriggerStyle();
          for (const { agent } of entries) {
            const projected = projectTrackedAgent(agent);
            nextIds.add(projected.id);
            trackedAgents.set(projected.id, projected);
            syncPillForAgent(projected, style);
          }
          for (const existingId of Array.from(trackedAgents.keys())) {
            if (!nextIds.has(existingId)) {
              trackedAgents.delete(existingId);
            }
          }
          for (const [pillAgentId, pill] of Array.from(pills.entries())) {
            if (!nextIds.has(pillAgentId)) {
              pill.reg.remove();
              pills.delete(pillAgentId);
            }
          }
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            const projected = projectTrackedAgent(update.agent);
            trackedAgents.set(projected.id, projected);
            syncPillForAgent(projected, getTriggerStyle());
          } else {
            trackedAgents.delete(update.agentId);
            const existing = pills.get(update.agentId);
            if (existing) {
              existing.reg.remove();
              pills.delete(update.agentId);
            }
          }
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) {
        console.error("[model-switch] Agent observation failed:", error);
      }
    });

  return () => {
    lifetime.abort();
    unsubscribeAgents?.();
    unsubscribeAgents = null;
    unsubscribeStyle();
    removeAllPills();
    trackedAgents.clear();
    removeSlashSwitch();
    removeSlashM();
    removeCommand();
    removePanel();
    removeComposerItem();
    removeSettings();
    removeTimelineRenderer();
  };
}
