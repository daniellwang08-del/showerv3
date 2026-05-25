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

    def __init__(self):
        self.seen_hashes: set[str] = set()

    def open_spider(self, spider):
        self.seen_hashes.clear()

    def process_item(self, item: JobItem, spider) -> JobItem:
        if item.content_hash in self.seen_hashes:
            raise DropItem(f"Duplicate within run: {item.source}:{item.source_job_id}")
        self.seen_hashes.add(item.content_hash)
        return item
