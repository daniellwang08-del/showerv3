import re

from pydantic import BaseModel, Field, field_validator
from datetime import datetime


def check_password_policy(v: str) -> str:
    """Same rules the signup form shows: 8+ chars with upper, lower, and a digit."""
    if not v or len(v) < 8:
        raise ValueError("Password must be at least 8 characters")
    if not re.search(r"[A-Z]", v) or not re.search(r"[a-z]", v) or not re.search(r"\d", v):
        raise ValueError("Password must include an uppercase letter, a lowercase letter, and a number")
    return v


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
        return check_password_policy(v)


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
    # "pending" means the account exists but waits for admin approval or an
    # access key; the session it carries only reaches /auth/approval*.
    approval_status: str | None = None


class SignupApprovalState(BaseModel):
    email: str
    approval_status: str
    requested_at: datetime


class RedeemAccessKeyRequest(BaseModel):
    key: str = Field(..., min_length=1, max_length=64)


class UserResponse(BaseModel):
    id: str
    email: str
    name: str | None = None
    display_name: str
    is_active: bool
    is_admin: bool = False
    created_at: datetime
    approval_status: str = "approved"
    approved_at: datetime | None = None
    # Subscription snapshot (mirrored from Stripe) so the SPA can gate UI and
    # show billing status without a second request. Defaults keep every other
    # place that builds a UserResponse working unchanged.
    is_subscribed: bool = False
    subscription_plan: str | None = None
    subscription_status: str | None = None
    subscription_current_period_end: datetime | None = None
    subscription_cancel_at_period_end: bool = False


class ProfileUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=100)
