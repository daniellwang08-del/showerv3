from app.utils.resume_text_format import parse_bold_markers, strip_bold_markers


def test_parse_bold_markers_single():
    parts = parse_bold_markers("Led **Kafka** pipeline")
    assert parts == [("Led ", False), ("Kafka", True), (" pipeline", False)]


def test_parse_bold_markers_multiple():
    parts = parse_bold_markers("**Python** and **AWS**")
    assert parts == [("Python", True), (" and ", False), ("AWS", True)]


def test_parse_bold_markers_plain():
    assert parse_bold_markers("no markup") == [("no markup", False)]


def test_strip_bold_markers():
    assert strip_bold_markers("Built **Java** APIs") == "Built Java APIs"
