"""Encrypt/decrypt user-provided secrets at rest (e.g. custom OpenAI API keys)."""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        settings = get_settings()
        seed = (settings.auth_secret_key or "dev-insecure-settings-key").encode("utf-8")
        key = base64.urlsafe_b64encode(hashlib.sha256(seed).digest())
        _fernet = Fernet(key)
    return _fernet


def encrypt_secret(plain: str) -> str:
    token = _get_fernet().encrypt(plain.strip().encode("utf-8"))
    return token.decode("ascii")


def decrypt_secret(token: str) -> str:
    try:
        return _get_fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        logger.warning("secret_decrypt_failed")
        raise ValueError("Stored secret could not be decrypted") from e


def mask_api_key(key: str | None) -> str | None:
    if not key:
        return None
    k = key.strip()
    if len(k) <= 8:
        return "••••••••"
    return f"{k[:3]}…{k[-4:]}"
