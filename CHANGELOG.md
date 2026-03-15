# Changelog

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
