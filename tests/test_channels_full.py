"""视频号完整测试（含封面上传、封面修改、定时发布、多标签页检测）
用法: python tests/test_channels_full.py <video_path> <cover_path> [account_id]
示例: python tests/test_channels_full.py ~/Downloads/测试视频1.mp4 ~/Downloads/cover.png test
"""
import sys
import os
import time
import subprocess
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools import (
    login, check_login, logout,
    upload_video, get_task_status,
    list_posts, edit_post, delete_post, delete_all_posts,
)
from core.session import load_session

PLATFORM = "channels"

if len(sys.argv) < 3:
    print("用法: python tests/test_channels_full.py <video_path> <cover_path> [account_id]")
    sys.exit(1)

VIDEO_PATH = sys.argv[1]
COVER_PATH = sys.argv[2]
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


def wait_login(label=""):
    """统一登录等待逻辑"""
    r = login(PLATFORM, ACCOUNT_ID)
    if r["status"] == "qr_required":
        print(f"  请扫描二维码...{label}")
        for i in range(180):
            time.sleep(2)
            r = check_login(PLATFORM, ACCOUNT_ID)
            if r["status"] == "qr_refreshed":
                print(f"  [{i+1}] 二维码已刷新，请重新扫描")
                continue
            if r["status"] == "confirmed":
                return True, r
            if r["status"] in ("error", "expired"):
                return False, r
        return False, {"status": "error", "error": "扫码超时"}
    elif r["status"] == "ok":
        return True, r
    return False, r


def wait_upload(task_id, check_cover=False):
    """等待上传完成，返回 (success, had_cover_step, had_schedule_step)"""
    last_progress = -1
    had_cover = False
    had_schedule = False
    while True:
        t = get_task_status(task_id)
        if t.get("status") == "error":
            return False, had_cover, had_schedule, t
        if t["progress"] != last_progress:
            msg = t.get("status_msg") or t["status"]
            print(f"  [{t['progress']}%] {msg}")
            if "封面" in msg:
                had_cover = True
            if "定时" in msg:
                had_schedule = True
            last_progress = t["progress"]
        if t["status"] == "done":
            return True, had_cover, had_schedule, t
        if t["status"] == "failed":
            return False, had_cover, had_schedule, t
        time.sleep(3)


# 计算明天的定时发布时间
tomorrow = datetime.now() + timedelta(days=1)
SCHEDULE_TIME = tomorrow.strftime("%Y-%m-%d %H:%M")

# ============================================================
print(f"\n{'='*60}")
print(f"  视频号完整自动化测试")
print(f"  平台: {PLATFORM}  账号: {ACCOUNT_ID}")
print(f"  视频: {VIDEO_PATH}")
print(f"  封面: {COVER_PATH}")
print(f"  定时: {SCHEDULE_TIME}")
print(f"{'='*60}\n")

for p, label in [(VIDEO_PATH, "视频"), (COVER_PATH, "封面")]:
    if not os.path.exists(p):
        print(f"{label}文件不存在: {p}")
        sys.exit(1)


# ── 1. 登录测试 ──────────────────────────────────────────────
print("[1/11] 登录测试")
ok, r = wait_login()
report("login", ok, str(r))
if not ok:
    print("\n登录失败，无法继续后续测试")
    sys.exit(1)


# ── 2. 上传测试（带封面） ────────────────────────────────────
print(f"\n[2/11] 上传测试（带封面）")
r = upload_video(
    PLATFORM, ACCOUNT_ID,
    {"type": "local", "path": VIDEO_PATH},
    {
        "title": f"封面测试 {time.strftime('%Y%m%d_%H%M%S')}",
        "description": "完整测试：含封面上传",
        "tags": ["测试", "封面"],
        "cover_path": COVER_PATH,
    },
)
if r.get("status") == "error":
    report("upload_with_cover", False, r.get("error"))
    print("\n上传失败，跳过后续测试")
    sys.exit(1)

task_id = r["task_id"]
print(f"  task_id: {task_id}")
ok, had_cover, _, t = wait_upload(task_id, check_cover=True)
report("upload_with_cover", ok, t.get("post_url", "") if ok else t.get("error", str(t)))
if had_cover:
    report("cover_upload_step", True, "上传流程包含封面处理步骤")
else:
    report("cover_upload_step", False, "上传流程未检测到封面处理步骤")


# ── 3. 上传测试（定时发布） ──────────────────────────────────
print(f"\n[3/11] 上传测试（定时发布: {SCHEDULE_TIME}）")
r = upload_video(
    PLATFORM, ACCOUNT_ID,
    {"type": "local", "path": VIDEO_PATH},
    {
        "title": f"定时发布测试 {time.strftime('%Y%m%d_%H%M%S')}",
        "description": "完整测试：定时发布",
        "tags": ["测试", "定时"],
        "publish_time": SCHEDULE_TIME,
    },
)
if r.get("status") == "error":
    report("upload_scheduled", False, r.get("error"))
else:
    task_id_sched = r["task_id"]
    print(f"  task_id: {task_id_sched}")
    ok, _, had_schedule, t = wait_upload(task_id_sched)
    report("upload_scheduled", ok, f"定时={SCHEDULE_TIME}" if ok else t.get("error", str(t)))
    if had_schedule:
        report("schedule_step", True, "上传流程包含定时发布步骤")
    else:
        report("schedule_step", False, "上传流程未检测到定时发布步骤")


