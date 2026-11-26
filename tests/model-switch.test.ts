import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { resolveTargetFromSlashArgs } from "../client/switch-runner.ts";
import {
  buildCanonicalTurns,
  collectSessionOutputFiles,
  compactToolRecords,
  compileContextFromEntries,
  copyAntigravityBrainFiles,
  copyPersistedArtifactsToAntigravityBrain,
  estimateCharsPerToken,
  extractAntigravitySessionId,
  extractMentionedFilePaths,
  isReadPreviousSessionContextPermission,
  selectSafeAllowPermissionAction,
} from "../server/context.ts";
import { mapModeForTargetProvider, resolveModeAndOptionsForTarget } from "../server/mode-map.ts";
import {
  generateSwitchId,
  loadPreferences,
  loadSwitchRecord,
  pruneOldSwitchArtifacts,
  readAcrossHops,
  recordRecentModel,
  resolveDefaultHop,
  saveSwitchArtifacts,
  togglePinnedModel,
} from "../server/storage.ts";
import { IncrementalTimelineCache } from "../server/turn-cache.ts";
import {
  DEFAULT_MODEL_SWITCH_SETTINGS,
  ModelSwitchSettingsSchema,
  modelSwitchSettings,
} from "../shared/settings.ts";
import type { CatalogProvider } from "../shared/contracts.ts";

