"""RemoteRocketship search links (the site's /remote-jobs/ URL) as API filters.

The website and both APIs (the OpenClaw Jobs API and the site's internal
``/api/fetch_job_openings/``) share filter names and values, so a link copied
from the browser address bar reproduces the same search when syncing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import parse_qs, unquote, urlsplit

SEARCH_HOSTS = frozenset({"remoterocketship.com", "www.remoterocketship.com"})

SENIORITY_VALUES = frozenset({"entry-level", "junior", "mid", "senior", "expert"})
EMPLOYMENT_TYPE_VALUES = frozenset({"full-time", "part-time", "contract", "internship"})

# The default admin sync search (mirrors the operator's saved site search).
DEFAULT_JOB_TITLES: tuple[str, ...] = (
    "AI Engineer",
    "Application Engineer",
    "Backend Engineer",
    "Cloud Engineer",
    "Data Engineer",
    "Full-stack Engineer",
    "Frontend Engineer",
    "Infrastructure Engineer",
    "LLM Engineer",
    "Machine Learning Engineer",
    "Platform Engineer",
    "Software Engineer",
)
DEFAULT_LOCATIONS: tuple[str, ...] = ("United States",)
DEFAULT_MIN_SALARY = 120000
DEFAULT_SENIORITY: tuple[str, ...] = ("mid",)
DEFAULT_EMPLOYMENT_TYPES: tuple[str, ...] = ("full-time", "contract")

_IGNORED_PARAMS = frozenset({"page", "sort"})


class SearchLinkError(ValueError):
    """The pasted link is not a RemoteRocketship job search."""


@dataclass
class RemoteRocketshipSearch:
    job_titles: list[str] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)
    seniority: list[str] = field(default_factory=list)
    employment_types: list[str] = field(default_factory=list)
    min_salary: int = 0
    ignored_params: list[str] = field(default_factory=list)

    def api_filters(self) -> dict:
        """Filter keys shared by both RemoteRocketship APIs (empty lists mean "any")."""
        filters: dict = {
            "jobTitleFilters": list(self.job_titles),
            "locationFilters": list(self.locations),
            "seniorityFilters": list(self.seniority),
            "employmentTypeFilters": list(self.employment_types),
        }
        if self.min_salary > 0:
            filters["minSalaryFilter"] = self.min_salary
        return filters


def default_search() -> RemoteRocketshipSearch:
    return RemoteRocketshipSearch(
        job_titles=list(DEFAULT_JOB_TITLES),
        locations=list(DEFAULT_LOCATIONS),
        seniority=list(DEFAULT_SENIORITY),
        employment_types=list(DEFAULT_EMPLOYMENT_TYPES),
        min_salary=DEFAULT_MIN_SALARY,
    )


def _split_values(raw: str) -> list[str]:
    """Comma list where each item may be encoded again (``AI%2520Engineer``)."""
    out: list[str] = []
    for part in raw.split(","):
        value = part
        for _ in range(3):
            decoded = unquote(value)
            if decoded == value:
                break
            value = decoded
        value = " ".join(value.split())
        if value and value not in out:
            out.append(value)
    return out


def parse_search_link(link: str) -> RemoteRocketshipSearch:
    text = (link or "").strip()
    if not text:
        raise SearchLinkError("Paste a RemoteRocketship search link.")
    if "://" not in text:
        text = "https://" + text
    parts = urlsplit(text)
    if (parts.hostname or "").lower() not in SEARCH_HOSTS:
        raise SearchLinkError("The search link must be a remoterocketship.com address.")

    search = RemoteRocketshipSearch()
    for name, values in parse_qs(parts.query).items():
        raw = ",".join(values)
        if name == "jobTitle":
            search.job_titles = _split_values(raw)
        elif name == "locations":
            search.locations = _split_values(raw)
        elif name == "seniority":
            search.seniority = [v.lower() for v in _split_values(raw) if v.lower() in SENIORITY_VALUES]
        elif name == "employmentType":
            search.employment_types = [
                v.lower() for v in _split_values(raw) if v.lower() in EMPLOYMENT_TYPE_VALUES
            ]
        elif name == "minSalary":
            digits = "".join(ch for ch in raw if ch.isdigit())
            search.min_salary = int(digits) if digits else 0
        elif name not in _IGNORED_PARAMS:
            search.ignored_params.append(name)
    return search
