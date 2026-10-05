from app.utils.company_name import companies_match, normalize_company_name


def test_normalize_strips_legal_suffixes():
    assert normalize_company_name("Google LLC") == "google"
    assert normalize_company_name("Meta Platforms, Inc.") == "meta platforms"
    assert normalize_company_name("IBM Corporation") == "ibm"


def test_companies_match_aliases_and_rejects_short_containment():
    assert companies_match("Google LLC", "Google")
    assert companies_match("Meta", "Meta Platforms")
    assert not companies_match("A", "Acme")
    assert not companies_match("", "Google")
