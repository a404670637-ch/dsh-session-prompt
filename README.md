# dsh-session-prompt

在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web 的**会话头部**为每个对话固定一段独立提示词。它作为系统提示词的一部分随每次请求完整发送，**不进入对话历史**，因此上下文压缩（compaction / ACP fold）不会把它折叠或省略；压缩之后仍然完整传给模型。

> A DSH Web plugin that pins a per-conversation prompt as a system-prompt section. It is sent in full on every request and is never folded by context compaction.

## 为什么不会被压缩

DSH 的上下文压缩只处理**对话历史消息**（用户/助手/工具调用/工具结果），而本插件把文本注册成**系统提示词段**：

- 段名：`session-prompt:pinned`
- 顺序：`9500`
- `interpolate: false`（提示词按原文发送，不当作模板插值）
- 每次组装系统提示词时实时读取，保存后下一次模型请求生效

所以无论 DSH 原生 compaction 还是 ACP 插件折叠历史，都不会删掉这段文字。它也不是工具结果，不会因为工具结果被摘要而消失。

## 功能

- **每个对话独立**：状态按会话 id 保存，互不影响；分支/新会话默认没有提示词。
- **会话头部入口**：标题旁新增「提示词 / Prompt」按钮；有内容时显示一个圆点。点击打开编辑弹窗。
- **仅空闲时可编辑**：模型运行中弹窗只读、保存按钮禁用；Host 侧也会拒绝运行中的保存（`RUNNING`）。
- **上限保护**：默认 5,000 tokens；保存时按 token 预算校验，超出拒绝并显示计数，不会静默写爆。
- **持久化**：`$DSH_HOME/dsh-session-prompt/sessions/<sha256(sessionId)>.json`，重启后保留。
- **中英文 UI**：跟随 DSH 语言设置。

## 安装

要求：DSH `0.2.x`、Web profile、Node.js 22+。

### 方式 A：DSH CLI（推荐）

```bash
git clone https://github.com/a404670637-ch/dsh-session-prompt.git
dsh plugin --profile web add ./dsh-session-prompt
```

`dsh plugin` 会把参数转发给 profile 目录里的 pnpm；安装的是本地目录依赖。安装完成后**刷新 DSH Web 页面**（Client 半是浏览器模块，需要重新加载）。

### 方式 B：插件管理器

在 DSH 的 `plugin_manager` 中用 `install_bundle` 指向克隆下来的目录，确认 `dsh.bundle.patch` 生效后刷新页面。

### 方式 C：手动 patch（开发/调试）

把仓库放进 profile 的依赖可解析位置，然后在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: session-prompt
      name: dsh-session-prompt
      config:
        maxTokens: 5000
        sectionOrder: 9500
```

安装后请确认插件行是 active；Client 半需要刷新页面才会出现按钮。

## 配置

```yaml
- insert:
    - id: session-prompt
      name: dsh-session-prompt
      config:
        maxTokens: 5000      # 每个对话的固定提示词 token 上限
        sectionOrder: 9500   # 系统提示词段顺序
```

- `maxTokens` 默认 `5000`。建议不要调到 5,000 以上：它会永久占用每次请求的头部 token。
- `sectionOrder` 默认 `9500`，位于交付物引用（9000）之后、结构化输出（9900）之前。

## Token 上限怎么算

用公开的 DeepSeek-V3 tokenizer（`tokenizers` 0.23.3）实测：

| 文本类型 | chars/token | ≈ 5,000 tokens 的字数 |
|---|---:|---:|
| 中文说明文 | 1.773 | 约 8,800 字 |
| 英文说明文 | 5.75 | 约 28,800 字 |
| 中英混排 Markdown | 2.58 | 约 12,900 字 |

代码、符号、emoji 的 token 密度更高，所以插件没有用固定字数，而是用随内容组成切换的**保守估算**（CJK 0.55 tok/char、ASCII 字母数字空白 0.17、ASCII 标点 0.4、其他非 ASCII 0.8 起）。当前保守上限约为：纯中文 7,300 字 / 纯英文 25,000 字 / 中英混排 12,500 字。界面实时显示估算 tokens 与字符数。

## 与上下文窗口的关系

- 提示词上限 5,000 tokens，约为 1,048,576 窗口的 **0.48%**。
- 它会被计入 bili（billion-context）等压缩插件的输入估算，不会绕过 80% 压缩线。
- 把 `maxTokens` 调得很大才会明显抬高头部占用；保持 5,000 以内是安全的。
- 推荐搭配：`billion-context` 的 `compress.maxContextLimit` 设为 `80%` 左右，让历史在接近窗口前先折叠。

## 开发

```bash
node --test
```

Host 测试覆盖：估算器、注入段渲染、按会话保存/读取、运行中拒绝、超限拒绝、未知会话、跨实例持久化、`agent/created` 注册。测试不依赖 DSH 运行时，可在 Node 22 下直接运行。

## 兼容性与限制

- 只针对 **DSH Web**（Client 半使用 `conversation.session.header.actions` 与 `shell.overlay` 槽位）；TUI/headless 不显示该按钮，但 Host 段仍会注入。
- 会话 id 来自 DSH；分支/新会话不会复制提示词。
- 保存时只允许空闲状态；如果模型正在运行，请等结束。
- 本插件不修改 DSH 的 compaction/native 行为，也不写 bili 的状态。
- 数据只存本地 `$DSH_HOME`，不发网络请求。

## License

MIT
