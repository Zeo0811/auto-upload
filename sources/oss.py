"""
阿里云 OSS / AWS S3 来源
需要在环境变量或 config 里配置 key/secret
"""
import os
from pathlib import Path
from typing import Optional
from sources.base import VideoSource


class OssSource(VideoSource):
    """阿里云 OSS"""
    def __init__(self, bucket: str, key: str, endpoint: Optional[str] = None):
        self.bucket = bucket
        self.key = key
        self.endpoint = endpoint or os.environ.get("OSS_ENDPOINT", "")

    async def resolve(self, tmp_dir: Path) -> Path:
        import oss2
        auth = oss2.Auth(
            os.environ["OSS_ACCESS_KEY_ID"],
            os.environ["OSS_ACCESS_KEY_SECRET"],
        )
        bucket = oss2.Bucket(auth, self.endpoint, self.bucket)
        dest = tmp_dir / Path(self.key).name
        bucket.get_object_to_file(self.key, str(dest))
        return dest


class S3Source(VideoSource):
    """AWS S3 / 兼容 S3 协议的存储"""
    def __init__(self, bucket: str, key: str, region: str = "us-east-1"):
        self.bucket = bucket
        self.key = key
        self.region = region

    async def resolve(self, tmp_dir: Path) -> Path:
        import boto3
        s3 = boto3.client("s3", region_name=self.region)
        dest = tmp_dir / Path(self.key).name
        s3.download_file(self.bucket, self.key, str(dest))
        return dest
