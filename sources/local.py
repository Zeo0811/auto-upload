from pathlib import Path
from sources.base import VideoSource


class LocalSource(VideoSource):
    def __init__(self, path: str):
        self.path = Path(path)

    async def resolve(self, tmp_dir: Path) -> Path:
        if not self.path.exists():
            raise FileNotFoundError(f"本地文件不存在: {self.path}")
        return self.path
