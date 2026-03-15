"""测试内容列表查询"""
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools import login, check_login, list_posts
from core.session import load_session

SUPPORTED_PLATFORMS = {
    "1": "xiaohongshu",
    "2": "channels",
    "3": "douyin",
}

print("=" * 50)
print("  内容列表查询测试")
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

print("选择过滤条件:")
print("  1. 全部")
print("  2. 已发布 (published)")
print("  3. 定时发布 (scheduled)")
print("  4. 草稿 (draft)")
print("  5. 审核中")
filter_map = {"1": "", "2": "published", "3": "scheduled", "4": "draft", "5": "审核中"}
f_choice = input("请输入序号 [默认 1]: ").strip() or "1"
status_filter = filter_map.get(f_choice, "")

print(f"\n--- 查询内容列表 (filter={status_filter or '全部'}) ---")
r = list_posts(PLATFORM, ACCOUNT_ID, status_filter)
print(f"状态: {r.get('status')}")

if r.get("status") == "ok":
    posts = r.get("posts", [])
    print(f"共 {len(posts)} 条内容:\n")
    for i, post in enumerate(posts):
        print(f"  [{i+1}] {post.get('title', '无标题')}")
        print(f"       post_id: {post.get('post_id', '无')}")
        print(f"       状态: {post.get('status', '未知')}")
        print(f"       发布时间: {post.get('publish_time', '无')}")
        if post.get("cover_url"):
            print(f"       封面: {post['cover_url'][:60]}...")
        print()
elif r.get("status") == "error":
    print(f"查询失败: {r.get('error')}")
else:
    print(f"返回: {r}")

print("测试完成")
