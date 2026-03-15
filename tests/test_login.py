"""测试登录 / 退出登录流程"""
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools import login, check_login, logout
from core.session import load_session

SUPPORTED_PLATFORMS = {
    "1": "xiaohongshu",
    "2": "channels",
    "3": "douyin",
}

print("=" * 50)
print("  登录 / 退出登录 测试")
print("=" * 50)

print("\n选择测试平台:")
for k, v in SUPPORTED_PLATFORMS.items():
    print(f"  {k}. {v}")
choice = input("请输入序号 [默认 1]: ").strip() or "1"
PLATFORM = SUPPORTED_PLATFORMS.get(choice, "xiaohongshu")
ACCOUNT_ID = input("账号 ID [默认 test]: ").strip() or "test"
print(f"\n平台: {PLATFORM}  账号: {ACCOUNT_ID}\n")

print("选择测试操作:")
print("  1. 登录（完整流程）")
print("  2. 检查当前登录状态")
print("  3. 退出登录")
print("  4. 登录 → 退出 → 重新登录（完整回归）")
op = input("请输入序号 [默认 1]: ").strip() or "1"


def do_login():
    print("\n--- 发起登录 ---")
    r = login(PLATFORM, ACCOUNT_ID)
    print("login():", r)

    if r["status"] == "qr_required":
        print("\n请用手机扫描二维码...")
        for i in range(180):
            time.sleep(2)
            r = check_login(PLATFORM, ACCOUNT_ID)
            if r["status"] == "qr_refreshed":
                print(f"  [{i+1}] 二维码已自动刷新，请重新扫描")
                continue
            print(f"  [{i+1}] check_login: {r['status']}")
            if r["status"] == "confirmed":
                print("登录成功!")
                return True
            if r["status"] in ("error", "expired"):
                print("登录失败:", r.get("error", ""))
                return False
        print("等待扫码超时")
        return False

    if r["status"] == "ok":
        print("已有有效登录，无需扫码")
        return True

    print("登录异常:", r)
    return False


def do_check():
    print("\n--- 检查登录状态 ---")
    session = load_session(PLATFORM, ACCOUNT_ID)
    if session:
        print(f"本地 session 存在: {PLATFORM}/{ACCOUNT_ID}")
    else:
        print(f"本地 session 不存在: {PLATFORM}/{ACCOUNT_ID}")
    return session is not None


def do_logout():
    print("\n--- 退出登录 ---")
    r = logout(PLATFORM, ACCOUNT_ID)
    print("logout():", r)
    # 验证 session 已删除
    session = load_session(PLATFORM, ACCOUNT_ID)
    if session is None:
        print("验证通过: session 已清除")
    else:
        print("验证失败: session 仍然存在!")
    return r


if op == "1":
    do_login()

elif op == "2":
    do_check()

elif op == "3":
    do_logout()

elif op == "4":
    print("\n===== 第一步: 登录 =====")
    if not do_login():
        print("登录失败，终止测试")
        sys.exit(1)

    print("\n===== 第二步: 退出登录 =====")
    do_logout()

    print("\n===== 第三步: 验证已退出 =====")
    has_session = do_check()
    if has_session:
        print("退出登录失败!")
        sys.exit(1)

    print("\n===== 第四步: 重新登录 =====")
    if do_login():
        print("\n全部测试通过!")
    else:
        print("\n重新登录失败!")
        sys.exit(1)

print("\n测试完成")