# ── 4. 列表查询测试 ──────────────────────────────────────────
print(f"\n[4/11] 列表查询测试")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok":
    posts = r.get("posts", [])
    report("list_posts", True, f"共 {len(posts)} 条")
    for p in posts[:5]:
        title = p.get("title", "无标题")
        cover = "有封面" if p.get("cover_url") else "无封面"
        status = p.get("status", "")
        pub_time = p.get("publish_time", "")
        print(f"    - {title} | {status} | {cover} | {pub_time}")
    if len(posts) > 5:
        print(f"    ... 还有 {len(posts)-5} 条")

    # 检查定时发布的帖子是否出现
    scheduled = [p for p in posts if p.get("status") == "scheduled"]
    if scheduled:
        report("scheduled_in_list", True, f"列表中有 {len(scheduled)} 条定时发布")
    else:
        report("scheduled_in_list", False, "列表中未找到定时发布的帖子")
else:
    report("list_posts", False, str(r))


# ── 5. 编辑测试（含封面修改） ────────────────────────────────
print(f"\n[5/11] 编辑测试（含封面修改）")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok" and r.get("posts"):
    target = r["posts"][0]
    target_id = target["post_id"]
    new_title = f"封面修改测试 {time.strftime('%H:%M:%S')}"
    print(f"  编辑 post_id={target_id}, 新标题={new_title}")
    print(f"  同时修改封面: {COVER_PATH}")
    r2 = edit_post(PLATFORM, ACCOUNT_ID, target_id, {
        "title": new_title,
        "cover_path": COVER_PATH,
    })
    report("edit_with_cover", r2.get("status") == "ok", str(r2))
else:
    report_skip("edit_with_cover", "无可编辑内容")


# ── 6. 纯标题编辑测试（不改封面） ────────────────────────────
print(f"\n[6/11] 纯标题编辑测试")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok" and r.get("posts"):
    target = r["posts"][0]
    target_id = target["post_id"]
    new_title = f"标题编辑测试 {time.strftime('%H:%M:%S')}"
    print(f"  编辑 post_id={target_id}, 新标题={new_title}")
    r2 = edit_post(PLATFORM, ACCOUNT_ID, target_id, {"title": new_title})
    report("edit_title_only", r2.get("status") == "ok", str(r2))
else:
    report_skip("edit_title_only", "无可编辑内容")


# ── 7. 多标签页测试 ──────────────────────────────────────────
print(f"\n[7/11] 多标签页测试")
print("  打开额外的视频号标签页...")
subprocess.run(["open", "-a", "Google Chrome", "https://channels.weixin.qq.com/platform/post/create"], capture_output=True)
time.sleep(3)
subprocess.run(["open", "-a", "Google Chrome", "https://channels.weixin.qq.com/platform/post/list"], capture_output=True)
time.sleep(3)

# 在多标签页环境下尝试上传
print("  在多标签页环境下上传...")
r = upload_video(
    PLATFORM, ACCOUNT_ID,
    {"type": "local", "path": VIDEO_PATH},
    {
        "title": f"多标签页测试 {time.strftime('%Y%m%d_%H%M%S')}",
        "description": "多标签页环境下的上传测试",
        "tags": ["多标签页", "测试"],
    },
)
if r.get("status") == "error":
    report("multi_tab_upload", False, r.get("error"))
else:
    task_id2 = r["task_id"]
    print(f"  task_id: {task_id2}")
    ok, _, _, t = wait_upload(task_id2)
    report("multi_tab_upload", ok, "多标签页环境上传成功" if ok else t.get("error", str(t)))

# 多标签页环境下列表查询
print("  多标签页环境下列表查询...")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok":
    report("multi_tab_list", True, f"多标签页环境 - 共 {len(r.get('posts', []))} 条")
else:
    report("multi_tab_list", False, str(r))


# ── 8. 定时发布的帖子删除测试 ────────────────────────────────
print(f"\n[8/11] 删除定时发布帖子测试")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok" and r.get("posts"):
    # 优先删定时发布的
    scheduled = [p for p in r["posts"] if p.get("status") == "scheduled"]
    target = scheduled[0] if scheduled else r["posts"][0]
    target_id = target["post_id"]
    print(f"  删除 post_id={target_id} ({target.get('title', '')} | {target.get('status', '')})")
    r2 = delete_post(PLATFORM, ACCOUNT_ID, target_id)
    report("delete_post", r2.get("status") == "ok", str(r2))
else:
    report_skip("delete_post", "无可删除内容")


# ── 9. 普通帖子删除测试 ──────────────────────────────────────
print(f"\n[9/11] 删除普通帖子测试")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok" and r.get("posts"):
    target = r["posts"][0]
    target_id = target["post_id"]
    print(f"  删除 post_id={target_id} ({target.get('title', '')})")
    r2 = delete_post(PLATFORM, ACCOUNT_ID, target_id)
    report("delete_post_2", r2.get("status") == "ok", str(r2))
else:
    report_skip("delete_post_2", "无可删除内容")


# ── 10. 退出登录测试 ─────────────────────────────────────────
print(f"\n[10/11] 退出登录测试")
r = logout(PLATFORM, ACCOUNT_ID)
report("logout", r.get("status") == "ok", r.get("message", ""))
session_after = load_session(PLATFORM, ACCOUNT_ID)
report("logout_verify", session_after is None, "session 应为空")


# ── 11. 重新登录测试 ─────────────────────────────────────────
print(f"\n[11/11] 重新登录测试")
ok, r = wait_login("（重新登录）")
report("re-login", ok, str(r))


# ── 总结 ─────────────────────────────────────────────────────
print(f"\n{'='*60}")
total = passed + failed + skipped
print(f"  测试总结: {passed} 通过 / {failed} 失败 / {skipped} 跳过 (共 {total} 项)")
if failed == 0:
    print("  全部通过！")
else:
    print(f"  有 {failed} 项失败")
print(f"{'='*60}")
sys.exit(1 if failed > 0 else 0)
