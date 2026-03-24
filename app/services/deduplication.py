from app.services.url_manager import URLManager
from app.storage.repository import JobExtractionRepository
from app.storage.database import get_session
from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import JobExtraction
from app.models.schemas import ExtractionStatus

logger = get_logger(__name__)


class DeduplicationService:
    def __init__(self, repository: JobExtractionRepository):
        self._repository = repository
        self._settings = get_settings()

    async def check_and_create(
        self,
        source_url: str,
        force_refresh: bool = False,
    ) -> tuple[JobExtraction, bool]:
        normalized_url = URLManager.normalize_url(source_url)
        domain = URLManager.extract_domain(source_url)

        existing_any = await self._repository.get_by_normalized_url(normalized_url)
        if force_refresh and existing_any:
            if existing_any.status in (ExtractionStatus.PENDING, ExtractionStatus.PROCESSING):
                return existing_any, True

            await self._repository.reset_for_refresh(existing_any.id, source_url, domain)
            refreshed = await self._repository.get_by_id(existing_any.id)
            return (refreshed or existing_any), False

        if not force_refresh:
            existing = await self._repository.find_recent_by_normalized_url(
                normalized_url,
                within_hours=self._settings.dedup_window_hours,
            )
            if existing:
                logger.info(
                    "found_recent_extraction",
                    job_id=existing.id,
                    normalized_url=normalized_url,
                )
                return existing, True

        if existing_any and not force_refresh:
            return existing_any, True

        extraction, created = await self._repository.get_or_create(
            source_url=source_url,
            normalized_url=normalized_url,
            domain=domain,
        )

        if created:
            logger.info(
                "created_new_extraction",
                job_id=extraction.id,
                normalized_url=normalized_url,
                domain=domain,
            )
        else:
            logger.info(
                "found_existing_extraction",
                job_id=extraction.id,
                normalized_url=normalized_url,
            )

        return extraction, not created


async def check_duplicate(source_url: str, force_refresh: bool = False) -> tuple[JobExtraction, bool]:
    async with get_session() as session:
        repository = JobExtractionRepository(session)
        service = DeduplicationService(repository)
        return await service.check_and_create(source_url, force_refresh)
