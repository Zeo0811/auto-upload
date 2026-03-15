"""测试删除内容（单个 / 批量 / 全部）"""
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools import login, check_login, list_posts, delete_post, delete_batch, delete_all_posts
from core.session import load_session

SUPPORTED_PLATFORMS = {
    "1": "xiaohongshu",
    "2": "channels",
    "3": "douyin",
}

print("=" * 50)
print("  内容删除测试")
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

print("选择删除操作:")
print("  1. 删除单个内容")
print("  2. 批量删除（选择多个）")
print("  3. 删除全部内容")
op = input("请输入序号 [默认 1]: ").strip() or "1"

if op == "1":
    # 单个删除
    print("\n--- 查询内容列表 ---")
    r = list_posts(PLATFORM, ACCOUNT_ID)
    if r.get("status") != "ok" or not r.get("posts"):
        print("没有可删除的内容:", r)
        sys.exit(1)

    posts = r["posts"]
    for i, post in enumerate(posts):
        print(f"  [{i+1}] {post.get('title', '无标题')} | {post.get('status', '')} | post_id: {post.get('post_id', '无')}")

    idx = input(f"\n选择要删除的内容 [1-{len(posts)}]: ").strip()
    if not idx.isdigit() or int(idx) < 1 or int(idx) > len(posts):
        print("无效选择")
        sys.exit(1)

    post = posts[int(idx) - 1]
    post_id = post["post_id"]
    print(f"\n将删除: {post.get('title', '无标题')} (post_id: {post_id})")
    confirm = input("确认删除? [y/N]: ").strip().lower()
    if confirm != "y":
        print("已取消")
        sys.exit(0)

    print(f"\n--- 删除 {post_id} ---")
    r = delete_post(PLATFORM, ACCOUNT_ID, post_id)
    print(f"结果: {r}")

elif op == "2":
    # 批量删除
    print("\n--- 查询内容列表 ---")
    r = list_posts(PLATFORM, ACCOUNT_ID)
    if r.get("status") != "ok" or not r.get("posts"):
        print("没有可删除的内容:", r)
        sys.exit(1)

    posts = r["posts"]
    for i, post in enumerate(posts):
        print(f"  [{i+1}] {post.get('title', '无标题')} | {post.get('status', '')} | post_id: {post.get('post_id', '无')}")

    indices = input(f"\n选择要删除的内容 (逗号分隔, 如 1,3,5): ").strip()
    selected_ids = []
    selected_titles = []
    for idx_str in indices.split(","):
        idx_str = idx_str.strip()
        if idx_str.isdigit():
            idx = int(idx_str)
            if 1 <= idx <= len(posts):
                selected_ids.append(posts[idx - 1]["post_id"])
                selected_titles.append(posts[idx - 1].get("title", "无标题"))

    if not selected_ids:
        print("未选择任何内容")
        sys.exit(1)

    print(f"\n将批量删除 {len(selected_ids)} 条内容:")
    for t in selected_titles:
        print(f"  - {t}")
    confirm = input("确认删除? [y/N]: ").strip().lower()
    if confirm != "y":
        print("已取消")
        sys.exit(0)

    print(f"\n--- 批量删除 ---")
    r = delete_batch(PLATFORM, ACCOUNT_ID, selected_ids)
    print(f"结果: {r}")

elif op == "3":
    # 全部删除
    print("\n--- 查询内容列表 ---")
    r = list_posts(PLATFORM, ACCOUNT_ID)
    count = len(r.get("posts", [])) if r.get("status") == "ok" else 0
    print(f"当前共 {count} 条内容")

    if count == 0:
        print("没有内容可删除")
        sys.exit(0)

    confirm = input(f"\n确认删除全部 {count} 条内容? 输入 'DELETE ALL' 确认: ").strip()
    if confirm != "DELETE ALL":
        print("已取消")
        sys.exit(0)

    print(f"\n--- 删除全部内容 ---")
    r = delete_all_posts(PLATFORM, ACCOUNT_ID)
    print(f"结果: {r}")

# 删除后验证
print("\n--- 删除后验证 ---")
r = list_posts(PLATFORM, ACCOUNT_ID)
if r.get("status") == "ok":
    print(f"剩余内容: {len(r.get('posts', []))} 条")
else:
    print(f"查询结果: {r}")

print("\n测试完成")
