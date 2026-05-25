import asyncio
import logging
import sys
from logging.config import fileConfig
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config
from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

from app.models.database import Base
from app.core.config import get_settings

logger = logging.getLogger("alembic.env")

target_metadata = Base.metadata


def _configure_windows_event_loop() -> None:
    """asyncpg + asyncio.run on Windows needs SelectorEventLoop for clean shutdown."""
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def get_url():
    settings = get_settings()
    return settings.database_url


def run_migrations_offline() -> None:
    logger.info("alembic_migrations_offline_start")
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()
    logger.info("alembic_migrations_offline_complete")


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    configuration = config.get_section(config.config_ini_section)
    configuration["sqlalchemy.url"] = get_url()
    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    try:
        async with connectable.connect() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await connectable.dispose()


def run_migrations_online() -> None:
    logger.info("alembic_migrations_online_start")
    _configure_windows_event_loop()
    asyncio.run(run_async_migrations())
    logger.info("alembic_migrations_online_complete")


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
