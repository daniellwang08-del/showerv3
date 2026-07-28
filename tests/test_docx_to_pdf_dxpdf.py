"""PDF conversion must use the pure-Python dxpdf engine (no LibreOffice)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

dxpdf = pytest.importorskip("dxpdf")


def test_convert_docx_to_pdf_uses_dxpdf_only(tmp_path: Path) -> None:
    from app.models.resume_design_schemas import HeaderMetrics
    from app.services.resume_builder_service import convert_docx_to_pdf
    from app.services.resume_design_compiler import compile_design
    from app.services.resume_themes import default_design

    design = default_design()
    design.layout.header_metrics = HeaderMetrics(band_pt=90.0, gap_pt=12.0, measured_at_px=816)

    user = SimpleNamespace(
        first_name="Ada",
        last_name="Lovelace",
        profile_title="Software Engineer",
        profile_email="ada@example.com",
        email="ada@example.com",
        phone="+1 555-0100",
        phone_number="+1 555-0100",
        linkedin_url="linkedin.com/in/ada",
        github_url="github.com/ada",
        profile_summary="Mathematician and pioneering programmer.",
        work_experience=[
            {
                "company_name": "Analytical Engine Co",
                "role": "Engineer",
                "period_start": "2020-01",
                "period_end": None,
                "is_current": True,
                "location": "Remote",
                "contributions": ["Wrote the first algorithm notes."],
            }
        ],
        skills=[{"category": "Languages", "items": ["Python", "Math"]}],
        education=[],
        certificates=[],
    )

    docx_path = tmp_path / "resume.docx"
    pdf_path = tmp_path / "resume.pdf"
    compile_design(design, user, docx_path, apply_content=False)
    assert docx_path.exists() and docx_path.stat().st_size > 0

    out = convert_docx_to_pdf(docx_path, pdf_path)
    assert out == pdf_path
    assert pdf_path.exists()
    assert pdf_path.stat().st_size > 500
    # PDF magic header
    assert pdf_path.read_bytes()[:4] == b"%PDF"


def test_convert_docx_to_pdf_has_no_libreoffice_helpers() -> None:
    import app.services.resume_builder_service as mod

    assert not hasattr(mod, "_find_libreoffice")
    assert not hasattr(mod, "_convert_docx_to_pdf_libreoffice")
    assert not hasattr(mod, "_convert_docx_to_pdf_dxpdf")
