import hashlib
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class JobItem(BaseModel):
    """Validated job posting item. Every spider yields these."""

    source: str
    source_job_id: str
    url: str
    origin_url: Optional[str] = None
    title: str
    company_name: Optional[str] = None
    location: Optional[str] = None
    is_remote: bool = False
    salary_raw: Optional[str] = None
    salary_min_cents: Optional[int] = None
    salary_max_cents: Optional[int] = None
    salary_currency: str = "USD"
    salary_period: Optional[str] = None
    description: Optional[str] = None
    job_type: Optional[str] = None
    experience_level: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    posted_at: Optional[datetime] = None
    content_hash: Optional[str] = None

    @field_validator("title", "source", "source_job_id", "url")
    @classmethod
    def must_not_be_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Field must not be empty")
        return v.strip()

    @field_validator("salary_period")
    @classmethod
    def normalize_salary_period(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        mapping = {
            "yr": "yearly",
            "year": "yearly",
            "annual": "yearly",
            "annually": "yearly",
            "mo": "monthly",
            "month": "monthly",
            "hr": "hourly",
            "hour": "hourly",
            "wk": "weekly",
            "week": "weekly",
        }
        return mapping.get(v.lower(), v.lower())

    @field_validator("job_type")
    @classmethod
    def normalize_job_type(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        mapping = {
            "full time": "full-time",
            "fulltime": "full-time",
            "part time": "part-time",
            "parttime": "part-time",
            "freelance": "contract",
        }
        return mapping.get(v.lower(), v.lower())

    @model_validator(mode="after")
    def compute_content_hash(self):
        if self.content_hash is None:
            key_parts = [
                self.source,
                self.source_job_id,
                self.title or "",
                self.company_name or "",
                self.location or "",
                self.salary_raw or "",
                (self.description or "")[:500],
            ]
            raw = "|".join(key_parts)
            self.content_hash = hashlib.sha256(raw.encode()).hexdigest()
        return self
