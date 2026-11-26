import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type {
  AgentTaskItem,
  AgentTimelineItem,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "@getpaseo/protocol/agent-types";
import type { PreviewTurn } from "../shared/contracts";
import type { ModelSwitchSettings } from "../shared/settings";
import type {
  OutputFileOrigin,
  PersistedSwitchRecord,
  SessionOutputFile,
} from "./storage";
import type { CachedTimelineEntry, IncrementalTimelineCache } from "./turn-cache";

const execFileAsync = promisify(execFile);

export const READ_CONTEXT_TOOL_NAME = "read_previous_session_context";
export const READ_CONTEXT_TOOL_TITLE = "Read Previous Session Context";

export function isReadPreviousSessionContextPermission(request: {
  kind: string;
  name: string;
  title?: string;
}): boolean {
  if (request.kind !== "tool") return false;
  const normalized = request.name.trim().toLowerCase();
  if (
    normalized === READ_CONTEXT_TOOL_NAME ||
    normalized === `mcp__paseo__${READ_CONTEXT_TOOL_NAME}` ||
    normalized === `mcp_paseo_${READ_CONTEXT_TOOL_NAME}` ||
    normalized === `paseo_${READ_CONTEXT_TOOL_NAME}` ||
    normalized === `paseo.${READ_CONTEXT_TOOL_NAME}` ||
    normalized === `paseo:${READ_CONTEXT_TOOL_NAME}` ||
    normalized === `paseo/${READ_CONTEXT_TOOL_NAME}`
  ) {
    return true;
  }
  // ACP ToolCall permission payloads may fall back to `toolCall.title` when `name` is absent
  const normalizedTitle = request.title?.trim().toLowerCase() ?? "";
  const expectedTitle = READ_CONTEXT_TOOL_TITLE.toLowerCase();
  if (normalized === expectedTitle) return true;
  if (normalizedTitle === expectedTitle && (normalized === "tool" || normalized === "")) {
    return true;
  }
  return false;
}

export function selectSafeAllowPermissionAction(
  actions:
    | ReadonlyArray<{ id: string; label?: string; behavior: "allow" | "deny" }>
    | undefined,
): { id: string; label?: string; behavior: "allow" | "deny" } | undefined {
  if (!actions || actions.length === 0) return undefined;
  const allowActions = actions.filter((a) => a.behavior === "allow");
  if (allowActions.length === 0) return undefined;
  return (
    allowActions.find((a) => /once/i.test(a.id) || /once/i.test(a.label ?? "")) ??
    allowActions.find(
      (a) => !/always|session|server|all/i.test(`${a.id} ${a.label ?? ""}`),
    ) ??
    allowActions[0]
  );
}

export interface RichToolHighlight {
  kind: "error_output" | "edit_diff" | "plan";
  label: string;
  body: string;
}

export interface TranscriptExtraDetail {
  label: string;
  body: string;
}

export interface ToolSummaryRecord {
  kind: "edit" | "write" | "shell" | "plan" | "sub_agent" | "worktree" | "read" | "search" | "fetch" | "other";
  failed: boolean;
  summary: string;
  target?: string;
}

export interface CanonicalTurn {
  index: number;
  timestamp: string;
  userText: string;
  assistantTexts: string[];
  lastReasoning: string;
  toolSummaries: string[];
  toolRecords: ToolSummaryRecord[];
  richHighlights: RichToolHighlight[];
  transcriptExtras: TranscriptExtraDetail[];
  filesWritten: string[];
  filesEdited: string[];
  filesRead: string[];
  errors: string[];
}

export interface GitWorkspaceContext {
  branch: string | null;
  statusShort: string;
  diffStat: string;
  uncommittedPatch: string;
}

export interface CompiledContext {
  turns: CanonicalTurn[];
  filesTouched: string[];
  outputFiles: SessionOutputFile[];
  git: GitWorkspaceContext;
  latestTodos: AgentTaskItem[];
  latestPlan: string | null;
  isEmptySession: boolean;
  hasOmittedHistory: boolean;
  systemPromptBriefing: string;
  transcriptMarkdown: string;
  previewTurns: PreviewTurn[];
  ancestorSummary: string;
  initialTaskAnchor?: string;
}

export function truncateText(
  text: string,
  maxChars: number,
  onTruncate?: () => void,
): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  onTruncate?.();
  const keepHead = Math.floor(maxChars * 0.72);
  const keepTail = Math.max(0, maxChars - keepHead - 40);
  return `${clean.slice(0, keepHead)}\n...[truncated ${clean.length - keepHead - keepTail} chars]...\n${clean.slice(clean.length - keepTail)}`;
}

function oneLine(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return `${single.slice(0, maxChars - 1)}…`;
}

/**
 * Estimate average characters per token with CJK awareness (~4.0 for Latin, ~1.6 for CJK).
 */
export function estimateCharsPerToken(sampleText: string): number {
  if (!sampleText) return 3.6;
  const sample = sampleText.slice(0, 6000);
  let cjkCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkCount += 1;
    }
  }
  const cjkRatio = cjkCount / sample.length;
  return Math.max(1.5, 4.0 - 2.4 * cjkRatio);
}

/**
 * Prioritize high-signal actions (edits, writes, failed/recent shells, plans, sub-agents)
 * and collapse repetitive read/search calls so end-of-turn mutations are never truncated off.
 */
export function compactToolRecords(
  records: readonly ToolSummaryRecord[],
  maxLines = 12,
  onTruncate?: () => void,
): string[] {
  if (records.length <= maxLines) {
    return records.map((r) => r.summary);
  }

  const highPriority: ToolSummaryRecord[] = [];
  const readTargets = new Set<string>();
  const searchTargets = new Set<string>();
  const fetchTargets = new Set<string>();
  const otherSummaries: string[] = [];

  for (const r of records) {
    if (
      r.failed ||
      r.kind === "edit" ||
      r.kind === "write" ||
      r.kind === "shell" ||
      r.kind === "plan" ||
      r.kind === "sub_agent" ||
      r.kind === "worktree"
    ) {
      highPriority.push(r);
    } else if (r.kind === "read") {
      if (r.target) readTargets.add(r.target);
    } else if (r.kind === "search") {
      if (r.target) searchTargets.add(r.target);
    } else if (r.kind === "fetch") {
      if (r.target) fetchTargets.add(r.target);
    } else {
      otherSummaries.push(r.summary);
    }
  }

  const out: string[] = [];
  const groupedExtras: string[] = [];
  if (readTargets.size > 0) {
    const readList = Array.from(readTargets);
    const shown = readList.slice(0, 6).join(", ");
    const more = readList.length > 6 ? `, +${readList.length - 6} more` : "";
    groupedExtras.push(`read ${readList.length} file(s): ${shown}${more}`);
  }
  if (searchTargets.size > 0) {
    const searchList = Array.from(searchTargets);
    const shown = searchList.slice(0, 4).map((q) => `"${q}"`).join(", ");
    const more = searchList.length > 4 ? `, +${searchList.length - 4} more` : "";
    groupedExtras.push(`search ×${searchList.length}: ${shown}${more}`);
  }
  if (fetchTargets.size > 0) {
    const fetchList = Array.from(fetchTargets);
    groupedExtras.push(`fetch ×${fetchList.length}: ${fetchList.slice(0, 3).join(", ")}`);
  }

  const reserveForGroups = Math.min(groupedExtras.length, 3);
  const highLimit = Math.max(4, maxLines - reserveForGroups);

  // Keep the most recent high-priority actions (especially final edits & test runs)
  if (highPriority.length > highLimit) {
    onTruncate?.();
    const skipped = highPriority.length - highLimit;
    out.push(`...(${skipped} earlier mutations/commands condensed)`);
    for (const r of highPriority.slice(-highLimit)) {
      out.push(r.summary);
    }
  } else {
    for (const r of highPriority) {
      out.push(r.summary);
    }
  }

  for (const g of groupedExtras) {
    if (out.length < maxLines + 2) out.push(g);
  }
  if (otherSummaries.length > 0 && out.length < maxLines + 2) {
    out.push(...otherSummaries.slice(0, Math.max(0, maxLines + 2 - out.length)));
  }

  if (records.length > out.length) {
    onTruncate?.();
  }
  return out;
}

