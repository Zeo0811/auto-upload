"""一键运行全部测试（自动化，非交互）
用法: python tests/test_all.py <platform> <video_path> [account_id]
示例: python tests/test_all.py channels /path/to/video.mp4 test
"""
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools import (
    login, check_login, logout,
    upload_video, get_task_status,
    list_posts, edit_post, delete_post, delete_all_posts,
)
from core.session import load_session

if len(sys.argv) < 3:
    print("用法: python tests/test_all.py <platform> <video_path> [account_id]")
    print("  platform: xiaohongshu / channels / douyin")
    print("  video_path: 测试视频文件路径")
    print("  account_id: 账号标识 (默认 test)")
    sys.exit(1)

PLATFORM = sys.argv[1]
VIDEO_PATH = sys.argv[2]
ACCOUNT_ID = sys.argv[3] if len(sys.argv) > 3 else "test"

passed = 0
failed = 0
skipped = 0


def report(name, success, msg=""):
    global passed, failed
    if success:
        passed += 1
        print(f"  PASS  {name}" + (f" - {msg}" if msg else ""))
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f" - {msg}" if msg else ""))


def report_skip(name, msg=""):
    global skipped
    skipped += 1
    print(f"  SKIP  {name}" + (f" - {msg}" if msg else ""))


# ============================================================
print(f"\n{'='*60}")
print(f"  全流程自动化测试")
print(f"  平台: {PLATFORM}  账号: {ACCOUNT_ID}")
print(f"  视频: {VIDEO_PATH}")
print(f"{'='*60}\n")

if not os.path.exists(VIDEO_PATH):
    print(f"视频文件不存在: {VIDEO_PATH}")
    sys.exit(1)


# ── 1. 登录测试 ──────────────────────────────────────────────
print("[1/7] 登录测试")
r = login(PLATFORM, ACCOUNT_ID)
if r["status"] == "qr_required":
    print("  请扫描二维码...")
    for i in range(180):
        time.sleep(2)
        r = check_login(PLATFORM, ACCOUNT_ID)
        if r["status"] == "qr_refreshed":
            print(f"  [{i+1}] 二维码已自动刷新，请重新扫描")
            continue
        if r["status"] == "confirmed":
            break
        if r["status"] in ("error", "expired"):
            break
    report("login", r.get("status") == "confirmed", str(r))
elif r["status"] == "ok":
    report("login", True, "已有有效 session")
else:
    report("login", False, str(r))

if r.get("status") not in ("ok", "confirmed"):
    print("\n登录失败，无法继续后续测试")
    sys.exit(1)


# ── 2. 上传测试 ──────────────────────────────────────────────
print(f"\n[2/7] 上传测试")
r = upload_video(
    PLATFORM, ACCOUNT_ID,
    {"type": "local", "path": VIDEO_PATH},
    {
        "title": f"自动化测试 {time.strftime('%Y%m%d_%H%M%S')}",
        "description": "全流程自动化测试视频",
        "tags": ["测试", "自动化"],
    },
)
if r.get("status") == "error":
    report("upload", False, r.get("error"))
    print("\n上传失败，跳过后续测试")
    sys.exit(1)

task_id = r["task_id"]
print(f"  task_id: {task_id}")

# 轮询上传进度
last_progress = -1
while True:
    t = get_task_status(task_id)
    if t.get("status") == "error":
        report("upload", False, str(t))
        break
    if t["progress"] != last_progress:
        print(f"  [{t['progress']}%] {t.get('status_msg') or t['status']}")
        last_progress = t["progress"]
    if t["status"] == "done":
        report("upload", True, t.get("post_url", ""))
        break
    if t["status"] == "failed":
        report("upload", False, t.get("error", ""))
        break
    time.sleep(3)


# ── 3. 列表查询测试 ──────────────────────────────────────────
print(f"\n[3/7] 列表查询测试")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok":
    posts = r.get("posts", [])
    report("list_posts", True, f"共 {len(posts)} 条")
    for p in posts[:3]:
        print(f"    - {p.get('title', '无标题')} | {p.get('status', '')} | {p.get('post_id', '')}")
    if len(posts) > 3:
        print(f"    ... 还有 {len(posts)-3} 条")
else:
    report("list_posts", False, str(r))


# ── 4. 编辑测试 ──────────────────────────────────────────────
print(f"\n[4/7] 编辑测试")
if r.get("status") == "ok" and r.get("posts"):
    target = r["posts"][0]
    target_id = target["post_id"]
    new_title = f"编辑测试 {time.strftime('%H:%M:%S')}"
    print(f"  编辑 post_id={target_id}, 新标题={new_title}")
    r2 = edit_post(PLATFORM, ACCOUNT_ID, target_id, {"title": new_title})
    report("edit_post", r2.get("status") == "ok", str(r2))
else:
    report_skip("edit_post", "无可编辑内容")


# ── 5. 删除单个测试 ──────────────────────────────────────────
print(f"\n[5/7] 删除单个测试")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok" and r.get("posts"):
    target = r["posts"][0]
    target_id = target["post_id"]
    print(f"  删除 post_id={target_id} ({target.get('title', '')})")
    r2 = delete_post(PLATFORM, ACCOUNT_ID, target_id)
    report("delete_post", r2.get("status") == "ok", str(r2))
else:
    report_skip("delete_post", "无可删除内容")


# ── 6. 退出登录测试 ──────────────────────────────────────────
print(f"\n[6/7] 退出登录测试")
r = logout(PLATFORM, ACCOUNT_ID)
report("logout", r.get("status") == "ok", r.get("message", ""))
session_after = load_session(PLATFORM, ACCOUNT_ID)
report("logout_verify", session_after is None, "session 应为空")


# ── 7. 重新登录测试 ──────────────────────────────────────────
print(f"\n[7/7] 重新登录测试")
r = login(PLATFORM, ACCOUNT_ID)
if r["status"] == "qr_required":
    print("  请再次扫描二维码...")
    for i in range(180):
        time.sleep(2)
        r = check_login(PLATFORM, ACCOUNT_ID)
        if r["status"] == "qr_refreshed":
            print(f"  [{i+1}] 二维码已自动刷新，请重新扫描")
            continue
        if r["status"] == "confirmed":
            break
        if r["status"] in ("error", "expired"):
            break
    report("re-login", r.get("status") == "confirmed", str(r))
elif r["status"] == "ok":
    report("re-login", True)
else:
    report("re-login", False, str(r))


# ── 总结 ─────────────────────────────────────────────────────
print(f"\n{'='*60}")
print(f"  测试总结: {passed} 通过, {failed} 失败, {skipped} 跳过")
print(f"{'='*60}")
sys.exit(1 if failed > 0 else 0)
