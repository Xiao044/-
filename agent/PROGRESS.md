# Agent 构建进度

> 更新时间：2026-10-27（Asia/Shanghai）  
> 计划基线：[AGENT_BACKEND_PLAN.md](./AGENT_BACKEND_PLAN.md)  
> 当前方式：按小阶段实施；每段完成、验证后暂停，收到“继续”再进入下一段。

## 当前状态

Agent 后端核心、项目级运行记录、旧数据迁移、工作台基础接入、A 版结构化字段编辑和历史运行恢复已完成。当前本阶段服务地址为 `http://127.0.0.1:5174`（5173 已有服务占用）。服务端使用 `.env` 中的 DeepSeek 配置，模型设为 `4.0flash`；不要把 API Key 写入本文件、前端或日志。

## 已完成

1. 新增 `agent/agent-service.js`：输入校验、图片及非 Agent 字段过滤、DeepSeek 消息构建、JSON 解析、A 版 Schema 规范化、用户字段编辑元数据和运行记录辅助函数。
2. 将旧 `POST /api/agent` 接入服务模块；保留旧响应字段，增加 Schema 版本、运行 ID、结构化草稿和错误码。覆盖未配置 Key、超时、空响应、非法 JSON 和无效 A 版输出。
3. 增加项目级 Agent 接口：
   - `POST/GET /api/projects/:projectId/agent-runs`
   - `GET/PATCH /api/projects/:projectId/agent-runs/:runId`
   - `POST /api/projects/:projectId/agent-runs/:runId/accept`
4. Agent 运行记录写入项目 JSON，保存输入快照、输出、状态、错误码、版本和接受状态。用户编辑会留存旧输出到 `revisions`；接受草稿会同步项目当前 A 版字段。
5. 修正运行状态规则：追问和失败调用不增加 A 版版本号；接受旧运行不会回退 `latestRunId`；项目常规 `PUT` 不会覆盖服务端 Agent 历史。
6. 新增 `agent/migrate-agent-data.js`，支持旧 `descriptionA` 和 `descriptionAStructured` 迁移、自动备份、原子写入和重复执行保护。
7. 已将当前项目 `demo-pearl-necklace` 迁移为一条历史 A 版运行记录。迁移备份：`data/projects.json.backup-agent-20261026T161111Z`。历史运行 ID 为 `agent-legacy-demo-pearl-necklace`，草稿版本 1，状态已接受。
8. 工作台已改为通过项目级接口创建追问和 A 版运行；恢复 Agent 运行列表；确认 A 版时保存原文修改并调用接受接口；新建项目时先同步项目。
9. A 版简报改为六个逐字段编辑区，展示用户资料/Agent 来源；字段输入和来源元数据随草稿恢复。新增“保存简报”，只提交有改动的字段到项目级 PATCH 并生成修订；确认 A 时也先保存结构化字段和原始文本，再接受该版本。项目普通保存和本地版本快照会保留规范化 A 版草稿。
10. 增加 Agent 运行历史弹窗，可选择运行并只读预览输入快照、A 版原文、结构化字段、来源、警告和先前修订。可恢复的已完成 A 版可克隆为新运行；新 runId 和版本号递增，记录 `restoredFromRunId`，原运行及已接受状态不变。追问、失败或无草稿运行不可恢复。

## 验证

- `node --test tests/agent-service.test.js tests/agent-api.test.js tests/agent-migration.test.js`：15 项通过；`server.js`、Agent 模块、迁移脚本和 `index.html` 内联脚本语法检查通过。
- 本地页面 HTTP 烟测返回 200；Agent 历史接口能读取已迁移记录和接受状态。
- API 回归覆盖结构化字段用户来源、修订历史、接受同步和历史运行克隆；确认旧运行未变、接受状态保留，追问运行返回 409。
- 本阶段服务 `http://127.0.0.1:5174` 的健康检查和 Agent 历史读取均返回 200，项目中可读到 1 条运行记录。
- 浏览器实机检查未完成；Computer Use 因无法确认 Edge 当前 URL 而停止。
- DeepSeek HTTP 测试使用本地模拟响应；没有发起真实模型请求。
- API 测试对 `data/projects.json` 做快照并恢复，不应留下测试运行记录。

## 尚未完成 / 注意事项

- A 版原始文本仍来自模型；当前事实保护主要保证用户事实摘要和保留项优先，并提供部分冲突提示，不构成完整的语义事实核验。后续需补更可靠的冲突处理和对应测试。
- 当前 `.env` 的实际密钥仅在本机配置，测试没有验证真实模型账户或额度。
- 迁移时旧项目已写入 `schemaVersion: 1`。后续新增运行状态字段由读取归一化兼容；例如旧迁移记录缺少 `acceptedRunId` 时，接口从已接受运行推导该值。

## 建议续做顺序

1. 完善模型事实冲突保护，重点处理原始 A 文本与用户商品事实矛盾的情况。
2. 在用户可控环境下做一次明确的真实 DeepSeek 调用验收，再做浏览器完整流程验证。
