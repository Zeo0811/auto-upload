"""测试视频上传（单个 + 批量）"""
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools import login, check_login, upload_video, get_task_status, batch_upload
from core.session import load_session

SUPPORTED_PLATFORMS = {
    "1": "xiaohongshu",
    "2": "channels",
    "3": "douyin",
}

print("=" * 50)
print("  视频上传测试")
print("=" * 50)

print("\n选择测试平台:")
for k, v in SUPPORTED_PLATFORMS.items():
    print(f"  {k}. {v}")
choice = input("请输入序号 [默认 1]: ").strip() or "1"
PLATFORM = SUPPORTED_PLATFORMS.get(choice, "xiaohongshu")
ACCOUNT_ID = input("账号 ID [默认 test]: ").strip() or "test"
print(f"\n平台: {PLATFORM}  账号: {ACCOUNT_ID}\n")

# 确保已登录
session = load_session(PLATFORM, ACCOUNT_ID)
if not session:
    print("未登录，先执行登录流程...")
    r = login(PLATFORM, ACCOUNT_ID)
    print("login():", r)
    if r["status"] == "qr_required":
        print("请扫描二维码...")
        for i in range(180):
            time.sleep(2)
            r = check_login(PLATFORM, ACCOUNT_ID)
            if r["status"] == "qr_refreshed":
                print(f"  [{i+1}] 二维码已自动刷新，请重新扫描")
                continue
            print(f"  [{i+1}] {r['status']}")
            if r["status"] == "confirmed":
                break
            if r["status"] in ("error", "expired"):
                print("登录失败:", r)
                sys.exit(1)
        else:
            print("扫码超时")
            sys.exit(1)
    elif r["status"] not in ("ok", "confirmed"):
        print("登录失败:", r)
        sys.exit(1)
    print("登录成功\n")
else:
    print("已有登录 session\n")

print("选择上传测试:")
print("  1. 单个上传（本地文件）")
print("  2. 单个上传（URL）")
print("  3. 批量上传")
op = input("请输入序号 [默认 1]: ").strip() or "1"


def poll_task(task_id):
    """轮询任务直到完成"""
    print(f"\n轮询任务 {task_id} ...")
    last_progress = -1
    while True:
        t = get_task_status(task_id)
        if t.get("status") == "error":
            print(f"  任务查询失败: {t}")
            return t
        if t["progress"] != last_progress:
            print(f"  [{t['progress']}%] {t.get('status_msg') or t['status']}")
            last_progress = t["progress"]
        if t["status"] in ("done", "failed"):
            print(f"\n最终结果: {t}")
            return t
        time.sleep(3)


if op == "1":
    # 单个上传 - 本地文件
    video_path = input("视频文件路径: ").strip()
    if not video_path:
        print("请提供视频路径")
        sys.exit(1)
    if not os.path.exists(video_path):
        print(f"文件不存在: {video_path}")
        sys.exit(1)

    title = input("标题 [默认: 测试上传]: ").strip() or f"测试上传 {time.strftime('%H:%M:%S')}"
    desc = input("描述 [默认: 自动化测试]: ").strip() or "自动化测试"
    tags_str = input("标签 (逗号分隔) [默认: 测试,自动化]: ").strip() or "测试,自动化"
    tags = [t.strip() for t in tags_str.split(",")]
    cover_path = input("封面图路径 (留空不设置): ").strip()

    meta = {"title": title, "description": desc, "tags": tags}
    if cover_path:
        meta["cover_path"] = cover_path

    schedule = input("定时发布 (YYYY-MM-DD HH:MM, 留空=立即): ").strip()
    if schedule:
        try:
            from datetime import datetime
            dt = datetime.strptime(schedule.replace('/', '-'), "%Y-%m-%d %H:%M")
            schedule = dt.strftime("%Y-%m-%d %H:%M")
        except ValueError:
            print(f"  警告: 时间格式可能有误: {schedule}，建议使用 YYYY-MM-DD HH:MM")
        meta["publish_time"] = schedule
        print(f"  定时发布: {schedule}")

    print(f"\n--- 提交上传 ---")
    print(f"  source: local, {video_path}")
    print(f"  meta: {meta}")
    r = upload_video(PLATFORM, ACCOUNT_ID, {"type": "local", "path": video_path}, meta)
    print("upload_video():", r)

    if r.get("status") == "error":
        print("上传失败:", r["error"])
        sys.exit(1)

    poll_task(r["task_id"])

elif op == "2":
    # 单个上传 - URL
    url = input("视频 URL: ").strip()
    if not url:
        print("请提供 URL")
        sys.exit(1)

    title = input("标题 [默认: URL测试]: ").strip() or f"URL测试 {time.strftime('%H:%M:%S')}"
    meta = {"title": title, "description": "URL上传测试", "tags": ["测试", "URL"]}

    print(f"\n--- 提交 URL 上传 ---")
    r = upload_video(PLATFORM, ACCOUNT_ID, {"type": "url", "url": url}, meta)
    print("upload_video():", r)

    if r.get("status") == "error":
        print("上传失败:", r["error"])
        sys.exit(1)

    poll_task(r["task_id"])

elif op == "3":
    # 批量上传
    print("\n输入多个视频路径（每行一个，空行结束）:")
    paths = []
    while True:
        p = input("  路径: ").strip()
        if not p:
            break
        if not os.path.exists(p):
            print(f"  警告: 文件不存在 {p}")
        paths.append(p)

    if not paths:
        print("未输入任何路径")
        sys.exit(1)

    tasks = []
    for i, p in enumerate(paths):
        tasks.append({
            "source": {"type": "local", "path": p},
            "meta": {
                "title": f"批量测试 {i+1} - {time.strftime('%H:%M:%S')}",
                "description": "批量上传测试",
                "tags": ["测试", "批量"],
            }
        })

    print(f"\n--- 提交批量上传 ({len(tasks)} 个) ---")
    r = batch_upload(PLATFORM, ACCOUNT_ID, tasks)
    print("\n批量上传结果:")
    for i, result in enumerate(r.get("results", [])):
        status = result.get("status", "unknown")
        print(f"  [{i+1}] {status} - {result.get('post_url', result.get('error', ''))}")

print("\n测试完成")
