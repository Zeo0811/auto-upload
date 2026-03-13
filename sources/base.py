"""视频来源抽象基类"""
from abc import ABC, abstractmethod
from pathlib import Path


class VideoSource(ABC):
    @abstractmethod
    async def resolve(self, tmp_dir: Path) -> Path:
        """
        获取本地可用的视频文件路径。
        如需下载，下载到 tmp_dir 并返回路径。
        """
        ...
