---
description: Manage published content (list/edit/delete)
---

Use the auto-upload MCP tools to manage content. Follow these steps based on user intent:

## List content
- Call `list_posts(platform, account_id, status_filter)`
- status_filter: "" (all), "published", "scheduled", "draft"
- Display results in a table format

## Edit content
- First call `list_posts` to show available content
- Then call `edit_post(platform, account_id, post_id, meta)` with only the fields to change
- meta fields: title, description, tags, cover_path, publish_time

## Delete content
- `delete_post(platform, account_id, post_id)` for single delete
- `delete_batch(platform, account_id, post_ids)` for multiple
- `delete_all_posts(platform, account_id)` for all - ALWAYS confirm with user first

$ARGUMENTS
