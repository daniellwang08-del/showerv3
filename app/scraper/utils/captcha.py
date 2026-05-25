"""CAPTCHA detection utilities.

Since we use only free/open-source tools, we detect CAPTCHAs and log them
rather than attempting to solve them. The spider can then skip or retry.
"""

import logging
import re

logger = logging.getLogger(__name__)

CAPTCHA_PATTERNS = [
    re.compile(r"captcha", re.IGNORECASE),
    re.compile(r"recaptcha", re.IGNORECASE),
    re.compile(r"hcaptcha", re.IGNORECASE),
    re.compile(r"cf-turnstile", re.IGNORECASE),
    re.compile(r"challenge-platform", re.IGNORECASE),
    re.compile(r"verify.*human", re.IGNORECASE),
    re.compile(r"are you a robot", re.IGNORECASE),
    re.compile(r"unusual traffic", re.IGNORECASE),
    re.compile(r"security check", re.IGNORECASE),
]

CAPTCHA_URLS = [
    "challenges.cloudflare.com",
    "google.com/recaptcha",
    "hcaptcha.com",
    "arkoselabs.com",
]


def detect_captcha(response) -> bool:
    """Check if a Scrapy response contains a CAPTCHA challenge."""
    body = response.text[:5000]

    for pattern in CAPTCHA_PATTERNS:
        if pattern.search(body):
            logger.warning("CAPTCHA detected on %s (pattern: %s)", response.url, pattern.pattern)
            return True

    for captcha_url in CAPTCHA_URLS:
        if captcha_url in body:
            logger.warning("CAPTCHA service detected on %s (%s)", response.url, captcha_url)
            return True

    return False


def detect_cloudflare_challenge(response) -> bool:
    """Specifically detect Cloudflare challenge pages."""
    if response.status == 403:
        server = response.headers.get(b"server", b"").decode(errors="ignore").lower()
        if "cloudflare" in server:
            return True
    body = response.text[:3000]
    return "cf-browser-verification" in body or "challenge-platform" in body
