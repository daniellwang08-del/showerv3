"""
Sanitize text for PostgreSQL TEXT columns.
PostgreSQL rejects null bytes (0x00) and requires valid UTF-8.
"""


def sanitize_for_postgres_text(value: str | bytes | None) -> str | None:
    """
    Sanitize text for PostgreSQL TEXT columns.
    Removes null bytes and replaces invalid UTF-8 sequences.
    """
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8", errors="replace")
        except Exception:
            value = value.decode("latin-1", errors="replace")
    elif not isinstance(value, str):
        value = str(value)
    # Remove null bytes (PostgreSQL CharacterNotInRepertoireError)
    value = value.replace("\x00", "")
    # Replace invalid UTF-8 sequences
    value = value.encode("utf-8", errors="replace").decode("utf-8")
    return value if value else None
