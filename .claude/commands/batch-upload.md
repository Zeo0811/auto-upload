---
description: Batch upload multiple videos to social platform
---

Use the auto-upload MCP tools to batch upload videos. Follow these steps:

1. Call `login_and_wait` with the platform and account_id
2. Handle QR login if needed (display qr_url to user, poll check_login)
3. Call `batch_upload` with the task list from user input
   - Each task: {"source": {"type": "local", "path": "..."}, "meta": {"title": "...", "description": "...", "tags": [...]}}
4. Report results for each video

$ARGUMENTS
