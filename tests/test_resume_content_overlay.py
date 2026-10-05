from types import SimpleNamespace

from app.models.resume_design_schemas import ResumeContent
from app.services.resume_content_overlay import apply_content_overlay
from app.services.resume_location import format_resume_header_location


def test_overlay_location_updates_address():
    user = SimpleNamespace(
        address={"city": "Boston", "state": "MA", "country": "United States"},
        name_first="Ada",
    )
    content = ResumeContent(location="London, United Kingdom", name_first="Ada")
    overlaid = apply_content_overlay(user, content)
    formatted = format_resume_header_location(overlaid.address)
    assert formatted == "London, United Kingdom"


def test_blank_location_keeps_profile_address():
    user = SimpleNamespace(address={"city": "Boston", "state": "MA", "country": "United States"})
    overlaid = apply_content_overlay(user, ResumeContent(name_first="Ada"))
    assert format_resume_header_location(overlaid.address) == "Boston, MA"
