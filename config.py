from pathlib import Path

BASE_DIR = Path(__file__).parent
SESSIONS_DIR = BASE_DIR / "sessions"
TMP_DIR = BASE_DIR / "tmp"
TASKS_DIR = BASE_DIR / "tasks"

# 确保目录存在
for d in [SESSIONS_DIR, TMP_DIR, TASKS_DIR]:
    d.mkdir(exist_ok=True)

PLATFORM_URLS = {
    "xiaohongshu": "https://creator.xiaohongshu.com/publish/publish",
    "channels":    "https://channels.weixin.qq.com/platform/post/create",
    "douyin":      "https://creator.douyin.com/creator-micro/content/upload",
    "bilibili":    "https://member.bilibili.com/platform/upload/video/frame",
}

PLATFORM_MANAGE_URLS = {
    "xiaohongshu": "https://creator.xiaohongshu.com/new/note-manager",
    "channels":    "https://channels.weixin.qq.com/platform/post/list",
}
