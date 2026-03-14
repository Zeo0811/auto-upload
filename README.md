# Auto Upload

自动化视频上传 & 内容管理 Chrome 扩展 + Python 后端，支持多平台发布。

## 支持平台

| 平台 | 登录 | 上传 | 封面 | 定时发布 | 话题标签 | 内容管理 |
|------|------|------|------|----------|----------|----------|
| 小红书 (xiaohongshu) | QR | ✅ | ✅ 自定义封面 + 比例选择 | ✅ | ✅ | ✅ 列表/编辑/删除 |
| 视频号 (channels) | QR | ✅ | ✅ 个人卡片 + 分享卡片 | ✅ | ✅ | ✅ 列表/编辑/删除 |
| 抖音 (douyin) | - | 计划中 | - | - | - | - |

## 功能概览

### 视频上传
- 支持本地文件、HTTP URL、OSS 等多种视频来源
- 自动填写标题、描述、话题标签
- 自定义封面上传（小红书支持比例选择，视频号支持个人卡片 + 分享卡片）
- 定时发布（日期 + 时间选择器）

### 内容管理
- **列表查询**：获取已发布/定时发布的内容列表
- **编辑内容**：修改标题、描述、标签、封面图、定时发布时间
- **删除内容**：删除指定内容

### 技术特性
- Chrome 扩展 MV3 架构
- CDP (Chrome Debugger Protocol) 实现 iframe 内元素精准操作
- SPA 导航自动重注入 content.js
- MCP Server 接口，支持 AI Agent 调用

## 架构

```
Python 后端 (port 7788)  ←→  Chrome 扩展 (content.js + background.js)
       ↑                              ↓
  tools.py (API)              CDP (Chrome Debugger Protocol)
       ↑                              ↓
  Agent / 脚本                  各平台发布页面
```

- **Python 后端**：HTTP 服务器，管理任务队列、登录状态、上传进度
- **Chrome 扩展**：注入到平台页面，通过 CDP 操作 DOM 完成自动化上传
- **tools.py**：对外 API，供 Agent 或脚本调用
- **mcp_server.py**：MCP Server 接口，供 Claude 等 AI Agent 直接调用

## 项目结构

```
├── chrome-extension/
│   ├── manifest.json       # MV3 扩展配置
│   ├── content.js          # 页面注入脚本，执行上传/管理流程
│   └── background.js       # Service Worker，CDP 命令封装
├── core/
│   ├── local_server.py     # HTTP 服务器 (port 7788)
│   ├── session.py          # 登录会话持久化
│   └── task_runner.py      # 任务管理
├── sources/                # 视频来源适配器
│   ├── local.py            # 本地文件
│   ├── url.py              # HTTP URL
│   ├── oss.py              # 阿里云 OSS / AWS S3
│   └── sheet.py            # Google Sheets / 飞书
├── config.py               # 平台 URL 配置
├── tools.py                # Python API 入口
├── mcp_server.py           # MCP Server 接口
├── run_test.py             # 上传测试脚本
└── run_test_manage.py      # 内容管理测试脚本
```

## 快速开始

### 1. 安装 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `chrome-extension/` 目录

### 2. 视频上传

```bash
python run_test.py
```

按提示选择平台，首次使用需要扫码登录。

### 3. 内容管理

```bash
python run_test_manage.py
```

支持操作：
- **列表查询**：查看已发布内容（标题、状态、发布时间）
- **编辑内容**：修改标题、描述、标签、封面、定时发布
- **删除内容**：按索引删除指定内容

## API 调用

### 上传视频

```python
from tools import login, upload_video, get_task_status

# 登录
login("xiaohongshu", "my_account")

# 上传视频
result = upload_video(
    platform="xiaohongshu",
    account_id="my_account",
    source={"type": "local", "path": "/path/to/video.mp4"},
    meta={
        "title": "视频标题",
        "description": "视频描述",
        "tags": ["标签1", "标签2"],
        "cover_path": "/path/to/cover.png",
        "cover_ratio": "3:4",
        # "publish_time": "2026-03-16 20:00",  # 定时发布
    },
)

# 查询进度
status = get_task_status(result["task_id"])
```

### 内容管理

```python
from tools import list_posts, edit_post, delete_post

# 列表查询
posts = list_posts("channels", "my_account")

# 编辑内容
edit_post("channels", "my_account", post_id="0", meta={
    "title": "新标题",
    "description": "新描述",
    "tags": ["新标签"],
    "cover_path": "/path/to/new_cover.png",
    "publish_time": "2026-03-20 18:00",  # 修改定时发布
    # "publish_time": "",  # 取消定时发布
})

# 删除内容
delete_post("channels", "my_account", post_id="0")
```

## Meta 参数

### 上传参数

| 字段 | 类型 | 说明 | 平台 |
|------|------|------|------|
| `title` | string | 视频标题 | 全部 |
| `description` | string | 视频描述 | 全部 |
| `tags` | list[str] | 话题标签 | 小红书、视频号 |
| `cover_path` | string | 封面图片路径 | 小红书、视频号 |
| `cover_ratio` | string | 封面比例，如 "3:4" | 小红书 |
| `publish_time` | string | 定时发布，格式 "YYYY-MM-DD HH:MM" | 小红书、视频号 |

### 编辑参数

只传需要修改的字段即可：

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 新标题 |
| `description` | string | 新描述 |
| `tags` | list[str] | 新标签 |
| `cover_path` | string | 新封面图片路径 |
| `publish_time` | string | 定时发布时间 / 空字符串取消定时 |

## 视频来源

支持多种视频来源，通过 `source` 参数指定：

```python
# 本地文件
source = {"type": "local", "path": "/path/to/video.mp4"}

# HTTP URL
source = {"type": "url", "url": "https://example.com/video.mp4"}

# 阿里云 OSS
source = {"type": "oss", "bucket": "my-bucket", "key": "video.mp4"}
```

## MCP Server

支持通过 MCP 协议接入 AI Agent（如 Claude）：

```bash
python mcp_server.py
```

提供的 MCP Tools：
- `login` - 平台登录
- `upload_video` - 上传视频
- `get_task_status` - 查询任务状态
- `list_posts` - 列表查询
- `edit_post` - 编辑内容
- `delete_post` - 删除内容
