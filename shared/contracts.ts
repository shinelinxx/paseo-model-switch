import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ThinkingOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean().optional(),
});

export const CatalogModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  contextWindowMaxTokens: z.number().optional(),
  defaultThinkingOptionId: z.string().optional(),
  thinkingOptions: z.array(ThinkingOptionSchema).optional(),
});

export const CatalogModeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  colorTier: z.string().optional(),
  isUnattended: z.boolean().optional(),
});

export const CatalogProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ready", "loading", "error", "unavailable"]),
  defaultModeId: z.string().nullable().optional(),
  modes: z.array(CatalogModeSchema),
  models: z.array(CatalogModelSchema),
});

export type CatalogProvider = z.infer<typeof CatalogProviderSchema>;
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type CatalogMode = z.infer<typeof CatalogModeSchema>;
export type ThinkingOption = z.infer<typeof ThinkingOptionSchema>;

export const ModelRefSchema = z.object({
  provider: z.string(),
  model: z.string(),
  thinkingOptionId: z.string().optional(),
  label: z.string().optional(),
  usedAt: z.string().optional(),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

export const listCatalogRpc = defineRpc({
  name: "catalog.list",
  input: z.object({
    cwd: z.string().optional(),
  }),
  output: z.object({
    providers: z.array(CatalogProviderSchema),
    recent: z.array(ModelRefSchema),
    pinned: z.array(ModelRefSchema),
  }),
});

export const togglePinRpc = defineRpc({
  name: "preferences.pin.toggle",
  input: z.object({
    provider: z.string(),
    model: z.string(),
    label: z.string().optional(),
  }),
  output: z.object({
    pinned: z.boolean(),
    items: z.array(ModelRefSchema),
  }),
});

export const recordRecentRpc = defineRpc({
  name: "preferences.recent.record",
  input: z.object({
    provider: z.string(),
    model: z.string(),
    thinkingOptionId: z.string().optional(),
    label: z.string().optional(),
  }),
  output: z.object({
    items: z.array(ModelRefSchema),
  }),
});

export const switchModelRpc = defineRpc({
  name: "session.switch",
  input: z.object({
    agentId: z.string(),
    targetProvider: z.string(),
    targetModel: z.string(),
    targetThinkingOptionId: z.string().optional(),
    targetModeId: z.string().optional(),
    followUpPrompt: z.string().optional(),
    handoffNote: z.string().optional(),
    stopRunning: z.boolean().optional(),
    archivePreviousOverride: z.boolean().optional(),
  }),
  output: z.object({
    kind: z.enum(["migrated"]),
    switchId: z.string(),
    newAgentId: z.string(),
    previousAgentId: z.string(),
    workspaceId: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    turnsCarried: z.number(),
    totalTurns: z.number(),
    archivedPrevious: z.boolean(),
    archiveSkippedReason: z.string().optional(),
    modeMapped: z.string().nullable(),
    transcriptPath: z.string(),
  }),
});

export const PreviewTurnSchema = z.object({
  turnIndex: z.number(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  timestamp: z.string().optional(),
});

export type PreviewTurn = z.infer<typeof PreviewTurnSchema>;

export const LineageHopSchema = z.object({
  switchId: z.string(),
  hop: z.number(),
  fromProvider: z.string(),
  fromModel: z.string(),
  fromThinkingOptionId: z.string().nullable().optional(),
  toProvider: z.string(),
  toModel: z.string(),
  createdAt: z.string(),
  turnsInSegment: z.number(),
});

export type LineageHop = z.infer<typeof LineageHopSchema>;

export const SwitchBannerDataSchema = z.object({
  switchId: z.string(),
  fromProvider: z.string(),
  fromModel: z.string(),
  fromThinkingOptionId: z.string().nullable().optional(),
  toProvider: z.string(),
  toModel: z.string(),
  turnsCarried: z.number(),
  totalTurns: z.number(),
  hopCount: z.number(),
  filesTouched: z.array(z.string()),
  gitBranch: z.string().nullable(),
  modeMapped: z.string().nullable(),
  transcriptPath: z.string(),
  handoffNote: z.string().optional(),
  previewTurns: z.array(PreviewTurnSchema),
  lineage: z.array(LineageHopSchema).optional(),
});

export type SwitchBannerData = z.infer<typeof SwitchBannerDataSchema>;

export const getSwitchRecordRpc = defineRpc({
  name: "record.get",
  input: z.object({
    switchId: z.string(),
    hopSwitchId: z.string().optional(),
    query: z.string().optional(),
  }),
  output: z.object({
    found: z.boolean(),
    transcriptPreview: z.string().optional(),
    transcriptPath: z.string().optional(),
    totalChars: z.number().optional(),
    lineage: z.array(LineageHopSchema).optional(),
  }),
});

export const SWITCH_BANNER_KIND = "model-switch-banner";
export const SWITCH_META_KEY = "modelSwitch.switchId";
export const SWITCH_HOP_META_KEY = "modelSwitch.hopCount";
export const SWITCH_FROM_AGENT_KEY = "modelSwitch.fromAgentId";
export const SWITCH_FROM_PROVIDER_KEY = "modelSwitch.fromProvider";
export const SWITCH_FROM_MODEL_KEY = "modelSwitch.fromModel";
export const SWITCH_FROM_THINKING_KEY = "modelSwitch.fromThinkingOptionId";