function summarizeToolCall(
  item: ToolCallTimelineItem,
  filesWritten: Set<string>,
  filesEdited: Set<string>,
  filesRead: Set<string>,
  richHighlights: RichToolHighlight[],
  transcriptExtras: TranscriptExtraDetail[],
  onPlan: (planText: string) => void,
): ToolSummaryRecord {
  const d: ToolCallDetail = item.detail;
  const failed = item.status === "failed";
  const statusTag =
    item.status === "failed"
      ? " [FAILED]"
      : item.status === "canceled"
        ? " [CANCELED]"
        : "";

  const succeeded = item.status === "completed";

  switch (d.type) {
    case "edit": {
      if (succeeded) {
        filesEdited.add(d.filePath);
      }
      if (d.unifiedDiff && d.unifiedDiff.trim()) {
        richHighlights.push({
          kind: "edit_diff",
          label: `Edit ${d.filePath}${statusTag}`,
          body: truncateText(d.unifiedDiff, 800),
        });
      } else if (d.oldString !== undefined && d.newString !== undefined) {
        richHighlights.push({
          kind: "edit_diff",
          label: `Edit ${d.filePath}${statusTag}`,
          body: truncateText(`- ${d.oldString}\n+ ${d.newString}`, 800),
        });
      }
      return { kind: "edit", failed, target: d.filePath, summary: `edit ${d.filePath}${statusTag}` };
    }
    case "write": {
      if (succeeded) {
        filesWritten.add(d.filePath);
        filesEdited.add(d.filePath);
      }
      if (d.content && d.content.trim()) {
        richHighlights.push({
          kind: "edit_diff",
          label: `Write ${d.filePath}${statusTag}`,
          body: truncateText(d.content, 600),
        });
      }
      return { kind: "write", failed, target: d.filePath, summary: `write ${d.filePath}${statusTag}` };
    }
    case "read": {
      filesRead.add(d.filePath);
      if (d.content && d.content.trim()) {
        transcriptExtras.push({
          label: `Read ${d.filePath}`,
          body: truncateText(d.content, 450),
        });
      }
      return { kind: "read", failed, target: d.filePath, summary: `read ${d.filePath}${statusTag}` };
    }
    case "shell": {
      const exitInfo = typeof d.exitCode === "number" ? ` (exit ${d.exitCode})` : "";
      const isFailure = failed || (typeof d.exitCode === "number" && d.exitCode !== 0);
      if (isFailure && d.output && d.output.trim()) {
        richHighlights.push({
          kind: "error_output",
          label: `Failed command: ${oneLine(d.command, 90)}${exitInfo}`,
          body: truncateText(d.output, 1200),
        });
      } else if (d.output && d.output.trim()) {
        transcriptExtras.push({
          label: `Shell ${oneLine(d.command, 70)}${exitInfo}`,
          body: truncateText(d.output, 450),
        });
      }
      const errSnippet = isFailure && d.output ? ` -> ${oneLine(d.output, 140)}` : "";
      return {
        kind: "shell",
        failed: isFailure,
        target: oneLine(d.command, 80),
        summary: `shell \`${oneLine(d.command, 100)}\`${exitInfo}${statusTag}${errSnippet}`,
      };
    }
    case "search": {
      const q = oneLine(d.query, 60);
      if (d.filePaths && d.filePaths.length > 0) {
        transcriptExtras.push({
          label: `Search "${q}" matches`,
          body: d.filePaths.slice(0, 15).join("\n"),
        });
      } else if (d.content && d.content.trim()) {
        transcriptExtras.push({
          label: `Search "${q}"`,
          body: truncateText(d.content, 400),
        });
      }
      return {
        kind: "search",
        failed,
        target: q,
        summary: `search "${oneLine(d.query, 80)}"${typeof d.numMatches === "number" ? ` (${d.numMatches} matches)` : ""}${statusTag}`,
      };
    }
    case "fetch":
      return {
        kind: "fetch",
        failed,
        target: oneLine(d.url, 80),
        summary: `fetch ${oneLine(d.url, 100)}${statusTag}`,
      };
    case "sub_agent":
      return {
        kind: "sub_agent",
        failed,
        summary: `sub_agent ${d.subAgentType ?? "agent"}: ${oneLine(d.description ?? "", 100)}${statusTag}`,
      };
    case "plan": {
      if (d.text.trim()) {
        onPlan(d.text.trim());
        richHighlights.push({
          kind: "plan",
          label: "Plan",
          body: truncateText(d.text, 1200),
        });
      }
      return { kind: "plan", failed, summary: `plan: ${oneLine(d.text, 140)}${statusTag}` };
    }
    case "worktree_setup":
      return {
        kind: "worktree",
        failed,
        summary: `worktree_setup ${d.branchName} (${d.worktreePath})${statusTag}`,
      };
    case "plain_text": {
      const label = d.label ?? item.name;
      const body = d.text?.trim() ?? "";
      if (body.length > 160) {
        transcriptExtras.push({
          label,
          body: truncateText(body, 2000),
        });
      }
      return {
        kind: "other",
        failed,
        summary: `${label}: ${oneLine(body, 100)}${statusTag}`,
      };
    }
    case "unknown":
    default:
      return { kind: "other", failed, summary: `tool ${item.name}${statusTag}` };
  }
}

function extractIncomingAgentMessage(item: ToolCallTimelineItem): string | null {
  const detail = item.detail;
  const isAgentMessage =
    item.name === "agent_message" ||
    (detail.type === "plain_text" && detail.label === "agent_message") ||
    Boolean(item.agentMessage);
  if (!isAgentMessage) return null;

  const am = item.agentMessage;
  let body: string | null = null;
  if (am && typeof am.text === "string" && am.text.trim()) {
    body = am.text.trim();
  } else if (detail.type === "plain_text" && typeof detail.text === "string" && detail.text.trim()) {
    body = detail.text.trim();
  }
  if (!body) return null;

  if (am) {
    const senderLabel = am.sender?.title?.trim() || am.sender?.id?.trim() || "agent";
    const eventLabel = am.event && am.event !== "message" ? ` (${am.event})` : "";
    return `[Agent Message${eventLabel} from ${senderLabel}]\n${body}`;
  }
  return `[Handoff / Agent Message]\n${body}`;
}

export type CanonicalTurnsResult = ReturnType<typeof buildCanonicalTurns>;

