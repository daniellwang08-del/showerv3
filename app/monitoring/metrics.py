from prometheus_client import Counter, Histogram, Gauge

EXTRACTION_TOTAL = Counter(
    "extraction_total",
    "Total extraction attempts",
    ["method", "status", "domain"],
)

EXTRACTION_DURATION = Histogram(
    "extraction_duration_seconds",
    "Extraction duration",
    ["method"],
    buckets=[0.5, 1, 2, 5, 10, 30, 60, 120],
)

EXTRACTION_CONFIDENCE = Histogram(
    "extraction_confidence",
    "Extraction confidence scores",
    ["method"],
    buckets=[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
)

BROWSER_POOL_SIZE = Gauge(
    "browser_pool_available",
    "Available browser pool slots",
)

QUEUE_SIZE = Gauge(
    "extraction_queue_size",
    "Pending extraction jobs in queue",
)

AI_API_CALLS = Counter(
    "ai_api_calls_total",
    "Total AI API calls",
    ["status"],
)

AI_API_LATENCY = Histogram(
    "ai_api_latency_seconds",
    "AI API call latency",
    buckets=[0.5, 1, 2, 5, 10, 30],
)


def record_extraction(method: str, status: str, domain: str, duration: float, confidence: float | None = None):
    EXTRACTION_TOTAL.labels(method=method, status=status, domain=domain).inc()
    EXTRACTION_DURATION.labels(method=method).observe(duration)
    if confidence is not None:
        EXTRACTION_CONFIDENCE.labels(method=method).observe(confidence)


def record_ai_call(status: str, latency: float):
    AI_API_CALLS.labels(status=status).inc()
    AI_API_LATENCY.observe(latency)


def update_browser_pool(available: int):
    BROWSER_POOL_SIZE.set(available)


def update_queue_size(size: int):
    QUEUE_SIZE.set(size)
