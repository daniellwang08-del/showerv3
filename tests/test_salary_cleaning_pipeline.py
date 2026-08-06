"""Salary parsing must not treat currency codes like SEK as a 'k' multiplier."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from scrapy.exceptions import DropItem
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.scraper.items import JobItem
from app.scraper.models.db import Base, ScrapeRun, ScrapedJob
from app.scraper.pipelines.cleaning import CleaningPipeline
from app.scraper.pipelines.postgres import PostgresPipeline


def _item(**overrides) -> JobItem:
    base = {
        "source": "remoterocketship",
        "source_job_id": "1",
        "url": "https://example.com/job/1",
        "title": "Engineer",
    }
    base.update(overrides)
    return JobItem(**base)


def _clean(salary_raw: str, **overrides) -> JobItem:
    pipeline = CleaningPipeline(crawler=None)
    return pipeline.process_item(_item(salary_raw=salary_raw, **overrides))


def test_sek_salary_does_not_trigger_k_multiplier():
    item = _clean("SEK 775,444 - SEK 930,533 per year", source_job_id="19827925")
    assert item.salary_min_cents == 77_544_400
    assert item.salary_max_cents == 93_053_300
    assert item.salary_currency == "SEK"
    assert item.salary_period == "year"


def test_euro_range_parses_both_bounds():
    item = _clean("€104,000 - €124,800 per year")
    assert item.salary_min_cents == 10_400_000
    assert item.salary_max_cents == 12_480_000
    assert item.salary_currency == "EUR"


def test_usd_k_suffix_still_multiplies():
    item = _clean("$150k - $200k per year")
    assert item.salary_min_cents == 15_000_000
    assert item.salary_max_cents == 20_000_000
    assert item.salary_currency == "USD"


def test_usd_plain_range():
    item = _clean("$100,000 - $192,000 per year")
    assert item.salary_min_cents == 10_000_000
    assert item.salary_max_cents == 19_200_000


def test_single_k_amount():
    item = _clean("$180k/yr")
    assert item.salary_min_cents == 18_000_000
    assert item.salary_max_cents is None
    assert item.salary_period == "yr"


def test_out_of_range_cents_are_ignored(caplog):
    # Force an absurd amount that would overflow PG INTEGER even without the
    # SEK/k bug — parser must refuse rather than hand bad values to Postgres.
    pipeline = CleaningPipeline(crawler=None)
    item = _item(salary_raw="$99999999999 per year")
    with caplog.at_level("WARNING"):
        pipeline.process_item(item)
    assert item.salary_min_cents is None


def test_postgres_sanitizes_out_of_range_cents_instead_of_failing(tmp_path):
    """The VPS SEK overflow must not abort the run — clear cents and save the row."""
    db_path = tmp_path / "scraper_sanitize.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    crawler = MagicMock()
    crawler.stats.get_value.return_value = "finished"
    spider = SimpleNamespace(
        name="remoterocketship",
        logger=MagicMock(),
        settings={"DATABASE_URL": f"sqlite:///{db_path}"},
        _close_reason=None,
    )
    crawler.spider = spider

    pipeline = PostgresPipeline(crawler)
    pipeline.engine = engine
    pipeline.session = Session()
    pipeline.scrape_run = ScrapeRun(
        id="run-sanitize",
        spider_name="remoterocketship",
        status="running",
    )
    pipeline.session.add(pipeline.scrape_run)
    pipeline.session.commit()

    # Old SEK/"k" bug value — must be cleared before INSERT.
    item = _item(
        source_job_id="19827925",
        title="Senior Software Engineer – k6 Core",
        salary_raw="SEK 775,444 - SEK 930,533 per year",
        salary_min_cents=77_544_400_000,
        salary_currency="USD",
    )
    assert pipeline.process_item(item) is item
    pipeline.close_spider(spider)

    with Session() as session:
        row = session.query(ScrapedJob).filter_by(source_job_id="19827925").one()
        assert row.salary_min_cents is None
        assert row.salary_raw.startswith("SEK")
        run = session.get(ScrapeRun, "run-sanitize")
        assert run.status == "success"
        assert run.items_new == 1
        assert run.errors == 0


def test_postgres_pipeline_rolls_back_and_continues_after_db_error(tmp_path):
    db_path = tmp_path / "scraper.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    crawler = MagicMock()
    crawler.stats.get_value.return_value = "finished"
    spider = SimpleNamespace(
        name="remoterocketship",
        logger=MagicMock(),
        settings={"DATABASE_URL": f"sqlite:///{db_path}"},
        _close_reason=None,
    )
    crawler.spider = spider

    pipeline = PostgresPipeline(crawler)
    pipeline.engine = engine
    pipeline.session = Session()
    pipeline.scrape_run = ScrapeRun(
        id="run-1",
        spider_name="remoterocketship",
        status="running",
    )
    pipeline.session.add(pipeline.scrape_run)
    pipeline.session.commit()

    real_commit = pipeline.session.commit
    fail_next = {"armed": False}

    def commit_maybe_fail():
        if fail_next["armed"]:
            fail_next["armed"] = False
            raise Exception(
                "(psycopg2.errors.NumericValueOutOfRange) integer out of range"
            )
        return real_commit()

    pipeline.session.commit = commit_maybe_fail

    good = _item(source_job_id="ok-1", title="Good Job")
    assert pipeline.process_item(good) is good

    fail_next["armed"] = True
    bad = _item(source_job_id="bad-1", title="Transient DB Failure")
    with pytest.raises(DropItem):
        pipeline.process_item(bad)

    good2 = _item(source_job_id="ok-2", title="Another Good Job")
    assert pipeline.process_item(good2) is good2

    pipeline.close_spider(spider)

    with Session() as session:
        run = session.get(ScrapeRun, "run-1")
        assert run is not None
        assert run.status == "error"
        assert run.finished_at is not None
        assert run.items_new == 2
        assert run.errors == 1
        assert session.query(ScrapedJob).count() == 2
        assert session.query(ScrapedJob).filter_by(source_job_id="bad-1").first() is None


def test_postgres_pipeline_success_when_no_item_failures(tmp_path):
    db_path = tmp_path / "scraper_ok.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    crawler = MagicMock()
    crawler.stats.get_value.return_value = "finished"
    spider = SimpleNamespace(
        name="remoterocketship",
        logger=MagicMock(),
        settings={"DATABASE_URL": f"sqlite:///{db_path}"},
        _close_reason=None,
    )
    crawler.spider = spider

    pipeline = PostgresPipeline(crawler)
    pipeline.engine = engine
    pipeline.session = Session()
    pipeline.scrape_run = ScrapeRun(id="run-ok", spider_name="remoterocketship", status="running")
    pipeline.session.add(pipeline.scrape_run)
    pipeline.session.commit()

    item = _item(source_job_id="only-1", title="Only Job")
    pipeline.process_item(item)
    pipeline.close_spider(spider)

    with Session() as session:
        run = session.get(ScrapeRun, "run-ok")
        assert run.status == "success"
        assert run.errors == 0
        assert run.items_new == 1
