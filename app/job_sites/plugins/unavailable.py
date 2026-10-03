"""Major boards that cannot be connected via user login or a public job-seeker API."""

from __future__ import annotations

from app.job_sites.base import AuthType, JobSitePlugin
from app.job_sites.registry import register


def _unavailable(
    *,
    slug: str,
    name: str,
    blurb: str,
    homepage: str,
    reason: str,
    logo_file: str,
    sort_order: int,
) -> None:
    register(
        JobSitePlugin(
            slug=slug,
            name=name,
            blurb=blurb,
            homepage=homepage,
            auth_type=AuthType.UNAVAILABLE,
            logo_file=logo_file,
            sort_order=sort_order,
            unavailable_reason=reason,
        )
    )


_unavailable(
    slug="linkedin",
    name="LinkedIn",
    blurb="LinkedIn Jobs is not available as a user login for third-party apps.",
    homepage="https://www.linkedin.com/jobs/",
    logo_file="linkedin.svg",
    sort_order=200,
    reason=(
        "LinkedIn does not offer a job-seeker search API. Individual OAuth cannot "
        "list jobs, and using account cookies to scrape LinkedIn violates their terms. "
        "Connect JSearch if you need aggregated LinkedIn-sourced listings via RapidAPI."
    ),
)

_unavailable(
    slug="indeed",
    name="Indeed",
    blurb="Indeed's APIs are for employer/ATS partners, not job seekers.",
    homepage="https://www.indeed.com/",
    logo_file="indeed.svg",
    sort_order=210,
    reason=(
        "Indeed Job Sync / Job Update APIs are for approved ATS and employer partners "
        "posting jobs to Indeed, they cannot pull your Indeed job feed. Connect JSearch "
        "for aggregated Indeed-sourced listings, or Adzuna for a first-party search API."
    ),
)

_unavailable(
    slug="glassdoor",
    name="Glassdoor",
    blurb="Glassdoor has no public job-search API for individuals.",
    homepage="https://www.glassdoor.com/",
    logo_file="glassdoor.svg",
    sort_order=220,
    reason=(
        "Glassdoor does not publish a job-seeker API, and signing in with your password "
        "or cookies to scrape listings is not permitted. Use JSearch for aggregated "
        "Glassdoor-sourced openings."
    ),
)

_unavailable(
    slug="wellfound",
    name="Wellfound",
    blurb="AngelList / Wellfound has no public jobs API.",
    homepage="https://wellfound.com/",
    logo_file="wellfound.svg",
    sort_order=230,
    reason=(
        "Wellfound (AngelList Talent) does not offer a supported job-list API for "
        "personal accounts. Session scraping of their GraphQL app is unofficial and brittle."
    ),
)

_unavailable(
    slug="otta",
    name="Otta",
    blurb="Otta does not expose a jobs API for connected accounts.",
    homepage="https://otta.com/",
    logo_file="otta.svg",
    sort_order=240,
    reason=(
        "Otta has no public or partner job-search API for individuals. Personalized "
        "matches stay inside their product."
    ),
)

_unavailable(
    slug="handshake",
    name="Handshake",
    blurb="Handshake is university SSO only, no third-party job fetch.",
    homepage="https://joinhandshake.com/",
    logo_file="handshake.svg",
    sort_order=250,
    reason=(
        "Handshake jobs are gated by university single sign-on. There is no API that "
        "lets a personal account export listings into another product."
    ),
)
