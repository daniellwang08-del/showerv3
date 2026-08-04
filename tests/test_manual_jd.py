"""Unit tests for admin manual JD paste."""

from __future__ import annotations

import pytest

from app.services.manual_jd import MIN_MANUAL_JD_LENGTH, apply_manual_job_description


@pytest.mark.asyncio
async def test_apply_manual_jd_rejects_short_text():
    with pytest.raises(ValueError, match="at least"):
        await apply_manual_job_description(
            session=None,  # type: ignore[arg-type]
            job=None,  # type: ignore[arg-type]
            plain_text="short",
        )


@pytest.mark.asyncio
async def test_apply_manual_jd_rejects_empty():
    with pytest.raises(ValueError, match="at least"):
        await apply_manual_job_description(
            session=None,  # type: ignore[arg-type]
            job=None,  # type: ignore[arg-type]
            plain_text="   ",
        )


def test_min_manual_jd_length_matches_schema():
    assert MIN_MANUAL_JD_LENGTH == 10
