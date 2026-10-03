from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
import tldextract
import hashlib
import re
from app.core.logging import get_logger

logger = get_logger(__name__)

JOB_BOARD_PATTERNS = {
    "greenhouse.io": re.compile(r"/jobs/(\d+)"),
    "jobs.greenhouse.io": re.compile(r"/jobs/(\d+)"),
    "job-boards.greenhouse.io": re.compile(r"/jobs/(\d+)"),
    "lever.co": re.compile(r"/([a-f0-9-]{8,})$"),
    "jobs.lever.co": re.compile(r"/([a-f0-9-]{8,})$"),
    "workday.com": re.compile(r"/job/([^/?]+)"),
    "myworkdayjobs.com": re.compile(r"/job/([^/?]+)"),
    "jobvite.com": re.compile(r"/job/([^/]+)"),
    "icims.com": re.compile(r"/jobs/(\d+)"),
    "smartrecruiters.com": re.compile(r"/([^/]+/[^/]+)$"),
    "ashbyhq.com": re.compile(r"/(?:[a-z0-9_-]+/)?([a-f0-9-]{36})(?:/application)?$", re.IGNORECASE),
    "jobs.ashbyhq.com": re.compile(r"/(?:[a-z0-9_-]+/)?([a-f0-9-]{36})(?:/application)?$", re.IGNORECASE),
    "applytojob.com": re.compile(r"/([a-zA-Z0-9_-]+)$"),
    "breezy.hr": re.compile(r"/position/([a-f0-9-]+)"),
    "bamboohr.com": re.compile(r"/jobs/(\d+)"),
    "recruitee.com": re.compile(r"/o/([^/]+)/jobs/([^/?]+)"),
    "workable.com": re.compile(r"/jobs/([a-f0-9]+)"),
}

JOB_BOARD_ROOT_DOMAINS = {
    "jobs.ashbyhq.com": "ashbyhq.com",
    "ashbyhq.com": "ashbyhq.com",
    "jobs.greenhouse.io": "greenhouse.io",
    "job-boards.greenhouse.io": "greenhouse.io",
    "greenhouse.io": "greenhouse.io",
    "jobs.lever.co": "lever.co",
    "lever.co": "lever.co",
}


# Query keys that only track the click, never select the posting.
_TRACKING_PARAMS = frozenset({
    "gh_src", "lever-source", "lever-origin", "lever-via", "trk", "trkinfo",
    "fbclid", "gclid", "msclkid", "dclid", "mc_cid", "mc_eid", "ref", "referrer",
    "src", "source", "sourcetype", "_hsenc", "_hsmi", "hs_ref", "igshid",
    "yclid", "rx_campaign", "rx_source", "rx_medium", "jobpipeline", "codes",
})


_HOST_ALIAS_GROUPS = (
    ("boards.greenhouse.io", "job-boards.greenhouse.io"),
    ("boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io"),
)
_HOST_ALIASES = {
    host: tuple(h for h in group if h != host)
    for group in _HOST_ALIAS_GROUPS
    for host in group
}


class URLManager:
    @staticmethod
    def normalize_url(url: str) -> str:
        """Stable dedup key for a posting URL.

        Lowercases scheme and host, drops the fragment, tracking query keys
        (``utm_*`` and friends) and a trailing slash, and sorts what is left.
        Path case is kept: some ATS ids are case sensitive.
        """
        raw = (url or "").strip()
        try:
            p = urlparse(raw)
        except Exception:
            return raw
        if not p.scheme or not p.netloc:
            return raw
        query = sorted(
            (k, v)
            for k, v in parse_qsl(p.query, keep_blank_values=True)
            if not k.lower().startswith("utm_") and k.lower() not in _TRACKING_PARAMS
        )
        path = p.path or "/"
        if len(path) > 1:
            path = path.rstrip("/") or "/"
        return urlunparse((
            p.scheme.lower(), p.netloc.lower(), path, "", urlencode(query, doseq=True), "",
        ))

    @staticmethod
    def equivalent_normalized_urls(url: str) -> list[str]:
        """``normalize_url(url)`` plus the same posting on its alias hosts.

        Greenhouse serves one posting from both ``boards.`` and ``job-boards.``
        hosts and redirects between them, so either form must find the stored job.
        """
        normalized = URLManager.normalize_url(url)
        p = urlparse(normalized)
        aliases = _HOST_ALIASES.get(p.netloc)
        if not aliases:
            return [normalized]
        return [normalized] + [urlunparse(p._replace(netloc=host)) for host in aliases]

    @staticmethod
    def validate_url(url: str) -> tuple[bool, str | None]:
        try:
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                logger.debug("url_validation_failed", url=url, reason="invalid_scheme")
                return False, "Invalid URL scheme"
            if not parsed.netloc:
                logger.debug("url_validation_failed", url=url, reason="missing_domain")
                return False, "Missing domain"
            return True, None
        except Exception as e:
            logger.debug("url_validation_error", url=url, error=str(e))
            return False, str(e)

    @staticmethod
    def extract_domain(url: str) -> str:
        extracted = tldextract.extract(url)
        if extracted.subdomain and extracted.subdomain != "www":
            return f"{extracted.subdomain}.{extracted.domain}.{extracted.suffix}"
        return f"{extracted.domain}.{extracted.suffix}"

    @staticmethod
    def extract_root_domain(url: str) -> str:
        extracted = tldextract.extract(url)
        return f"{extracted.domain}.{extracted.suffix}"

    @staticmethod
    def generate_url_hash(url: str) -> str:
        return hashlib.sha256(url.encode()).hexdigest()[:32]

    @staticmethod
    def detect_job_board(url: str) -> tuple[str | None, str | None]:
        domain = URLManager.extract_domain(url)
        parsed = urlparse(url)

        for board_domain, pattern in JOB_BOARD_PATTERNS.items():
            if board_domain in domain:
                match = pattern.search(parsed.path)
                if match:
                    return board_domain, match.group(1)
        return None, None

    @staticmethod
    def get_canonical_job_key(url: str) -> tuple[str | None, str | None]:
        parsed = urlparse(url.strip().lower())
        netloc = parsed.netloc
        if netloc.startswith("www."):
            netloc = netloc[4:]
        path = parsed.path or "/"

        for board_domain, pattern in JOB_BOARD_PATTERNS.items():
            if board_domain in netloc:
                match = pattern.search(path)
                if match:
                    job_id = match.group(1).lower().strip()
                    if len(match.groups()) == 2:
                        job_id = f"{match.group(1)}/{match.group(2)}".lower()
                    root = JOB_BOARD_ROOT_DOMAINS.get(board_domain) or board_domain
                    return root, job_id
        return None, None

    @staticmethod
    def is_job_url(url: str) -> bool:
        job_indicators = [
            "/job/", "/jobs/", "/career/", "/careers/",
            "/position/", "/positions/", "/opening/", "/openings/",
            "/vacancy/", "/vacancies/", "/apply/", "/hiring/",
        ]
        path = urlparse(url).path.lower()
        return any(indicator in path for indicator in job_indicators)
