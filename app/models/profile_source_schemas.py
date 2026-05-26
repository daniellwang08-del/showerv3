from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class SourceDocumentProject(BaseModel):
    name: str | None = None
    summary: str | None = None
    technologies: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    outcomes: list[str] = Field(default_factory=list)


class SourceDocumentStructured(BaseModel):
    company_name: str | None = None
    projects: list[SourceDocumentProject] = Field(default_factory=list)


class ProfileSourceDocumentResponse(BaseModel):
    id: str
    filename: str
    source_kind: str
    company_name: str | None = None
    char_count: int = 0
    project_count: int = 0
    parse_status: str
    parse_error: str | None = None
    created_at: datetime
    updated_at: datetime


class ProfileSourceDocumentListResponse(BaseModel):
    documents: list[ProfileSourceDocumentResponse] = Field(default_factory=list)


class ProfileSourceDocumentUpdateRequest(BaseModel):
    company_name: str = Field(..., min_length=1, max_length=200)

    @field_validator("company_name", mode="before")
    @classmethod
    def strip_company(cls, v: str) -> str:
        return str(v or "").strip()


class ProfileSourceDocumentUploadResponse(BaseModel):
    document: ProfileSourceDocumentResponse
    warnings: list[str] = Field(default_factory=list)
