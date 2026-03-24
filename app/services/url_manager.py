from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
import tldextract
import hashlib
import re
from app.core.logging import get_logger

logger = get_logger(__name__)

TRACKING_PARAMS = frozenset({
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid",
    "msclkid", "twclid", "igshid", "mc_cid", "mc_eid",
    "ref", "ref_", "_ref", "source", "src",
    "gh_src",
    "tracking_id", "track", "trk", "trkid",
    "affiliate", "aff_id", "partner",
    "session_id", "sid", "_ga", "_gl",
})

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

# Subdomains that map to the same job board root (for canonical key)
JOB_BOARD_ROOT_DOMAINS = {
    "jobs.ashbyhq.com": "ashbyhq.com",
    "ashbyhq.com": "ashbyhq.com",
    "jobs.greenhouse.io": "greenhouse.io",
    "job-boards.greenhouse.io": "greenhouse.io",
    "greenhouse.io": "greenhouse.io",
    "jobs.lever.co": "lever.co",
    "lever.co": "lever.co",
}


class URLManager:
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
    def normalize_url(url: str) -> str:
        parsed = urlparse(url.strip())

        scheme = parsed.scheme.lower()
        netloc = parsed.netloc.lower()

        if netloc.startswith("www."):
            netloc = netloc[4:]

        path = parsed.path.rstrip("/") or "/"

        # AshbyHQ canonicalization:
        # Job pages can appear as /<company>/<uuid> and /<company>/<uuid>/application.
        # Treat both as the same job by stripping the trailing /application.
        if netloc.endswith("ashbyhq.com"):
            if re.search(r"/[a-z0-9_-]+/[a-f0-9-]{36}/application$", path, re.IGNORECASE):
                path = re.sub(r"/application$", "", path, flags=re.IGNORECASE)

        # Greenhouse canonicalization (jobs.greenhouse.io, job-boards.greenhouse.io):
        # Canonical path is /<company>/jobs/<id>. Any extra path segments after the job ID are irrelevant.
        if "greenhouse.io" in netloc:
            gh_match = re.search(r"^(/.+?/jobs/\d+)", path)
            if gh_match:
                path = gh_match.group(1)

        query_params = parse_qs(parsed.query, keep_blank_values=False)
        filtered_params = {}
        for k, v in query_params.items():
            lower_k = k.lower()

            # Always drop known tracking parameters
            if lower_k in TRACKING_PARAMS:
                continue

            # Greenhouse: gh_jid can be an identifier when the job id is NOT in the path.
            # Only drop it when the path already contains /jobs/<id>.
            if lower_k == "gh_jid" and re.search(r"/jobs/\d+", path):
                continue

            filtered_params[k] = v
        sorted_params = sorted(filtered_params.items())
        query = urlencode(sorted_params, doseq=True) if sorted_params else ""

        normalized = urlunparse((scheme, netloc, path, "", query, ""))
        return normalized

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
    def generate_url_hash(normalized_url: str) -> str:
        return hashlib.sha256(normalized_url.encode()).hexdigest()[:32]

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
        """
        Extract a canonical (board_domain, job_id) for known job boards.
        Returns (root_domain, job_id) or (None, None) if not identifiable.
        Used for strong duplicate detection: same job_id on same board = duplicate.
        """
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
