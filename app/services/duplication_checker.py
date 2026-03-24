"""
Professional job duplication detection engine.

Multi-tier strategy:
  1. Exact normalized URL - strict equality after normalization
  2. Canonical job key - (board_domain, job_id) for known job boards (Ashby, Greenhouse, etc.)
  3. Same-domain URL similarity - alternate URLs for same job (path/stem matching)
  4. Same-company content - title/description similarity when company matches
  5. Cross-company content - high-content-similarity reposts (e.g. staffing agencies)
"""

import hashlib
import re
from difflib import SequenceMatcher
from urllib.parse import urlparse
from typing import Tuple, Optional, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_
from app.models.database import ValidJob, InvalidJob
from app.services.url_manager import URLManager
from app.core.logging import get_logger
import tldextract

logger = get_logger(__name__)

# Minimum similarity scores
SIMILARITY_THRESHOLD = 0.82
URL_SIMILARITY_THRESHOLD = 0.88
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

    def normalize_url(self, url: str) -> str:
        try:
            return URLManager.normalize_url(url)
        except Exception:
            return url.strip().lower()

    def extract_domain(self, url: str) -> str:
        try:
            extracted = tldextract.extract(url)
            return f"{extracted.domain}.{extracted.suffix}".lower()
        except Exception:
            return urlparse(url).netloc.lower()

    def _get_canonical_job_key(self, url: str) -> Tuple[str | None, str | None]:
        return URLManager.get_canonical_job_key(url)

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

    def calculate_url_similarity(self, url1: str, url2: str) -> float:
        norm1 = self.normalize_url(url1)
        norm2 = self.normalize_url(url2)
        if norm1 == norm2:
            return 1.0
        return SequenceMatcher(None, norm1, norm2).ratio()

    def _extract_url_path_stem(self, url: str) -> str:
        """Extract path without query for stem comparison."""
        parsed = urlparse(url)
        path = (parsed.path or "/").rstrip("/") or "/"
        path = re.sub(r"/application$", "", path, flags=re.IGNORECASE)
        return path.lower()

    async def check_exact_url_duplicate(
        self, url: str, company: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """Tier 1: Exact normalized URL match."""
        normalized_url = self.normalize_url(url)

        for model, label in [(ValidJob, "valid"), (InvalidJob, "invalid")]:
            stmt = select(model).where(model.normalized_url == normalized_url)
            if company:
                stmt = stmt.where(model.company.ilike(f"%{company}%"))
            result = await self.db_session.execute(stmt)
            job = result.scalar_one_or_none()
            if job:
                logger.debug("duplicate_tier1_exact_url", model=label, job_id=job.id, url=url)
                return True, job.id

        domain = self.extract_domain(url)
        canonical_prefix = normalized_url.split("?", 1)[0]

        for model in [ValidJob, InvalidJob]:
            stmt = select(model).where(
                and_(
                    model.domain == domain,
                    or_(
                        model.source_url.ilike(f"{canonical_prefix}%"),
                        model.normalized_url.ilike(f"{canonical_prefix}%"),
                    ),
                )
            )
            if company:
                stmt = stmt.where(model.company.ilike(f"%{company}%"))
            result = await self.db_session.execute(stmt)
            for job in result.scalars().all():
                if self.normalize_url(job.source_url) == normalized_url:
                    return True, job.id

        return False, None

    async def check_canonical_job_key_duplicate(
        self, url: str, exclude_valid_job_id: Optional[str] = None
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Tier 2: Same (board_domain, job_id) = same job."""
        root_domain, job_id = self._get_canonical_job_key(url)
        if not root_domain or not job_id:
            return False, None

        for model in [ValidJob, InvalidJob]:
            stmt = select(model).where(model.is_active == True)
            if exclude_valid_job_id and model == ValidJob:
                stmt = stmt.where(ValidJob.id != exclude_valid_job_id)
            result = await self.db_session.execute(stmt)
            for job in result.scalars().all():
                other_root, other_id = self._get_canonical_job_key(job.source_url)
                if other_root and other_id and other_root == root_domain and other_id == job_id:
                    match_type = "valid_job" if model == ValidJob else "invalid_job"
                    canonical_id = job.duplicate_of_job_id if hasattr(job, "duplicate_of_job_id") and job.duplicate_of_job_id else job.id
                    logger.debug(
                        "duplicate_tier2_canonical_key",
                        job_id=job.id,
                        root=root_domain,
                        key=job_id,
                        url=url,
                    )
                    return True, {
                        "job_id": canonical_id,
                        "similarity_score": 1.0,
                        "url_similarity": 1.0,
                        "content_similarity": 1.0,
                        "hash_match": False,
                        "match_type": match_type,
                        "duplication_reason": "Same job (identical job ID on same board)",
                    }
        return False, None

    async def check_same_domain_url_similarity(
        self, url: str, exclude_valid_job_id: Optional[str] = None
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Tier 3: High URL path similarity within same domain."""
        domain = self.extract_domain(url)
        path_stem = self._extract_url_path_stem(url)
        url_sim_thresh = URL_SIMILARITY_THRESHOLD

        for model in [ValidJob, InvalidJob]:
            stmt = select(model).where(and_(model.domain == domain, model.is_active == True))
            if exclude_valid_job_id and model == ValidJob:
                stmt = stmt.where(ValidJob.id != exclude_valid_job_id)
            result = await self.db_session.execute(stmt)
            best = None
            best_score = 0.0
            for job in result.scalars().all():
                other_stem = self._extract_url_path_stem(job.source_url)
                if path_stem == other_stem:
                    score = 1.0
                else:
                    score = self.calculate_url_similarity(url, job.source_url)
                if score >= url_sim_thresh and score > best_score:
                    best_score = score
                    match_type = "valid_job" if model == ValidJob else "invalid_job"
                    canonical_id = job.duplicate_of_job_id if hasattr(job, "duplicate_of_job_id") and job.duplicate_of_job_id else job.id
                    best = {
                        "job_id": canonical_id,
                        "similarity_score": score,
                        "url_similarity": score,
                        "content_similarity": 0.0,
                        "hash_match": False,
                        "match_type": match_type,
                        "duplication_reason": "Very similar URL on same job board",
                    }
            if best:
                logger.debug(
                    "duplicate_tier3_url_similarity",
                    job_id=best["job_id"],
                    score=best_score,
                    url=url,
                )
                return True, best
        return False, None

    async def check_company_duplicates(
        self,
        url: str,
        title: str = "",
        company: str = "",
        description: str = "",
        exclude_valid_job_id: Optional[str] = None,
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Tier 4: Same company + high content/URL similarity."""
        if not company and not title and not description:
            return False, None

        domain = self.extract_domain(url)
        content_hash = self.generate_content_hash(title, company, description)
        norm_company = _normalize_company(company)
        norm_title = _normalize_job_title(title)

        for model in [ValidJob, InvalidJob]:
            stmt = select(model).where(model.is_active == True)
            if norm_company:
                conds = [model.company.ilike(f"%{company}%")]
                if domain:
                    conds.append(
                        and_(
                            model.domain == domain,
                            model.company.ilike(f"%{norm_company[:30]}%"),
                        )
                    )
                stmt = stmt.where(or_(*conds))
            else:
                stmt = stmt.where(model.domain == domain)
            if exclude_valid_job_id and model == ValidJob:
                stmt = stmt.where(ValidJob.id != exclude_valid_job_id)
            result = await self.db_session.execute(stmt)
            best = None
            best_score = 0.0
            for job in result.scalars().all():
                url_sim = self.calculate_url_similarity(url, job.source_url)
                title_sim = self.calculate_text_similarity(title or "", job.title or "")
                if norm_title and (job.title or ""):
                    title_sim = max(title_sim, self.calculate_text_similarity(norm_title, _normalize_job_title(job.title or "")))
                desc_sim = self.calculate_text_similarity(description, job.description or "")
                content_sim = max(title_sim, desc_sim) if (title or description) else 0.0
                hash_match = content_hash is not None and content_hash == job.similarity_hash
                combined = (url_sim * 0.45 + content_sim * 0.55) if (title or description) else url_sim
                if hash_match:
                    combined = 1.0
                if combined >= SIMILARITY_THRESHOLD and combined > best_score:
                    best_score = combined
                    match_type = "valid_job" if model == ValidJob else "invalid_job"
                    canonical_id = job.duplicate_of_job_id if hasattr(job, "duplicate_of_job_id") and job.duplicate_of_job_id else job.id
                    best = {
                        "job_id": canonical_id,
                        "similarity_score": combined,
                        "url_similarity": url_sim,
                        "content_similarity": content_sim,
                        "hash_match": hash_match,
                        "match_type": match_type,
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
        """Tier 5: Cross-company high content similarity (reposts, staffing)."""
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

        if not title and not description:
            return False, None

        stmt = select(ValidJob).where(
            and_(
                ValidJob.is_active == True,
                ValidJob.title.isnot(None),
                ValidJob.description.isnot(None),
            )
        )
        if exclude_valid_job_id:
            stmt = stmt.where(ValidJob.id != exclude_valid_job_id)
        result = await self.db_session.execute(stmt)
        best = None
        best_score = 0.0
        for job in result.scalars().all():
            title_sim = self.calculate_text_similarity(title, job.title or "")
            desc_sim = self.calculate_text_similarity(description, job.description or "")
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
        """Run all tiers in order. First match wins."""
        is_exact, exact_id = await self.check_exact_url_duplicate(url, company or None)
        if is_exact and exact_id:
            return True, {
                "job_id": exact_id,
                "similarity_score": 1.0,
                "url_similarity": 1.0,
                "content_similarity": 1.0,
                "hash_match": True,
                "match_type": "exact_url",
                "duplication_reason": "Exact URL match",
            }

        is_canon, canon_match = await self.check_canonical_job_key_duplicate(url, exclude_valid_job_id)
        if is_canon and canon_match:
            logger.info(
                "comprehensive_duplicate_check_match",
                match_type="canonical_key",
                job_id=canon_match.get("job_id"),
                url=url,
            )
            return True, canon_match

        is_url_sim, url_sim_match = await self.check_same_domain_url_similarity(
            url, exclude_valid_job_id
        )
        if is_url_sim and url_sim_match:
            logger.info(
                "comprehensive_duplicate_check_match",
                match_type="url_similarity",
                job_id=url_sim_match.get("job_id"),
                url=url,
                score=url_sim_match.get("similarity_score"),
            )
            return True, url_sim_match

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
