"""测试内容管理功能：列表查询、编辑、删除"""
import sys
import time
import os

sys.path.insert(0, os.path.dirname(__file__))
from tools import login, check_login, list_posts, edit_post, delete_post
from core.session import load_session

SUPPORTED_PLATFORMS = {
    "1": "xiaohongshu",
    "2": "channels",
}

print("选择测试平台:")
print("  1. 小红书 (xiaohongshu)")
print("  2. 视频号 (channels)")
choice = input("请输入序号 [1/2，默认 1]: ").strip() or "1"
PLATFORM = SUPPORTED_PLATFORMS.get(choice, "xiaohongshu")
print(f"已选择平台: {PLATFORM}\n")

ACCOUNT_ID = "test"

# 1. 检查登录 session
print("=== 检查登录状态 ===")
session = load_session(PLATFORM, ACCOUNT_ID)
if session:
    print("已有登录 session，跳过登录流程")
else:
    print("未找到登录 session，需要先登录")
    r = login(PLATFORM, ACCOUNT_ID)
    print(r)

    if r["status"] == "qr_required":
        print("请用手机扫描已弹出的二维码，扫完后自动继续...")
        for _ in range(90):
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

print("登录 OK\n")

# 2. 测试操作选择
print("选择测试操作:")
print("  1. 查询列表 (list_posts)")
print("  2. 编辑内容 (edit_post)")
print("  3. 删除内容 (delete_post)")
op = input("请输入序号 [1/2/3，默认 1]: ").strip() or "1"

if op == "1":
    print("\n=== 查询内容列表 ===")
    status_filter = input("状态过滤 (published/scheduled/draft/空=全部): ").strip()
    r = list_posts(PLATFORM, ACCOUNT_ID, status_filter)
    print("结果:", r.get("status"))
    if r.get("status") == "ok":
        for i, post in enumerate(r.get("posts", [])):
            print(f"  [{i+1}] {post.get('title', '无标题')} | {post.get('status', '')} | {post.get('publish_time', '')}")
            print(f"       post_id: {post.get('post_id', '无')}")

elif op == "2":
    post_id = input("输入 post_id: ").strip()
    meta = {}
    title = input("新标题 (留空不改): ").strip()
    if title: meta["title"] = title
    desc = input("新描述 (留空不改): ").strip()
    if desc: meta["description"] = desc
    tags = input("标签 (逗号分隔，留空不改): ").strip()
    if tags: meta["tags"] = [t.strip() for t in tags.split(",")]
    cover = input("封面图路径 (留空不改): ").strip()
    if cover: meta["cover_path"] = cover
    if PLATFORM == "xiaohongshu":
        video = input("新视频路径 (留空不改): ").strip()
        if video: meta["video_path"] = video
    schedule = input("定时发布 (YYYY-MM-DD HH:MM / cancel=取消定时 / 留空不改): ").strip()
    if schedule.lower() == "cancel":
        meta["publish_time"] = ""
    elif schedule:
        meta["publish_time"] = schedule

    print(f"\n=== 编辑内容 {post_id} ===")
    print(f"修改字段: {meta}")
    r = edit_post(PLATFORM, ACCOUNT_ID, post_id, meta)
    print("结果:", r)

elif op == "3":
    post_id = input("输入 post_id: ").strip()
    print(f"\n=== 删除内容 {post_id} ===")
    r = delete_post(PLATFORM, ACCOUNT_ID, post_id)
    print("结果:", r)
