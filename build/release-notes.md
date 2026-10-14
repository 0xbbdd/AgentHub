# v1.69.0 更新说明

## 新增

- **Claude Code 可以直接连网关了**：网关新增 `POST /v1/messages` 入站协议面（另有 `POST /v1/messages/count_tokens`）。把 Claude Code / Anthropic SDK 的地址指向网关就能用到**全部渠道**，不再必须经 CC Switch 在中间做协议翻译。鉴权同时认 `x-api-key` 与 `Authorization: Bearer`；两个头都带且不是同一把 Key 时直接拒绝并说明原因，不猜一把
- **Codex CLI 也可以直连**：新增 `POST /v1/responses`。Codex 已经移除了对 `wire_api = "chat"` 的支持（写它会直接报错），此前只能靠 CC Switch 翻译；现在把 provider 的 `base_url` 指向网关、`wire_api = "responses"` 即可，工具调用（`function_call` / `function_call_output`）按 Codex 解析器的要求逐条对齐
- **API Key 支持多选批量删除**：Key 列表最左新增选择列（行选 + 全选），选中后工具栏出现「批量删除（N）」。逐个走与单删完全相同的链路（删除墓碑先行，才能经 WebDAV 传播到其他设备），日志只记汇总一条

三条入站协议面**共用同一套调度**：鉴权、模型别名、模型禁用、模型回退链、号池换号、冷却决策与用量记账对所有协议完全一致，区别只在「怎么读网关 Key」和「写成什么字节」。

## 修复

- **模型目录里选「关闭思考 (off)」不再被静默抬档**：声明了 `supportedEfforts` 的模型会把 `off` 当成一个最低档位，按「降到最近的支持档」抬成 `low` / `minimal` / `high`——用户明确关了思考，结果被改成继续思考，界面还没有任何提示。现在 `off` 作为「开关」不参与档位降级；真不接受它的上游仍由适配器按渠道改写
- **Codex 关掉推理时不再反而拿到最耗的档**：Responses 用 `reasoning.effort = "none"` 表示「不推理」，此前这个值会原样透到上游，落到按模型家族改写的渠道手里会被当成「未知值 = 开思考」抬成最高档。现在归一到内部开关值，如实关掉
- **记忆中枢的 MCP 桥在 Linux 源码运行下连不上**：源码运行时 Electron 的数据目录名是小写 `agenthub`，而桥只按大写 `AgentHub` 找，于是桌面端明明在跑、桥却一直报「AgentHub 未运行」。现在两种大小写、以及被 `XDG_CONFIG_HOME` 改过的 config 根目录都会找；另外补上 `AGENTHUB_DATA_DIR` 候选
- **`/v1/messages` 与 `/v1/responses` 一轮只发一个终止事件**：上游流中报错且正文已出线时，此前会在 `event: error` / `response.failed` 之后又补一个正常收尾（`message_stop` / `response.completed`），等于当着客户端的面把截断的一轮说成「正常说完」。按协议，错误帧就是这一轮的终点
- **模型回退时不再出现第二个流头**：`resetAttempt` 曾把「已出线」标记复位，导致回退重发时同一条流里出现两个 `message_start` / `response.created`（客户端必炸）。已落盘的字节与已发出的帧号都收不回来，这条现在钉成了断言
- **`thinking` 预算缺失时不再被当成「关思考」**：`budget_tokens` 为 `null` 或空串时会被读成 0，等于客户端只是没填这个字段就被静默关掉思考。现在「没给预算」与「显式给 0」分开处理

## 改进

- **转换中的语义损失全部留痕**：`thinking.signature` 不回投、`document` 块无对应物、`top_k` / `metadata` 无位置、Codex 的私有工具类型降级……每条都写进日志，不再静默丢弃——排查「同样的对话在官方能跑、走网关差一点」时有线索可查
- **桥会说明自己连的是哪一份 runtime 文件**：多台电脑或多个数据目录并存时，这条是排查「桌面端在跑但桥说未运行」的第一现场；一个都没找到时会把查过的候选路径逐个列出来
- **新增两个紧急止血开关**：`enableAnthropic` / `enableResponses`（默认开，手工改 `config.json`）。新的协议面万一卡住某个客户端，关掉即回到「该端点不存在」，不必回滚代码也不必重新打包；这两个开关不会因为设置页保存而被冲掉
- README 补上三条入站协议面、各自的直连填法与回归自测入口
