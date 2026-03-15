---
description: Upload video to social platform (xiaohongshu/channels/douyin)
---

Use the auto-upload MCP tools to upload a video. Follow these steps:

1. Call `login_and_wait` with the platform and account_id from user input (default account_id: "test")
2. If status is "qr_required":
   - Tell the user to scan the QR code at the URL: the `qr_url` field (e.g. http://127.0.0.1:7788/qr/test)
   - Then poll `check_login` every 3 seconds until status is "confirmed"
3. Once logged in, call `upload_and_wait` with:
   - platform, account_id
   - source: {"type": "local", "path": "<video_path from user>"}
   - meta: {"title": "<title>", "description": "<desc>", "tags": [<tags>]}
   - Fill in title/description/tags from user input
4. Report the result (post_url on success, error on failure)

If user provides cover image path, include "cover_path" in meta.
If user wants scheduled publish, include "publish_time": "YYYY-MM-DD HH:MM" in meta.

$ARGUMENTS
