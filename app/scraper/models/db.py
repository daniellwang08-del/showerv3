"""Scraper ORM models - writes to the shared PostgreSQL database.

Uses sync SQLAlchemy (Scrapy runs on Twisted, not asyncio). The
DATABASE_URL is converted from asyncpg to plain psycopg2 format
by the scraper config module.
"""

import json
import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker


def utcnow_naive() -> datetime:
    """UTC wall time as naive datetime - matches async app storage conventions."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class JSONType(TypeDecorator):
    """JSON column - native JSON on PostgreSQL, serialized TEXT on SQLite."""
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None:
            return json.dumps(value)
        return None

    def process_result_value(self, value, dialect):
        if value is not None:
            return json.loads(value)
        return None


class Base(DeclarativeBase):
    pass


def _generate_uuid():
    return str(uuid.uuid4())


class ScrapedJob(Base):
    __tablename__ = "scraped_jobs"

    id = Column(String(36), primary_key=True, default=_generate_uuid)
    source = Column(String(64), nullable=False, index=True)
    source_job_id = Column(String(256), nullable=False)
    url = Column(String(2048), nullable=False)
    origin_url = Column(String(2048))
    title = Column(String(512), nullable=False)
    company_name = Column(String(512))
    location = Column(String(512))
    is_remote = Column(Boolean, default=False)
    salary_raw = Column(String(256))
    salary_min_cents = Column(Integer)
    salary_max_cents = Column(Integer)
    salary_currency = Column(String(8), default="USD")
    salary_period = Column(String(32))
    description = Column(Text)
    job_type = Column(String(64))
    experience_level = Column(String(64))
    tags = Column(JSONType, default=list)
    content_hash = Column(String(64), nullable=False, index=True)

    posted_at = Column(DateTime)
    scraped_at = Column(DateTime, default=utcnow_naive)
    updated_at = Column(
        DateTime,
        default=utcnow_naive,
        onupdate=utcnow_naive,
    )

    scrape_run_id = Column(String(36), ForeignKey("scrape_runs.id"))
    scrape_run = relationship("ScrapeRun", back_populates="scraped_jobs")

    promoted_extraction_id = Column(String(36), nullable=True, index=True)
    promoted_at = Column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("source", "source_job_id", name="uq_scraped_source_job"),
        Index("ix_scraped_source_posted", "source", "posted_at"),
    )

    def __repr__(self):
        return f"<ScrapedJob {self.source}:{self.source_job_id} '{self.title}'>"


class ScrapeRun(Base):
    __tablename__ = "scrape_runs"

    id = Column(String(36), primary_key=True, default=_generate_uuid)
    spider_name = Column(String(128), nullable=False, index=True)
    started_at = Column(DateTime, default=utcnow_naive)
    finished_at = Column(DateTime)
    items_scraped = Column(Integer, default=0)
    items_new = Column(Integer, default=0)
    items_updated = Column(Integer, default=0)
    requests_made = Column(Integer, default=0)
    errors = Column(Integer, default=0)
    status = Column(String(32), default="running")

    scraped_jobs = relationship("ScrapedJob", back_populates="scrape_run")

    def __repr__(self):
        return f"<ScrapeRun {self.spider_name} {self.status}>"


class ScrapeCheckpoint(Base):
    """Stores the most recent job IDs per spider for incremental scraping."""
    __tablename__ = "scrape_checkpoints"

    spider_name = Column(String(128), primary_key=True)
    marker_job_ids = Column(JSONType, nullable=False, default=list)
    updated_at = Column(
        DateTime,
        default=utcnow_naive,
        onupdate=utcnow_naive,
    )

    def __repr__(self):
        return f"<ScrapeCheckpoint {self.spider_name} markers={self.marker_job_ids}>"


def _resolve_database_url(url: str | None = None) -> str:
    if url:
        return url.replace("postgresql+asyncpg://", "postgresql://")

    env_url = os.environ.get("DATABASE_URL", "")
    if env_url:
        return env_url.replace("postgresql+asyncpg://", "postgresql://")

    try:
        from app.scraper.config import settings as scraper_settings
        return scraper_settings.DATABASE_URL
    except Exception:
        return ""


def get_engine(url: str | None = None):
    db_url = _resolve_database_url(url)
    if not db_url:
        raise RuntimeError("No DATABASE_URL configured for the scraper module")
    return create_engine(db_url, pool_pre_ping=True, pool_size=5, max_overflow=5)


def get_session(engine=None) -> Session:
    engine = engine or get_engine()
    factory = sessionmaker(bind=engine)
    return factory()
