# ChatGPT Desktop ↔ 飞书

通过桌面应用自带的 App Tools MCP，读取和续聊已有的普通 ChatGPT 对话，并将新完成的回答转发到指定飞书私聊。飞书端使用官方 Node SDK 长连接，无需公网回调服务器。

这是一个 Windows 本地原型，依赖特定桌面版本的内部 MCP 接口，并非 OpenAI 或飞书官方集成。它不启动浏览器、独立 Codex CLI、app-server 或其他模型服务；不包含桌面应用或其 MCP 服务端文件。

## 功能

| 功能 | 当前状态 |
| --- | --- |
| 飞书文字 → 已有 ChatGPT 原对话 → 飞书回答 | 支持 |
| 转发当前所选对话中从桌面发起的新回答 | 支持 |
| 最近对话、项目筛选、最近一轮、刷新菜单 | 支持 |
| 切换对话后保留排队消息的原目标 | 支持 |
| 引用旧回答时追问对应原对话 | 支持，依赖飞书事件提供引用消息 ID |
| 重复事件去重、持久化选择、单实例锁 | 支持 |
| 创建普通 ChatGPT 新对话、创建分支、切换模型 | 未支持 |
| 附件、图片、音频、超长回答完整读取 | 未支持 |
| 开机自启动、桌面应用重启后自动恢复 | 未实现或未验收 |

初次绑定或切换到未激活对话时，从当下建立观察基线，不批量转发历史。每个配置的飞书私聊有一个当前所选对话。未知发送结果只做读回核对，不自动重发。

## 前提

- Windows 和 Node.js 22 或以上。
- 正在运行且已登录的桌面应用，其中安装了可读取普通 ChatGPT 对话的 `codex-app-tools` 插件。
- 从获授权的桌面任务启动本程序，合法继承 `CODEX_APP_TOOLS_PIPE_PATH` 与 `CODEX_THREAD_ID`。普通终端通常没有这些上下文，程序会拒绝启动；不要扫描其他任务或复制其他人的连接上下文。
- 一个独立的飞书企业自建机器人，以及自己的私聊 `chat_id`、用户 `open_id`。该应用内的 `open_id` 与其他应用的标识不通用。
- 一个已存在的普通 ChatGPT 对话。不要用 Codex 任务 ID 代替。

默认从当前用户的 `.codex/plugins/cache/openai-bundled/codex-app-tools/` 寻找已安装的 MCP 服务端。自定义 `CODEX_HOME` 或显式 `CHATGPT_BRIDGE_MCP_SERVER` 仅改变本机文件位置，不提供登录或授权。

## 安装与只读检查

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
Copy-Item .\config.example.json .\config.local.json
node .\src\cli.mjs probe --title '示例对话'
```

将 `--title` 改成自己准备使用的普通 ChatGPT 对话名称，名称需要唯一。`probe` 只读取元数据，不发送提示词；输出中的真实 ID 和标题属于本地信息，不应粘贴到公开 Issue。

填写 `config.local.json` 中的机器人应用 ID、初始对话 ID、标题、飞书私聊 ID 和允许使用的用户 ID，然后运行：

```powershell
node .\src\service.mjs --config .\config.local.json --check
```

此检查只读取桌面绑定，不连接飞书。示例配置默认 `enabled: false`，所有标识均为占位符。

## 配置飞书

在[飞书开放平台](https://open.feishu.cn/)创建独立机器人，配置：

1. 消息权限：`im:message:send_as_bot`、`im:message.p2p_msg:readonly`。
2. 事件订阅：长连接方式，事件 `im.message.receive_v1`。
3. 卡片回调：长连接方式，回调 `card.action.trigger`。
4. 将应用可用范围限制在自己的账号，并发布应用版本。

卡片回调配置保存后还需要发布。如果按钮提示未配置回调，检查是否使用了正确应用、回调是否已添加、修改是否已发布。不要与另一个桥接程序共用同一机器人的长连接，以免事件被分配给不同客户端。

通过本地安全配置为当前进程提供 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 环境变量。本程序不会自动加载 `.env` 文件。不要将真实密钥写入命令示例、源码或公开日志。

确认配置后将 `enabled` 改为 `true`，在上述合法桌面任务上下文中运行：

```powershell
node .\src\service.mjs --config .\config.local.json --live
```

也可以使用 `src/credentials.mjs` 的 `saveCredentials` / `loadCredentials` 在 Windows 当前用户下以 DPAPI 保护凭据，并通过 `--credentials` 指定本地文件。该文件不能迁移给其他用户，也不能提交到仓库。已有 DPAPI 凭据时可隐藏启动：

```powershell
node .\src\launch.mjs --credentials .\runtime\credentials.dpapi.json
```

`launch` 使用仓库根目录的 `config.local.json`。启动进程不等于连接成功，需查看 `runtime/service/health.json`，确认状态、最近成功轮询时间及飞书连接，再做一次真实的双向测试。

## 飞书菜单

发送 **菜单** 或 `/menu` 打开操作卡片：

- **最近对话**：只显示接口最近 50 条及置顶记录中的 ChatGPT 对话，每页 8 条。
- **选择项目**：筛选项目后再选择对话；筛选本身不会改变发送目标。
- **最近一轮**：只读当前卡片所指对话，不发送新提示词。
- **刷新菜单**：查看最新选择。

也可发送 `/chats`、`/projects`、`/last`。收到“已切换”卡片后再发送普通文字。旧卡片显示的是生成时的选择，按钮有效期为 7 天。

## 运行与恢复

```powershell
node .\src\status.mjs .\runtime\service
node .\src\stop.mjs .\runtime\service
```

正常停止后，应看到 health 状态变为 `STOPPED` 并释放锁，再启动新进程。不要直接清空状态来重试：`state.json` 包含去重、发送意图和选择记录。`UNKNOWN` 表示结果不确定，需要核对原对话或飞书实际消息，不能盲目重发。

桌面应用需要保持运行。桌面应用整体重启、原任务结束后的长期驻留、Windows 登录自启动尚未完成实机验收。接口升级后需要重新验证读取、发送和卡片回调。

## 验证范围

离线测试共 27 项，包括消息归属、鉴权、去重、未知结果恢复、卡片分发及 Windows DPAPI。已在一套 Windows 环境实测双向文本、桌面主动回答转发、对话选择卡片和正常停止恢复；项目筛选、分页等其余分支未逐项做客户端验收。离线测试通过不代表所有桌面版本或所有飞书租户可用。

`src/roundtrip.mjs --title '示例对话' --journal .\runtime\roundtrip --send-once` 会真实发送一条测试提示词；只在确认目标后使用。之后省略 `--send-once` 可读取同一次尝试的结果，不能通过换目录来重试结果不明的发送。

当前固定 `@larksuiteoapi/node-sdk` 版本为 `1.74.0`。`src/card-websocket.mjs` 对其卡片帧处理进行兼容，依赖 SDK 的内部运行时方法，升级时需要复核。

## 隐私与发布

`runtime/` 包含消息正文、对话标识、处理状态和本地诊断，属于私有数据。源码公开不会开放已部署机器人的使用权限；访问仍受机器人可用范围、配置的私聊 ID 和用户允许列表约束。

本仓库仅包含通用源码、合成测试数据和占位配置；不包含实际授权文件、对话记录、租户地址、截图、日志、个人设备路径、本机专用授权/发布/验收脚本或桌面应用文件。公开提交前运行 `npm run check:public`，并检查暂存区及提交历史；规则扫描不能代替人工检查。

仓库暂未为原创代码授予额外的开源许可（`UNLICENSED`）。第三方组件的许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
