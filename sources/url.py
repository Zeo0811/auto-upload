import httpx
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from sources.base import VideoSource


class UrlSource(VideoSource):
    def __init__(self, url: str, filename: Optional[str] = None):
        self.url = url
        self.filename = filename or Path(urlparse(url).path).name or "video.mp4"

    async def resolve(self, tmp_dir: Path) -> Path:
        dest = tmp_dir / self.filename
        async with httpx.AsyncClient(follow_redirects=True, timeout=300) as client:
            async with client.stream("GET", self.url) as resp:
                resp.raise_for_status()
                with open(dest, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=1024 * 1024):
                        f.write(chunk)
        return dest
