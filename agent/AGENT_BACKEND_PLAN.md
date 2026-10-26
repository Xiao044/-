# Agent 后端建设计划

> 项目：商品图工作台（造图）  
> 版本基线：2026-10-26  
> 适用范围：V2.0 Agent 后端与 A 版描述词服务  
> 当前状态：计划确认，尚未开始实现

## 1. 建设目标

将现有 DeepSeek 代理从“可以调用”建设为稳定、可校验、可追溯的 Agent 后端服务。

后端需要保证：

- Agent 只处理商品文字事实和创作方向；
- Agent 只生成或整理 A 版，不生成 B 版；
- 用户事实优先，模型不能静默改写事实；
- 每次 Agent 调用、重新生成和用户修改都可追溯；
- 服务重启后草稿、历史运行记录和版本仍可恢复；
- DeepSeek 异常时返回明确错误，不把半成品传给前端。

## 2. 明确边界

### Agent 后端负责

- 接收商品名称、卖点、文字描述和结构化商品事实；
- 接收用户选择的场景和创作方向；
- 进行必要的文字追问；
- 生成 A 版原始文本和简单结构化字段；
- 保存 Agent 运行记录、草稿版本和用户确认结果；
- 校验和规范化模型输出。

### Agent 后端不负责

- 商品图片识别；
- 将图片发送给 DeepSeek；
- 生成 B 版提示词；
- 自动选择生图平台或平台参数；
- 自动判断结果图片质量；
- 直接调用第三方生图平台。

## 3. 分阶段实施计划

### 阶段一：冻结服务契约

保留现有接口：

```http
POST /api/agent
```

兼容现有前端字段：

```json
{
  "reply": "...",
  "followUpQuestion": "...",
  "descriptionA": "...",
  "descriptionAStructured": {}
}
```

新增稳定字段：

```json
{
  "schemaVersion": 1,
  "runId": "agent-...",
  "draft": {},
  "warnings": [],
  "model": "deepseek-chat"
}
```

统一输入结构：

```json
{
  "task": "description_a",
  "projectId": "demo-pearl-necklace",
  "product": {
    "name": "春日珍珠项链",
    "subtitle": "温润珠光 · 轻盈日常",
    "description": "...",
    "facts": {}
  },
  "creativeDirection": {
    "scene": "自然窗边",
    "note": "希望画面自然、干净"
  },
  "previousRunId": ""
}
```

`task` 只允许 `follow_up` 和 `description_a`。图片字段、平台参数和 B 版字段不得进入 Agent 请求。为兼容旧前端，即使收到 `imageUrl` 等字段，也必须在服务端入口丢弃。

### 阶段二：增加输入校验和 DeepSeek 调用层

将当前 Agent 逻辑拆分为以下步骤：

```text
validateAgentInput
→ buildAgentMessages
→ callDeepSeek
→ parseModelJson
→ normalizeAgentOutput
→ mergeUserFacts
→ persistAgentRun
```

输入校验包括字段类型、任务类型、文本长度、商品事实格式、项目 ID，以及图片、平台参数和 B 版字段的排除。

DeepSeek 系统提示词必须明确：只能返回 JSON；只能返回允许字段；用户事实必须原样保留；不得虚构材质、颜色、尺寸、品牌、功效和商品结构；不生成 B 版、不选择平台参数、不识别图片；`follow_up` 只用于追问；`description_a` 才能生成 A 版。

### 阶段三：固定 A 版 Schema

建立 `schemaVersion: 1` 的统一结构：

```json
{
  "schemaVersion": 1,
  "rawText": "...",
  "fields": {
    "productFactsSummary": { "value": "...", "source": "agent", "updatedAt": "...", "version": 1 },
    "scene": { "value": "...", "source": "agent", "updatedAt": "...", "version": 1 },
    "composition": { "value": "...", "source": "agent", "updatedAt": "...", "version": 1 },
    "lightingMood": { "value": "...", "source": "agent", "updatedAt": "...", "version": 1 },
    "mustKeep": { "value": [], "source": "agent", "updatedAt": "...", "version": 1 },
    "forbidden": { "value": [], "source": "agent", "updatedAt": "...", "version": 1 }
  }
}
```

规则：`source` 只能是 `user` 或 `agent`；`mustKeep` 和 `forbidden` 统一为字符串数组；缺失字段补空值；未知字段不进入正式结构；`rawText` 与结构化字段同时保存；旧的 `descriptionAStructured` 通过适配层兼容。

### 阶段四：用户事实保护

服务端建立事实合并规则：

- 商品资料中的明确事实保存为 `source: "user"`；
- Agent 只能补充表达，不能覆盖用户事实；
- 用户事实优先级高于模型输出；
- 模型与用户事实冲突时保留用户事实，并返回 `warnings`；
- 用户未提供的信息不得被模型写成具体事实；
- 发送给 DeepSeek 的内容只包含过滤后的文字资料。

