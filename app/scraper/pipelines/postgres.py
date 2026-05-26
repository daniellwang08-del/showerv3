"""Write validated items to the shared PostgreSQL database with UPSERT dedup.

Tracks each spider run in the scrape_runs table for operational visibility.
"""

import logging
import uuid
from app.scraper.items import JobItem
from app.scraper.models.db import Base, ScrapedJob, ScrapeRun, get_engine, get_session, utcnow_naive

logger = logging.getLogger(__name__)


class PostgresPipeline:
    def __init__(self):
        self.session = None
        self.engine = None
        self.scrape_run = None
        self.items_new = 0
        self.items_updated = 0
        self._progress_flush_every = 5

    def _flush_run_counters(self, spider, *, force: bool = False) -> None:
        if not self.scrape_run:
            return
        total = self.items_new + self.items_updated
        if not force and total % self._progress_flush_every != 0:
            return
        self.scrape_run.items_scraped = total
        self.scrape_run.items_new = self.items_new
        self.scrape_run.items_updated = self.items_updated
        self.session.commit()
        spider.logger.info(
            "ScrapeRun %s progress: %d scraped (%d new, %d updated)",
            self.scrape_run.id,
            total,
            self.items_new,
            self.items_updated,
        )

    def open_spider(self, spider):
        db_url = spider.settings.get("DATABASE_URL")
        self.engine = get_engine(db_url)
        Base.metadata.create_all(self.engine)
        self.session = get_session(self.engine)

        self.scrape_run = ScrapeRun(
            id=str(uuid.uuid4()),
            spider_name=spider.name,
            started_at=utcnow_naive(),
            status="running",
        )
        self.session.add(self.scrape_run)
        self.session.commit()
        spider.logger.info("ScrapeRun %s started", self.scrape_run.id)

    def close_spider(self, spider):
        if self.scrape_run:
            self._flush_run_counters(spider, force=True)
            self.scrape_run.finished_at = utcnow_naive()
            self.scrape_run.status = "success"
            self.session.commit()
            spider.logger.info(
                "ScrapeRun %s finished: %d new, %d updated",
                self.scrape_run.id,
                self.items_new,
                self.items_updated,
            )
        if self.session:
            self.session.close()

    def process_item(self, item: JobItem, spider) -> JobItem:
        now = utcnow_naive()
        data = item.model_dump()
        data["scraped_at"] = now
        data["scrape_run_id"] = self.scrape_run.id

        existing = self.session.query(ScrapedJob).filter_by(
            source=item.source, source_job_id=item.source_job_id
        ).first()

        if existing:
            for key, value in data.items():
                if key not in ("id", "scraped_at") and value is not None:
                    setattr(existing, key, value)
            existing.updated_at = now
            existing.scrape_run_id = self.scrape_run.id
            self.session.commit()
            self.items_updated += 1
        else:
            data["id"] = str(uuid.uuid4())
            data["updated_at"] = now
            posting = ScrapedJob(**data)
            self.session.add(posting)
            self.session.commit()
            self.items_new += 1

        self._flush_run_counters(spider)

        return item
