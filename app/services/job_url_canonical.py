"""Map an application or login URL to the page that carries the description.

Users and job boards often hand over the "apply" step of a posting
(``jobs.lever.co/acme/<id>/apply``, SmartRecruiters one-click, iCIMS
``/login``). Those pages are forms or auth walls, while the same ATS serves the
full description one step back. Extraction fetches the description URL; the
job keeps its original link for applying.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

_SMARTRECRUITERS_ONECLICK = re.compile(
    rf"^/oneclick-ui/company/([^/]+)/publication/({_UUID})", re.I
)
# MyGreenhouse (the candidate-account site) wraps a public board posting
# behind a sign-in wall: my.greenhouse.io/jobs/{board}/{job id}.
_MY_GREENHOUSE_JOB = re.compile(r"^/jobs/([A-Za-z0-9_-]+)/(\d+)/?$")
_ICIMS_JOB = re.compile(r"^(/jobs/\d+/[^/]+)(?:/(?:job|login|apply|candidate)\b.*)?$", re.I)
_WORKDAY_APPLY = re.compile(r"^(.*/job/.+?)/apply(?:/.*)?$", re.I)
_TRAILING_APPLY = re.compile(r"^(.+?)/(?:apply|application|applynow|apply-now)/?$", re.I)

# Hosts whose apply path is the posting page itself, or whose first path
# segment is "apply" by design (JazzHR: /apply/<id>/<slug>).
_KEEP_HOSTS = ("applytojob.com", "recruitcrm.io", "proxify.io")


def _with_path(parsed, path: str, query: str | None = None) -> str:
    return urlunparse(parsed._replace(path=path, query=parsed.query if query is None else query))


def description_url(url: str | None) -> str:
    """The URL to fetch for *url*'s job description (unchanged when already one)."""
    if not url:
        return url or ""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return url
    host = (parsed.netloc or "").lower()
    path = parsed.path or ""
    if not host or any(host == h or host.endswith("." + h) for h in _KEEP_HOSTS):
        return url

    if host == "jobs.smartrecruiters.com":
        m = _SMARTRECRUITERS_ONECLICK.match(path)
        if m:
            return urlunparse(("https", host, f"/{m.group(1)}/{m.group(2)}", "", "", ""))
        return url

    if host == "my.greenhouse.io":
        m = _MY_GREENHOUSE_JOB.match(path)
        if m:
            return urlunparse(("https", "job-boards.greenhouse.io", f"/{m.group(1)}/jobs/{m.group(2)}", "", "", ""))
        return url

    if host.endswith("builtin.com") and path.lower().startswith("/apply/job/"):
        return _with_path(parsed, path[len("/apply"):])

    if host.endswith(".icims.com"):
        m = _ICIMS_JOB.match(path)
        if m:
            query = dict(parse_qsl(parsed.query, keep_blank_values=True))
            query.pop("mobile", None)
            query.pop("needsRedirect", None)
            query["in_iframe"] = "1"
            return _with_path(parsed, f"{m.group(1)}/job", urlencode(query))
        return url

    if "myworkdayjobs.com" in host:
        m = _WORKDAY_APPLY.match(path)
        return _with_path(parsed, m.group(1)) if m else url

    m = _TRAILING_APPLY.match(path)
    if m and m.group(1).strip("/").count("/") >= 1:
        return _with_path(parsed, m.group(1))
    return url
