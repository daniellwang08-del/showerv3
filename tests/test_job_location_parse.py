from app.services.job_location_classifier import detect_countries_in_text
from app.services.job_location_parse import (
    infer_location_from_text,
    location_specificity,
    prefer_job_location,
)


def test_city_only_and_city_country():
    assert detect_countries_in_text("London") == ["GB"]
    assert detect_countries_in_text("Berlin, Germany") == ["DE"]
    assert detect_countries_in_text("San Francisco, CA") == ["US"]
    assert detect_countries_in_text("Toronto") == ["CA"]
    assert detect_countries_in_text("Remote, United States") == ["US"]
    assert detect_countries_in_text("Bengaluru") == ["IN"]
    assert detect_countries_in_text("Amsterdam / Berlin") == ["DE", "NL"]


def test_region_overrides_city_default():
    assert detect_countries_in_text("Paris, TX") == ["US"]
    assert detect_countries_in_text("London, ON") == ["CA"]
    assert detect_countries_in_text("Paris") == ["FR"]
    assert detect_countries_in_text("Berlin, DE") == ["DE"]
    assert infer_location_from_text("This role is based in Dublin, Ireland. Apply today.") == "Dublin, Ireland"


def test_prefer_keeps_specific_over_remote():
    assert prefer_job_location("San Francisco, CA, United States", "Remote") == (
        "San Francisco, CA, United States"
    )
    assert prefer_job_location("Remote", "London, UK") == "London, UK"
    assert prefer_job_location(None, "Berlin") == "Berlin"
    assert location_specificity("San Francisco, CA") > location_specificity("Remote, United States")


def test_infer_from_labeled_and_based_in():
    text = """Title: Engineer
Location: Munich, Germany
Company: Acme

We are a team based in collaboration and trust.
"""
    assert infer_location_from_text(text) == "Munich, Germany"

    body = "This role is based in Dublin, Ireland. Apply today."
    assert infer_location_from_text(body) == "Dublin, Ireland"
