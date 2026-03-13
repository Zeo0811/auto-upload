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
    "douyin": "https://creator.douyin.com/creator-micro/content/upload",
    "bilibili": "https://member.bilibili.com/platform/upload/video/frame",
}

# 浏览器配置
BROWSER_HEADLESS = False       # 必须有头，登录时要显示
BROWSER_SLOW_MO = 50           # 操作间隔 ms，模拟人工

# 任务轮询
QR_POLL_INTERVAL = 2           # 秒
QR_EXPIRE_SECONDS = 120        # 二维码有效期