export function buildCanonicalTurns(
  entries: Array<{ item: AgentTimelineItem; timestamp: string; seqStart: number }>,
): {
  turns: CanonicalTurn[];
  filesWritten: string[];
  filesEdited: string[];
  filesRead: string[];
  latestTodos: AgentTaskItem[];
  latestPlan: string | null;
} {
  const turns: CanonicalTurn[] = [];
  const allWritten = new Set<string>();
  const allEdited = new Set<string>();
  const allRead = new Set<string>();
  let latestTodos: AgentTaskItem[] = [];
  let latestPlan: string | null = null;

  let current: {
    timestamp: string;
    userText: string;
    assistantTexts: string[];
    lastReasoning: string;
    toolSummaries: string[];
    toolRecords: ToolSummaryRecord[];
    richHighlights: RichToolHighlight[];
    transcriptExtras: TranscriptExtraDetail[];
    filesWritten: Set<string>;
    filesEdited: Set<string>;
    filesRead: Set<string>;
    errors: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    if (
      !current.userText.trim() &&
      current.assistantTexts.length === 0 &&
      current.toolSummaries.length === 0 &&
      current.errors.length === 0 &&
      !current.lastReasoning.trim()
    ) {
      return;
    }
    for (const f of current.filesWritten) allWritten.add(f);
    for (const f of current.filesEdited) allEdited.add(f);
    for (const f of current.filesRead) allRead.add(f);
    turns.push({
      index: turns.length + 1,
      timestamp: current.timestamp,
      userText: current.userText.trim(),
      assistantTexts: current.assistantTexts,
      lastReasoning: current.lastReasoning.trim(),
      toolSummaries: current.toolSummaries,
      toolRecords: current.toolRecords,
      richHighlights: current.richHighlights,
      transcriptExtras: current.transcriptExtras,
      filesWritten: Array.from(current.filesWritten),
      filesEdited: Array.from(current.filesEdited),
      filesRead: Array.from(current.filesRead),
      errors: current.errors,
    });
  };

  const ensureTurn = (timestamp: string) => {
    if (!current) {
      current = {
        timestamp,
        userText: "",
        assistantTexts: [],
        lastReasoning: "",
        toolSummaries: [],
        toolRecords: [],
        richHighlights: [],
        transcriptExtras: [],
        filesWritten: new Set(),
        filesEdited: new Set(),
        filesRead: new Set(),
        errors: [],
      };
    }
    return current;
  };

  for (const { item, timestamp } of entries) {
    switch (item.type) {
      case "user_message": {
        flush();
        const normalizedUserText = item.text.trim() || "[User sent image/attachment]";
        current = {
          timestamp,
          userText: normalizedUserText,
          assistantTexts: [],
          lastReasoning: "",
          toolSummaries: [],
          toolRecords: [],
          richHighlights: [],
          transcriptExtras: [],
          filesWritten: new Set(),
          filesEdited: new Set(),
          filesRead: new Set(),
          errors: [],
        };
        break;
      }
      case "assistant_message": {
        const t = ensureTurn(timestamp);
        if (item.text.trim()) {
          t.assistantTexts.push(item.text.trim());
        }
        break;
      }
      case "reasoning": {
        const t = ensureTurn(timestamp);
        if (item.text.trim()) {
          t.lastReasoning = item.text.trim();
        }
        break;
      }
      case "tool_call": {
        const formattedMsg = extractIncomingAgentMessage(item);
        if (formattedMsg) {
          if (!current || current.assistantTexts.length > 0) {
            flush();
            current = {
              timestamp,
              userText: formattedMsg,
              assistantTexts: [],
              lastReasoning: "",
              toolSummaries: [],
              toolRecords: [],
              richHighlights: [],
              transcriptExtras: [],
              filesWritten: new Set(),
              filesEdited: new Set(),
              filesRead: new Set(),
              errors: [],
            };
          } else if (current.userText.trim()) {
            // Append consecutive pre-reply agent messages instead of creating orphan empty turns
            current.userText = `${current.userText.trim()}\n\n${formattedMsg}`;
          } else {
            current.userText = formattedMsg;
          }
          break;
        }
        const t = ensureTurn(timestamp);
        const record = summarizeToolCall(
          item,
          t.filesWritten,
          t.filesEdited,
          t.filesRead,
          t.richHighlights,
          t.transcriptExtras,
          (planText) => {
            latestPlan = planText;
          },
        );
        t.toolRecords.push(record);
        t.toolSummaries.push(record.summary);
        break;
      }
      case "todo": {
        latestTodos = item.items;
        break;
      }
      case "error": {
        const t = ensureTurn(timestamp);
        if (item.message.trim()) t.errors.push(item.message.trim());
        break;
      }
      case "notification":
      case "compaction":
      case "plugin":
        break;
    }
  }

  flush();

  return {
    turns,
    filesWritten: Array.from(allWritten),
    filesEdited: Array.from(allEdited),
    filesRead: Array.from(allRead),
    latestTodos,
    latestPlan,
  };
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 1500,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function collectGitWorkspaceContext(
  cwd: string,
  includeGit: boolean,
  includePatch: boolean,
): Promise<GitWorkspaceContext> {
  if (!includeGit || !cwd) {
    return { branch: null, statusShort: "", diffStat: "", uncommittedPatch: "" };
  }
  const [branch, statusShort] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["status", "--short"]),
  ]);
  if (!branch || !statusShort) {
    return {
      branch: branch || null,
      statusShort: statusShort ? truncateText(statusShort, 1600) : "",
      diffStat: "",
      uncommittedPatch: "",
    };
  }
  const [diffStat, diffPatch] = await Promise.all([
    runGit(cwd, ["diff", "--stat"]),
    includePatch ? runGit(cwd, ["diff", "--unified=2"]) : Promise.resolve(null),
  ]);
  return {
    branch,
    statusShort: truncateText(statusShort, 1600),
    diffStat: diffStat ? truncateText(diffStat, 1600) : "",
    uncommittedPatch: diffPatch ? truncateText(diffPatch, 2400) : "",
  };
}

const ORIGIN_PRIORITY: Record<OutputFileOrigin, number> = {
  created: 0,
  modified: 1,
  artifact: 2,
  scratch: 3,
  uploaded: 4,
  referenced: 5,
};

const TEXT_ARTIFACT_EXTS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv"]);
const MAX_OUTPUT_FILES = 32;
const MAX_BRAIN_COPY_FILES = 50;
const MAX_BRAIN_COPY_BYTES = 20 * 1024 * 1024;

export function extractAntigravitySessionId(sessionId: string | null | undefined): string | null {
  if (!sessionId || typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("plugin:")) {
    try {
      const parsed = JSON.parse(trimmed.slice("plugin:".length)) as {
        data?: { sessionId?: unknown };
      };
      if (typeof parsed?.data?.sessionId === "string" && parsed.data.sessionId.trim()) {
        return parsed.data.sessionId.trim();
      }
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z0-9_-]{8,128}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function defaultAntigravityBrainRoot(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

const BOILERPLATE_BARE_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "readme.md",
  "readme.zh-cn.md",
  "license",
  "overview.md",
  "overview.zh-cn.md",
  ".gitignore",
]);

function isIgnoredMentionedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const tmpNormalized = os.tmpdir().replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    normalized.includes("/.git/") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/.system_generated/") ||
    normalized.startsWith("/dev/") ||
    normalized.endsWith("/SKILL.md") ||
    normalized.includes("/.paseo/plugin-data/model-switch/") ||
    normalized.includes("/.gemini/antigravity-cli/mcp/") ||
    normalized.includes("/paseo-attachments-") ||
    (tmpNormalized &&
      normalized.startsWith(`${tmpNormalized}/`) &&
      normalized.includes("paseo-attachments-"))
  ) {
    return true;
  }
  return false;
}

