"""Schemas for cover letter AI prompt settings."""

from pydantic import BaseModel


class CoverLetterPromptDefaultsResponse(BaseModel):
    default_instructions: str
    max_length: int
    min_length: int