const SAMPLE_PROVIDERS: CatalogProvider[] = [
  {
    id: "codex",
    label: "Codex",
    status: "ready",
    defaultModeId: "auto",
    modes: [
      { id: "auto", label: "Default", colorTier: "moderate" },
      { id: "auto-review", label: "Auto-review", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
    models: [
      {
        id: "gpt-6.2-sol",
        label: "GPT-6.2-Sol",
        isDefault: true,
        contextWindowMaxTokens: 200000,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high", isDefault: true },
          { id: "xhigh", label: "xhigh" },
          { id: "ultra", label: "ultra" },
        ],
      },
      { id: "gpt-6-sol", label: "GPT-6-Sol" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    status: "ready",
    defaultModeId: "build",
    modes: [
      { id: "build", label: "Build", colorTier: "moderate" },
      { id: "plan", label: "Plan", colorTier: "planning" },
    ],
    models: [
      { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free", isDefault: true },
      { id: "tencent/deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" },
      { id: "tencent/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro 0813" },
    ],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    status: "ready",
    defaultModeId: "default",
    modes: [
      { id: "default", label: "Default" },
      { id: "accept-edits", label: "Accept edits" },
      { id: "auto", label: "Auto" },
      { id: "plan", label: "Plan" },
      { id: "full-access", label: "Full access", colorTier: "dangerous", isUnattended: true },
    ],
    models: [
      {
        id: "gemini-4-neon",
        label: "Gemini 4 Neon",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra" },
        ],
      },
      {
        id: "gemini-4-carbon",
        label: "Gemini 4 Carbon",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ],
  },
];

describe("mode-map", () => {
  it("maps opencode build and codex auto-review to antigravity auto (not accept-edits)", () => {
    const fromOpenCode = resolveModeAndOptionsForTarget({
      sourceProvider: "opencode",
      sourceModeId: "build",
      sourceOptions: { auto_accept: false },
      targetProvider: "antigravity",
      targetModes: SAMPLE_PROVIDERS[2].modes,
      targetDefaultModeId: "default",
    });
    assert.equal(fromOpenCode.modeId, "auto");

    const fromCodex = resolveModeAndOptionsForTarget({
      sourceProvider: "codex",
      sourceModeId: "auto-review",
      targetProvider: "antigravity",
      targetModes: SAMPLE_PROVIDERS[2].modes,
      targetDefaultModeId: "default",
    });
    assert.equal(fromCodex.modeId, "auto");
  });

  it("synchronizes full-access <-> opencode build + auto_accept bidirectionally", () => {
    const toOpenCode = resolveModeAndOptionsForTarget({
      sourceProvider: "antigravity",
      sourceModeId: "full-access",
      targetProvider: "opencode",
      targetModes: SAMPLE_PROVIDERS[1].modes,
      targetDefaultModeId: "build",
    });
    assert.equal(toOpenCode.modeId, "build");
    assert.deepEqual(toOpenCode.providerOptions, { auto_accept: true });

    const backToAntigravity = resolveModeAndOptionsForTarget({
      sourceProvider: "opencode",
      sourceModeId: "build",
      sourceOptions: { auto_accept: true },
      targetProvider: "antigravity",
      targetModes: SAMPLE_PROVIDERS[2].modes,
      targetDefaultModeId: "default",
    });
    assert.equal(backToAntigravity.modeId, "full-access");

    const planToOpenCode = resolveModeAndOptionsForTarget({
      sourceProvider: "antigravity",
      sourceModeId: "plan",
      targetProvider: "opencode",
      targetModes: SAMPLE_PROVIDERS[1].modes,
      targetDefaultModeId: "build",
    });
    assert.equal(planToOpenCode.modeId, "plan");
    assert.deepEqual(planToOpenCode.providerOptions, { auto_accept: false });
  });

  it("falls back to targetDefaultModeId when source mode is missing", () => {
    assert.equal(
      mapModeForTargetProvider({
        sourceModeId: null,
        targetModes: SAMPLE_PROVIDERS[0].modes,
        targetDefaultModeId: "auto",
      }),
      "auto",
    );
  });
});

describe("slash command resolver", () => {
  it("parses leading/trailing --force, --note=..., @thinking, and follow-up prompt", () => {
    const leading = resolveTargetFromSlashArgs(
      '--force --note "只做\\"审查\\"不改代码" codex/gpt-6.2-sol@xhigh 帮我看看 auth.ts',
      SAMPLE_PROVIDERS,
    );
    assert.ok(!("error" in leading));
    assert.equal(leading.provider.id, "codex");
    assert.equal(leading.model.id, "gpt-6.2-sol");
    assert.equal(leading.thinkingOptionId, "xhigh");
    assert.equal(leading.stopRunning, true);
    assert.equal(leading.handoffNote, '只做"审查"不改代码');
    assert.equal(leading.followUpPrompt, "帮我看看 auth.ts");

    const trailing = resolveTargetFromSlashArgs(
      'codex/gpt-6.2-sol --note="仅查根因" --force 继续分析',
      SAMPLE_PROVIDERS,
    );
    assert.ok(!("error" in trailing));
    assert.equal(trailing.provider.id, "codex");
    assert.equal(trailing.model.id, "gpt-6.2-sol");
    assert.equal(trailing.stopRunning, true);
    assert.equal(trailing.handoffNote, "仅查根因");
    assert.equal(trailing.followUpPrompt, "继续分析");

    const endForce = resolveTargetFromSlashArgs("codex/gpt-6.2-sol 帮我修复 --force", SAMPLE_PROVIDERS);
    assert.ok(!("error" in endForce));
    assert.equal(endForce.stopRunning, true);
    assert.equal(endForce.followUpPrompt, "帮我修复");
  });

  it("resolves OpenCode single-slash and double-slash model IDs cleanly", () => {
    const singleSlash = resolveTargetFromSlashArgs(
      "opencode/deepseek-v4.1-flash-free",
      SAMPLE_PROVIDERS,
    );
    assert.ok(!("error" in singleSlash));
    assert.equal(singleSlash.provider.id, "opencode");
    assert.equal(singleSlash.model.id, "opencode/deepseek-v4.1-flash-free");

    const doubleSlashWithPrefix = resolveTargetFromSlashArgs(
      "opencode/tencent/deepseek/deepseek-flash",
      SAMPLE_PROVIDERS,
    );
    assert.ok(!("error" in doubleSlashWithPrefix));
    assert.equal(doubleSlashWithPrefix.provider.id, "opencode");
    assert.equal(doubleSlashWithPrefix.model.id, "tencent/deepseek/deepseek-flash");

    const directFullId = resolveTargetFromSlashArgs(
      "tencent/deepseek/deepseek-flash",
      SAMPLE_PROVIDERS,
    );
    assert.ok(!("error" in directFullId));
    assert.equal(directFullId.provider.id, "opencode");
    assert.equal(directFullId.model.id, "tencent/deepseek/deepseek-flash");
  });

  it("restores previous thinking level on `/m back` and allows explicit override", () => {
    const restored = resolveTargetFromSlashArgs("back 继续写单测", SAMPLE_PROVIDERS, {
      currentProvider: "codex",
      currentModel: "gpt-6.2-sol",
      fromProvider: "antigravity",
      fromModel: "gemini-4-neon",
      fromThinkingOptionId: "xhigh",
    });
    assert.ok(!("error" in restored));
    assert.equal(restored.provider.id, "antigravity");
    assert.equal(restored.model.id, "gemini-4-neon");
    assert.equal(restored.thinkingOptionId, "xhigh");
    assert.equal(restored.followUpPrompt, "继续写单测");

    const overridden = resolveTargetFromSlashArgs("back@low", SAMPLE_PROVIDERS, {
      currentProvider: "codex",
      currentModel: "gpt-6.2-sol",
      fromProvider: "antigravity",
      fromModel: "gemini-4-neon",
      fromThinkingOptionId: "xhigh",
    });
    assert.ok(!("error" in overridden));
    assert.equal(overridden.thinkingOptionId, "low");
  });

  it("reports ambiguity on equal-score fuzzy collisions and rejects invalid thinking levels", () => {
    const ambiguous = resolveTargetFromSlashArgs("sol", SAMPLE_PROVIDERS);
    assert.ok("error" in ambiguous);
    assert.match(ambiguous.error, /匹配/);

    const badThinking = resolveTargetFromSlashArgs("codex/gpt-6.2-sol@nonexistent", SAMPLE_PROVIDERS);
    assert.ok("error" in badThinking);
    assert.match(badThinking.error, /low, medium, high, xhigh, ultra/);
  });
});

describe("rich context compiler", () => {
  it("rescues interrupted reasoning, handles image-only turns, and sets hasOmittedHistory accurately", () => {
    const shortEntries: Array<{ item: AgentTimelineItem; timestamp: string; seqStart: number }> = [
      {
        seqStart: 1,
        timestamp: "2026-11-26T00:00:00Z",
        item: { type: "user_message", text: "   " },
      },
      {
        seqStart: 2,
        timestamp: "2026-11-26T00:00:01Z",
        item: { type: "reasoning", text: "Inspecting screenshot: button overlap caused by width: 390." },
      },
    ];

    const built = buildCanonicalTurns(shortEntries);
    assert.equal(built.turns.length, 1);
    assert.equal(built.turns[0].userText, "[User sent image/attachment]");

    const compiled = compileContextFromEntries({
      entries: shortEntries,
      git: { branch: null, statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/tmp/repo",
      sourceProvider: "antigravity",
      sourceModel: "gemini-4-carbon",
      settings: DEFAULT_MODEL_SWITCH_SETTINGS,
      transcriptPathPlaceholder: "/tmp/t.md",
    });

    assert.equal(compiled.hasOmittedHistory, false);
    assert.doesNotMatch(compiled.systemPromptBriefing, /read_previous_session_context/);
    assert.match(compiled.systemPromptBriefing, /\[Interrupted Reasoning/);
    assert.match(compiled.systemPromptBriefing, /button overlap caused by width: 390/);
    assert.match(compiled.systemPromptBriefing, /\[User sent image\/attachment\]/);
  });

  it("preserves failed shell traces, edit diffs, active plan, and enables tool rule when truncated", () => {
    const entries: Array<{ item: AgentTimelineItem; timestamp: string; seqStart: number }> = [];
    for (let i = 1; i <= 12; i++) {
      entries.push({
        seqStart: i * 3 - 2,
        timestamp: `2026-11-26T00:00:${String(i).padStart(2, "0")}Z`,
        item: { type: "user_message", text: `Turn ${i}: ${"x".repeat(400)}` },
      });
      entries.push({
        seqStart: i * 3 - 1,
        timestamp: `2026-11-26T00:00:${String(i).padStart(2, "0")}Z`,
        item:
          i === 12
            ? {
                type: "tool_call",
                callId: `c-${i}`,
                name: "shell",
                status: "failed",
                error: "exit 1",
                detail: {
                  type: "shell",
                  command: "npm test",
                  exitCode: 1,
                  output: "AssertionError: EXPECTED_TRACE_LINE",
                },
              }
            : {
                type: "tool_call",
                callId: `c-${i}`,
                name: "shell",
                status: "completed",
                error: null,
                detail: {
                  type: "shell",
                  command: "npm test",
                  exitCode: 0,
                  output: "ok",
                },
              },
      });
      entries.push({
        seqStart: i * 3,
        timestamp: `2026-11-26T00:00:${String(i).padStart(2, "0")}Z`,
        item: {
          type: "assistant_message",
          text: i === 12 ? "FINAL_TURN_SENTINEL" : `Reply ${i}`,
        },
      });
    }

    const compiled = compileContextFromEntries({
      entries,
      git: { branch: "main", statusShort: " M a.ts", diffStat: "", uncommittedPatch: "+const a = 1;" },
      cwd: "/tmp/repo",
      sourceProvider: "codex",
      sourceModel: "gpt-6.2-sol",
      settings: { ...DEFAULT_MODEL_SWITCH_SETTINGS, maxContextChars: 5500, recentTurnsVerbatim: 5 },
      handoffNote: "只修单测",
      transcriptPathPlaceholder: "/tmp/t.md",
    });

    assert.equal(compiled.hasOmittedHistory, true);
    assert.match(compiled.systemPromptBriefing, /read_previous_session_context/);
    assert.match(compiled.systemPromptBriefing, /EXPECTED_TRACE_LINE/);
    assert.match(compiled.systemPromptBriefing, /FINAL_TURN_SENTINEL/);
    assert.match(compiled.systemPromptBriefing, /只修单测/);
  });

  it("prioritizes mutations & failed shells over repetitive reads, adjusts CJK budget, and flags empty sessions", () => {
    const records = [
      ...Array.from({ length: 14 }, (_, i) => ({
        kind: "read" as const,
        failed: false,
        target: `src/file${i}.ts`,
        summary: `read src/file${i}.ts`,
      })),
      { kind: "edit" as const, failed: false, target: "src/core.ts", summary: "edit src/core.ts" },
      {
        kind: "shell" as const,
        failed: true,
        target: "npm test",
        summary: "shell `npm test` (exit 1) [FAILED]",
      },
    ];
    const compacted = compactToolRecords(records, 8);
    assert.ok(compacted.some((l) => l.includes("edit src/core.ts")));
    assert.ok(compacted.some((l) => l.includes("shell `npm test` (exit 1) [FAILED]")));
    assert.ok(compacted.some((l) => l.startsWith("read 14 file(s):")));

    const enRatio = estimateCharsPerToken("Refactor the authentication middleware for JWT rotation.");
    const zhRatio = estimateCharsPerToken("重构鉴权中间件以支持无感切换和上下文压缩，避免重复提示词。");
    assert.ok(enRatio > 3.5);
    assert.ok(zhRatio < 2.2);

    const empty = compileContextFromEntries({
      entries: [],
      git: { branch: "main", statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/tmp/repo",
      sourceProvider: "antigravity",
      sourceModel: "gemini-4-neon",
      settings: DEFAULT_MODEL_SWITCH_SETTINGS,
      transcriptPathPlaceholder: "/tmp/t.md",
    });
    assert.equal(empty.isEmptySession, true);
    assert.equal(empty.systemPromptBriefing, "");

    const withNote = compileContextFromEntries({
      entries: [],
      git: { branch: "main", statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/tmp/repo",
      sourceProvider: "antigravity",
      sourceModel: "gemini-4-neon",
      settings: DEFAULT_MODEL_SWITCH_SETTINGS,
      handoffNote: "直接帮我审查代码",
      transcriptPathPlaceholder: "/tmp/t.md",
    });
    assert.equal(withNote.isEmptySession, false);
    assert.match(withNote.systemPromptBriefing, /直接帮我审查代码/);
  });
});

describe("incremental turn cache", () => {
  it("loops across multiple hasNewer delta pages without dropping entries", async () => {
    const cache = new IncrementalTimelineCache();
    let callCount = 0;

    const fakePaseo = {
      agents: {
        ref: () => ({
          timeline: {
            refetch: async (opts?: { direction?: string; cursor?: { epoch: string; seq: number } }) => {
              callCount += 1;
              if (opts?.direction === "tail") {
                return {
                  epoch: "ep1",
                  reset: false,
                  staleCursor: false,
                  hasOlder: false,
                  hasNewer: false,
                  startCursor: { epoch: "ep1", seq: 1 },
                  endCursor: { epoch: "ep1", seq: 2 },
                  entries: [
                    { seqStart: 1, timestamp: "t1", item: { type: "user_message", text: "hi" } },
                    { seqStart: 2, timestamp: "t2", item: { type: "assistant_message", text: "hello" } },
                  ],
                };
              }
              // First `after` page from seq 2 -> returns seq 3..4 with hasNewer: true
              if (opts?.cursor?.seq === 2) {
                return {
                  epoch: "ep1",
                  reset: false,
                  staleCursor: false,
                  hasOlder: false,
                  hasNewer: true,
                  startCursor: { epoch: "ep1", seq: 3 },
                  endCursor: { epoch: "ep1", seq: 4 },
                  entries: [
                    { seqStart: 3, timestamp: "t3", item: { type: "user_message", text: "big turn" } },
                    { seqStart: 4, timestamp: "t4", item: { type: "assistant_message", text: "part 1" } },
                  ],
                };
              }
              // Second `after` page from seq 4 -> returns seq 5 with hasNewer: false
              return {
                epoch: "ep1",
                reset: false,
                staleCursor: false,
                hasOlder: false,
                hasNewer: false,
                startCursor: { epoch: "ep1", seq: 5 },
                endCursor: { epoch: "ep1", seq: 5 },
                entries: [
                  { seqStart: 5, timestamp: "t5", item: { type: "assistant_message", text: "part 2" } },
                ],
              };
            },
          },
        }),
      },
    } as unknown as PaseoApi;

    // Seed initial cache
    await cache.syncLatest(fakePaseo, "ag_test");
    // Concurrent syncLatest + fetchFullTimeline must serialize and catch up all 5 entries
    const [, full] = await Promise.all([
      cache.syncLatest(fakePaseo, "ag_test"),
      cache.fetchFullTimeline(fakePaseo, "ag_test"),
    ]);

    assert.equal(full.length, 5);
    assert.deepEqual(
      full.map((e) => e.seqStart),
      [1, 2, 3, 4, 5],
    );
    assert.ok(callCount >= 3);
  });
});

describe("storage, atomic preferences, multi-hop search, and GC", () => {
  it("handles concurrent preference writes atomically and preserves multi-hop transcripts during GC", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "model-switch-v5-"));
    try {
      // 1. Concurrent atomic preference writes
      await Promise.all([
        togglePinnedModel({ provider: "codex", model: "gpt-6.2-sol" }, tmpRoot),
        togglePinnedModel({ provider: "antigravity", model: "gemini-4-carbon" }, tmpRoot),
        togglePinnedModel({ provider: "opencode", model: "tencent/deepseek/deepseek-flash" }, tmpRoot),
        recordRecentModel({ provider: "codex", model: "gpt-6.2-sol", thinkingOptionId: "high" }, tmpRoot),
        recordRecentModel({ provider: "antigravity", model: "gemini-4-carbon", thinkingOptionId: "high" }, tmpRoot),
      ]);

      const prefs = await loadPreferences(tmpRoot);
      assert.equal(prefs.pinned.length, 3);
      assert.equal(prefs.recent.length, 2);

      // 2. Multi-hop chain + GC retaining ancestor transcript referenced by newest hop
      const idOld = generateSwitchId();
      await saveSwitchArtifacts(
        {
          record: {
            switchId: idOld,
            createdAt: "2026-11-26T00:00:00Z",
            fromAgentId: "ag_old",
            fromProvider: "codex",
            fromModel: "gpt-5.6-sol",
            toProvider: "antigravity",
            toModel: "gemini-4-neon",
            hopCount: 1,
            totalTurns: 1,
            turnsCarried: 1,
            filesTouched: [],
            gitBranch: null,
            systemPromptBriefing: "old",
            priorTranscriptPaths: [],
            priorHops: [],
          },
          transcriptMarkdown: "# Orphan old transcript",
        },
        tmpRoot,
      );

      // Ensure distinct mtime for deterministic GC ordering
      await new Promise((r) => setTimeout(r, 25));

      const id1 = generateSwitchId();
      const hop1 = await saveSwitchArtifacts(
        {
          record: {
            switchId: id1,
            createdAt: "2026-11-26T01:00:00Z",
            fromAgentId: "ag_1",
            fromProvider: "antigravity",
            fromModel: "gemini-4-neon",
            fromThinkingOptionId: "xhigh",
            toProvider: "codex",
            toModel: "gpt-6.2-sol",
            hopCount: 1,
            totalTurns: 4,
            turnsCarried: 4,
            filesTouched: ["src/a.ts"],
            gitBranch: "main",
            systemPromptBriefing: "brief 1",
            priorTranscriptPaths: [],
            priorHops: [],
          },
          transcriptMarkdown: "# Hop 1\nDecision: use PostgreSQL advisory locks.",
        },
        tmpRoot,
      );

      await new Promise((r) => setTimeout(r, 25));

      const id2 = generateSwitchId();
      await saveSwitchArtifacts(
        {
          record: {
            switchId: id2,
            createdAt: "2026-11-26T01:10:00Z",
            fromAgentId: "ag_2",
            fromProvider: "codex",
            fromModel: "gpt-6.2-sol",
            fromThinkingOptionId: "high",
            toProvider: "opencode",
            toModel: "tencent/deepseek/deepseek-flash",
            hopCount: 2,
            totalTurns: 3,
            turnsCarried: 3,
            filesTouched: ["src/b.ts"],
            gitBranch: "main",
            systemPromptBriefing: "brief 2",
            priorTranscriptPaths: [hop1.transcriptPath],
            priorHops: hop1.hops,
          },
          transcriptMarkdown: "# Hop 2\nAdded retry backoff.",
        },
        tmpRoot,
      );

      // Prune to keep only the 1 newest record (id2) -> idOld record+transcript deleted,
      // id1 record deleted, BUT hop1's transcript MUST survive because id2 references it!
      const gc = await pruneOldSwitchArtifacts(1, tmpRoot);
      assert.equal(gc.deletedRecords, 2);
      assert.equal(gc.deletedTranscripts, 1);

      const loaded = await loadSwitchRecord(id2, tmpRoot);
      assert.ok(loaded);
      const searchAll = await readAcrossHops(loaded, {
        action: "search",
        hop: "all",
        query: "advisory locks",
      });
      assert.match(searchAll.text, /PostgreSQL advisory locks/);

      assert.equal(await loadSwitchRecord("../../etc/passwd", tmpRoot), null);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("permission hook matcher for read_previous_session_context", () => {
  it("matches exact tool name and Paseo MCP prefixed variants only for tool permissions", () => {
    const allowedNames = [
      "read_previous_session_context",
      "mcp__paseo__read_previous_session_context",
      "mcp_paseo_read_previous_session_context",
      "paseo_read_previous_session_context",
      "paseo.read_previous_session_context",
      "paseo:read_previous_session_context",
      "paseo/read_previous_session_context",
      "  MCP__PASEO__READ_PREVIOUS_SESSION_CONTEXT  ",
    ];
    for (const name of allowedNames) {
      assert.equal(
        isReadPreviousSessionContextPermission({ kind: "tool", name }),
        true,
        `expected ${name} to match`,
      );
    }

    assert.equal(
      isReadPreviousSessionContextPermission({ kind: "plan", name: "read_previous_session_context" }),
      false,
    );
    assert.equal(
      isReadPreviousSessionContextPermission({ kind: "tool", name: "shell" }),
      false,
    );
    assert.equal(
      isReadPreviousSessionContextPermission({ kind: "tool", name: "mcp__other__read_previous_session_context" }),
      false,
    );
    assert.equal(
      isReadPreviousSessionContextPermission({ kind: "tool", name: "read_previous_session_context_extra" }),
      false,
    );
  });
});

describe("handoff agent_message preservation, initial task anchor, and output files", () => {
  it("preserves full agent_message handoff prompt in transcript and anchors Turn 1 when pushed out of verbatim window", () => {
    const handoffPrompt = [
      "## Task",
      "Sign in to bringingchichi@gmail.com in AdsPower profile k1fimixy.",
      "## Relevant files",
      "- `/tmp/warmup.mjs`",
      "## Acceptance criteria",
      "- Run warmup.mjs and report Country Version and Schedule 127cc083.",
    ].join("\n");

    const entries: Array<{ item: AgentTimelineItem; timestamp: string; seqStart: number }> = [
      {
        seqStart: 1,
        timestamp: "2026-11-26T03:37:00Z",
        item: {
          type: "tool_call",
          callId: "msg-1",
          name: "agent_message",
          status: "completed",
          error: null,
          detail: {
            type: "plain_text",
            label: "agent_message",
            text: handoffPrompt,
          },
        },
      },
      {
        seqStart: 2,
        timestamp: "2026-11-26T03:37:30Z",
        item: { type: "assistant_message", text: "Paused at reCAPTCHA." },
      },
    ];

    for (let i = 2; i <= 10; i++) {
      entries.push({
        seqStart: i * 2,
        timestamp: `2026-11-26T03:${String(i).padStart(2, "0")}:00Z`,
        item: { type: "user_message", text: `Follow-up ${i}` },
      });
      entries.push({
        seqStart: i * 2 + 1,
        timestamp: `2026-11-26T03:${String(i).padStart(2, "0")}:10Z`,
        item: { type: "assistant_message", text: `Reply ${i}` },
      });
    }

    const compiled = compileContextFromEntries({
      entries,
      git: { branch: null, statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/tmp/repo",
      sourceProvider: "codex",
      sourceModel: "gpt-6.2-sol",
      settings: { ...DEFAULT_MODEL_SWITCH_SETTINGS, recentTurnsVerbatim: 8 },
      transcriptPathPlaceholder: "/tmp/t.md",
    });

    assert.equal(compiled.turns.length, 10);
    assert.match(compiled.turns[0].userText, /Schedule 127cc083/);
    assert.match(compiled.transcriptMarkdown, /Schedule 127cc083/);
    assert.match(compiled.systemPromptBriefing, /## Initial Task \/ Original Request \(Turn 1\)/);
    assert.match(compiled.systemPromptBriefing, /Schedule 127cc083/);
  });

  it("collects created/modified/git/mentioned/brain output files and copies Antigravity brain artifacts", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-switch-outputs-"));
    try {
      const workspaceDir = path.join(tmpDir, "workspace");
      const brainBase = path.join(tmpDir, "brain");
      const srcSessionUuid = "11111111-2222-3333-4444-555555555555";
      const dstSessionUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const srcBrainDir = path.join(brainBase, srcSessionUuid);

      await fs.mkdir(path.join(workspaceDir, "out"), { recursive: true });
      await fs.mkdir(path.join(srcBrainDir, "scratch"), { recursive: true });
      await fs.mkdir(path.join(srcBrainDir, ".system_generated"), { recursive: true });

      const writtenFile = path.join(workspaceDir, "out", "report.md");
      const gitUntrackedFile = path.join(workspaceDir, "out", "summary.csv");
      const mentionedRelFile = path.join(workspaceDir, "out", "chart.png");
      const artifactFile = path.join(srcBrainDir, "implementation_plan.md");
      const scratchFile = path.join(srcBrainDir, "scratch", "helper.py");
      const ignoredSysFile = path.join(srcBrainDir, ".system_generated", "transcript.jsonl");

      await Promise.all([
        fs.writeFile(writtenFile, "# Report\nDone", "utf8"),
        fs.writeFile(gitUntrackedFile, "col1,col2\n1,2\n", "utf8"),
        fs.writeFile(mentionedRelFile, "PNGDATA", "utf8"),
        fs.writeFile(artifactFile, "# Implementation Plan\nStep 1: ship it.", "utf8"),
        fs.writeFile(scratchFile, "print('ok')\n", "utf8"),
        fs.writeFile(ignoredSysFile, "{}\n", "utf8"),
      ]);

      const entries: Array<{ item: AgentTimelineItem; timestamp: string; seqStart: number }> = [
        {
          seqStart: 1,
          timestamp: "2026-11-26T04:00:00Z",
          item: { type: "user_message", text: "Generate the project deliverables." },
        },
        {
          seqStart: 2,
          timestamp: "2026-11-26T04:00:05Z",
          item: {
            type: "tool_call",
            callId: "w1",
            name: "write",
            status: "completed",
            error: null,
            detail: { type: "write", filePath: "out/report.md", content: "# Report\nDone" },
          },
        },
        {
          seqStart: 3,
          timestamp: "2026-11-26T04:00:10Z",
          item: {
            type: "assistant_message",
            text: `Generated \`out/chart.png\` and [report](file://${writtenFile}).`,
          },
        },
      ];

      const wrappedSessionId = `plugin:${JSON.stringify({ version: 1, data: { sessionId: srcSessionUuid } })}`;
      assert.equal(extractAntigravitySessionId(wrappedSessionId), srcSessionUuid);

      const outputFiles = await collectSessionOutputFiles({
        cwd: workspaceDir,
        entries,
        gitStatusShort: "?? out/summary.csv\n",
        sourceProvider: "antigravity",
        sourceSessionId: wrappedSessionId,
        brainBaseDir: brainBase,
      });

      const byPath = new Map(outputFiles.map((f) => [f.path, f]));
      assert.equal(byPath.get(writtenFile)?.origin, "created");
      assert.equal(byPath.get(gitUntrackedFile)?.origin, "created");
      assert.equal(byPath.get(mentionedRelFile)?.origin, "referenced");
      assert.equal(byPath.get(artifactFile)?.origin, "artifact");
      assert.match(byPath.get(artifactFile)?.preview ?? "", /Implementation Plan/);
      assert.equal(byPath.get(scratchFile)?.origin, "scratch");
      assert.equal(byPath.has(ignoredSysFile), false);

      const compiled = compileContextFromEntries({
        entries,
        git: { branch: "main", statusShort: "?? out/summary.csv", diffStat: "", uncommittedPatch: "" },
        cwd: workspaceDir,
        sourceProvider: "antigravity",
        sourceModel: "gemini-4-neon",
        settings: DEFAULT_MODEL_SWITCH_SETTINGS,
        outputFiles,
        transcriptPathPlaceholder: "/tmp/t.md",
      });

      assert.match(compiled.systemPromptBriefing, /## Project Output Files & Artifacts/);
      assert.match(compiled.systemPromptBriefing, /out\/report\.md/);
      assert.match(compiled.systemPromptBriefing, /out\/summary\.csv/);
      assert.match(compiled.systemPromptBriefing, /implementation_plan\.md/);
      assert.match(compiled.transcriptMarkdown, /## Project Output Files & Artifacts/);

      const copied = await copyAntigravityBrainFiles(wrappedSessionId, dstSessionUuid, brainBase);
      assert.equal(copied.length, 2);
      const copiedArtifact = await fs.readFile(
        path.join(brainBase, dstSessionUuid, "implementation_plan.md"),
        "utf8",
      );
      assert.match(copiedArtifact, /Step 1: ship it/);
      await assert.rejects(
        fs.stat(path.join(brainBase, dstSessionUuid, ".system_generated", "transcript.jsonl")),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("deduplicates filesTouched across outputFiles/edited/read, filters SKILL.md, and passes through 0-turn hops losslessly", () => {
    const entries: Array<{ item: AgentTimelineItem; timestamp: string; seqStart: number }> = [
      {
        seqStart: 1,
        timestamp: "2026-11-26T04:00:00Z",
        item: { type: "user_message", text: "Update warmup script" },
      },
      {
        seqStart: 2,
        timestamp: "2026-11-26T04:00:02Z",
        item: {
          type: "tool_call",
          callId: "r1",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "/Users/test/.gemini/config/skills/paseo/SKILL.md" },
        },
      },
      {
        seqStart: 3,
        timestamp: "2026-11-26T04:00:05Z",
        item: {
          type: "tool_call",
          callId: "e1",
          name: "edit",
          status: "completed",
          error: null,
          detail: { type: "edit", filePath: "/Users/test/scratch/warmup.mjs" },
        },
      },
      {
        seqStart: 4,
        timestamp: "2026-11-26T04:00:08Z",
        item: { type: "assistant_message", text: "Updated warmup.mjs." },
      },
    ];

    const hop1 = compileContextFromEntries({
      entries,
      git: { branch: null, statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/Users/test/workspace",
      sourceProvider: "antigravity",
      sourceModel: "gemini-4-neon",
      settings: DEFAULT_MODEL_SWITCH_SETTINGS,
      outputFiles: [{ path: "/Users/test/scratch/warmup.mjs", origin: "modified", sizeBytes: 1200 }],
      transcriptPathPlaceholder: "/tmp/hop1.md",
    });

    assert.deepEqual(hop1.filesTouched, ["warmup.mjs"]);

    // 0-turn immediate re-switch (Hop 2) must pass through Hop 1 briefing & previewTurns losslessly
    const hop2 = compileContextFromEntries({
      entries: [],
      git: { branch: null, statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/Users/test/workspace",
      sourceProvider: "codex",
      sourceModel: "gpt-6.2-sol",
      settings: DEFAULT_MODEL_SWITCH_SETTINGS,
      outputFiles: [{ path: "/Users/test/scratch/warmup.mjs", origin: "modified", sizeBytes: 1200 }],
      ancestor: {
        switchId: "sw_hop1",
        createdAt: "2026-11-26T04:00:10Z",
        fromAgentId: "ag_1",
        fromProvider: "antigravity",
        fromModel: "gemini-4-neon",
        toProvider: "codex",
        toModel: "gpt-6.2-sol",
        hopCount: 1,
        totalTurns: 1,
        turnsCarried: 1,
        hasOmittedHistory: false,
        filesTouched: hop1.filesTouched,
        outputFiles: hop1.outputFiles,
        gitBranch: null,
        transcriptPath: "/tmp/hop1.md",
        systemPromptBriefing: hop1.systemPromptBriefing,
        priorTranscriptPaths: [],
        hops: [],
        ancestorSummary: hop1.ancestorSummary,
        bannerData: {
          switchId: "sw_hop1",
          fromProvider: "antigravity",
          fromModel: "gemini-4-neon",
          toProvider: "codex",
          toModel: "gpt-6.2-sol",
          turnsCarried: 1,
          totalTurns: 1,
          hopCount: 1,
          filesTouched: hop1.filesTouched,
          gitBranch: null,
          modeMapped: "full-access",
          transcriptPath: "/tmp/hop1.md",
          previewTurns: hop1.previewTurns,
        },
      },
      transcriptPathPlaceholder: "/tmp/hop2.md",
    });

    assert.equal(hop2.systemPromptBriefing, hop1.systemPromptBriefing);
    assert.doesNotMatch(hop2.systemPromptBriefing, /No prior turns were recorded/);
    assert.equal(hop2.previewTurns.length, hop1.previewTurns.length);
    assert.deepEqual(hop2.filesTouched, ["warmup.mjs"]);
    assert.equal(hop2.hasOmittedHistory, false);
  });

  it("extracts backticked absolute/home/:line paths while ignoring boilerplate and temp attachments", () => {
    const tmpShot = path.join(os.tmpdir(), "paseo-attachments-abc123", "screen.jpg");
    const sample = [
      "See `/tmp/warmup.mjs` and `/tmp/foo/bar.ts:42:10` and `~/docs/report.md`.",
      "Also `out/deliverable.csv` and `package.json` and `README.md`.",
      `Temp screenshot: ![img](file://${tmpShot})`,
      "MCP schema: `/Users/me/.gemini/antigravity-cli/mcp/paseo/create_agent.json`",
    ].join("\n");

    const paths = extractMentionedFilePaths(sample, "/workspace/proj");
    assert.ok(paths.includes(path.resolve("/tmp/warmup.mjs")));
    assert.ok(paths.includes(path.resolve("/tmp/foo/bar.ts")));
    assert.ok(paths.includes(path.join(os.homedir(), "docs", "report.md")));
    assert.ok(paths.includes(path.resolve("/workspace/proj/out/deliverable.csv")));
    assert.ok(!paths.some((p) => p.endsWith("package.json")));
    assert.ok(!paths.some((p) => p.endsWith("README.md")));
    assert.ok(!paths.some((p) => p.includes("paseo-attachments-")));
    assert.ok(!paths.some((p) => p.includes("create_agent.json")));
  });

  it("prefers allow_once over allow_always, matches ACP title fallback, and ignores failed writes", () => {
    assert.equal(
      isReadPreviousSessionContextPermission({
        kind: "tool",
        name: "Read Previous Session Context",
      }),
      true,
    );
    assert.equal(
      isReadPreviousSessionContextPermission({
        kind: "tool",
        name: "Tool",
        title: "Read Previous Session Context",
      }),
      true,
    );

    const chosen = selectSafeAllowPermissionAction([
      { id: "allow_always", label: "Always allow MCP server 'paseo'", behavior: "allow" },
      { id: "allow_once", label: "Allow once", behavior: "allow" },
      { id: "deny", label: "Deny", behavior: "deny" },
    ]);
    assert.equal(chosen?.id, "allow_once");

    const built = buildCanonicalTurns([
      {
        seqStart: 1,
        timestamp: "2026-11-26T04:00:00Z",
        item: { type: "user_message", text: "Try writing file" },
      },
      {
        seqStart: 2,
        timestamp: "2026-11-26T04:00:01Z",
        item: {
          type: "tool_call",
          callId: "w-fail",
          name: "write",
          status: "failed",
          error: "EACCES",
          detail: { type: "write", filePath: "blocked.ts", content: "x" },
        },
      },
      {
        seqStart: 3,
        timestamp: "2026-11-26T04:00:02Z",
        item: {
          type: "tool_call",
          callId: "e-cancel",
          name: "edit",
          status: "canceled",
          error: null,
          detail: { type: "edit", filePath: "aborted.ts", oldString: "a", newString: "b" },
        },
      },
    ]);
    assert.deepEqual(built.filesWritten, []);
    assert.deepEqual(built.filesEdited, []);
  });

  it("preserves agentMessage provenance, merges consecutive pre-reply messages, and carries initialTaskAnchor across hops", () => {
    const built = buildCanonicalTurns([
      {
        seqStart: 1,
        timestamp: "2026-11-26T04:00:00Z",
        item: {
          type: "tool_call",
          callId: "am-1",
          name: "agent_message",
          status: "completed",
          error: null,
          agentMessage: {
            event: "finished",
            sender: { id: "ag_child", title: "Review Bot" },
            text: "Found 2 issues in parser.ts",
          },
          detail: { type: "plain_text", label: "agent_message", text: "Found 2 issues in parser.ts" },
        },
      },
      {
        seqStart: 2,
        timestamp: "2026-11-26T04:00:01Z",
        item: {
          type: "tool_call",
          callId: "am-2",
          name: "agent_message",
          status: "completed",
          error: null,
          agentMessage: {
            event: "errored",
            sender: { id: "ag_lint", title: "Linter" },
            text: "ESLint timed out",
          },
          detail: { type: "plain_text", label: "agent_message", text: "ESLint timed out" },
        },
      },
      {
        seqStart: 3,
        timestamp: "2026-11-26T04:00:05Z",
        item: { type: "assistant_message", text: "Handled both callbacks." },
      },
    ]);
    assert.equal(built.turns.length, 1);
    assert.match(built.turns[0].userText, /Review Bot/);
    assert.match(built.turns[0].userText, /finished/);
    assert.match(built.turns[0].userText, /ESLint timed out/);

    // Multi-hop Turn 1 anchor persists into Hop 2 even after new turns occur
    const hop2 = compileContextFromEntries({
      entries: [
        { seqStart: 1, timestamp: "t1", item: { type: "user_message", text: "Continue task" } },
        { seqStart: 2, timestamp: "t2", item: { type: "assistant_message", text: "Continuing" } },
      ],
      git: { branch: null, statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/tmp/repo",
      sourceProvider: "codex",
      sourceModel: "gpt-6.2-sol",
      settings: DEFAULT_MODEL_SWITCH_SETTINGS,
      ancestor: {
        switchId: "sw_h1",
        createdAt: "2026-11-26T04:00:00Z",
        fromAgentId: "ag_1",
        fromProvider: "antigravity",
        fromModel: "gemini-4-neon",
        toProvider: "codex",
        toModel: "gpt-6.2-sol",
        hopCount: 1,
        totalTurns: 10,
        turnsCarried: 8,
        filesTouched: [],
        gitBranch: null,
        transcriptPath: "/tmp/h1.md",
        systemPromptBriefing: "h1",
        priorTranscriptPaths: [],
        hops: [],
        ancestorSummary: "summary",
        initialTaskAnchor: "ORIGINAL_MISSION_SENTINEL",
      },
      transcriptPathPlaceholder: "/tmp/h2.md",
    });
    assert.equal(hop2.initialTaskAnchor, "ORIGINAL_MISSION_SENTINEL");
    assert.match(hop2.systemPromptBriefing, /ORIGINAL_MISSION_SENTINEL/);
  });

  it("handles 0-turn hop default read, refreshes git/files/note, enforces 0600/0700 perms, and copies persisted brain artifacts", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "model-switch-review-"));
    try {
      const id1 = generateSwitchId();
      const hop1 = await saveSwitchArtifacts(
        {
          record: {
            switchId: id1,
            createdAt: "2026-11-26T05:00:00Z",
            fromAgentId: "ag_1",
            fromProvider: "antigravity",
            fromModel: "gemini-4-neon",
            toProvider: "codex",
            toModel: "gpt-6.2-sol",
            hopCount: 1,
            totalTurns: 4,
            turnsInSegment: 4,
            turnsCarried: 4,
            filesTouched: ["a.ts"],
            gitBranch: "main",
            systemPromptBriefing:
              "[SEAMLESS MODEL SWITCH CONTEXT]\n1. Rule\n2. **User handoff instruction for this switch:** old note\n\n## Workspace State\n- Git branch: `old-branch`\n\n## Project Output Files & Artifacts\n- [created, 10 B] `/tmp/old.md`\n\n## Recent Conversation (Verbatim)\n\n### Turn 1\n**User:** hi",
            priorTranscriptPaths: [],
            priorHops: [],
          },
          transcriptMarkdown: "# Hop 1\nREAL_HISTORY_TOKEN",
        },
        tmpRoot,
      );

      // Verify restrictive permissions (0o700 dir, 0o600 file)
      const dirStat = await fs.stat(path.join(tmpRoot, "records"));
      const fileStat = await fs.stat(path.join(tmpRoot, "records", `${id1}.json`));
      assert.equal(dirStat.mode & 0o777, 0o700);
      assert.equal(fileStat.mode & 0o777, 0o600);

      // 0-turn Hop 2 refreshes git branch, output files, and replaces handoff note
      const compiledHop2 = compileContextFromEntries({
        entries: [],
        git: { branch: "feat/new-branch", statusShort: " M a.ts", diffStat: "", uncommittedPatch: "" },
        cwd: tmpRoot,
        sourceProvider: "codex",
        sourceModel: "gpt-6.2-sol",
        settings: DEFAULT_MODEL_SWITCH_SETTINGS,
        handoffNote: "new updated note",
        outputFiles: [{ path: "/tmp/fresh.md", origin: "created", sizeBytes: 42 }],
        ancestor: hop1,
        transcriptPathPlaceholder: "/tmp/h2.md",
      });

      assert.match(compiledHop2.systemPromptBriefing, /feat\/new-branch/);
      assert.doesNotMatch(compiledHop2.systemPromptBriefing, /old-branch/);
      assert.match(compiledHop2.systemPromptBriefing, /\/tmp\/fresh\.md/);
      assert.doesNotMatch(compiledHop2.systemPromptBriefing, /\/tmp\/old\.md/);
      assert.match(compiledHop2.systemPromptBriefing, /new updated note/);
      assert.doesNotMatch(compiledHop2.systemPromptBriefing, /old note/);

      const id2 = generateSwitchId();
      const hop2 = await saveSwitchArtifacts(
        {
          record: {
            switchId: id2,
            createdAt: "2026-11-26T05:01:00Z",
            fromAgentId: "ag_2",
            fromProvider: "codex",
            fromModel: "gpt-6.2-sol",
            toProvider: "antigravity",
            toModel: "gemini-4-neon",
            hopCount: 2,
            totalTurns: 4,
            turnsInSegment: 0,
            turnsCarried: 4,
            filesTouched: compiledHop2.filesTouched,
            gitBranch: "feat/new-branch",
            systemPromptBriefing: compiledHop2.systemPromptBriefing,
            priorTranscriptPaths: [hop1.transcriptPath],
            priorHops: hop1.hops,
          },
          transcriptMarkdown: "# Hop 2 (0 turns)",
        },
        tmpRoot,
      );

      assert.equal(resolveDefaultHop(hop2.hops)?.switchId, id1);
      const readRes = await readAcrossHops(hop2, { action: "read" });
      assert.match(readRes.text, /REAL_HISTORY_TOKEN/);

      // Persisted artifact copy works even when sourceProvider was codex (round-trip)
      const brainBase = path.join(tmpRoot, "brain");
      const srcArtifact = path.join(tmpRoot, "plan.md");
      await fs.writeFile(srcArtifact, "# Plan", "utf8");
      const copied = await copyPersistedArtifactsToAntigravityBrain(
        [{ path: srcArtifact, origin: "artifact", sizeBytes: 6 }],
        "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        brainBase,
      );
      assert.equal(copied.length, 1);
      assert.equal(
        await fs.readFile(path.join(brainBase, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", "plan.md"), "utf8"),
        "# Plan",
      );

      // Settings migration sanitizes corrupt legacy values cleanly
      const migrated = modelSwitchSettings.migrate?.(
        {
          recentTurnsVerbatim: 9999,
          composerTriggerStyle: "invalid-style",
          archivePreviousAgent: false,
        },
        2,
      );
      const parsed = ModelSwitchSettingsSchema.safeParse(migrated);
      assert.equal(parsed.success, true);
      if (parsed.success) {
        assert.equal(parsed.data.recentTurnsVerbatim, DEFAULT_MODEL_SWITCH_SETTINGS.recentTurnsVerbatim);
        assert.equal(parsed.data.composerTriggerStyle, DEFAULT_MODEL_SWITCH_SETTINGS.composerTriggerStyle);
        assert.equal(parsed.data.archivePreviousAgent, false);
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("fetchFullTimelineWithMeta propagates truncated flag and avoids mislabeling truncated mid-session turn as Turn 1", async () => {
    const cache = new IncrementalTimelineCache();
    const fakePaseo = {
      agents: {
        ref: () => ({
          timeline: {
            refetch: async (opts?: { direction?: string }) => {
              if (opts?.direction === "tail") {
                return {
                  epoch: "ep1",
                  reset: false,
                  staleCursor: false,
                  hasOlder: true,
                  hasNewer: false,
                  startCursor: { epoch: "ep1", seq: 10 },
                  endCursor: { epoch: "ep1", seq: 11 },
                  entries: [
                    { seqStart: 10, timestamp: "t10", item: { type: "user_message", text: "MID_SESSION_TURN" } },
                    { seqStart: 11, timestamp: "t11", item: { type: "assistant_message", text: "reply" } },
                  ],
                };
              }
              return {
                epoch: "ep1",
                reset: false,
                staleCursor: false,
                hasOlder: true,
                hasNewer: false,
                startCursor: { epoch: "ep1", seq: 8 },
                endCursor: { epoch: "ep1", seq: 9 },
                entries: [],
              };
            },
          },
        }),
      },
    } as unknown as PaseoApi;

    const { entries, truncated } = await cache.fetchFullTimelineWithMeta(fakePaseo, "ag_long", 1);
    assert.equal(truncated, true);
    assert.equal(entries[0].seqStart, 10);

    const compiled = compileContextFromEntries({
      entries,
      timelineTruncated: truncated,
      git: { branch: null, statusShort: "", diffStat: "", uncommittedPatch: "" },
      cwd: "/tmp/repo",
      sourceProvider: "codex",
      sourceModel: "gpt-6.2-sol",
      settings: { ...DEFAULT_MODEL_SWITCH_SETTINGS, recentTurnsVerbatim: 1 },
      transcriptPathPlaceholder: "/tmp/t.md",
    });
    assert.equal(compiled.hasOmittedHistory, true);
    assert.equal(compiled.initialTaskAnchor, undefined);
    assert.doesNotMatch(compiled.systemPromptBriefing, /## Initial Task \/ Original Request \(Turn 1\)/);
  });
});