这部分必须通过服务端规则实现，不能只依赖模型提示词。

### 阶段五：保存 Agent 运行记录

项目数据增加：

```json
{
  "agent": {
    "schemaVersion": 1,
    "latestRunId": "agent-...",
    "latestDraftVersion": 2,
    "runs": []
  }
}
```

每次调用至少保存 `runId`、`task`、`status`、`input`、`output`、`accepted`、`createdAt`、`completedAt` 和 `errorCode`。

要求：旧 A 版不能被覆盖；每次重新发送生成新的 `runId` 和版本号；输入快照、模型输出和用户修改结果都可追溯；失败运行也要保存错误状态和错误码。

### 阶段六：增加项目级接口

保留无状态兼容接口，同时增加：

```http
POST  /api/projects/:projectId/agent-runs
GET   /api/projects/:projectId/agent-runs
GET   /api/projects/:projectId/agent-runs/:runId
POST  /api/projects/:projectId/agent-runs/:runId/accept
PATCH /api/projects/:projectId/agent-runs/:runId
```

接口负责创建并持久化 Agent 运行、查询历史、查看完整输入输出和错误、接受 A 版草稿，以及保存用户字段修改。

### 阶段七：统一错误码和状态

错误码：

```text
INVALID_REQUEST
UNSUPPORTED_TASK
AGENT_NOT_CONFIGURED
MODEL_TIMEOUT
MODEL_EMPTY_RESPONSE
MODEL_INVALID_JSON
MODEL_SCHEMA_INVALID
FACT_CONFLICT
PROJECT_NOT_FOUND
RUN_NOT_FOUND
PERSIST_FAILED
```

运行状态：`queued`、`running`、`waiting_user`、`completed`、`failed`、`cancelled`。

DeepSeek 超时、空响应、非法 JSON 或结构不合规时，不向前端传递模型半成品。

### 阶段八：旧项目迁移和恢复

新增可重复执行的迁移脚本：为旧项目补充 `agent.schemaVersion`；将旧 `descriptionA` 转换为历史运行记录；将旧 `descriptionAStructured` 映射到新字段；保留旧字段，避免旧前端立即失效；迁移前自动备份 `data/projects.json`；迁移失败时不覆盖原文件；服务重启后可读取新旧格式。

## 4. 测试计划

先测试纯函数，再测试 HTTP 接口。

### 输入与输出

- 正常追问和正常生成 A 版；
- 缺少字段、字段类型错误和非法 JSON；
- 模型返回额外字段或缺失字段；
- 图片字段被丢弃；
- B 版和平台参数不会进入模型请求。

### 事实保护

- 模型虚构材质、品牌或尺寸；
- 模型改写用户明确事实；
- 用户事实与模型输出冲突；
- `warnings` 是否正确返回；
- 用户字段优先级是否保持。

### 可靠性与恢复

- 未配置 API Key；
- DeepSeek 超时、空响应和非法 JSON；
- 运行记录持久化失败；
- Agent 重新生成保留旧版本；
- 迁移脚本重复执行；
- 服务重启后项目和 Agent 历史恢复。

当前项目没有 `package.json`，后端阶段需要补充 Node 原生测试入口，例如：

```text
tests/agent-schema.test.js
tests/agent-service.test.js
tests/agent-api.test.js
```

## 5. 后端完成验收标准

- `/api/agent` 始终返回稳定 Schema；
- Agent 永远只输出 A 版；
- 用户事实不会被静默改写；
- 图片不会进入 DeepSeek 请求；
- 每次重新生成都有新版本；
- 旧输入、旧输出和错误可追溯；
- 旧项目迁移前后内容不丢失；
- DeepSeek 异常时返回明确错误码；
- 服务重启后 Agent 历史和当前草稿仍可恢复；
- 后端测试覆盖主要成功、失败和恢复路径。

## 6. 实施顺序

1. 修改 `server.js`，加入输入校验、输出规范化和事实保护。
2. 抽出 Agent schema/service 逻辑，减少路由处理代码。
3. 增加项目 JSON 中的 Agent 运行记录。
4. 增加旧项目迁移脚本和备份机制。
5. 增加项目级 Agent 接口。
6. 增加 Node 原生测试和 HTTP 集成测试。
7. 完成后再接入前端字段编辑、来源展示和版本 UI。

## 7. 暂不纳入本阶段

- Agent 自动生成 B 版；
- Agent 图片识别；
- Agent 自动选择平台和参数；
- 自动视觉质量评分；
- RAG、向量检索和隐式知识注入；
- 正式账号权限和云端数据库迁移。
