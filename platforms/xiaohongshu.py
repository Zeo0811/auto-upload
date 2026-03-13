"""小红书创作者平台自动上传"""
import asyncio
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from playwright.async_api import BrowserContext, Page, TimeoutError as PlaywrightTimeout

from platforms.base import BasePlatform
from config import BASE_DIR

PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish"

# 最简单策略：所有看起来像「确认」的按钮文字，直接点击
_CONFIRM_TEXTS = ["允许", "好", "确认", "确定", "OK", "Allow", "继续", "同意"]

# Chromium 进程名（Playwright 用的是 Chromium）
_CHROMIUM_PROC = "Chromium"


def _window_nudge_worker(stop_event: threading.Event):
    """
    后台线程：每 2 秒通过 osascript 在 macOS Window Server 层面
    轻微移动 Chromium 窗口位置，强制触发 GPU 重绘。
    此操作不依赖 Chrome 进程是否响应，冻结时同样有效。
    """
    script = f"""
    tell application "System Events"
        if exists process "{_CHROMIUM_PROC}" then
            tell process "{_CHROMIUM_PROC}"
                if (count of windows) > 0 then
                    set w to window 1
                    set p to position of w
                    set position of w to {{(item 1 of p) + 2, item 2 of p}}
                    delay 0.05
                    set position of w to p
                end if
            end tell
        end if
    end tell
    """
    while not stop_event.is_set():
        try:
            subprocess.run(["osascript", "-e", script], capture_output=True, timeout=3)
        except Exception:
            pass
        stop_event.wait(2)


