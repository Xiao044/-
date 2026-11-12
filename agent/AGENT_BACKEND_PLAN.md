# DeepSeek Agent 后端：现有能力与演进边界

> 更新：2026-11-12；本文件说明可复用底座，不再重复旧阶段排期。
> 产品需求见 [需求基线](../PROJECT_REQUIREMENTS.md)，主线实施见 [A/B 重建计划](AB_REBUILD_PLAN.md)，状态见 [进度总览](PROGRESS.md)。

## 1. 已有实现

- `agent-service.js`：输入校验、非文字字段过滤、DeepSeek 消息构造、JSON 解析、A 草稿规范化、部分事实冲突检查、用户修订与运行记录。
- `server.js`：调用 DS API，持久化项目级 Agent 运行、失败状态、版本和确认结果，处理取消及迟到响应。
- `migrate-agent-data.js`：旧 A 迁移为运行记录；执行前备份、原子写入和幂等保护，仍供旧项目迁移使用，不能按“旧文件”删除。
- `index.html`：生成/追问、A 原文和六字段编辑、草稿保存/确认、参考图与编辑恢复。
- 当前任务类型仅为 `follow_up`、`description_a`；它不是知识库系统，也不是网页 B 生成器。

## 2. 当前服务契约

```text
POST /api/agent
POST/GET /api/projects/:projectId/agent-runs
GET/PATCH /api/projects/:projectId/agent-runs/:runId
POST /api/projects/:projectId/agent-runs/:runId/accept
POST /api/projects/:projectId/agent-runs/:runId/restore
POST /api/projects/:projectId/agent-runs/:runId/cancel
```

兼容输出包含 `reply`、`followUpQuestion`、`descriptionA`、`descriptionAStructured`；新版结构已有 `schemaVersion`、`runId`、`draft`、`warnings`、模型与版本信息。六字段容器为商品事实摘要、场景、构图、光线/氛围、必须保留项、禁止项；原文独立保存。具体字段与兼容规则以代码和测试为准。

## 3. 不可破坏的约束

- 用户明确事实优先，不臆造材质、颜色、尺寸、品牌、结构或功效；有限规则检查不等于已证明模型永不犯错。
- DS 只接收文字，商品图/参考图不进入 DS 请求；密钥只放服务端配置。
- 草稿保存不等于确认；确认成功后才提交下游影响，失败保留旧 A/B/结果。
- 运行输入、原始模型输出、用户修订与接受状态可追溯；普通项目 PUT 不能抹掉服务端运行历史。
- 项目/输入/操作身份与取消、重试、导入并发要隔离，旧返回不得覆盖新内容。

## 4. 本次演进

1. **当前复用 A**：继续使用现有 DS Agent 的 A 生成/编辑确认/历史能力，不改成 DS 直接生成 B，不声称已有知识库增强。
2. **当前建设网页 B**：用户选择网页文字模型，将确认 A 转为 B；由工作台/服务端编排、扩展回读，再衔接独立选择的生图模型。
3. **知识库后置**：条目/导入/检索/引用框架与真实知识整合均待后续排期；内容由用户收集，不自动启动 R1a/R1b。
4. 具体阶段、兼容和验收按 [AB_REBUILD_PLAN.md](AB_REBUILD_PLAN.md)，不再维护第二套阶段编号。

新增网页 B 使用独立 `lib/text-jobs.js` / 项目级 `/text-jobs` API 和 `project.textWorkflow`，不是 DS 的第三种任务。原始网页回复、候选、A 指纹与运行/版本、平台与 attempt/session 均单独记录；确认 B 和图片发送仍分开。实网验收状态见进度。

## 5. 验证与历史

当前服务/API/迁移专项为 33/33 本地通过，使用隔离数据和 mock DS；不证明知识库和网页 B 已完成，也不替代真实 DS 或浏览器验收。最新全量结果只在 [PROGRESS.md](PROGRESS.md) 更新。

旧阶段计划和重复进度可从 Git 历史恢复；详细缺陷修复证据见 [历史归档](../docs/archive/2026-11-12/creative-flow-evidence.md)。
