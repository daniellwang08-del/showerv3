"""Tests for resume artifact path resolution (local vs VPS CWD)."""

from pathlib import Path

from app.services.resume_builder_service import (
    build_output_directory,
    resolve_resume_artifact_path,
    resume_output_root,
)


def test_resume_output_root_is_absolute(tmp_path, monkeypatch):
    from app.core.config import get_settings
    from app.services import resume_builder_service as rbs

    get_settings.cache_clear()
    monkeypatch.setattr(rbs, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setenv("RESUME_OUTPUT_ROOT", "./resume_output")
    get_settings.cache_clear()
    root = resume_output_root()
    assert root.is_absolute()
    assert root == (tmp_path / "resume_output").resolve()
    get_settings.cache_clear()


def test_build_output_directory_stores_absolute(tmp_path, monkeypatch):
    from app.core.config import get_settings
    from app.services import resume_builder_service as rbs

    get_settings.cache_clear()
    monkeypatch.setattr(rbs, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setenv("RESUME_OUTPUT_ROOT", "./resume_output")
    get_settings.cache_clear()
    out = build_output_directory("Acme Corp", "job-aaaa-1111")
    assert out.is_absolute()
    assert out.is_dir()
    assert out == (tmp_path / "resume_output" / "Acme_Corp" / "job-aaaa-1111").resolve()
    get_settings.cache_clear()


def test_resolve_relative_artifact_from_other_cwd(tmp_path, monkeypatch):
    """DB-relative paths must still resolve after CWD changes (the VPS failure mode)."""
    from app.core.config import get_settings
    from app.services import resume_builder_service as rbs

    get_settings.cache_clear()
    monkeypatch.setattr(rbs, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setenv("RESUME_OUTPUT_ROOT", "./resume_output")
    get_settings.cache_clear()

    out = build_output_directory("Vannevar", "980f97d1-d55f-4abb-87ea-b33aa328d8af")
    pdf = out / "Chujia_Liu_resume.pdf"
    pdf.write_bytes(b"%PDF-1.4 test")

    stored = "resume_output/Vannevar/980f97d1-d55f-4abb-87ea-b33aa328d8af/Chujia_Liu_resume.pdf"
    assert (tmp_path / stored).is_file()

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    assert not Path(stored).is_file()
    resolved = resolve_resume_artifact_path(stored)
    assert resolved is not None
    assert resolved.is_file()
    assert resolved.read_bytes().startswith(b"%PDF-")
    get_settings.cache_clear()