class XiaohongshuPlatform(BasePlatform):
    def __init__(self, context: BrowserContext, account_id: str):
        super().__init__(context, account_id)
        self._page: Optional[Page] = None
        self._login_page: Optional[Page] = None

    # ------------------------------------------------------------------ #
    # 内部工具
    # ------------------------------------------------------------------ #

    async def _get_page(self) -> Page:
        if self._page is None or self._page.is_closed():
            self._page = await self.context.new_page()
            self._page.on("dialog", lambda dlg: asyncio.ensure_future(dlg.accept()))
        return self._page

    async def _get_login_page(self) -> Page:
        if self._login_page is None or self._login_page.is_closed():
            self._login_page = await self.context.new_page()
            self._login_page.on("dialog", lambda dlg: asyncio.ensure_future(dlg.accept()))
            await self._login_page.goto(PUBLISH_URL, wait_until="domcontentloaded")
            await asyncio.sleep(3)
        return self._login_page

    async def _click_all_confirm_buttons(self, page: Page):
        """
        最简单策略：扫描页面内所有可见按钮，
        凡是文字匹配「确认/允许/OK」类的，全部点击一遍。
        """
        for text in _CONFIRM_TEXTS:
            try:
                els = page.locator(f"button:has-text('{text}')")
                count = await els.count()
                for i in range(count):
                    el = els.nth(i)
                    if await el.is_visible():
                        await el.click()
                        await asyncio.sleep(0.3)
            except Exception:
                pass

        # 同时关闭常见的引导/通知弹窗
        for sel in [
            "button:has-text('不允许')",
            "button:has-text('稍后')",
            "button:has-text('跳过')",
            "button:has-text('我知道了')",
            "[class*='modal'] [class*='close']",
            "[class*='popup'] [class*='close']",
        ]:
            try:
                el = page.locator(sel).first
                if await el.is_visible():
                    await el.click()
                    await asyncio.sleep(0.3)
            except Exception:
                pass

    async def _keep_page_alive(self, page: Page, stop: asyncio.Event):
        """
        后台协程：每 3 秒 bring_to_front + dispatch resize，
        防止 Chromium 渲染冻结（手动挪动窗口才恢复的根因）。
        不在此处点按钮（避免干扰正在进行的 fill/click 操作）。
        """
        while not stop.is_set():
            try:
                await page.bring_to_front()
                await page.evaluate("window.dispatchEvent(new Event('resize'))")
            except Exception:
                pass
            await asyncio.sleep(3)

    async def _random_delay(self, lo=0.8, hi=2.0):
        import random
        await asyncio.sleep(lo + (hi - lo) * random.random())

    async def _force_repaint(self, page: Page):
        """模拟滚动 + 鼠标移动，触发 Chromium 重绘（备用，主要靠启动参数禁节流）"""
        try:
            await asyncio.wait_for(page.evaluate("window.scrollBy(0, 80)"), timeout=2)
            await asyncio.sleep(0.2)
            await asyncio.wait_for(page.evaluate("window.scrollBy(0, -80)"), timeout=2)
        except Exception:
            pass
        try:
            await page.mouse.move(640, 300)
            await page.mouse.move(640, 420)
        except Exception:
            pass

    # ------------------------------------------------------------------ #
    # 登录检测
    # ------------------------------------------------------------------ #

    async def is_logged_in(self) -> bool:
        page = await self._get_page()
        await page.goto(PUBLISH_URL, wait_until="domcontentloaded")
        await asyncio.sleep(3)
        has_login = await page.locator(".login-container").count()
        return has_login == 0

    # ------------------------------------------------------------------ #
    # 二维码登录
    # ------------------------------------------------------------------ #

    async def get_qr_code(self) -> str:
        page = await self._get_login_page()

        qr_toggle = page.locator(".login-box-container img").first
        await qr_toggle.wait_for(state="visible", timeout=8000)
        await qr_toggle.click()
        await asyncio.sleep(2)

        qr_path = str(BASE_DIR / "tmp" / "xhs_qr.png")
        try:
            qr_el = page.locator(".login-box-container img").nth(1)
            await qr_el.wait_for(state="visible", timeout=8000)
            await qr_el.screenshot(path=qr_path)
        except PlaywrightTimeout:
            await page.locator(".login-box-container").screenshot(path=qr_path)

        return qr_path

    async def check_qr_status(self) -> str:
        if self._login_page is None or self._login_page.is_closed():
            return "expired"

        page = self._login_page
        url = page.url

        if "creator.xiaohongshu.com" in url and "login" not in url and "/publish" not in url:
            return "confirmed"
        if await page.locator(".login-container").count() == 0:
            return "confirmed"

        try:
            if await page.locator("text=扫码成功, text=已扫描, text=请在手机上确认").count() > 0:
                return "scanned"
        except Exception:
            pass

        try:
            if await page.locator("text=二维码已失效, text=已过期, text=点击刷新").count() > 0:
                return "expired"
        except Exception:
            pass

        return "pending"

    # ------------------------------------------------------------------ #
    # 上传发布
    # ------------------------------------------------------------------ #

    async def upload(self, video_path: Path, meta: dict, on_progress=None) -> str:
        """
        meta 字段:
          title: str                必填
          description: str          选填
          tags: list[str]           选填
          scheduled_time: str|datetime  选填，定时发布时间
            支持格式: datetime 对象 或 "2024-12-31 18:00" 字符串
        """
        page = await self._get_page()

        # 启动窗口微移线程，防止 Chromium 渲染冻结
        stop = threading.Event()
        nudger = threading.Thread(target=_window_nudge_worker, args=(stop,), daemon=True)
        nudger.start()
        try:
            return await self._do_upload(page, video_path, meta, on_progress)
        finally:
            stop.set()

    async def _do_upload(self, page: Page, video_path: Path, meta: dict, on_progress=None) -> str:
        await page.bring_to_front()
        await page.goto(PUBLISH_URL, wait_until="networkidle")
        await asyncio.sleep(3)
        await self._click_all_confirm_buttons(page)

        if on_progress:
            on_progress(5, "页面已加载")

        # --- 1. 点击「发布视频」入口（如果需要） ---
        await self._click_upload_entry(page)

        if on_progress:
            on_progress(10, "找到上传入口")

        # --- 2. 注入视频文件 ---
        file_input = page.locator('input[type="file"]').first
        await file_input.set_input_files(str(video_path))

        if on_progress:
            on_progress(15, "视频文件已注入，等待上传")

        # --- 3. 等待上传完成 ---
        await self._wait_upload_complete(page, on_progress)

        if on_progress:
            on_progress(70, "视频上传完成，填写信息")

        # 上传完成后：强制重绘 + 点掉所有确认弹窗
        await self._force_repaint(page)
        await asyncio.sleep(1)
        await self._click_all_confirm_buttons(page)

        # --- 4. 填写标题 ---
        try:
            await asyncio.wait_for(
                self._fill_title(page, meta.get("title", "")), timeout=30
            )
        except asyncio.TimeoutError:
            raise RuntimeError("填写标题超时，页面可能被弹窗冻结")

        # --- 5. 填写描述 + 标签 ---
        try:
            await asyncio.wait_for(
                self._fill_description(page, meta.get("description", ""), meta.get("tags", [])),
                timeout=60,
            )
        except asyncio.TimeoutError:
            raise RuntimeError("填写描述超时")

        # --- 6. 定时发布（可选）---
        scheduled_time = meta.get("scheduled_time")
        if scheduled_time:
            await self._set_scheduled_time(page, scheduled_time)
            if on_progress:
                on_progress(88, "定时发布时间已设置")

        if on_progress:
            on_progress(85, "信息填写完成，准备发布")

        await self._random_delay(1, 2)

        # 发布前模拟滚动，触发页面重绘，防止渲染冻结
        await self._force_repaint(page)

        # --- 7. 点击发布 ---
        try:
            await asyncio.wait_for(self._click_publish(page), timeout=30)
        except asyncio.TimeoutError:
            raise RuntimeError("点击发布超时")

        if on_progress:
            on_progress(95, "已点击发布，等待确认")

        # --- 8. 等待发布成功 ---
        post_url = await self._wait_publish_done(page)

        if on_progress:
            on_progress(100, "发布成功")

        return post_url

    # ------------------------------------------------------------------ #
    # 上传子步骤
    # ------------------------------------------------------------------ #

    async def _click_upload_entry(self, page: Page):
        try:
            fi = page.locator('input[type="file"]').first
            if await fi.count() > 0:
                return
        except Exception:
            pass

        for sel in ["text=发布视频", "[class*='video'][class*='upload']"]:
            try:
                el = page.locator(sel).first
                await el.wait_for(state="visible", timeout=4000)
                await el.click()
                await self._random_delay()
                return
            except PlaywrightTimeout:
                continue

    async def _wait_upload_complete(self, page: Page, on_progress=None):
        """等待视频上传完成（最多 10 分钟）"""
        start = time.time()
        timeout = 600

        while time.time() - start < timeout:
            await asyncio.sleep(3)

            # 每轮滚动一下，防止 Chromium 渲染冻结导致进度条不动
            await self._force_repaint(page)

            try:
                if await page.locator(
                    "input[placeholder='填写标题会有更多赞哦']"
                ).first.is_visible():
                    break
            except Exception:
                pass

            try:
                text = await page.locator(
                    "[class*='progress'] [class*='percent'], [class*='progress'] [class*='text']"
                ).first.inner_text(timeout=1000)
                num = int("".join(filter(str.isdigit, text)) or "0")
                if on_progress:
                    on_progress(15 + int(num * 0.55), f"上传中 {num}%")
            except Exception:
                pass

            if await page.locator("text=上传失败").count() > 0:
                raise RuntimeError("视频上传失败，请检查文件格式或网络")
        else:
            raise TimeoutError("视频上传超时（>10 分钟）")

    async def _fill_title(self, page: Page, title: str):
        for sel in [
            "input[placeholder='填写标题会有更多赞哦']",
            "input[placeholder*='标题']",
            "textarea[placeholder*='标题']",
            "[class*='title'] input",
        ]:
            try:
                el = page.locator(sel).first
                await el.wait_for(state="visible", timeout=5000)
                await el.click()
                await el.fill(title)
                await self._random_delay(0.3, 0.8)
                return
            except PlaywrightTimeout:
                continue

    async def _fill_description(self, page: Page, description: str, tags: list):
        full_text = description
        if tags:
            full_text += " " + " ".join(f"#{t}" for t in tags)
        if not full_text.strip():
            return

        for sel in [
            "div.tiptap.ProseMirror",
            "[contenteditable='true']",
            "[placeholder*='添加正文']",
            ".ql-editor",
        ]:
            try:
                el = page.locator(sel).first
                await el.wait_for(state="visible", timeout=5000)
                await el.click()
                await page.keyboard.type(full_text, delay=40)
                await self._random_delay(0.3, 0.8)
                return
            except PlaywrightTimeout:
                continue

    async def _set_scheduled_time(self, page: Page, scheduled_time):
        if isinstance(scheduled_time, str):
            for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y/%m/%d %H:%M"):
                try:
                    scheduled_time = datetime.strptime(scheduled_time, fmt)
                    break
                except ValueError:
                    continue

        if not isinstance(scheduled_time, datetime):
            raise ValueError(f"无法解析定时时间: {scheduled_time}")

        switch_sels = [
            ".post-time-switch-container input[type='checkbox']",
            "input[type='checkbox'][class*='time']",
            "label:has-text('定时发布') input",
            "label:has-text('定时') input",
        ]
        switched = False
        for sel in switch_sels:
            try:
                cb = page.locator(sel).first
                await cb.wait_for(state="attached", timeout=5000)
                if not await cb.is_checked():
                    await cb.click()
                await asyncio.sleep(1)
                switched = True
                break
            except PlaywrightTimeout:
                continue

        if not switched:
            try:
                label = page.locator("text=定时发布").first
                await label.wait_for(state="visible", timeout=4000)
                await label.click()
                await asyncio.sleep(1)
            except PlaywrightTimeout:
                raise RuntimeError("找不到定时发布开关")

        date_str = scheduled_time.strftime("%Y-%m-%d")
        time_str = scheduled_time.strftime("%H:%M")

        for sel in ["input[placeholder*='日期']", "input[type='date']", "[class*='date-picker'] input"]:
            try:
                el = page.locator(sel).first
                await el.wait_for(state="visible", timeout=3000)
                await el.triple_click()
                await el.fill(date_str)
                await asyncio.sleep(0.3)
                break
            except PlaywrightTimeout:
                continue

        for sel in ["input[placeholder*='时间']", "input[type='time']", "[class*='time-picker'] input"]:
            try:
                el = page.locator(sel).first
                await el.wait_for(state="visible", timeout=3000)
                await el.triple_click()
                await el.fill(time_str)
                await asyncio.sleep(0.3)
                break
            except PlaywrightTimeout:
                continue

        await page.keyboard.press("Escape")
        await asyncio.sleep(0.5)

    async def _click_publish(self, page: Page):
        # 优先用 JS 强制点击，绕过 disabled 状态检查
        clicked = await page.evaluate("""() => {
            const sels = [
                '.publish-page-publish-btn button.bg-red',
                '.publish-page-publish-btn button',
            ];
            for (const sel of sels) {
                const btn = document.querySelector(sel);
                if (btn) { btn.removeAttribute('disabled'); btn.click(); return true; }
            }
            return false;
        }""")
        if clicked:
            return

        # fallback：Playwright 点击
        for sel in [
            ".publish-page-publish-btn button.bg-red",
            ".publish-page-publish-btn button",
            "button:has-text('发布')",
            "button:has-text('立即发布')",
            "button:has-text('定时发布')",
        ]:
            try:
                el = page.locator(sel).first
                await el.wait_for(state="visible", timeout=5000)
                await el.click(force=True)
                return
            except PlaywrightTimeout:
                continue

        debug_path = str(BASE_DIR / "tmp" / "debug_publish.png")
        try:
            await page.screenshot(path=debug_path, full_page=True, timeout=5000)
        except Exception:
            debug_path = "（截图失败）"
        try:
            buttons = await page.evaluate("""() =>
                [...document.querySelectorAll('button, [class*=btn], [class*=publish]')]
                .map(el => ({tag: el.tagName, class: el.className, text: el.innerText?.trim().slice(0,30)}))
            """, timeout=5000)
        except Exception:
            buttons = []
        raise RuntimeError(f"找不到发布按钮，截图已保存: {debug_path}\n按钮列表: {buttons}")

    async def _wait_publish_done(self, page: Page) -> str:
        try:
            await page.wait_for_url(
                lambda url: "success" in url or "content" in url or "work" in url,
                timeout=30000,
            )
        except PlaywrightTimeout:
            pass

        try:
            link = await page.locator(
                "a[href*='xiaohongshu.com/explore']"
            ).first.get_attribute("href", timeout=3000)
            if link:
                return link
        except Exception:
            pass

        return page.url
