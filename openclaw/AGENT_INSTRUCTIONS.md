# OpenClaw Agent Instructions

把 `auto-upload` 作为 MCP 工具使用时，遵守下面约定：

## 登录二维码

1. 调用 `login_and_wait(platform, account_id)`。
2. 如果返回 `{"status": "ok"}`，直接继续后续上传。
3. 如果返回 `{"status": "qr_required"}`：
   - 先把 `channel_message` 原样发回当前用户所在会话。
   - 如果当前渠道支持发图片，并且存在 `channel_image_data_url`，再把该二维码图片一并发送。
   - 如果渠道不支持图片，至少把 `qr_url` 发给用户。
4. 之后轮询 `check_login(platform, account_id)`，直到 `status == "confirmed"`。

## 上传流程

优先使用 `upload_and_wait`，减少 tool call 轮次。

## 管理流程

- 查询：`list_posts`
- 编辑：`edit_post`
- 删除：`delete_post`

## 当前渠道约定

- 微信 / 企业微信 / 飞书：优先发文字 + 二维码图片
- 如果图片发送失败：退化为只发 `qr_url`
