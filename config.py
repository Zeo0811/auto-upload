from pathlib import Path
import logging
import os
import platform
import shutil

BASE_DIR = Path(__file__).resolve().parent
SESSIONS_DIR = BASE_DIR / "sessions"
TMP_DIR = BASE_DIR / "tmp"
TASKS_DIR = BASE_DIR / "tasks"
LOCAL_SERVER_PORT = int(os.environ.get("AUTO_UPLOAD_PORT", "7790"))
LOCAL_SERVER_BASE_URL = f"http://127.0.0.1:{LOCAL_SERVER_PORT}"

# 确保目录存在
for d in [SESSIONS_DIR, TMP_DIR, TASKS_DIR]:
    d.mkdir(exist_ok=True)

# ====================================================================== #
# 日志配置
# ====================================================================== #

LOG_LEVEL = os.environ.get("AUTO_UPLOAD_LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# ====================================================================== #
# 跨平台 Chrome 路径自动检测
# ====================================================================== #

def _detect_chrome_path() -> str:
    """根据操作系统自动检测 Chrome 可执行文件路径"""
    system = platform.system()
    if system == "Darwin":
        path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        if os.path.isfile(path):
            return path
    elif system == "Windows":
        for candidate in [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        ]:
            if os.path.isfile(candidate):
                return candidate
    else:  # Linux
        for name in ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]:
            found = shutil.which(name)
            if found:
                return found
    # 回退：尝试 PATH 中查找
    found = shutil.which("google-chrome") or shutil.which("chrome")
    return found or "google-chrome"


def _detect_chrome_user_data_dir() -> str:
    """根据操作系统自动检测 Chrome 用户数据目录"""
    system = platform.system()
    if system == "Darwin":
        return os.path.expanduser("~/Library/Application Support/Google/Chrome")
    elif system == "Windows":
        return os.path.expandvars(r"%LocalAppData%\Google\Chrome\User Data")
    else:  # Linux
        return os.path.expanduser("~/.config/google-chrome")


CHROME_APP = os.environ.get("CHROME_PATH", _detect_chrome_path())
CHROME_USER_DATA_DIR = os.environ.get("CHROME_USER_DATA_DIR", _detect_chrome_user_data_dir())
CHROME_PROFILE_DIR = os.environ.get("CHROME_PROFILE_DIR", "Default")

# ====================================================================== #
# 超时常量（秒）
# ====================================================================== #

TIMEOUT_LOGIN_WAIT = 90          # 等待插件报告登录状态
TIMEOUT_LOGOUT_WAIT = 30         # 等待退出登录完成
TIMEOUT_QR_REFRESH_WAIT = 30     # 等待二维码刷新
TIMEOUT_UPLOAD = 900             # 单次上传超时（15 分钟）
TIMEOUT_MANAGE_DEFAULT = 300     # 管理操作默认超时
TIMEOUT_MANAGE_DELETE_ALL = 600  # 删除全部内容超时
TIMEOUT_PAGE_LOAD = 4            # 等待页面加载 + 插件初始化
MAX_QR_REFRESH = 3               # 二维码超时最多刷新次数

# ====================================================================== #
# 平台 URL
# ====================================================================== #

PLATFORM_URLS = {
    "xiaohongshu": "https://creator.xiaohongshu.com/publish/publish",
    "channels":    "https://channels.weixin.qq.com/platform/post/create",
    "douyin":      "https://creator.douyin.com/creator-micro/content/upload",
    "bilibili":    "https://member.bilibili.com/platform/upload/video/frame",
}

PLATFORM_MANAGE_URLS = {
    "xiaohongshu": "https://creator.xiaohongshu.com/new/note-manager",
    "channels":    "https://channels.weixin.qq.com/platform/post/list",
    "douyin":      "https://creator.douyin.com/creator-micro/content/manage",
}
