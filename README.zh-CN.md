# paseo-model-switch（简体中文）

[English](README.md) | 简体中文

为 [Paseo](https://paseo.sh) 打造的会话中途无感切换模型插件，同时支持**同 Provider 原地热切换**与**跨 Provider 会话无感续接**（覆盖 `antigravity`、`codex`、`opencode`、`claude`、`copilot`、`pi` 等），以最小化界面打扰完成上下文交接。

## 安装

需要 Paseo Daemon `>=0.17.4` 且已开启插件功能：

```bash
paseo plugin install github:shinelinxx/paseo-model-switch
```

## 核心特性

- **统一轻量入口**
  - 极简输入框胶囊（`⇄ 切` / `⇄ ×N`），可在 **设置 → 插件 → Model Switch** 中自由切换展示形态（`compact`、`toolbar`、`when-switched`、`hidden`）。
  - 桌面端自动聚焦的搜索弹窗，支持 **回车直切（Enter-to-switch）**、Provider 筛选标签、收藏置顶、最近使用模型、内联思考档位切换、可选交接备注（Handoff Note）以及一键切回上一个模型。
  - 支持斜杠命令 `/m` 与 `/switch`，以及 `⌘K` Command Center 快捷入口。
- **同 Provider 与跨 Provider 智能路由**
  - **同 Provider**：通过 `composer.setModel()` / `setThinking()` 在当前会话内原地热切换。
  - **跨 Provider**：通过序列化增量缓存提取完整时间线，生成针对中英文（CJK）优化预算的交接摘要（优先保留文件修改、失败命令输出、当前计划、`--force` 强切时被中断的思考过程与工作区 Git 状态），经由 `agent.open.before`（`appendSystemPrompt`）静默注入新会话，按需挂载免审批的多跳历史检索工具（`read_previous_session_context`），自动迁移未发送草稿与插件附件并聚焦新标签页；若原会话仍有活跃子 Agent 或后台任务，则自动保护跳过归档。
  - **空会话快速通道**：在尚未发起对话的 0 回合新标签页跨 Provider 切换时，自动跳过合成摘要与顶部横幅，做到零噪音。
- **精准的模式与选项映射**
  - 在不同 Provider 之间语义化映射 `plan`、`auto`、`accept-edits` 与 `full-access` 模式，并支持与 OpenCode 的 `build` + `auto_accept` 双向同步。
- **多跳谱系与内联横幅**
  - 时间线顶部提供可折叠交接横幅，支持多跳面包屑（`#1 → #2`）、可控高度的滚动历史检索以及一键切回并恢复原思考档位。

## 斜杠命令速查

```text
/m codex/gpt-6.2-sol                          # 切换到指定 provider/model
/m codex/gpt-6.2-sol@xhigh                    # 切换并显式指定思考档位
/m opencode/tencent/deepseek/deepseek-flash   # 支持多斜杠 OpenCode 模型 ID
/m back                                       # 一键切回上一模型（自动恢复原思考档位）
/m back@low                                   # 切回上一模型并覆盖思考档位
/m codex/gpt-6.2-sol 继续排查 auth.ts 报错      # 切换模型并顺带发送下一句指令
/m --force --note="只审查不改文件" codex         # 中断运行中回合，并静默注入交接备注
```

## 本地开发

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-model-switch --id model-switch
paseo plugin reload model-switch
```

## 许可证

MIT
