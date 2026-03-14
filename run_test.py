"""一键测试：检查登录 → 上传测试视频 → 轮询进度"""
import sys
import time
import os

sys.path.insert(0, os.path.dirname(__file__))
from tools import login, check_login, upload_video, get_task_status

SUPPORTED_PLATFORMS = {
    "1": "xiaohongshu",
    "2": "channels",
    "3": "douyin",
}

print("选择测试平台:")
print("  1. 小红书 (xiaohongshu)")
print("  2. 视频号 (channels)")
print("  3. 抖音   (douyin)")
choice = input("请输入序号 [1/2/3，默认 1]: ").strip() or "1"
PLATFORM = SUPPORTED_PLATFORMS.get(choice, "xiaohongshu")
print(f"已选择平台: {PLATFORM}\n")

ACCOUNT_ID = "test"
VIDEO_PATH = "test_video.mp4"  # 替换为你的视频路径

# 1. 检查登录
print("=== 检查登录状态 ===")
r = login(PLATFORM, ACCOUNT_ID)
print(r)

if r["status"] == "qr_required":
    print("请用手机扫描已弹出的二维码，扫完后自动继续...")
    for _ in range(90):   # 最多等 3 分钟
        time.sleep(2)
        r = check_login(PLATFORM, ACCOUNT_ID)
        print("扫码状态:", r["status"])
        if r["status"] == "confirmed":
            break
        if r["status"] == "expired":
            print("二维码已过期，请重新运行")
            sys.exit(1)
    else:
        print("等待扫码超时")
        sys.exit(1)

if r.get("status") not in ("ok", "confirmed"):
    print("登录失败:", r)
    sys.exit(1)

print("登录 OK，开始上传")

# 2. 提交上传
r = upload_video(
    platform=PLATFORM,
    account_id=ACCOUNT_ID,
    source={"type": "local", "path": VIDEO_PATH},
    meta={
        "title": "测试上传 " + time.strftime("%H:%M:%S"),
        "description": "自动化测试",
        "tags": ["测试", "自动化", "上传"],
        "cover_path": "test_cover.png",  # 替换为你的封面路径
        "cover_ratio": "3:4",
        # "publish_time": "2026-03-16 20:00",  # 取消注释启用定时发布
    },
)
print("任务提交:", r)
task_id = r["task_id"]

# 3. 轮询进度
print("\n=== 进度轮询 ===")
last_progress = -1
while True:
    t = get_task_status(task_id)
    if t["progress"] != last_progress:
        print(f"[{t['progress']}%] {t.get('status_msg') or t['status']}")
        last_progress = t["progress"]
    if t["status"] in ("done", "failed"):
        print("\n最终结果:", t)
        break
    time.sleep(3)
