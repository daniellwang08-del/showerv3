from app.services.url_manager import URLManager
from app.storage.repository import JobExtractionRepository
from app.storage.database import get_session
from app.core.logging import get_logger
from app.models.database import JobExtraction

logger = get_logger(__name__)


class DeduplicationService:
    def __init__(self, repository: JobExtractionRepository):
        self._repository = repository

    async def check_and_create(
        self,
        source_url: str,
        force_refresh: bool = False,
    ) -> tuple[JobExtraction, bool]:
        normalized_url = URLManager.normalize_url(source_url)
        domain = URLManager.extract_domain(source_url)

        extraction, _ = await self._repository.get_or_create(
            source_url=source_url,
            normalized_url=normalized_url,
            domain=domain,
        )

        logger.info(
            "created_new_extraction",
            job_id=extraction.id,
            normalized_url=normalized_url,
            domain=domain,
            force_refresh=force_refresh,
        )

        # URL-based dedupe is disabled; this service always returns non-duplicate.
        return extraction, False


async def check_duplicate(source_url: str, force_refresh: bool = False) -> tuple[JobExtraction, bool]:
    async with get_session() as session:
        repository = JobExtractionRepository(session)
        service = DeduplicationService(repository)
        return await service.check_and_create(source_url, force_refresh)
