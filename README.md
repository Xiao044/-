# 商品图工作台（造图）

本地运行的商品图片创作工作台，使用 Node.js、浏览器页面和 Chrome/Edge 扩展。当前处于 **V2.0 开发与手动验收阶段**，尚未正式发布。

## 当前主线

```text
简短描述／几个关键词
    → 知识库整合＋DeepSeek API → A
    → 用户选择的网页端文字模型 → B
    → 用户另行选择的生图模型 → 图片 → 挑选归档
```

**知识库从零建设、内容由用户后续收集，现已按用户要求将框架和内容建设一并后置。** 当前优先复用已有 DS Agent 生成 A，开发独立的网页模型生成 B、分别选择文字/生图模型及 B→生图衔接；此阶段不声称 A 已有知识库增强。网页 B 已新增独立文字任务、候选与来源链，可选择豆包或 ChatGPT 的当前页面模型（实验性、真实完整流程待验收）；手填/模板作为兼容回退保留，不表示长期知识增强链路已完成。

## 运行

需要 Node.js（项目使用内置模块，无 `npm install` 步骤）。首次配置：

```powershell
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
# 在 .env 填入服务端 DEEPSEEK_API_KEY；不要覆盖已有配置。
node server.js
```

已有配置时直接运行 `node server.js`，打开 [本地工作台](http://127.0.0.1:5173/)。直接打开 `index.html` 只能看静态界面，不能替代项目 API、上传或模型调用。

**升级使用：** 停止旧 Node 进程后重新运行 `node server.js`，让新增 `/text-jobs` API 生效；扩展需重载并刷新工作台及平台页面，工作台应显示 0.5.1。仅刷新网页不能升级已运行的后端。

密钥只放 `.env` 或服务端环境变量，不进入前端、文档、日志或 Git。部署步骤见 [deploy/README.md](deploy/README.md)；存在部署说明不表示云环境已验收。

## 文档从哪里看

| 需要了解 | 文档 |
|---|---|
| 产品需求和已确认规则 | [PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md) |
| V2/V3 范围与实施顺序 | [VERSION_PLAN.md](VERSION_PLAN.md) |
| 最新进度、测试、验收和发布状态 | [agent/PROGRESS.md](agent/PROGRESS.md) |
| A/B 重建技术方案 | [agent/AB_REBUILD_PLAN.md](agent/AB_REBUILD_PLAN.md) |
| 已有 Agent 与当前问题 | [后端说明](agent/AGENT_BACKEND_PLAN.md)、[问题清单](agent/CREATIVE_FLOW_ISSUES.md) |
| 知识资料以后放哪里 | [knowledge/README.md](knowledge/README.md) |
| 目录整理与历史记录 | [文档索引](docs/README.md)、[维护记录](docs/MAINTENANCE.md) |

历史证据只在 `docs/archive/` 追溯；不把历史“当前状态”或旧模型职责当成今天需求。

## 当前可用底座与边界

- 商品资料/场景、DS 追问和 A 生成；A/B 编辑、确认和未保存文本恢复。
- 项目 JSON 保存与浏览器本地恢复、图片上传、版本、任务中心、资产/质量标签、模板和导入导出。
- 本地扩展为 **0.5.1**：保留豆包精确发送、版本保护、原图过滤/同图合并，新增独立文字任务桥接；安装/重载见 [扩展说明](doubao-extension/README.md)。
- 四平台仍需 Chrome/Edge 完整真实验收；网页 B 目前只有豆包/ChatGPT 的实验性文字适配，其他文字平台不开放，不能因已有生图 adapter 就宣称支持。
- MySQL、OSS、登录/权限、团队协作和正式云部署属于后续 V3.0，尚未实现。备份恢复专项演练按原决策暂缓。
- 最新测试数字与哪些修改未提交只在 [进度总览](agent/PROGRESS.md) 汇总，避免多份文档过期。

## 目录地图

```text
index.html / styles.css           页面和样式
scroll-workspace.js / .css        当前仍引用的滚动交互模块，不是旧版残留
server.js / health.html           Node 服务与健康页
agent/                           Agent 源码、迁移工具、当前专项计划/状态
lib/                             图片 ZIP 等服务辅助模块
assets/                          当前页面使用的本地资源
scripts/                         数据归一化与发布 smoke 工具
tests/                          自动化回归及 mock（全部保留）
doubao-extension/                当前解压缩扩展目录，不迁移以免安装失效
knowledge/                       知识资料筹备说明；私有 sources/ 默认忽略
docs/                            文档入口、维护记录及单独历史归档
deploy/                          部署说明与 Nginx 模板
data/                           本地业务数据、uploads/、backups/（不提交 Git）
.env / .env.example              私有配置 / 配置样例
```

`data/` 中的当前项目、任务、版本、资产、模板和真实上传不是临时文件。历史旧备份已收纳至 `data/backups/legacy-2026-11-12.zip`，保留原字节校验信息；这不是当前完整备份，也不能覆盖恢复到最新项目。

## 测试

在项目根目录运行：

```powershell
node --test tests/*.test.js
node scripts/release-smoke.js
```

自动化使用隔离数据和 mock，不能替代真实 DS、网页模型和 Chrome/Edge 手动验收。维护时保留测试、旧项目迁移脚本与当前滚动模块；版本由 Git 管理，不在根目录存放旧版运行副本、临时 diff、日志或截图。

## 上传与导出

- 上传支持 PNG/JPEG/WebP，当前单图 8 MiB；本地保存于 `data/uploads/<projectId>/`。
- 项目 JSON 使用“导出项目”；归档图片使用“导出图片”，接口为 `GET /api/projects/:id/export-images`。
- ZIP 中 `images/` 保存原图，`manifest.json` 记录资产、平台、任务/attempt、提示词版本、标签、尺寸、路径、字节数与 SHA-256。同文件只存一份，来源映射仍独立保留。
- 缺失、跨项目、不安全路径、符号链接或不可读图片在清单中记录原因；不自动请求外部临时 URL，不改变资产状态。
- 当前图片 ZIP 限额：单图 8 MiB、1000 条归档资产、完整 ZIP 64 MiB（含清单和头）；超限明确报错，不输出截断包。
- 图片包不等于完整项目备份，尚不支持 ZIP 导入。完整下载/生成/归档与备份恢复仍需各自验收。
