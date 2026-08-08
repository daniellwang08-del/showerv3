"""Regression: dashboard "Added from" must name the scrape site, not a generic bucket."""

from app.api.routes import resolve_dashboard_added_from


def test_manual_submission():
    assert resolve_dashboard_added_from({"submitted_data": {"url": "https://x"}}) == "manual"


def test_admin_manual_submission():
    assert (
        resolve_dashboard_added_from(
            {"submitted_data": {"url": "https://x"}, "submitted_by_admin": True}
        )
        == "admin_manual"
    )
    assert (
        resolve_dashboard_added_from(
            {"submitted_data": {"url": "https://x"}, "submitted_by_admin": "true"}
        )
        == "admin_manual"
    )
    assert (
        resolve_dashboard_added_from(
            {"submitted_data": {"url": "https://x"}, "submitted_by": "admin"}
        )
        == "admin_manual"
    )


def test_scraped_source_slug():
    assert resolve_dashboard_added_from({"scraped_source": "remoterocketship"}) == "remoterocketship"
    assert resolve_dashboard_added_from({"scraped_source": "JobRight"}) == "jobright"
    assert resolve_dashboard_added_from({"scraped_source": " welcometothejungle "}) == "welcometothejungle"
    assert resolve_dashboard_added_from({"scraped_source": "adzuna"}) == "adzuna"


def test_legacy_job_sites_when_missing():
    assert resolve_dashboard_added_from({}) == "job_sites"
    assert resolve_dashboard_added_from(None) == "job_sites"
    assert resolve_dashboard_added_from({"scraped_source": ""}) == "job_sites"
    assert resolve_dashboard_added_from({"scraped_source": "unknown"}) == "job_sites"


def test_manual_wins_over_scraped_source():
    assert (
        resolve_dashboard_added_from(
            {"submitted_data": True, "scraped_source": "jobright"}
        )
        == "manual"
    )


def test_admin_manual_wins_over_scraped_source():
    assert (
        resolve_dashboard_added_from(
            {
                "submitted_data": True,
                "submitted_by_admin": True,
                "scraped_source": "jobright",
            }
        )
        == "admin_manual"
    )
