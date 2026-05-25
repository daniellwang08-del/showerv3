import logging

from pydantic import ValidationError
from scrapy.exceptions import DropItem

from app.scraper.items import JobItem

logger = logging.getLogger(__name__)


class ValidationPipeline:
    """Validate each scraped item against the Pydantic schema.

    Spiders can yield either a dict or a JobItem directly.
    Invalid items are dropped with a log warning.
    """

    def process_item(self, item, spider):
        try:
            if isinstance(item, JobItem):
                return item
            validated = JobItem(**item)
            return validated
        except ValidationError as e:
            logger.warning(
                "Dropped invalid item from %s: %s",
                spider.name,
                e.errors(),
            )
            raise DropItem(f"Validation failed: {e}")
