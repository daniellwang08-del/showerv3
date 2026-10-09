"""Plugin contract for user-connectable job sites."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Awaitable, Callable

from app.services.job_source_boards import BoardJob


class AuthType(StrEnum):
    """How a user connects this site."""

    NONE = "none"  # public feed, enabling the tile is enough
    API_KEY = "api_key"  # user pastes a developer / publisher key
    ACCOUNT = "account"  # browser session captured by the extension (no passwords)
    UNAVAILABLE = "unavailable"  # researched; no legitimate user-login fetch path


@dataclass(frozen=True)
class CredentialField:
    key: str
    label: str
    placeholder: str = ""
    help_url: str = ""
    secret: bool = True
    required: bool = True
    help_text: str = ""


@dataclass(frozen=True)
class FetchContext:
    user_email: str = ""
    country_codes: tuple[str, ...] = ()
    max_jobs: int = 40

    @property
    def primary_country(self) -> str:
        return (self.country_codes[0] if self.country_codes else "US").upper()


FetchFn = Callable[[dict[str, Any], FetchContext], Awaitable[list[BoardJob]]]


@dataclass(frozen=True)
class SessionCapture:
    """Browser-session connect: the extension opens the board in a real tab and watches where it lands.

    The extension opens ``start_url`` and tracks navigation until it settles.
    The board's own redirect is the login test: an authenticated Jobright user
    asking for ``https://jobright.ai/`` is sent to ``/jobs/recommend``, which
    matches ``signed_in_url_patterns``. A signed-out user stays on the landing
    or login page instead.

    ``verify_url`` is the protected page we re-open once when the landing URL
    is inconclusive but session cookies already exist.
    """

    cookie_domains: tuple[str, ...]
    start_url: str = ""
    verify_url: str = ""
    signed_in_url_patterns: tuple[str, ...] = ()
    logged_out_url_patterns: tuple[str, ...] = ()
    session_cookie_names: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "cookie_domains": list(self.cookie_domains),
            "start_url": self.start_url,
            "verify_url": self.verify_url or self.start_url,
            "signed_in_url_patterns": list(self.signed_in_url_patterns),
            "logged_out_url_patterns": list(self.logged_out_url_patterns),
            "session_cookie_names": list(self.session_cookie_names),
        }


@dataclass
class JobSitePlugin:
    slug: str
    name: str
    blurb: str
    homepage: str
    auth_type: AuthType
    logo_file: str
    sort_order: int = 100
    signup_url: str = ""
    login_url: str = ""
    credential_fields: tuple[CredentialField, ...] = ()
    unavailable_reason: str = ""
    session_capture: SessionCapture | None = None
    fetch: FetchFn | None = None
    # Minimum hours between syncs; set from the board's published polling rules.
    min_sync_hours: float = 6.0
    # Requests a key may ever make (Jooble free keys: 500). 0 means no cap.
    lifetime_request_cap: int = 0

    @property
    def connectable(self) -> bool:
        return self.auth_type != AuthType.UNAVAILABLE

    def catalog_dict(self) -> dict[str, Any]:
        capture = self.session_capture
        start_url = ""
        if capture and capture.start_url:
            start_url = capture.start_url
        elif self.login_url:
            start_url = self.login_url
        return {
            "slug": self.slug,
            "name": self.name,
            "blurb": self.blurb,
            "homepage": self.homepage,
            "signup_url": self.signup_url or None,
            "login_url": self.login_url or None,
            "auth_type": str(self.auth_type),
            "connectable": self.connectable,
            "unavailable_reason": self.unavailable_reason or None,
            "logo_src": f"/integrations/job-sites/{self.logo_file}",
            "sort_order": self.sort_order,
            "min_sync_hours": self.min_sync_hours,
            "lifetime_request_cap": self.lifetime_request_cap or None,
            "credential_fields": [
                {
                    "key": f.key,
                    "label": f.label,
                    "placeholder": f.placeholder,
                    "help_url": f.help_url or None,
                    "secret": f.secret,
                    "required": f.required,
                    "help_text": f.help_text or None,
                }
                for f in self.credential_fields
            ],
            "session_capture": (
                {
                    **capture.as_dict(),
                    "start_url": start_url or capture.start_url,
                }
                if capture
                else None
            ),
        }


COUNTRY_TO_ADZUNA = {
    "US": "us",
    "GB": "gb",
    "UK": "gb",
    "CA": "ca",
    "AU": "au",
    "DE": "de",
    "FR": "fr",
    "NL": "nl",
    "AT": "at",
    "BE": "be",
    "CH": "ch",
    "ES": "es",
    "IT": "it",
    "IN": "in",
    "SG": "sg",
    "NZ": "nz",
    "PL": "pl",
    "BR": "br",
    "MX": "mx",
    "ZA": "za",
    "IE": "ie",
}

COUNTRY_NAMES = {
    "US": "United States",
    "GB": "United Kingdom",
    "UK": "United Kingdom",
    "CA": "Canada",
    "AU": "Australia",
    "DE": "Germany",
    "FR": "France",
    "NL": "Netherlands",
    "IN": "India",
    "SG": "Singapore",
    "IE": "Ireland",
    "NZ": "New Zealand",
}


def adzuna_country_path(country_code: str) -> str:
    return COUNTRY_TO_ADZUNA.get((country_code or "US").upper(), "us")
