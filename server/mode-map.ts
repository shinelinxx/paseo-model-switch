import type { CatalogMode } from "../shared/contracts";

type ModeCategory = "plan" | "full" | "auto" | "accept-edits" | "default";

function classifyMode(mode: Pick<CatalogMode, "id" | "colorTier" | "isUnattended">): ModeCategory {
  const lower = mode.id.toLowerCase();
  if (
    lower.includes("plan") ||
    lower.includes("read-only") ||
    lower.includes("readonly") ||
    mode.colorTier === "planning"
  ) {
    return "plan";
  }
  if (
    mode.isUnattended === true ||
    mode.colorTier === "dangerous" ||
    lower.includes("full") ||
    lower.includes("bypass") ||
    lower.includes("yolo") ||
    lower.includes("unrestricted")
  ) {
    return "full";
  }
  if (lower === "accept-edits" || lower === "acceptedits" || lower.includes("accept-edit")) {
    return "accept-edits";
  }
  if (
    lower === "auto" ||
    lower.startsWith("auto-") ||
    lower === "build" ||
    lower === "agent" ||
    mode.colorTier === "moderate"
  ) {
    return "auto";
  }
  return "default";
}

export interface ModeMappingInput {
  sourceProvider?: string;
  sourceModeId: string | null | undefined;
  sourceOptions?: Readonly<Record<string, unknown>> | null;
  targetProvider?: string;
  targetModes: readonly CatalogMode[];
  targetDefaultModeId?: string | null;
}

export interface ModeMappingResult {
  modeId: string | undefined;
  providerOptions?: Record<string, unknown>;
}

export function resolveModeAndOptionsForTarget(input: ModeMappingInput): ModeMappingResult {
  const {
    sourceProvider,
    sourceModeId,
    sourceOptions,
    targetProvider,
    targetModes,
    targetDefaultModeId,
  } = input;

  // Determine semantic intent of source mode (+ opencode auto_accept option)
  let sourceCategory: ModeCategory | null = null;
  if (sourceProvider === "opencode" && sourceOptions?.auto_accept === true && sourceModeId !== "plan") {
    sourceCategory = "full";
  } else if (sourceModeId) {
    sourceCategory = classifyMode({ id: sourceModeId });
  }

  // OpenCode uses `build` + `options.auto_accept` for full unattended access
  if (targetProvider === "opencode") {
    if (sourceCategory === "plan") {
      const planMode = targetModes.find((m) => classifyMode(m) === "plan");
      return {
        modeId: planMode?.id ?? "plan",
        providerOptions: { auto_accept: false },
      };
    }
    const buildMode =
      targetModes.find((m) => m.id === "build") ??
      targetModes.find((m) => classifyMode(m) === "auto") ??
      targetModes[0];
    if (sourceCategory === "full") {
      return {
        modeId: buildMode?.id ?? targetDefaultModeId ?? "build",
        providerOptions: { auto_accept: true },
      };
    }
    return {
      modeId: buildMode?.id ?? targetDefaultModeId ?? "build",
      providerOptions: { auto_accept: false },
    };
  }

  if (targetModes.length === 0) {
    return { modeId: targetDefaultModeId ?? undefined };
  }

  if (sourceModeId) {
    // 1. Exact ID match (unless source was opencode build+auto_accept upgrading to full)
    if (!(sourceProvider === "opencode" && sourceCategory === "full")) {
      const exact = targetModes.find((m) => m.id === sourceModeId);
      if (exact) return { modeId: exact.id };
    }

    // 2. Semantic category match with exact ordering so `auto` never downgrades to `accept-edits`
    const category = sourceCategory ?? classifyMode({ id: sourceModeId });
    const preferredOrder: Record<ModeCategory, ModeCategory[]> = {
      plan: ["plan", "default"],
      full: ["full", "auto", "accept-edits", "default"],
      auto: ["auto", "accept-edits", "default", "full"],
      "accept-edits": ["accept-edits", "auto", "default"],
      default: ["default", "accept-edits", "auto"],
    };

    for (const wanted of preferredOrder[category]) {
      // Prefer exact id === "auto" when looking for "auto" category over "auto-review" etc.
      const exactIdPreferred =
        wanted === "auto"
          ? targetModes.find((m) => m.id.toLowerCase() === "auto")
          : undefined;
      if (exactIdPreferred) return { modeId: exactIdPreferred.id };

      const match = targetModes.find((m) => classifyMode(m) === wanted);
      if (match) return { modeId: match.id };
    }
  }

  if (targetDefaultModeId && targetModes.some((m) => m.id === targetDefaultModeId)) {
    return { modeId: targetDefaultModeId };
  }

  return { modeId: targetModes[0]?.id };
}

export function mapModeForTargetProvider(input: {
  sourceModeId: string | null | undefined;
  targetModes: readonly CatalogMode[];
  targetDefaultModeId?: string | null;
}): string | undefined {
  return resolveModeAndOptionsForTarget(input).modeId;
}
