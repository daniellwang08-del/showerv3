from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid
import jwt
from passlib.context import CryptContext
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Password hashing context
# prefer pbkdf2_sha256 to avoid external bcrypt backend issues and 72-byte limit
pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

class AuthService:
    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a password using bcrypt"""
        # bcrypt has a 72-byte input limit; truncate UTF-8 bytes to 72 bytes
        try:
            b = password.encode("utf-8")
        except Exception:
            b = str(password).encode("utf-8", "ignore")

        if len(b) > 72:
            logger.warning("password_truncated", original_length=len(b))
            # truncate and drop partial multibyte at end
            b = b[:72]
            password = b.decode("utf-8", "ignore")
            logger.info("password_truncated_to", truncated_length=len(password.encode("utf-8")))

        try:
            return pwd_context.hash(password)
        except Exception as e:
            logger.error("password_hash_failed", error=str(e))
            raise

    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        """Verify a password against its hash"""
        # apply same truncation logic used during hashing
        try:
            b = plain_password.encode("utf-8")
        except Exception:
            b = str(plain_password).encode("utf-8", "ignore")

        if len(b) > 72:
            b = b[:72]
            plain_password = b.decode("utf-8", "ignore")

        try:
            return pwd_context.verify(plain_password, hashed_password)
        except Exception as e:
            logger.error("password_verify_failed", error=str(e))
            return False

    @staticmethod
    def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
        settings = get_settings()
        to_encode = data.copy()
        now = datetime.now(timezone.utc)
        if expires_delta:
            expire = now + expires_delta
        else:
            expire = now + timedelta(minutes=1440) # 24 hours default

        # Unique token id so individual tokens can be revoked (logout) without
        # rotating the signing secret (which would invalidate everyone at once).
        to_encode.setdefault("jti", uuid.uuid4().hex)
        # `iat` lets a per-user cutoff (users.sessions_valid_after) revoke every
        # token issued before a password reset or signup rejection.
        to_encode.update({"exp": expire, "iat": int(now.timestamp())})
        encoded_jwt = jwt.encode(to_encode, settings.auth_secret_key, algorithm="HS256")
        return encoded_jwt

    @staticmethod
    def verify_token(token: str) -> Optional[dict]:
        settings = get_settings()
        try:
            payload = jwt.decode(token, settings.auth_secret_key, algorithms=["HS256"])
            return payload
        except jwt.PyJWTError as e:
            logger.debug("token_verify_failed", error=str(e))
            return None
