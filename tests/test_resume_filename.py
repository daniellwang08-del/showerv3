from datetime import date
from types import SimpleNamespace

import pytest

from app.services.resume_filename import (
    document_filename_for_user,
    document_stem_for_user,
    job_document_names,
    normalize_filename_value,
    normalize_job_filename,
    resolve_document_stem,
)


def _user(mode="pattern", value="{firstname}_{lastname}_{kind}", first="Jane", last="Doe"):
    return SimpleNamespace(
        resume_filename_mode=mode, resume_filename_value=value, name_first=first, name_last=last
    )


def _stem(value, kind="resume", mode="pattern", **ctx):
    return resolve_document_stem(mode=mode, value=value, first_name="Jane", last_name="Doe", kind=kind, **ctx)


def test_default_pattern_matches_the_old_names():
    assert _stem("{firstname}_{lastname}_{kind}") == "Jane_Doe_resume"
    assert _stem("{firstname}_{lastname}_{kind}", "cover_letter") == "Jane_Doe_cover_letter"


def test_job_fields_fill_in_and_are_sanitized():
    stem = _stem("{fullname}-{company}-{title}", company="Acme, Inc.", title="Sr. Engineer / Platform")
    assert stem == "Jane_Doe-Acme_Inc-Sr.Engineer_Platform"


def test_missing_fields_drop_their_separators():
    assert _stem("{firstname}_{company}_{lastname}", company="") == "Jane_Doe"
    assert _stem("{company}_{firstname}", company="") == "Jane"


def test_cover_letter_without_kind_gets_a_distinct_name():
    assert _stem("{firstname}_{company}", company="Acme") == "Jane_Acme"
    assert _stem("{firstname}_{company}", "cover_letter", company="Acme") == "Jane_Acme_cover_letter"


def test_static_names():
    assert _stem("My Resume", mode="static") == "My_Resume"
    assert _stem("My Resume", "cover_letter", mode="static") == "My_Resume_cover_letter"


def test_plain_words_are_not_fields():
    assert _stem("Title_Last_Resume") == "Title_Last_Resume"


def test_date_field():
    stem = resolve_document_stem(
        mode="pattern", value="{lastname}_{date}", first_name="Jane", last_name="Doe", on=date(2026, 10, 8)
    )
    assert stem == "Doe_2026-10-08"


def test_aliases_and_case():
    assert _stem("{First}_{LAST}_{role}", title="Engineer") == "Jane_Doe_Engineer"


def test_validation():
    with pytest.raises(ValueError, match="Unknown field"):
        normalize_filename_value("pattern", "{firstname}_{salary}")
    with pytest.raises(ValueError, match="path characters"):
        normalize_filename_value("pattern", "a/b")
    with pytest.raises(ValueError, match="Enter a file name"):
        normalize_filename_value("static", "  ")
    assert normalize_filename_value("pattern", "") == "{firstname}_{lastname}_{kind}"
    assert normalize_job_filename("  ") is None
    assert normalize_job_filename(" {company}_cv ") == "{company}_cv"


def test_user_rule_and_job_override():
    user = _user(value="{firstname}_{lastname}_{company}_{kind}")
    assert document_stem_for_user(user, company="Acme") == "Jane_Doe_Acme_resume"
    assert document_stem_for_user(user, title="Engineer", job_filename="Jane_{title}") == "Jane_Engineer"
    static = _user(mode="static", value="Fixed")
    assert document_stem_for_user(static, company="Acme", job_filename="{company}_Jane") == "Acme_Jane"


def test_filenames_and_job_names():
    user = _user()
    assert document_filename_for_user(user, "resume_pdf", company="Acme") == "Jane_Doe_resume.pdf"
    assert document_filename_for_user(user, "cover_letter_docx") == "Jane_Doe_cover_letter.docx"
    names = job_document_names(user, company="Acme", title="Engineer", job_filename="{company}_{lastname}")
    assert names == {"resume": "Acme_Doe", "cover_letter": "Acme_Doe_cover_letter"}


def test_name_without_profile_name_falls_back():
    user = _user(first="", last="")
    assert document_stem_for_user(user) == "resume"
    assert document_stem_for_user(user, "cover_letter") == "cover_letter"
