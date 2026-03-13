"""Cookie 持久化管理"""
import json
from typing import Optional
from pathlib import Path
from config import SESSIONS_DIR


def session_path(platform: str, account_id: str) -> Path:
    return SESSIONS_DIR / f"{platform}_{account_id}.json"


def save_session(platform: str, account_id: str, storage_state: dict):
    path = session_path(platform, account_id)
    with open(path, "w") as f:
        json.dump(storage_state, f)


def load_session(platform: str, account_id: str) -> Optional[dict]:
    path = session_path(platform, account_id)
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def delete_session(platform: str, account_id: str):
    path = session_path(platform, account_id)
    if path.exists():
        path.unlink()
