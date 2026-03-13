"""Playwright 浏览器单例管理"""
import asyncio
from typing import Optional
from playwright.async_api import async_playwright, Browser, BrowserContext, Page
from config import BROWSER_HEADLESS, BROWSER_SLOW_MO


_playwright = None
_browser: Optional[Browser] = None


async def get_browser() -> Browser:
    global _playwright, _browser
    if _browser is None or not _browser.is_connected():
        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(
            headless=BROWSER_HEADLESS,
            slow_mo=BROWSER_SLOW_MO,
            args=[
                "--disable-blink-features=AutomationControlled",
                # 禁止媒体设备弹窗（摄像头/麦克风），返回假设备
                "--use-fake-ui-for-media-stream",
                # 禁用 Cast/mDNS 本地网络发现，避免触发「访问此设备上的其他应用和服务」弹窗
                "--disable-features=MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider",
                "--media-router=0",
                # 完全禁用 OS 层面的地理位置请求，避免触发「获取您的位置」弹窗
                "--disable-geolocation",
                "--no-first-run",
                "--no-default-browser-check",
                # 禁用渲染器节流：窗口在后台/被遮挡时不冻结渲染，解决「进度条不动」问题
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
                "--disable-background-timer-throttling",
                "--disable-background-media-suspend",
            ],
        )
    return _browser


async def new_context(storage_state: Optional[dict] = None) -> BrowserContext:
    browser = await get_browser()
    context = await browser.new_context(
        storage_state=storage_state,
        viewport={"width": 1280, "height": 800},
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        # 预授权常见权限，避免触发浏览器内弹窗
        permissions=["notifications", "clipboard-read", "clipboard-write"],
        locale="zh-CN",
    )
    # 隐藏自动化特征，mock geolocation 避免网页触发任何位置相关行为
    await context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // mock geolocation：直接返回固定坐标，不触发任何系统权限请求
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition = function(success) {
                success({ coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 100 }, timestamp: Date.now() });
            };
            navigator.geolocation.watchPosition = function(success) {
                success({ coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 100 }, timestamp: Date.now() });
                return 0;
            };
        }
    """)
    return context


async def close_browser():
    global _browser, _playwright
    if _browser:
        await _browser.close()
        _browser = None
    if _playwright:
        await _playwright.stop()
        _playwright = None
