# Changelog

## v1.8.0 (2026-03-15)

### New Features — 抖音 (Douyin) 全平台支持（已实测通过）

#### 视频上传
- **视频文件注入**: CDP `setFileInput` 注入视频文件，支持重试（15次 × 2秒）
- **标题填写**: `nativeSetter` + `input`/`change` 事件触发
- **描述 + 话题标签**: `execCommand('insertText')` + 话题弹窗自动选择第一个建议
- **自定义封面上传**: CDP 真实鼠标点击封面区域 → 等待模态框 → 点击"上传封面"标签 → CDP `setFileViaChooser` 注入封面图片 → 点击"完成"按钮
- **定时发布**: 点击"定时发布"选项 → 填写日期时间（需距当前 > 2小时）
- **发布确认**: 检测页面跳转或成功 toast，精准区分成功/失败/验证弹窗
- **自动关闭标签页**: 发布成功后自动关闭 Chrome 标签页

#### 内容管理
- **`list_posts`**: 卡片式布局解析，提取标题、发布时间、状态（已发布/定时/审核中/私密/草稿/未通过）、封面URL（`background-image` 提取）、数据指标（播放/点赞/评论/分享）
- **`edit_post`**: 支持已发布（"编辑作品"按钮）和定时发布（"继续编辑"按钮），可修改标题、描述、标签
- **`delete_post`**: 点击"删除作品" → 确认弹窗自动确认
- **`delete_batch`**: 按标题 ID 批量匹配删除，返回 deleted/failed/not_found 计数
- **`delete_all_posts`**: 循环删除所有卡片

### Bug Fixes
- **封面上传修复**: 旧代码用 JS `.click()` 无法触发模态框，改为 CDP `cdpClick` 真实鼠标事件
- **封面模态框定位修复**: `[class*="dy-creator-content-modal"]` 误匹配到空的 mask 遮罩层，改为等待 `.semi-upload-drag-area` 出现
- **封面上传选择器修复**: 哈希类名拼接不可靠，改用 `data-auto-upload-target` 属性标记精确定位
- **发布确认误判修复**: `[class*="verify"]` 和 `bodyText.includes('验证码')` 等选择器过于宽泛，将正常提示误判为安全验证弹窗；重写为优先检测成功信号（页面跳转/成功 toast），仅对 iframe 验证报错
- **管理页选择器修复**: 从表格/列表选择器改为卡片式布局（`[class*="content-body"]` 容器 + `[class*="video-card"]` 子卡片），适配抖音实际 DOM 结构

### Technical Details
- 抖音 CSS Modules 类名格式: `语义名-哈希值`（如 `coverControl-CjlzqC`），选择器使用 `[class*="语义名"]` 部分匹配，不依赖哈希后缀
- 封面上传流程: `cdpClick` 封面区域 → 等待 `semi-upload-drag-area` → 点击"上传封面"标签切换面板 → `setFileViaChooser` 注入文件 → 点击 `semi-button-primary` 完成
- Post ID: 抖音管理页 DOM 未暴露数字 ID，使用 `title_` + 标题前20字符作为标识

## v1.7.0 (2026-03-15)

### New Features — 抖音 (Douyin) 平台基础支持
- **抖音登录**: QR 扫码登录（支持 canvas/img/截图三种二维码获取方式），SSO 页面自动检测
- **抖音视频上传**: 基础上传流程
- **抖音内容管理**: 基础框架
- **manifest.json**: 添加 `*.douyin.com` 匹配，支持 SSO 登录域
- **background.js**: SPA 导航监听添加 `creator.douyin.com` + `sso.douyin.com`

## v1.6.0 (2026-03-15)

### New Features — MCP & AI Agent 优化
- **`login_and_wait` MCP tool**: 一次调用返回 QR 二维码（base64 data URL + HTTP URL），解决 AI 获取二维码发送到 IM 耗时过长的问题
- **`upload_and_wait` MCP tool**: 提交上传 + 自动轮询等待完成，无需 AI 反复调用 `get_task_status`
- **`delete_batch` / `delete_all_posts` MCP tools**: 补齐批量删除接口
- **`GET /qr/{account_id}` HTTP 端点**: 浏览器直接访问 `http://127.0.0.1:7790/qr/test` 查看登录二维码，AI 只需发一个 URL 给用户

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
- Python HTTP Server（默认端口 7790，可由 `AUTO_UPLOAD_PORT` 覆盖）任务队列
- 多视频源：本地文件、URL、OSS、Google Sheets / 飞书
- Session 持久化登录状态
