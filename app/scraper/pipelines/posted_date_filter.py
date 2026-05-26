"""Drop scraped items outside a configured posted-date window."""

from scrapy.exceptions import DropItem


class PostedDateFilterPipeline:
    def process_item(self, item, spider):
        if not hasattr(spider, "_posted_in_range"):
            return item
        posted_at = getattr(item, "posted_at", None)
        if posted_at is None and hasattr(item, "get"):
            posted_at = item.get("posted_at")
        if not spider._posted_in_range(posted_at):
            raise DropItem("posted_at outside sync date range")
        return item
