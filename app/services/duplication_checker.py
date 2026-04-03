"""
Professional job duplication detection engine.

Multi-tier strategy (content-first):
  1. Same-company content similarity (title/description/hash)
  2. Cross-company content similarity (high-content reposts)
"""

import hashlib
import re
from difflib import SequenceMatcher
from urllib.parse import urlparse
from typing import Tuple, Optional, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from app.models.database import ValidJob, InvalidJob
from app.core.logging import get_logger
import tldextract

logger = get_logger(__name__)

# Minimum similarity scores
SIMILARITY_THRESHOLD = 0.82
CROSS_COMPANY_CONTENT_THRESHOLD = 0.92
TITLE_NORMALIZE_PATTERN = re.compile(r"\b(sr\.?|junior|jr\.?|senior|lead|principal|staff|remote|hybrid|onsite|contract|full[- ]?time|part[- ]?time)\b", re.IGNORECASE)


def _normalize_job_title(title: str) -> str:
    """Strip common modifiers for better fuzzy matching."""
    if not title:
        return ""
    s = re.sub(r"\s+", " ", title.lower().strip())
    s = TITLE_NORMALIZE_PATTERN.sub("", s)
    s = re.sub(r"[^\w\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _token_set_similarity(text1: str, text2: str) -> float:
    """Jaccard-like similarity using word token sets."""
    if not text1 or not text2:
        return 0.0
    t1 = set(re.findall(r"\w+", text1.lower()))
    t2 = set(re.findall(r"\w+", text2.lower()))
    if not t1 or not t2:
        return 0.0
    inter = len(t1 & t2)
    union = len(t1 | t2)
    return inter / union if union else 0.0


def _normalize_company(name: str) -> str:
    """Normalize company name for matching."""
    if not name:
        return ""
    s = re.sub(r"\s+", " ", name.lower().strip())
    s = re.sub(r"\b(inc\.?|llc|corp\.?|ltd\.?|co\.?|corporation|limited)\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"[^\w\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


class DuplicationChecker:
    def __init__(self, db_session: AsyncSession):
        self.db_session = db_session

    def extract_domain(self, url: str) -> str:
        try:
            extracted = tldextract.extract(url)
            return f"{extracted.domain}.{extracted.suffix}".lower()
        except Exception:
            return urlparse(url).netloc.lower()

    def generate_content_hash(
        self,
        title: str = "",
        company: str = "",
        description: str = "",
    ) -> Optional[str]:
        """Generate similarity hash for exact content comparison."""
        norm_title = _normalize_job_title(title or "")
        norm_company = _normalize_company(company or "")
        desc_snippet = (description or "")[:2000].lower()
        desc_clean = re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", desc_snippet))
        content = f"{norm_title} {norm_company} {desc_clean}".strip()
        if not content:
            return None
        return hashlib.sha256(content.encode()).hexdigest()

    def calculate_text_similarity(self, text1: str, text2: str) -> float:
        if not text1 or not text2:
            return 0.0
        t1 = re.sub(r"\s+", " ", text1.lower().strip())
        t2 = re.sub(r"\s+", " ", text2.lower().strip())
        seq = SequenceMatcher(None, t1, t2).ratio()
        jaccard = _token_set_similarity(t1, t2)
        return max(seq, jaccard)

    async def check_company_duplicates(
        self,
        url: str,
        title: str = "",
        company: str = "",
        description: str = "",
        exclude_valid_job_id: Optional[str] = None,
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Tier 1: Same company + high content similarity."""
        if not company and not title and not description:
            return False, None

        content_hash = self.generate_content_hash(title, company, description)
        norm_company = _normalize_company(company)
        norm_title = _normalize_job_title(title)

        if not norm_company:
            return False, None

        # SQL pre-filter: hash match OR company name match (narrows candidate set)
        for model in [ValidJob, InvalidJob]:
            conditions = [model.is_active == True, model.company.ilike(f"%{norm_company}%")]
            if exclude_valid_job_id and model == ValidJob:
                conditions.append(ValidJob.id != exclude_valid_job_id)
            if content_hash:
                hash_stmt = select(model).where(
                    model.is_active == True,
                    model.similarity_hash == content_hash,
                )
                if exclude_valid_job_id and model == ValidJob:
                    hash_stmt = hash_stmt.where(ValidJob.id != exclude_valid_job_id)
                hash_result = await self.db_session.execute(hash_stmt)
                for job in hash_result.scalars().all():
                    match_type = "valid_job" if model == ValidJob else "invalid_job"
                    canonical_id = job.duplicate_of_job_id if hasattr(job, "duplicate_of_job_id") and job.duplicate_of_job_id else job.id
                    return True, {
                        "job_id": canonical_id, "similarity_score": 1.0,
                        "url_similarity": 0.0, "content_similarity": 1.0,
                        "hash_match": True, "match_type": match_type,
                        "duplication_reason": "Similar job from same company",
                    }

            stmt = select(model).where(and_(*conditions))
            result = await self.db_session.execute(stmt)
            best = None
            best_score = 0.0
            for job in result.scalars().all():
                title_sim = self.calculate_text_similarity(title or "", job.title or "")
                if norm_title and (job.title or ""):
                    title_sim = max(title_sim, self.calculate_text_similarity(norm_title, _normalize_job_title(job.title or "")))
                desc_sim = self.calculate_text_similarity(description, job.description or "")
                content_sim = max(title_sim, desc_sim) if (title or description) else 0.0
                if content_sim >= SIMILARITY_THRESHOLD and content_sim > best_score:
                    best_score = content_sim
                    match_type = "valid_job" if model == ValidJob else "invalid_job"
                    canonical_id = job.duplicate_of_job_id if hasattr(job, "duplicate_of_job_id") and job.duplicate_of_job_id else job.id
                    best = {
                        "job_id": canonical_id, "similarity_score": content_sim,
                        "url_similarity": 0.0, "content_similarity": content_sim,
                        "hash_match": False, "match_type": match_type,
                        "duplication_reason": "Similar job from same company",
                    }
            if best:
                return True, best
        return False, None

    async def check_cross_company_duplicates(
        self,
        url: str,
        title: str = "",
        company: str = "",
        description: str = "",
        exclude_valid_job_id: Optional[str] = None,
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Tier 2: Cross-company high content similarity (reposts, staffing)."""
        content_hash = self.generate_content_hash(title, company, description)
        if not content_hash and not (title and description):
            return False, None

        if content_hash:
            stmt = select(ValidJob).where(
                and_(ValidJob.similarity_hash == content_hash, ValidJob.is_active == True)
            )
            if exclude_valid_job_id:
                stmt = stmt.where(ValidJob.id != exclude_valid_job_id)
            result = await self.db_session.execute(stmt)
            job = result.scalar_one_or_none()
            if job:
                return True, {
                    "job_id": job.id,
                    "similarity_score": 1.0,
                    "url_similarity": 0.0,
                    "content_similarity": 1.0,
                    "hash_match": True,
                    "match_type": "cross_company_valid",
                    "original_company": job.company,
                    "duplication_reason": "Identical job content posted by different company",
                }

        if not title:
            return False, None

        # SQL pre-filter: only load candidates whose title shares key words
        norm_title = _normalize_job_title(title)
        title_words = [w for w in norm_title.split() if len(w) >= 3]
        if not title_words:
            return False, None

        # Use the longest word from the title for SQL pre-filter
        key_word = max(title_words, key=len)
        stmt = select(ValidJob).where(
            and_(
                ValidJob.is_active == True,
                ValidJob.title.isnot(None),
                ValidJob.title.ilike(f"%{key_word}%"),
            )
        )
        if exclude_valid_job_id:
            stmt = stmt.where(ValidJob.id != exclude_valid_job_id)
        result = await self.db_session.execute(stmt)
        best = None
        best_score = 0.0
        for job in result.scalars().all():
            title_sim = self.calculate_text_similarity(title, job.title or "")
            desc_sim = self.calculate_text_similarity(description, job.description or "") if description else 0.0
            content_sim = max(title_sim, desc_sim)
            if content_sim >= CROSS_COMPANY_CONTENT_THRESHOLD and content_sim > best_score:
                best_score = content_sim
                best = {
                    "job_id": job.id,
                    "similarity_score": content_sim,
                    "url_similarity": 0.0,
                    "content_similarity": content_sim,
                    "hash_match": False,
                    "match_type": "cross_company_valid",
                    "original_company": job.company,
                    "duplication_reason": "Very similar job posted by different company",
                }
        return best is not None, best

    async def comprehensive_duplicate_check(
        self,
        url: str,
        title: str = "",
        company: str = "",
        description: str = "",
        exclude_valid_job_id: Optional[str] = None,
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Run content-based duplicate tiers in order. First match wins."""

        is_company, company_match = await self.check_company_duplicates(
            url, title, company, description, exclude_valid_job_id
        )
        if is_company and company_match:
            company_match["duplication_reason"] = company_match.get(
                "duplication_reason", "Similar job from same company"
            )
            logger.info(
                "comprehensive_duplicate_check_match",
                match_type="company",
                job_id=company_match.get("job_id"),
                url=url,
                score=company_match.get("similarity_score"),
            )
            return True, company_match

        is_cross, cross_match = await self.check_cross_company_duplicates(
            url, title, company, description, exclude_valid_job_id
        )
        if is_cross and cross_match:
            cross_match["duplication_reason"] = cross_match.get(
                "duplication_reason", "Similar job posted by different company"
            )
            logger.info(
                "comprehensive_duplicate_check_match",
                match_type="cross_company",
                job_id=cross_match.get("job_id"),
                url=url,
            )
            return True, cross_match

        logger.debug("comprehensive_duplicate_check_no_match", url=url)
        return False, None
