"""Write validated items to the shared PostgreSQL database with UPSERT dedup.

Tracks each spider run in the scrape_runs table for operational visibility.
"""

import logging
import uuid

from sqlalchemy import func, literal_column
from sqlalchemy.dialects.postgresql import insert as pg_insert

from scrapy.exceptions import DropItem

from app.scraper.items import JobItem
from app.scraper.models.db import Base, ScrapedJob, ScrapeRun, get_engine, get_session, utcnow_naive

logger = logging.getLogger(__name__)

# Matches scraped_jobs.salary_*_cents Integer columns (Postgres INT4).
_PG_INT_MAX = 2_147_483_647

# Scrapy close reasons that mean the process was killed / stopped mid-crawl,
# not a clean completion. Mapped to scrape_runs.status = "interrupted".
_INTERRUPT_REASONS = frozenset({"shutdown", "sigterm", "cancelled", "cancel"})


class PostgresPipeline:
    def __init__(self, crawler):
        self.crawler = crawler
        self.session = None
        self.engine = None
        self.scrape_run = None
        self.items_new = 0
        self.items_updated = 0
        self.items_failed = 0
        self._progress_flush_every = 5

    @classmethod
    def from_crawler(cls, crawler):
        pipe = cls(crawler)
        # ItemPipeline.close_spider() runs BEFORE stats finish_reason is written.
        # Stash Scrapy's close reason on the spider as soon as the engine starts
        # closing so finalize does not default SIGTERM/shutdown to "success".
        pipe._patch_engine_close_reason(crawler)
        from scrapy import signals

        # Receivers are held weakly, so this must be a bound method of the live pipeline.
        crawler.signals.connect(pipe._on_engine_started, signal=signals.engine_started)
        return pipe

    def _on_engine_started(self) -> None:
        self._patch_engine_close_reason(self.crawler)

    def _patch_engine_close_reason(self, crawler) -> None:
        # Scrapy 2.13+ raises RuntimeError (not AttributeError) before the engine exists.
        try:
            engine = getattr(crawler, "engine", None)
        except RuntimeError:
            return
        if engine is None or getattr(engine, "_postgres_close_reason_patched", False):
            return

        # Scrapy 2.19 dropped the spider argument (close_spider_async(*, reason)),
        # older releases pass (spider, reason). Accept both and forward untouched:
        # a signature mismatch here raises inside _spider_idle and the crawl
        # never closes.
        def _stash(args: tuple, kwargs: dict) -> None:
            reason = kwargs.get("reason")
            spider = kwargs.get("spider")
            for a in args:
                if isinstance(a, str):
                    reason = reason or a
                elif spider is None:
                    spider = a
            if spider is None:
                spider = getattr(crawler, "spider", None)
            if spider is not None:
                setattr(spider, "_close_reason", reason or "cancelled")

        if hasattr(engine, "close_spider_async"):
            orig_async = engine.close_spider_async

            async def _close_spider_async(*args, **kwargs):
                _stash(args, kwargs)
                return await orig_async(*args, **kwargs)

            engine.close_spider_async = _close_spider_async  # type: ignore[method-assign]

        if hasattr(engine, "close_spider"):
            orig = engine.close_spider

            def _close_spider(*args, **kwargs):
                _stash(args, kwargs)
                return orig(*args, **kwargs)

            engine.close_spider = _close_spider  # type: ignore[method-assign]

        engine._postgres_close_reason_patched = True

    def _spider(self):
        return self.crawler.spider

    def _safe_rollback(self) -> None:
        if self.session is None:
            return
        try:
            self.session.rollback()
        except Exception:
            logger.exception("Failed to rollback scraper DB session")

    def _flush_run_counters(self, *, force: bool = False) -> None:
        if not self.scrape_run or self.session is None:
            return
        total = self.items_new + self.items_updated
        if not force and total % self._progress_flush_every != 0:
            return
        try:
            self.scrape_run.items_scraped = total
            self.scrape_run.items_new = self.items_new
            self.scrape_run.items_updated = self.items_updated
            self.scrape_run.errors = self.items_failed
            self.session.commit()
            self._spider().logger.info(
                "ScrapeRun %s progress: %d scraped (%d new, %d updated, %d failed)",
                self.scrape_run.id,
                total,
                self.items_new,
                self.items_updated,
                self.items_failed,
            )
        except Exception:
            logger.exception(
                "Failed to flush scrape run counters for %s",
                getattr(self.scrape_run, "id", None),
            )
            self._safe_rollback()

    def open_spider(self):
        spider = self._spider()
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

    def close_spider(self, spider=None):
        spider = spider or self._spider()
        # Clear any poisoned transaction before final status write. Without this,
        # a single item flush failure left status stuck at "running".
        self._safe_rollback()
        try:
            if self.scrape_run and self.session is not None:
                self._finalize_scrape_run(spider)
        finally:
            if self.session is not None:
                self.session.close()
                self.session = None

    def _finalize_scrape_run(self, spider) -> None:
        try:
            self.scrape_run.items_scraped = self.items_new + self.items_updated
            self.scrape_run.items_new = self.items_new
            self.scrape_run.items_updated = self.items_updated
            self.scrape_run.errors = self.items_failed
            self.scrape_run.finished_at = utcnow_naive()

            # Scrapy's normal completion reason is "finished". Custom
            # CloseSpider reasons (auth_expired, fetch_failed, …) must not
            # be recorded as success, that caused false-green sync runs.
            #
            # Pipeline close_spider often runs BEFORE stats finish_reason is
            # set, so honor spider._close_reason (stashed by engine patch).
            finish_reason = (
                getattr(spider, "_close_reason", None)
                or self.crawler.stats.get_value("finish_reason")
                or "finished"
            )

            if finish_reason in _INTERRUPT_REASONS:
                # SIGTERM / deploy restart mid-crawl, jobs already flushed
                # stay saved; status must not read as a clean success.
                self.scrape_run.status = "interrupted"
                spider.logger.warning(
                    "ScrapeRun %s interrupted (reason=%s): %d new, %d updated",
                    self.scrape_run.id,
                    finish_reason,
                    self.items_new,
                    self.items_updated,
                )
            elif finish_reason == "finished" and self.items_failed == 0:
                self.scrape_run.status = "success"
                spider.logger.info(
                    "ScrapeRun %s finished: %d new, %d updated",
                    self.scrape_run.id,
                    self.items_new,
                    self.items_updated,
                )
            elif finish_reason == "finished" and self.items_failed > 0:
                # Spider closed normally but one or more items failed to persist.
                self.scrape_run.status = "error"
                spider.logger.error(
                    "ScrapeRun %s finished with %d item write error(s): %d new, %d updated",
                    self.scrape_run.id,
                    self.items_failed,
                    self.items_new,
                    self.items_updated,
                )
            else:
                self.scrape_run.status = finish_reason
                self.scrape_run.errors = max(self.items_failed, 1)
                spider.logger.error(
                    "ScrapeRun %s finished with failure reason=%s: %d new, %d updated",
                    self.scrape_run.id,
                    finish_reason,
                    self.items_new,
                    self.items_updated,
                )

            self.session.commit()
        except Exception:
            logger.exception(
                "Failed to finalize ScrapeRun %s; attempting recovery write",
                getattr(self.scrape_run, "id", None),
            )
            self._safe_rollback()
            self._force_mark_run_status(
                run_id=getattr(self.scrape_run, "id", None),
                status="error",
                spider=spider,
            )

    def _force_mark_run_status(self, *, run_id: str | None, status: str, spider) -> None:
        """Last-resort status update on a fresh session so runs never stay 'running'."""
        if not run_id or self.engine is None:
            return
        session = get_session(self.engine)
        try:
            run = session.get(ScrapeRun, run_id)
            if run is None:
                return
            run.status = status
            run.finished_at = run.finished_at or utcnow_naive()
            run.items_scraped = self.items_new + self.items_updated
            run.items_new = self.items_new
            run.items_updated = self.items_updated
            run.errors = max(self.items_failed, run.errors or 0, 1)
            session.commit()
            spider.logger.error(
                "ScrapeRun %s force-marked status=%s after finalize failure",
                run_id,
                status,
            )
        except Exception:
            logger.exception("Failed force-marking ScrapeRun %s as %s", run_id, status)
            try:
                session.rollback()
            except Exception:
                pass
        finally:
            session.close()

    def process_item(self, item: JobItem) -> JobItem:
        if self.session is None or self.scrape_run is None:
            raise DropItem("scraper DB session is not open")

        now = utcnow_naive()
        data = item.model_dump()
        data["scraped_at"] = now
        data["scrape_run_id"] = self.scrape_run.id
        self._sanitize_salary_cents(data, item)

        try:
            # One round trip: insert, or on (source, source_job_id) conflict
            # overwrite only the fields this scrape actually has.
            table = ScrapedJob.__table__
            row = {k: v for k, v in data.items() if k in table.c}
            row["id"] = str(uuid.uuid4())
            row["updated_at"] = now
            stmt = pg_insert(table).values(**row)
            keep = {"id", "scraped_at", "source", "source_job_id"}
            update_set = {
                c: func.coalesce(stmt.excluded[c], table.c[c])
                for c in row
                if c not in keep
            }
            update_set["updated_at"] = now
            update_set["scrape_run_id"] = self.scrape_run.id
            stmt = stmt.on_conflict_do_update(
                constraint="uq_scraped_source_job", set_=update_set
            ).returning(literal_column("(xmax = 0)"))
            inserted = bool(self.session.execute(stmt).scalar())
            self.session.commit()
            if inserted:
                self.items_new += 1
            else:
                self.items_updated += 1

            self._flush_run_counters()
            return item
        except DropItem:
            raise
        except Exception as exc:
            self.items_failed += 1
            self._safe_rollback()
            spider = self._spider()
            spider.logger.exception(
                "Failed to persist scraped job %s:%s, skipping item and continuing",
                item.source,
                item.source_job_id,
            )
            raise DropItem(f"db_write_failed: {exc}") from exc

    @staticmethod
    def _sanitize_salary_cents(data: dict, item: JobItem) -> None:
        """Drop out-of-range cents so a bad parse cannot abort the whole run."""
        for key in ("salary_min_cents", "salary_max_cents"):
            value = data.get(key)
            if value is None:
                continue
            if not isinstance(value, int) or value < 0 or value > _PG_INT_MAX:
                logger.warning(
                    "Clearing %s=%r for %s:%s (salary_raw=%r), exceeds Integer range",
                    key,
                    value,
                    item.source,
                    item.source_job_id,
                    item.salary_raw,
                )
                data[key] = None
