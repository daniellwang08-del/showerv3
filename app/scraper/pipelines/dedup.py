import logging
from scrapy.exceptions import DropItem

from app.scraper.items import JobItem

logger = logging.getLogger(__name__)


class DedupPipeline:
    """In-memory deduplication within a single crawl run using content_hash.

    DB-level dedup (UPSERT) happens in the PostgresPipeline. This pipeline
    avoids sending obviously duplicate items through the rest of the pipeline
    during a single spider run.
    """

    def __init__(self, crawler):
        self.crawler = crawler
        self.seen_hashes: set[str] = set()

    @classmethod
    def from_crawler(cls, crawler):
        return cls(crawler)

    def open_spider(self):
        self.seen_hashes.clear()

    def process_item(self, item: JobItem) -> JobItem:
        if item.content_hash in self.seen_hashes:
            raise DropItem(f"Duplicate within run: {item.source}:{item.source_job_id}")
        self.seen_hashes.add(item.content_hash)
        return item
