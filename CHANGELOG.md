# Changelog

## v1.6.0 (2026-03-15)

### New Features — MCP & AI Agent 优化
- **`login_and_wait` MCP tool**: 一次调用返回 QR 二维码（base64 data URL + HTTP URL），解决 AI 获取二维码发送到 IM 耗时过长的问题
- **`upload_and_wait` MCP tool**: 提交上传 + 自动轮询等待完成，无需 AI 反复调用 `get_task_status`
- **`delete_batch` / `delete_all_posts` MCP tools**: 补齐批量删除接口
- **`GET /qr/{account_id}` HTTP 端点**: 浏览器直接访问 `http://127.0.0.1:7788/qr/test` 查看登录二维码，AI 只需发一个 URL 给用户

### New Features — Claude Code Skills & 打包
- **Claude Code Skills** (`.claude/commands/`): `/upload`、`/batch-upload`、`/manage` 三个快捷指令
- **`CLAUDE.md`**: 项目架构说明，Claude Code 自动读取
- **`pyproject.toml`**: pip 安装打包配置，支持 `pip install .` 或 `auto-upload-server` 命令启动

### Bug Fixes
- 修复管理操作（查询/编辑/删除）登录成功后标签页已关闭但未重新打开管理页面的问题
- 修复小红书描述不填写：编辑器选择器从 `.ql-editor` 更新为 `.tiptap.ProseMirror`（适配新版编辑器）
- 修复小红书话题弹窗选择器过时 + 最后一个话题选择框关不掉

### Improvements
- MCP Server 重构：13 个 tool（原 9 个 + 新增 4 个），快捷版优先、基础版兼容
- 管理操作登录后自动重新打开页面 + 重新投递任务

## v1.5.0 (2026-03-15)

### New Features
- 视频号批量上传支持
- 测试套件（tests/）：上传、编辑、删除、列表、登录完整测试
- MCP Server 接口增强

### Bug Fixes
- 修复视频号封面上传失败：浏览器高度不够时元素不可见，添加 scrollIntoView 自动滚动
- 修复发布后 "离开此网站？" 系统弹窗未自动关闭，使用 CDP 自动处理 beforeunload 对话框
- 封面上传 setFileViaChooser / cdpClickIframe 坐标计算优化

### Improvements
- 插件 Logo：机器人风格图标（16/48/128px）
- closeTab 增强：allFrames 清除 beforeunload + CDP javascriptDialogOpening 兜底
- delete_batch / delete_all_posts API

## v1.0.0

### Features
- 小红书视频上传（封面、标签、定时发布）
- 视频号完整上传支持（视频、封面、个人卡片/分享卡片、定时发布）
- 视频号登录（QR 扫码）
- 内容管理：编辑、删除、列表查询（小红书 + 视频号）
- Chrome Extension MV3 + CDP 自动化
- Python HTTP Server（端口 7788）任务队列
- 多视频源：本地文件、URL、OSS、Google Sheets / 飞书
- Session 持久化登录状态
