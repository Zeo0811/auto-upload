"""
从在线表格读取视频 URL，然后下载。
支持 Google Sheet / 飞书多维表格（Bitable）
表格中视频字段存的是可访问的 URL
"""
import os
from pathlib import Path
from sources.base import VideoSource
from sources.url import UrlSource


class GoogleSheetSource(VideoSource):
    """
    Google Sheet 来源
    sheet_id: 表格 ID
    row_id: 行号（1-based）或行标识
    video_col: 视频 URL 所在列名
    """
    def __init__(self, sheet_id: str, row_id: str | int, video_col: str = "video_url"):
        self.sheet_id = sheet_id
        self.row_id = row_id
        self.video_col = video_col

    async def resolve(self, tmp_dir: Path) -> Path:
        import gspread
        from google.oauth2.service_account import Credentials

        creds = Credentials.from_service_account_file(
            os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"],
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
        )
        gc = gspread.authorize(creds)
        sheet = gc.open_by_key(self.sheet_id).sheet1
        records = sheet.get_all_records()
        row = records[int(self.row_id) - 1]
        url = row[self.video_col]
        return await UrlSource(url).resolve(tmp_dir)


class FeishuSheetSource(VideoSource):
    """
    飞书多维表格（Bitable）来源
    app_token: 多维表格的 token
    table_id: 数据表 ID
    record_id: 记录 ID
    field_name: 附件字段名
    """
    def __init__(self, app_token: str, table_id: str, record_id: str, field_name: str = "视频"):
        self.app_token = app_token
        self.table_id = table_id
        self.record_id = record_id
        self.field_name = field_name

    async def resolve(self, tmp_dir: Path) -> Path:
        import httpx

        # 获取飞书访问 token
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                json={
                    "app_id": os.environ["FEISHU_APP_ID"],
                    "app_secret": os.environ["FEISHU_APP_SECRET"],
                },
            )
            token = resp.json()["tenant_access_token"]

            # 获取记录
            resp = await client.get(
                f"https://open.feishu.cn/open-apis/bitable/v1/apps/{self.app_token}"
                f"/tables/{self.table_id}/records/{self.record_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            fields = resp.json()["data"]["record"]["fields"]
            attachments = fields[self.field_name]
            file_token = attachments[0]["file_token"]

            # 下载附件
            resp = await client.get(
                f"https://open.feishu.cn/open-apis/drive/v1/medias/{file_token}/download",
                headers={"Authorization": f"Bearer {token}"},
            )
            filename = attachments[0].get("name", "video.mp4")
            dest = tmp_dir / filename
            with open(dest, "wb") as f:
                f.write(resp.content)

        return dest
