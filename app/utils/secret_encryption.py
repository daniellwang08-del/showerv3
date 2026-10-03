"""Encrypt/decrypt user-provided secrets at rest (e.g. custom OpenAI API keys)."""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_fernet: Fernet | None = None


_DEV_FALLBACK_SEED = "dev-insecure-settings-key"


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        settings = get_settings()
        # Prefer a dedicated encryption key; fall back to the JWT secret for
        # back-compat with existing installs that only set AUTH_SECRET_KEY.
        raw = (settings.settings_encryption_key or settings.auth_secret_key or "").strip()
        if not raw:
            is_production = settings.app_env.strip().lower() in ("production", "prod")
            if is_production:
                # Never silently encrypt production secrets with a public,
                # source-code-embedded key, that is equivalent to plaintext.
                raise RuntimeError(
                    "SETTINGS_ENCRYPTION_KEY or AUTH_SECRET_KEY must be set in production; "
                    "refusing to encrypt user secrets with the insecure development fallback."
                )
            logger.warning(
                "secret_encryption_dev_fallback_key",
                detail="No SETTINGS_ENCRYPTION_KEY/AUTH_SECRET_KEY set; using insecure dev key. "
                "Do NOT use this outside local development.",
            )
            raw = _DEV_FALLBACK_SEED
        key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest())
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
