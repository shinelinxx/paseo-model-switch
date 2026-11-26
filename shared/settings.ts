import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const ComposerTriggerStyleSchema = z.enum([
  "compact",
  "toolbar",
  "when-switched",
  "hidden",
]);

export type ComposerTriggerStyle = z.infer<typeof ComposerTriggerStyleSchema>;

export const ModelSwitchSettingsSchema = z.object({
  composerTriggerStyle: ComposerTriggerStyleSchema.default("compact"),
  archivePreviousAgent: z.boolean().default(true),
  recentTurnsVerbatim: z.number().int().min(1).max(30).default(8),
  maxContextChars: z.number().int().min(4000).max(160000).default(36000),
  includeGitContext: z.boolean().default(true),
  includeRecentDiffs: z.boolean().default(true),
  includeUncommittedPatch: z.boolean().default(true),
  autoMapMode: z.boolean().default(true),
  showSwitchBanner: z.boolean().default(true),
});

export type ModelSwitchSettings = z.infer<typeof ModelSwitchSettingsSchema>;

export const DEFAULT_MODEL_SWITCH_SETTINGS: ModelSwitchSettings = {
  composerTriggerStyle: "compact",
  archivePreviousAgent: true,
  recentTurnsVerbatim: 8,
  maxContextChars: 36000,
  includeGitContext: true,
  includeRecentDiffs: true,
  includeUncommittedPatch: true,
  autoMapMode: true,
  showSwitchBanner: true,
};

export const modelSwitchSettings = defineSettings({
  id: "model-switch",
  scope: "host",
  version: 3,
  schema: ModelSwitchSettingsSchema,
  migrate(values) {
    if (!values || typeof values !== "object") {
      return DEFAULT_MODEL_SWITCH_SETTINGS;
    }
    const raw = values as Record<string, unknown>;
    const shape = ModelSwitchSettingsSchema.shape;
    const sanitized: Record<string, unknown> = { ...DEFAULT_MODEL_SWITCH_SETTINGS };
    for (const key of Object.keys(shape) as Array<keyof ModelSwitchSettings>) {
      if (raw[key] !== undefined) {
        const parsed = shape[key].safeParse(raw[key]);
        if (parsed.success) {
          sanitized[key] = parsed.data;
        }
      }
    }
    return sanitized as ModelSwitchSettings;
  },
});
