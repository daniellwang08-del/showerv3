import logging
import random

from twisted.internet import defer, reactor as _reactor
from scrapy.downloadermiddlewares.retry import RetryMiddleware
from scrapy.utils.response import response_status_message

logger = logging.getLogger(__name__)

BAN_INDICATORS = [
    "access denied",
    "captcha",
    "blocked",
    "rate limit",
    "too many requests",
    "please verify",
    "unusual traffic",
    "are you a robot",
    "security check",
]


class SmartRetryMiddleware(RetryMiddleware):
    """Extends the default retry middleware with ban detection and async
    exponential backoff.

    IMPORTANT: the backoff delay is implemented with Twisted's
    ``reactor.callLater`` instead of the blocking ``time.sleep``.
    Using ``time.sleep`` inside Scrapy's Twisted reactor freezes the
    *entire* spider — no other requests can be made or processed while
    the sleep is running.  ``callLater`` schedules the delayed retry on
    the event loop without blocking anything else.
    """

    def process_response(self, request, response, spider):
        if response.status in self.retry_http_codes:
            reason = response_status_message(response.status)
            delay = self._backoff_delay(request)
            spider.logger.warning(
                "Got %s from %s — retrying in %.1fs",
                response.status,
                request.url,
                delay,
            )
            retried = self._retry(request, reason)
            if retried is None:
                # dont_retry=True or retries exhausted — pass through as-is
                return response
            # Non-blocking async delay via Twisted reactor
            d: defer.Deferred = defer.Deferred()
            _reactor.callLater(delay, d.callback, retried)
            return d

        if response.status == 200 and self._looks_like_ban(response):
            spider.logger.warning(
                "Ban pattern detected on %s (200 response but suspicious body)",
                request.url,
            )
            return self._retry(request, "ban_detected") or response

        return response

    def _looks_like_ban(self, response) -> bool:
        try:
            body = response.text[:2000].lower()
        except AttributeError:
            return False
        return any(indicator in body for indicator in BAN_INDICATORS)

    def _backoff_delay(self, request) -> float:
        retry_count = request.meta.get("retry_times", 0)
        base = 2 ** retry_count
        jitter = random.uniform(0, base * 0.5)
        return min(base + jitter, 60.0)
