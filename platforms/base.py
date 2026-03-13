"""平台上传器抽象基类"""
from abc import ABC, abstractmethod
from pathlib import Path
from playwright.async_api import BrowserContext


class BasePlatform(ABC):
    def __init__(self, context: BrowserContext, account_id: str):
        self.context = context
        self.account_id = account_id

    @abstractmethod
    async def is_logged_in(self) -> bool:
        ...

    # ---------- 登录方式：二者实现其一即可 ----------

    async def get_qr_code(self) -> str:
        """截图登录二维码，返回图片路径（支持二维码登录的平台实现）"""
        raise NotImplementedError

    async def check_qr_status(self) -> str:
        """返回: 'pending' | 'scanned' | 'confirmed' | 'expired'"""
        raise NotImplementedError

    async def send_sms_code(self, phone: str) -> None:
        """填入手机号并发送验证码（支持短信登录的平台实现）"""
        raise NotImplementedError

    async def verify_sms_code(self, code: str) -> bool:
        """填入验证码并登录，成功返回 True"""
        raise NotImplementedError

    # ---------- 上传 ----------

    @abstractmethod
    async def upload(self, video_path: Path, meta: dict, on_progress=None) -> str:
        """执行上传发布，返回帖子 URL"""
        ...
