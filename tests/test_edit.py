"""测试编辑内容"""
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools import login, check_login, list_posts, edit_post
from core.session import load_session

SUPPORTED_PLATFORMS = {
    "1": "xiaohongshu",
    "2": "channels",
    "3": "douyin",
}

print("=" * 50)
print("  内容编辑测试")
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

# 先列出内容供选择
print("--- 查询内容列表 ---")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") != "ok" or not r.get("posts"):
    print("没有可编辑的内容:", r)
    sys.exit(1)

posts = r["posts"]
for i, post in enumerate(posts):
    print(f"  [{i+1}] {post.get('title', '无标题')} | {post.get('status', '')} | post_id: {post.get('post_id', '无')}")

idx = input(f"\n选择要编辑的内容 [1-{len(posts)}]: ").strip()
if not idx.isdigit() or int(idx) < 1 or int(idx) > len(posts):
    print("无效选择")
    sys.exit(1)
post = posts[int(idx) - 1]
post_id = post["post_id"]
print(f"\n已选择: {post.get('title', '无标题')} (post_id: {post_id})")

# 收集修改字段
meta = {}
print("\n输入修改内容（留空跳过）:")

title = input("  新标题: ").strip()
if title:
    meta["title"] = title

desc = input("  新描述: ").strip()
if desc:
    meta["description"] = desc

tags = input("  标签 (逗号分隔): ").strip()
if tags:
    meta["tags"] = [t.strip() for t in tags.split(",")]

cover = input("  封面图路径: ").strip()
if cover:
    meta["cover_path"] = cover

if PLATFORM == "xiaohongshu":
    video = input("  新视频路径: ").strip()
    if video:
        meta["video_path"] = video

schedule = input("  定时发布 (YYYY-MM-DD HH:MM / cancel=取消定时): ").strip()
if schedule.lower() == "cancel":
    meta["publish_time"] = ""
elif schedule:
    meta["publish_time"] = schedule

if not meta:
    print("\n未修改任何字段，退出")
    sys.exit(0)

print(f"\n--- 编辑内容 {post_id} ---")
print(f"修改字段: {meta}")
confirm = input("确认编辑? [y/N]: ").strip().lower()
if confirm != "y":
    print("已取消")
    sys.exit(0)

r = edit_post(PLATFORM, ACCOUNT_ID, post_id, meta)
print(f"\n结果: {r}")

# 编辑后重新查询验证
if r.get("status") == "ok":
    print("\n--- 重新查询验证 ---")
    r2 = list_posts(PLATFORM, ACCOUNT_ID)
    if r2.get("status") == "ok":
        for p in r2["posts"]:
            if p.get("post_id") == post_id:
                print(f"  标题: {p.get('title')}")
                print(f"  状态: {p.get('status')}")
                break

print("\n测试完成")
