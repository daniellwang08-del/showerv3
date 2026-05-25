from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text, inspect as sa_inspect
from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import Base
from contextlib import asynccontextmanager
from typing import AsyncGenerator

logger = get_logger(__name__)

_engine = None
_session_factory = None
_initialized = False


async def init_database() -> None:
    global _engine, _session_factory, _initialized
    settings = get_settings()

    engine_kwargs = {
        "echo": settings.sqlalchemy_echo,
    }

    engine_kwargs["pool_size"] = settings.database_pool_size
    engine_kwargs["max_overflow"] = settings.database_max_overflow
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 3600

    try:
        _engine = create_async_engine(settings.database_url, **engine_kwargs)

        _session_factory = async_sessionmaker(
            bind=_engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
        )

        async with _engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

        # Only run create_all on a truly empty database (no tables yet).
        # Once Alembic migrations have been applied the schema is managed
        # exclusively by Alembic and create_all must be skipped to avoid
        # conflicts with already-existing tables/types.
        async with _engine.connect() as conn:
            existing_tables = await conn.run_sync(
                lambda sync_conn: sa_inspect(sync_conn).get_table_names()
            )

        if not existing_tables:
            logger.info("database_empty_running_create_all")
            async with _engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        else:
            logger.info("database_tables_exist_skipping_create_all", table_count=len(existing_tables))

        _initialized = True
        logger.info("database_initialized", url=settings.database_url.split("@")[-1] if "@" in settings.database_url else settings.database_url)

    except Exception as e:
        logger.error("database_init_failed", error=str(e))
        raise


async def close_database() -> None:
    global _engine
    if _engine:
        await _engine.dispose()
        _engine = None
        logger.info("database_closed")


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    if _session_factory is None:
        raise RuntimeError("Database not initialized")
    return _session_factory


@asynccontextmanager
async def get_session() -> AsyncGenerator[AsyncSession, None]:
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def check_database_connection() -> bool:
    try:
        if _engine is None or not _initialized:
            return False
        async with _engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as e:
        logger.debug("database_connection_check_failed", error=str(e))
        return False