function normalizeCandidatePath(raw: string, cwd: string): string | null {
  let clean = raw.trim();
  if (!clean) return null;
  if (clean.startsWith("file://")) {
    try {
      clean = decodeURIComponent(clean.slice("file://".length));
    } catch {
      clean = clean.slice("file://".length);
    }
  }
  // Strip line/column anchors like #L10-L20, #anchor, or :12 / :12:4
  clean = clean
    .replace(/#L\d+(?:-L\d+)?$/i, "")
    .replace(/#.*$/, "")
    .replace(/:\d+(?::\d+)?$/, "");
  clean = clean.replace(/[),.;:'"`]+$/, "");
  if (!clean || clean.includes("\n") || clean.includes("\0")) return null;

  if (clean.startsWith("~/")) {
    clean = path.join(os.homedir(), clean.slice(2));
  }
  if (!path.isAbsolute(clean)) {
    if (!cwd) return null;
    clean = path.resolve(cwd, clean);
  } else {
    clean = path.resolve(clean);
  }
  return clean;
}

export function extractMentionedFilePaths(text: string, cwd: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  // 1. file:// URLs (e.g. markdown links `[report.md](file:///...)` or `![img](file:///...)`)
  const fileUrlRe = /file:\/\/(\/[^\s)\]>'"]+)/g;
  let match: RegExpExecArray | null;
  while ((match = fileUrlRe.exec(text)) !== null) {
    const resolved = normalizeCandidatePath(`file://${match[1]}`, cwd);
    if (resolved && !isIgnoredMentionedPath(resolved)) {
      found.add(resolved);
    }
  }

  // 2. Inline code absolute / home / workspace-relative file paths (verified on disk later via fs.stat)
  const backtickPathRe =
    /`((?:\/|~\/)?[a-zA-Z0-9._\u4e00-\u9fff-]+(?:\/[a-zA-Z0-9._\u4e00-\u9fff-]+)*\.[a-zA-Z0-9]{1,12}(?::\d+(?::\d+)?)?)`/g;
  while ((match = backtickPathRe.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (/^https?:\/\//i.test(candidate)) continue;
    const withoutLine = candidate.replace(/:\d+(?::\d+)?$/, "");
    if (
      !withoutLine.includes("/") &&
      BOILERPLATE_BARE_FILENAMES.has(withoutLine.toLowerCase())
    ) {
      continue;
    }
    const resolved = normalizeCandidatePath(candidate, cwd);
    if (resolved && !isIgnoredMentionedPath(resolved)) {
      found.add(resolved);
    }
  }

  return Array.from(found);
}

export function parseGitOutputFiles(
  statusShort: string,
  cwd: string,
): Array<{ path: string; origin: "created" | "modified" }> {
  if (!statusShort || !cwd) return [];
  const out: Array<{ path: string; origin: "created" | "modified" }> = [];
  for (const rawLine of statusShort.split("\n")) {
    if (rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    let rel = rawLine.slice(3).trim();
    if (!rel) continue;
    // Handle renames: `R  old -> new`
    const arrowIdx = rel.indexOf(" -> ");
    if (arrowIdx >= 0) {
      rel = rel.slice(arrowIdx + 4).trim();
    }
    if (rel.startsWith('"') && rel.endsWith('"')) {
      rel = rel.slice(1, -1);
    }
    if (code.includes("D")) continue;
    const resolved = path.resolve(cwd, rel);
    if (isIgnoredMentionedPath(resolved)) continue;
    const origin: "created" | "modified" =
      code === "??" || code.includes("A") ? "created" : "modified";
    out.push({ path: resolved, origin });
  }
  return out;
}

async function listDirFilesRecursive(
  dirPath: string,
  maxFiles: number,
  depth = 0,
): Promise<string[]> {
  if (depth > 3) return [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (entry.name === ".system_generated" || entry.name === ".DS_Store") continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      results.push(full);
    } else if (entry.isDirectory()) {
      const nested = await listDirFilesRecursive(full, maxFiles - results.length, depth + 1);
      results.push(...nested);
    }
  }
  return results;
}

export async function collectAntigravityBrainFiles(
  sessionId: string | null | undefined,
  brainBaseDir = defaultAntigravityBrainRoot(),
): Promise<Array<{ path: string; origin: OutputFileOrigin }>> {
  const id = extractAntigravitySessionId(sessionId);
  if (!id || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) return [];
  const brainDir = path.join(brainBaseDir, id);

  let topEntries;
  try {
    topEntries = await fs.readdir(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const collected: Array<{ path: string; origin: OutputFileOrigin }> = [];
  for (const entry of topEntries) {
    if (entry.name === ".system_generated" || entry.name === ".DS_Store") continue;
    const full = path.join(brainDir, entry.name);
    if (entry.isFile()) {
      collected.push({ path: full, origin: "artifact" });
    } else if (entry.isDirectory()) {
      const origin: OutputFileOrigin =
        entry.name === "scratch"
          ? "scratch"
          : entry.name === ".user_uploaded"
            ? "uploaded"
            : "artifact";
      const nested = await listDirFilesRecursive(full, 24);
      for (const f of nested) {
        collected.push({ path: f, origin });
      }
    }
  }
  return collected;
}

export async function copyAntigravityBrainFiles(
  sourceSessionId: string | null | undefined,
  targetSessionId: string | null | undefined,
  brainBaseDir = defaultAntigravityBrainRoot(),
): Promise<string[]> {
  const srcId = extractAntigravitySessionId(sourceSessionId);
  const dstId = extractAntigravitySessionId(targetSessionId);
  if (!srcId || !dstId || srcId === dstId) return [];

  const srcDir = path.join(brainBaseDir, srcId);
  const dstDir = path.join(brainBaseDir, dstId);
  const files = await collectAntigravityBrainFiles(srcId, brainBaseDir);
  if (files.length === 0) return [];

  const copied: string[] = [];
  let totalBytes = 0;

  for (const item of files.slice(0, MAX_BRAIN_COPY_FILES)) {
    try {
      const st = await fs.stat(item.path);
      if (!st.isFile()) continue;
      if (totalBytes + st.size > MAX_BRAIN_COPY_BYTES) continue;
      const rel = path.relative(srcDir, item.path);
      if (!rel || rel.startsWith("..")) continue;
      const destPath = path.join(dstDir, rel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(item.path, destPath, fs.constants.COPYFILE_EXCL);
      totalBytes += st.size;
      copied.push(destPath);
    } catch {
      // Skip existing or unreadable files without failing the switch
    }
  }
  return copied;
}

export async function copyPersistedArtifactsToAntigravityBrain(
  outputFiles: readonly SessionOutputFile[],
  targetSessionId: string | null | undefined,
  brainBaseDir = defaultAntigravityBrainRoot(),
): Promise<string[]> {
  const dstId = extractAntigravitySessionId(targetSessionId);
  if (!dstId) return [];

  const brainArtifacts = outputFiles.filter(
    (f) => f.origin === "artifact" || f.origin === "scratch" || f.origin === "uploaded",
  );
  if (brainArtifacts.length === 0) return [];

  const dstDir = path.join(brainBaseDir, dstId);
  const copied: string[] = [];
  let totalBytes = 0;

  for (const item of brainArtifacts.slice(0, MAX_BRAIN_COPY_FILES)) {
    try {
      const st = await fs.stat(item.path);
      if (!st.isFile()) continue;
      if (totalBytes + st.size > MAX_BRAIN_COPY_BYTES) continue;
      // Skip if the file already lives inside the target brain dir
      const relToTarget = path.relative(dstDir, item.path);
      if (relToTarget && !relToTarget.startsWith("..") && !path.isAbsolute(relToTarget)) {
        continue;
      }
      const subDir =
        item.origin === "scratch"
          ? "scratch"
          : item.origin === "uploaded"
            ? ".user_uploaded"
            : "";
      const fileName = path.basename(item.path);
      if (!fileName || fileName === "." || fileName === "..") continue;
      const destPath = subDir ? path.join(dstDir, subDir, fileName) : path.join(dstDir, fileName);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(item.path, destPath, fs.constants.COPYFILE_EXCL);
      totalBytes += st.size;
      copied.push(destPath);
    } catch {
      // Skip existing or unreadable files without failing the switch
    }
  }
  return copied;
}

export async function collectSessionOutputFiles(input: {
  cwd: string;
  entries: CachedTimelineEntry[];
  canonical?: CanonicalTurnsResult;
  gitStatusShort: string;
  sourceProvider: string;
  sourceSessionId?: string | null;
  ancestorOutputFiles?: readonly SessionOutputFile[];
  brainBaseDir?: string;
}): Promise<SessionOutputFile[]> {
  const { turns, filesWritten, filesEdited } =
    input.canonical ?? buildCanonicalTurns(input.entries);
  const byPath = new Map<string, OutputFileOrigin>();

  const register = (rawPath: string, origin: OutputFileOrigin) => {
    const resolved = normalizeCandidatePath(rawPath, input.cwd);
    if (!resolved) return;
    if (origin === "referenced" && isIgnoredMentionedPath(resolved)) return;
    const existing = byPath.get(resolved);
    if (!existing || ORIGIN_PRIORITY[origin] < ORIGIN_PRIORITY[existing]) {
      byPath.set(resolved, origin);
    }
  };

  for (const f of filesWritten) register(f, "created");
  for (const f of filesEdited) register(f, "modified");
  for (const g of parseGitOutputFiles(input.gitStatusShort, input.cwd)) {
    register(g.path, g.origin);
  }

  if (input.sourceProvider === "antigravity" && input.sourceSessionId) {
    const brainFiles = await collectAntigravityBrainFiles(
      input.sourceSessionId,
      input.brainBaseDir,
    );
    for (const bf of brainFiles) {
      register(bf.path, bf.origin);
    }
  }

  // Extract concrete file links/paths from Turn 1 handoff/initial prompt and all assistant replies
  if (turns.length > 0 && turns[0].userText) {
    for (const p of extractMentionedFilePaths(turns[0].userText, input.cwd)) {
      register(p, "referenced");
    }
  }
  for (const turn of turns) {
    for (const reply of turn.assistantTexts) {
      for (const p of extractMentionedFilePaths(reply, input.cwd)) {
        register(p, "referenced");
      }
    }
  }

  // Carry over output files from prior hops
  if (input.ancestorOutputFiles) {
    for (const prev of input.ancestorOutputFiles) {
      register(prev.path, prev.origin);
    }
  }

  const ordered = Array.from(byPath.entries())
    .sort((a, b) => ORIGIN_PRIORITY[a[1]] - ORIGIN_PRIORITY[b[1]])
    .slice(0, 48);

  const verified: SessionOutputFile[] = [];

  await Promise.all(
    ordered.map(async ([filePath, origin]) => {
      try {
        const st = await fs.stat(filePath);
        if (!st.isFile()) return;
        verified.push({
          path: filePath,
          origin,
          sizeBytes: st.size,
        });
      } catch {
        // Skip paths that do not exist on disk
      }
    }),
  );

  verified.sort(
    (a, b) =>
      ORIGIN_PRIORITY[a.origin] - ORIGIN_PRIORITY[b.origin] || a.path.localeCompare(b.path),
  );
  const capped = verified.slice(0, MAX_OUTPUT_FILES);

  // Deterministically read previews for up to 4 small text artifacts after sorting
  const previewCandidates = capped
    .filter(
      (entry) =>
        entry.origin === "artifact" &&
        TEXT_ARTIFACT_EXTS.has(path.extname(entry.path).toLowerCase()) &&
        typeof entry.sizeBytes === "number" &&
        entry.sizeBytes > 0 &&
        entry.sizeBytes <= 24 * 1024,
    )
    .slice(0, 4);

  await Promise.all(
    previewCandidates.map(async (entry) => {
      try {
        const raw = await fs.readFile(entry.path, "utf8");
        if (raw.trim()) {
          entry.preview = truncateText(raw, 480);
        }
      } catch {
        // Non-fatal
      }
    }),
  );

  return capped;
}

function formatByteSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatOutputFileLines(outputFiles: readonly SessionOutputFile[], includePreview: boolean): string[] {
  const lines: string[] = [];
  for (const f of outputFiles) {
    const size = formatByteSize(f.sizeBytes);
    const meta = size ? `${f.origin}, ${size}` : f.origin;
    lines.push(`- [${meta}] \`${f.path}\``);
    if (includePreview && f.preview) {
      lines.push(`  > ${oneLine(f.preview, 220)}`);
    }
  }
  return lines;
}

function toBannerFileLabel(filePath: string, cwd: string): string {
  if (cwd) {
    const rel = path.relative(cwd, filePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel;
    }
  }
  return path.basename(filePath) || filePath;
}

function toTranscriptFileDisplay(filePath: string, cwd: string): string {
  if (cwd) {
    const rel = path.relative(cwd, filePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel;
    }
  }
  const home = os.homedir();
  if (home && (filePath === home || filePath.startsWith(`${home}${path.sep}`))) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function buildDeduplicatedFilesTouched(input: {
  cwd: string;
  outputFiles: readonly SessionOutputFile[];
  filesWritten: readonly string[];
  filesEdited: readonly string[];
  filesRead: readonly string[];
  ancestorFilesTouched?: readonly string[];
}): string[] {
  const seenResolved = new Set<string>();
  const seenLabels = new Set<string>();
  const labels: string[] = [];

  const addPath = (rawPath: string, allowIgnored = false) => {
    const resolved = normalizeCandidatePath(rawPath, input.cwd) ?? rawPath.trim();
    if (!resolved) return;
    if (!allowIgnored && isIgnoredMentionedPath(resolved)) return;
    if (seenResolved.has(resolved)) return;
    seenResolved.add(resolved);

    let label = toBannerFileLabel(resolved, input.cwd);
    if (seenLabels.has(label)) {
      const parent = path.basename(path.dirname(resolved));
      if (parent && parent !== "." && parent !== "/") {
        label = `${parent}/${label}`;
      }
    }
    if (seenLabels.has(label)) {
      label = toTranscriptFileDisplay(resolved, input.cwd);
    }
    if (seenLabels.has(label)) return;
    seenLabels.add(label);
    labels.push(label);
  };

  for (const f of input.outputFiles) addPath(f.path, true);
  for (const f of input.filesWritten) addPath(f, true);
  for (const f of input.filesEdited) addPath(f, true);
  for (const f of input.filesRead) addPath(f, false);
  if (input.ancestorFilesTouched) {
    for (const raw of input.ancestorFilesTouched) {
      const clean = raw.trim();
      if (!clean || isIgnoredMentionedPath(clean)) continue;
      if (path.isAbsolute(clean) || clean.startsWith("~/")) {
        const resolved = normalizeCandidatePath(clean, input.cwd) ?? clean;
        if (seenResolved.has(resolved)) continue;
        const label = toBannerFileLabel(resolved, input.cwd);
        if (seenLabels.has(label)) continue;
        seenResolved.add(resolved);
        seenLabels.add(label);
        labels.push(label);
      } else if (!seenLabels.has(clean)) {
        seenLabels.add(clean);
        labels.push(clean);
      }
    }
  }

  return labels.slice(0, 40);
}

function replaceOrAppendMarkdownSection(
  doc: string,
  heading: string,
  newBody: string | null,
): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(`(^|\\n\\n)${escaped}\\n[\\s\\S]*?(?=\\n\\n## |$)`);
  const replacement = newBody ? `${heading}\n${newBody}` : "";
  if (sectionRe.test(doc)) {
    return doc
      .replace(sectionRe, (_m, lead: string) => (replacement ? `${lead}${replacement}` : ""))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  if (!replacement) return doc;
  // Insert before Conversation sections when possible so state stays near the top
  const insertBeforeRe = /\n\n## (?:Earlier Session Chain|Initial Task|Earlier Turns Summary|Recent Conversation)/;
  const idx = doc.search(insertBeforeRe);
  if (idx >= 0) {
    return `${doc.slice(0, idx)}\n\n${replacement}${doc.slice(idx)}`;
  }
  return `${doc}\n\n${replacement}`;
}

function upsertHandoffNoteInBriefing(doc: string, cleanNote: string): string {
  const noteLineRe = /^(\d+\.\s+\*\*User handoff instruction for this switch:\*\*).*$/m;
  if (noteLineRe.test(doc)) {
    return doc.replace(noteLineRe, `$1 ${cleanNote}`);
  }
  // Insert right after the last numbered rule in the header block
  const headerEndIdx = doc.indexOf("\n\n## ");
  const headerPart = headerEndIdx >= 0 ? doc.slice(0, headerEndIdx) : doc;
  const restPart = headerEndIdx >= 0 ? doc.slice(headerEndIdx) : "";
  const ruleMatches = [...headerPart.matchAll(/^(\d+)\.\s+/gm)];
  const nextNum =
    ruleMatches.length > 0 ? Number(ruleMatches[ruleMatches.length - 1][1]) + 1 : 4;
  return `${headerPart}\n${nextNum}. **User handoff instruction for this switch:** ${cleanNote}${restPart}`;
}

function formatTurnDigestLine(turn: CanonicalTurn): string {
  const parts: string[] = [];
  if (turn.userText) parts.push(`User: ${oneLine(turn.userText, 220)}`);
  if (turn.filesEdited.length > 0) {
    parts.push(`Edited: ${turn.filesEdited.slice(0, 6).join(", ")}`);
  }
  if (turn.toolRecords.length > 0) {
    const keyTools = compactToolRecords(turn.toolRecords, 4);
    parts.push(`Tools(${turn.toolRecords.length}): ${keyTools.join("; ")}`);
  }
  if (turn.errors.length > 0) {
    parts.push(`Errors: ${oneLine(turn.errors.join(" | "), 160)}`);
  }
  if (turn.assistantTexts.length > 0) {
    const lastReply = turn.assistantTexts[turn.assistantTexts.length - 1];
    parts.push(`Assistant: ${oneLine(lastReply, 240)}`);
  }
  return `- Turn ${turn.index}: ${parts.join(" | ")}`;
}

function formatTurnVerbatim(
  turn: CanonicalTurn,
  maxTurnChars: number,
  options: {
    includeRichDetails: boolean;
    isNewestTurn: boolean;
    onTruncate: () => void;
  },
): string {
  const blocks: string[] = [`### Turn ${turn.index}`];
  if (turn.userText) {
    blocks.push(
      `**User:**\n${truncateText(turn.userText, Math.floor(maxTurnChars * 0.35), options.onTruncate)}`,
    );
  }
  if (turn.toolRecords.length > 0) {
    const compacted = compactToolRecords(turn.toolRecords, 12, options.onTruncate);
    blocks.push(`**Actions:**\n${compacted.map((s) => `- ${s}`).join("\n")}`);
  }
  if (options.includeRichDetails && turn.richHighlights.length > 0) {
    const highlightBudget = Math.max(400, Math.floor(maxTurnChars * 0.3));
    const lines: string[] = [];
    let used = 0;
    const prioritized = [...turn.richHighlights].sort((a, b) => {
      const score = (k: RichToolHighlight["kind"]) =>
        k === "error_output" ? 0 : k === "plan" ? 1 : 2;
      return score(a.kind) - score(b.kind);
    });
    for (const h of prioritized.slice(0, 4)) {
      const snippet = `#### ${h.label}\n\`\`\`\n${truncateText(h.body, Math.min(700, highlightBudget), options.onTruncate)}\n\`\`\``;
      if (used + snippet.length > highlightBudget && lines.length > 0) {
        options.onTruncate();
        break;
      }
      lines.push(snippet);
      used += snippet.length + 2;
    }
    if (lines.length > 0) {
      blocks.push(`**Key Tool Details:**\n${lines.join("\n")}`);
    }
  }
  if (turn.errors.length > 0) {
    blocks.push(`**Errors:**\n${turn.errors.map((e) => `- ${oneLine(e, 240)}`).join("\n")}`);
  }
  if (turn.assistantTexts.length > 0) {
    const combinedAssistant = turn.assistantTexts.join("\n\n");
    blocks.push(
      `**Assistant:**\n${truncateText(combinedAssistant, Math.floor(maxTurnChars * 0.5), options.onTruncate)}`,
    );
  } else if (options.isNewestTurn && turn.lastReasoning) {
    blocks.push(
      `**[Interrupted Reasoning — previous model stopped before replying]:**\n${truncateText(turn.lastReasoning, 1000, options.onTruncate)}`,
    );
  }
  return blocks.join("\n\n");
}

function buildFullTranscriptMarkdown(input: {
  sourceProvider: string;
  sourceModel: string;
  cwd: string;
  turns: CanonicalTurn[];
  git: GitWorkspaceContext;
  filesTouched: string[];
  outputFiles: SessionOutputFile[];
  latestTodos: AgentTaskItem[];
  latestPlan: string | null;
  handoffNote?: string;
  ancestor?: PersistedSwitchRecord | null;
}): string {
  const lines: string[] = [
    `# Session Transcript (${input.sourceProvider}/${input.sourceModel})`,
    "",
    `- Workspace: \`${input.cwd}\``,
    `- Captured At: ${new Date().toISOString()}`,
    `- Total Turns in This Segment: ${input.turns.length}`,
  ];

  if (input.git.branch) lines.push(`- Git Branch: \`${input.git.branch}\``);
  if (input.filesTouched.length > 0) {
    lines.push(`- Files Touched: ${input.filesTouched.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (input.handoffNote) {
    lines.push(`- Handoff Note: ${input.handoffNote}`);
  }
  if (input.ancestor) {
    lines.push(
      `- Prior Switch Hop #${input.ancestor.hopCount}: from \`${input.ancestor.fromProvider}/${input.ancestor.fromModel}\` (transcript: \`${input.ancestor.transcriptPath}\`)`,
    );
  }
  if (input.outputFiles.length > 0) {
    lines.push(
      "",
      "## Project Output Files & Artifacts",
      "",
      ...formatOutputFileLines(input.outputFiles, true),
    );
  }
  if (input.ancestor?.ancestorSummary) {
    lines.push("", "## Earlier Hop Summary", "", input.ancestor.ancestorSummary);
  }
  if (input.latestPlan) {
    lines.push("", "## Latest Active Plan", "", input.latestPlan);
  }
  if (input.latestTodos.length > 0) {
    lines.push(
      "",
      "## Active Task Checklist",
      "",
      ...input.latestTodos.map(
        (t) => `- [${t.completed || t.status === "completed" ? "x" : " "}] ${t.text}`,
      ),
    );
  }

  lines.push("", "## Conversation History", "");
  for (const turn of input.turns) {
    lines.push(`### Turn ${turn.index} (${turn.timestamp})`);
    if (turn.userText) lines.push("", "**User:**", "", turn.userText);
    if (turn.toolSummaries.length > 0) {
      lines.push("", "**Tool Calls:**", "", ...turn.toolSummaries.map((s) => `- ${s}`));
    }
    if (turn.richHighlights.length > 0) {
      for (const h of turn.richHighlights) {
        lines.push("", `**${h.label}:**`, "", "```", h.body, "```");
      }
    }
    if (turn.transcriptExtras.length > 0) {
      for (const extra of turn.transcriptExtras.slice(0, 6)) {
        lines.push("", `**${extra.label}:**`, "", "```", extra.body, "```");
      }
    }
    if (turn.errors.length > 0) {
      lines.push("", "**Errors:**", "", ...turn.errors.map((e) => `- ${e}`));
    }
    if (turn.assistantTexts.length > 0) {
      lines.push("", "**Assistant:**", "", turn.assistantTexts.join("\n\n"));
    } else if (turn.lastReasoning) {
      lines.push("", "**Interrupted Reasoning:**", "", turn.lastReasoning);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function compileContextFromEntries(input: {
  entries: CachedTimelineEntry[];
  canonical?: CanonicalTurnsResult;
  timelineTruncated?: boolean;
  git: GitWorkspaceContext;
  cwd: string;
  sourceProvider: string;
  sourceModel: string;
  targetContextWindowTokens?: number;
  settings: ModelSwitchSettings;
  handoffNote?: string;
  ancestor?: PersistedSwitchRecord | null;
  outputFiles?: SessionOutputFile[];
  transcriptPathPlaceholder: string;
}): CompiledContext {
  const { turns, filesWritten, filesEdited, filesRead, latestTodos, latestPlan } =
    input.canonical ?? buildCanonicalTurns(input.entries);
  const outputFiles = input.outputFiles ?? [];
  const cleanNote = input.handoffNote?.trim();
  const isEmptySession =
    turns.length === 0 && outputFiles.length === 0 && !input.ancestor && !cleanNote;
  const initialTaskAnchor =
    input.ancestor?.initialTaskAnchor ??
    (!input.timelineTruncated ? turns[0]?.userText || undefined : undefined);

  const buildWorkspaceStateLines = (markTruncated?: () => void): string[] => {
    const lines: string[] = [];
    if (input.git.branch) lines.push(`- Git branch: \`${input.git.branch}\``);
    if (filesEdited.length > 0) {
      lines.push(
        `- Files modified earlier: ${filesEdited.slice(0, 20).map((f) => `\`${f}\``).join(", ")}`,
      );
    }
    if (input.git.statusShort) {
      lines.push(`- Working tree status:\n\`\`\`\n${input.git.statusShort}\n\`\`\``);
    }
    if (input.git.diffStat) {
      lines.push(`- Uncommitted diff stat:\n\`\`\`\n${input.git.diffStat}\n\`\`\``);
    }
    if (input.git.uncommittedPatch && input.settings.includeUncommittedPatch) {
      lines.push(
        `- Uncommitted patch preview:\n\`\`\`diff\n${input.git.uncommittedPatch}\n\`\`\``,
      );
    }
    if (latestPlan) {
      lines.push(`- Latest active plan:\n${truncateText(latestPlan, 1800, markTruncated)}`);
    }
    if (latestTodos.length > 0) {
      lines.push(
        `- Active task list:\n${latestTodos.map((t) => `  - [${t.completed || t.status === "completed" ? "x" : " "}] ${t.text}`).join("\n")}`,
      );
    }
    return lines;
  };

  // Lossless pass-through when switching back-to-back with 0 new turns on an already-switched session:
  // carry forward the previous hop's verbatim briefing while refreshing live workspace state,
  // output files, and any new handoff note.
  if (turns.length === 0 && input.ancestor && input.ancestor.systemPromptBriefing) {
    const filesTouched = buildDeduplicatedFilesTouched({
      cwd: input.cwd,
      outputFiles,
      filesWritten,
      filesEdited,
      filesRead,
      ancestorFilesTouched: input.ancestor.filesTouched,
    });
    const transcriptFiles = Array.from(
      new Set([
        ...outputFiles.map((f) => toTranscriptFileDisplay(f.path, input.cwd)),
        ...filesTouched,
      ]),
    ).slice(0, 40);

    let systemPromptBriefing = input.ancestor.systemPromptBriefing;
    const liveWorkspaceLines = buildWorkspaceStateLines();
    if (liveWorkspaceLines.length > 0) {
      systemPromptBriefing = replaceOrAppendMarkdownSection(
        systemPromptBriefing,
        "## Workspace State",
        liveWorkspaceLines.join("\n"),
      );
    }
    if (outputFiles.length > 0) {
      const outputBlock = formatOutputFileLines(outputFiles.slice(0, 24), true).join("\n");
      systemPromptBriefing = replaceOrAppendMarkdownSection(
        systemPromptBriefing,
        "## Project Output Files & Artifacts",
        truncateText(outputBlock, 3600),
      );
    }
    if (cleanNote) {
      systemPromptBriefing = upsertHandoffNoteInBriefing(systemPromptBriefing, cleanNote);
    }

    const transcriptMarkdown = buildFullTranscriptMarkdown({
      sourceProvider: input.sourceProvider,
      sourceModel: input.sourceModel,
      cwd: input.cwd,
      turns,
      git: input.git,
      filesTouched: transcriptFiles,
      outputFiles,
      latestTodos,
      latestPlan,
      handoffNote: cleanNote,
      ancestor: input.ancestor,
    });
    return {
      turns,
      filesTouched,
      outputFiles,
      git: input.git,
      latestTodos,
      latestPlan,
      isEmptySession: false,
      hasOmittedHistory: Boolean(input.ancestor.hasOmittedHistory),
      systemPromptBriefing,
      transcriptMarkdown,
      previewTurns: input.ancestor.bannerData?.previewTurns ?? [],
      ancestorSummary: input.ancestor.ancestorSummary ?? "",
      initialTaskAnchor,
    };
  }

  const filesTouched = buildDeduplicatedFilesTouched({
    cwd: input.cwd,
    outputFiles,
    filesWritten,
    filesEdited,
    filesRead,
  });
  const transcriptFiles = Array.from(
    new Set([
      ...outputFiles.map((f) => toTranscriptFileDisplay(f.path, input.cwd)),
      ...filesWritten.map((f) => toTranscriptFileDisplay(normalizeCandidatePath(f, input.cwd) ?? f, input.cwd)),
      ...filesEdited.map((f) => toTranscriptFileDisplay(normalizeCandidatePath(f, input.cwd) ?? f, input.cwd)),
      ...filesRead
        .filter((f) => !isIgnoredMentionedPath(normalizeCandidatePath(f, input.cwd) ?? f))
        .map((f) => toTranscriptFileDisplay(normalizeCandidatePath(f, input.cwd) ?? f, input.cwd)),
    ]),
  ).slice(0, 40);

  // CJK-aware char budget so Chinese conversations respect target context windows accurately
  const textSample = turns
    .slice(-4)
    .map((t) => `${t.userText}\n${t.assistantTexts.join("\n")}`)
    .join("\n");
  const charsPerToken = estimateCharsPerToken(textSample);
  const modelCharCap = input.targetContextWindowTokens
    ? Math.floor(input.targetContextWindowTokens * charsPerToken * 0.35)
    : input.settings.maxContextChars;
  const budgetChars = Math.max(4000, Math.min(input.settings.maxContextChars, modelCharCap));

  const recentCount = Math.min(turns.length, input.settings.recentTurnsVerbatim);
  const splitIdx = Math.max(0, turns.length - recentCount);
  const olderTurns = turns.slice(0, splitIdx);
  const recentTurns = turns.slice(splitIdx);

  let wasTruncated = false;
  const markTruncated = () => {
    wasTruncated = true;
  };

  const metaLines = buildWorkspaceStateLines(markTruncated);

  const bodySections: string[] = [];
  if (metaLines.length > 0) {
    bodySections.push(`## Workspace State\n${metaLines.join("\n")}`);
  }

  if (outputFiles.length > 0) {
    const outputBlock = formatOutputFileLines(outputFiles.slice(0, 24), true).join("\n");
    bodySections.push(
      `## Project Output Files & Artifacts\n${truncateText(outputBlock, Math.min(3600, Math.floor(budgetChars * 0.2)), markTruncated)}`,
    );
  }

  if (input.ancestor?.ancestorSummary) {
    bodySections.push(
      `## Earlier Session Chain (Before Previous Switch)\n${truncateText(input.ancestor.ancestorSummary, 3000, markTruncated)}`,
    );
  }

  // Anchor the original root task whenever Turn 1 is omitted (or inherited from a prior hop)
  const shouldAnchorInitialTask =
    Boolean(initialTaskAnchor) &&
    (Boolean(input.ancestor?.initialTaskAnchor) || olderTurns.length > 0);
  if (shouldAnchorInitialTask && initialTaskAnchor) {
    const anchorBudget = Math.min(4500, Math.floor(budgetChars * 0.25));
    bodySections.push(
      `## Initial Task / Original Request (Turn 1)\n${truncateText(initialTaskAnchor, anchorBudget, markTruncated)}`,
    );
  }

  const allTurnDigestLines = turns.map(formatTurnDigestLine);

  if (olderTurns.length > 0) {
    const olderDigest = allTurnDigestLines.slice(0, splitIdx).join("\n");
    bodySections.push(
      `## Earlier Turns Summary (Turns 1–${olderTurns.length})\n${truncateText(olderDigest, Math.floor(budgetChars * 0.25), markTruncated)}`,
    );
  }

  const headerReserve = 750;
  const usedSoFar = headerReserve + bodySections.join("\n\n").length;
  const remainingForRecent = Math.max(2000, budgetChars - usedSoFar - 200);
  const perTurnCap =
    recentTurns.length > 0
      ? Math.max(900, Math.floor(remainingForRecent / recentTurns.length))
      : 2000;

  const formattedRecent: string[] = [];
  let recentChars = 0;
  let droppedRecent = false;
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const isVeryRecent = recentTurns.length - i <= 3;
    const isNewestTurn = i === recentTurns.length - 1;
    const block = formatTurnVerbatim(recentTurns[i], perTurnCap, {
      includeRichDetails: input.settings.includeRecentDiffs && isVeryRecent,
      isNewestTurn,
      onTruncate: markTruncated,
    });
    if (recentChars + block.length > remainingForRecent && formattedRecent.length > 0) {
      droppedRecent = true;
      break;
    }
    formattedRecent.push(block);
    recentChars += block.length + 2;
  }
  formattedRecent.reverse();

  if (formattedRecent.length > 0) {
    bodySections.push(`## Recent Conversation (Verbatim)\n\n${formattedRecent.join("\n\n")}`);
  } else if (turns.length === 0) {
    bodySections.push(
      `## Conversation State\nNo prior turns were recorded in the previous session; wait for the user's request.`,
    );
  }

  const hasOmittedHistory =
    Boolean(input.ancestor) ||
    Boolean(input.timelineTruncated) ||
    olderTurns.length > 0 ||
    droppedRecent ||
    wasTruncated ||
    turns.some((t) => t.transcriptExtras.length > 0);

  const headerLines: string[] = [
    `[SEAMLESS MODEL SWITCH CONTEXT]`,
    `You are seamlessly continuing an active Paseo coding session previously handled by \`${input.sourceProvider}/${input.sourceModel}\`.`,
    `Critical behavior rules:`,
    `1. Do NOT greet the user, re-introduce yourself, or mention the model switch unless asked.`,
    `2. Treat the conversation history below as your own prior work and continue naturally on the user's next message.`,
    `3. Preserve all established constraints, architectural decisions, and file edits.`,
  ];

  let nextRuleNum = 4;
  if (outputFiles.length > 0) {
    headerLines.push(
      `${nextRuleNum}. Existing project output files and session artifacts are listed under \`## Project Output Files & Artifacts\`—inspect, reuse, or update them directly rather than recreating them from scratch.`,
    );
    nextRuleNum += 1;
  }
  if (hasOmittedHistory) {
    headerLines.push(
      `${nextRuleNum}. If you need exact details from earlier turns or prior hops, call \`${READ_CONTEXT_TOOL_NAME}\` (supports \`action: "list_hops" | "search" | "read"\` and \`hop: "all"\`; full transcript is saved at \`${input.transcriptPathPlaceholder}\`).`,
    );
    nextRuleNum += 1;
  }

  if (cleanNote) {
    headerLines.push(`${nextRuleNum}. **User handoff instruction for this switch:** ${cleanNote}`);
  }

  const systemPromptBriefing = isEmptySession
    ? ""
    : [headerLines.join("\n"), ...bodySections].join("\n\n");

  const transcriptMarkdown = isEmptySession
    ? ""
    : buildFullTranscriptMarkdown({
        sourceProvider: input.sourceProvider,
        sourceModel: input.sourceModel,
        cwd: input.cwd,
        turns,
        git: input.git,
        filesTouched: transcriptFiles,
        outputFiles,
        latestTodos,
        latestPlan,
        handoffNote: cleanNote,
        ancestor: input.ancestor,
      });

  const previewTurns: PreviewTurn[] = [];
  for (const turn of turns.slice(-3)) {
    if (turn.userText) {
      previewTurns.push({
        turnIndex: turn.index,
        role: "user",
        text: truncateText(turn.userText, 360),
        timestamp: turn.timestamp,
      });
    }
    if (turn.assistantTexts.length > 0) {
      previewTurns.push({
        turnIndex: turn.index,
        role: "assistant",
        text: truncateText(turn.assistantTexts[turn.assistantTexts.length - 1], 420),
        timestamp: turn.timestamp,
      });
    }
  }

  const digestLines: string[] = [];
  if (input.ancestor?.ancestorSummary) {
    digestLines.push(truncateText(input.ancestor.ancestorSummary, 1400));
  }
  digestLines.push(...allTurnDigestLines);
  const ancestorSummary = truncateText(digestLines.join("\n"), 4000);

  return {
    turns,
    filesTouched,
    outputFiles,
    git: input.git,
    latestTodos,
    latestPlan,
    isEmptySession,
    hasOmittedHistory,
    systemPromptBriefing,
    transcriptMarkdown,
    previewTurns,
    ancestorSummary,
    initialTaskAnchor,
  };
}

export async function compileSessionContext(input: {
  paseo: PaseoApi;
  turnCache: IncrementalTimelineCache;
  agentId: string;
  cwd: string;
  sourceProvider: string;
  sourceModel: string;
  targetContextWindowTokens?: number;
  settings: ModelSwitchSettings;
  handoffNote?: string;
  ancestor?: PersistedSwitchRecord | null;
  transcriptPathPlaceholder: string;
}): Promise<CompiledContext> {
  const [entries, git] = await Promise.all([
    input.turnCache.fetchFullTimeline(input.paseo, input.agentId),
    collectGitWorkspaceContext(
      input.cwd,
      input.settings.includeGitContext,
      input.settings.includeUncommittedPatch,
    ),
  ]);

  return compileContextFromEntries({
    entries,
    git,
    cwd: input.cwd,
    sourceProvider: input.sourceProvider,
    sourceModel: input.sourceModel,
    targetContextWindowTokens: input.targetContextWindowTokens,
    settings: input.settings,
    handoffNote: input.handoffNote,
    ancestor: input.ancestor,
    transcriptPathPlaceholder: input.transcriptPathPlaceholder,
  });
}
