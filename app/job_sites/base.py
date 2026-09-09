"""Plugin contract for user-connectable job sites."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Awaitable, Callable

from app.services.job_source_boards import BoardJob


class AuthType(StrEnum):
    """How a user connects this site."""

    NONE = "none"  # public feed — enabling the tile is enough
    API_KEY = "api_key"  # user pastes a developer / publisher key
    ACCOUNT = "account"  # email/password or pasted session material (no extension)
    UNAVAILABLE = "unavailable"  # researched; no legitimate user-login fetch path


@dataclass(frozen=True)
class CredentialField:
    key: str
    label: str
    placeholder: str = ""
    help_url: str = ""
    secret: bool = True


@dataclass(frozen=True)
class FetchContext:
    user_email: str = ""
    country_codes: tuple[str, ...] = ()
    max_jobs: int = 40

    @property
    def primary_country(self) -> str:
        return (self.country_codes[0] if self.country_codes else "US").upper()


FetchFn = Callable[[dict[str, Any], FetchContext], Awaitable[list[BoardJob]]]


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
    fetch: FetchFn | None = None

    @property
    def connectable(self) -> bool:
        return self.auth_type != AuthType.UNAVAILABLE

    def catalog_dict(self) -> dict[str, Any]:
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
            "credential_fields": [
                {
                    "key": f.key,
                    "label": f.label,
                    "placeholder": f.placeholder,
                    "help_url": f.help_url or None,
                    "secret": f.secret,
                }
                for f in self.credential_fields
            ],
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
