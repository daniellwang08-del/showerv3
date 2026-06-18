from pydantic import BaseModel, Field, field_validator
from datetime import datetime


class SignupRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=255)
    password: str = Field(..., min_length=8, max_length=255)
    
    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        # Only validate format; normalization (lowercasing, stripping) is done in endpoints
        if not v or "@" not in v or "." not in v:
            raise ValueError("Invalid email format")
        return v
    
    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        # Only validate; do not transform
        if not v or len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=255)
    password: str = Field(..., min_length=8, max_length=255)
    # Non-cookie clients (e.g. the browser extension) set this to receive a
    # long-lived bearer token so the user stays signed in across restarts.
    long_lived: bool = Field(default=False)

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        # Only validate format; normalization (lowercasing, stripping) is done in endpoints
        if not v or "@" not in v or "." not in v:
            raise ValueError("Invalid email format")
        return v


class AuthResponse(BaseModel):
    success: bool
    message: str
    email: str | None = None
    user_id: str | None = None
    # Bearer token for non-cookie clients (e.g. browser extension). The web app
    # ignores this and relies on the HttpOnly access_token cookie instead.
    access_token: str | None = None
    token_type: str | None = None
    expires_in: int | None = None


class UserResponse(BaseModel):
    id: str
    email: str
    name: str | None = None
    display_name: str
    is_active: bool
    created_at: datetime


class ProfileUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=100)
