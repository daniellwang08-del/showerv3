"""Read the event out of a calendar invitation (.ics) attached to an email.

Outlook and Teams invites often carry no date in the email body: the time
lives only in the attachment, and its timezone is a Windows name such as
"Eastern Standard Time". Only the first VEVENT is read.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Windows timezone names Outlook writes in TZID, mapped to IANA zones.
WINDOWS_ZONES = {
    "dateline standard time": "Etc/GMT+12",
    "hawaiian standard time": "Pacific/Honolulu",
    "alaskan standard time": "America/Anchorage",
    "pacific standard time": "America/Los_Angeles",
    "us mountain standard time": "America/Phoenix",
    "mountain standard time": "America/Denver",
    "central standard time": "America/Chicago",
    "canada central standard time": "America/Regina",
    "central america standard time": "America/Guatemala",
    "central standard time (mexico)": "America/Mexico_City",
    "eastern standard time": "America/New_York",
    "us eastern standard time": "America/Indiana/Indianapolis",
    "atlantic standard time": "America/Halifax",
    "newfoundland standard time": "America/St_Johns",
    "e. south america standard time": "America/Sao_Paulo",
    "sa pacific standard time": "America/Bogota",
    "argentina standard time": "America/Buenos_Aires",
    "utc": "UTC",
    "coordinated universal time": "UTC",
    "gmt standard time": "Europe/London",
    "greenwich standard time": "Atlantic/Reykjavik",
    "w. europe standard time": "Europe/Berlin",
    "central europe standard time": "Europe/Budapest",
    "central european standard time": "Europe/Warsaw",
    "romance standard time": "Europe/Paris",
    "e. europe standard time": "Europe/Chisinau",
    "fle standard time": "Europe/Kiev",
    "gtb standard time": "Europe/Bucharest",
    "turkey standard time": "Europe/Istanbul",
    "israel standard time": "Asia/Jerusalem",
    "south africa standard time": "Africa/Johannesburg",
    "russian standard time": "Europe/Moscow",
    "arabian standard time": "Asia/Dubai",
    "pakistan standard time": "Asia/Karachi",
    "india standard time": "Asia/Kolkata",
    "bangladesh standard time": "Asia/Dhaka",
    "se asia standard time": "Asia/Bangkok",
    "china standard time": "Asia/Shanghai",
    "singapore standard time": "Asia/Singapore",
    "taipei standard time": "Asia/Taipei",
    "tokyo standard time": "Asia/Tokyo",
    "korea standard time": "Asia/Seoul",
    "aus eastern standard time": "Australia/Sydney",
    "e. australia standard time": "Australia/Brisbane",
    "w. australia standard time": "Australia/Perth",
    "new zealand standard time": "Pacific/Auckland",
}

_LINK = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_MEETING_HOST = re.compile(r"teams\.microsoft\.com|zoom\.us|meet\.google\.com|webex\.com|whereby\.com|gotomeeting\.com", re.I)


@dataclass
class Invite:
    title: str | None = None
    start: datetime | None = None  # naive UTC when the zone is known
    end: datetime | None = None
    start_local: str | None = None  # "2026-10-22 17:00 (Some Zone)" when it is not
    organizer: str | None = None
    location: str | None = None
    meeting_url: str | None = None
    cancelled: bool = False

    @property
    def duration_minutes(self) -> int | None:
        if self.start and self.end and self.end > self.start:
            minutes = int((self.end - self.start).total_seconds() // 60)
            return minutes if 5 <= minutes <= 600 else None
        return None

    def describe(self) -> str:
        """Lines for the extraction prompt."""
        lines = ["Calendar invitation attached:"]
        if self.cancelled:
            lines.append("Status: CANCELLED")
        if self.title:
            lines.append(f"Event: {self.title}")
        if self.start:
            lines.append(f"Starts: {self.start.replace(tzinfo=timezone.utc).isoformat()}")
        elif self.start_local:
            lines.append(f"Starts: {self.start_local}")
        if self.duration_minutes:
            lines.append(f"Duration: {self.duration_minutes} minutes")
        if self.organizer:
            lines.append(f"Organizer: {self.organizer}")
        if self.location:
            lines.append(f"Location: {self.location}")
        if self.meeting_url:
            lines.append(f"Meeting link: {self.meeting_url}")
        return "\n".join(lines)


def _unfold(text: str) -> list[str]:
    return re.sub(r"\r?\n[ \t]", "", text).replace("\r", "").split("\n")


def _unescape(value: str) -> str:
    return (
        value.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()
    )


def _split(line: str) -> tuple[str, dict[str, str], str]:
    """'DTSTART;TZID=X:2026...' -> ('DTSTART', {'TZID': 'X'}, '2026...')."""
    quoted = False
    cut = len(line)
    for i, ch in enumerate(line):
        if ch == '"':
            quoted = not quoted
        elif ch == ":" and not quoted:
            cut = i
            break
    head, value = line[:cut], line[cut + 1 :]
    name, *params = head.split(";")
    parsed = {}
    for p in params:
        k, _, v = p.partition("=")
        parsed[k.upper()] = v.strip('"')
    return name.upper(), parsed, value


def zone_for(tzid: str | None) -> ZoneInfo | None:
    if not tzid:
        return None
    name = tzid.strip().strip('"')
    for candidate in (name, WINDOWS_ZONES.get(name.lower())):
        if not candidate:
            continue
        try:
            return ZoneInfo(candidate)
        except (ZoneInfoNotFoundError, ValueError):
            continue
    return None


def _when(params: dict[str, str], value: str) -> tuple[datetime | None, str | None]:
    """(naive UTC, None) when the time can be placed; (None, readable local) when not."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        try:
            d = date(int(value[:4]), int(value[4:6]), int(value[6:8]))
        except ValueError:
            return None, None
        return None, f"{d.isoformat()} (all day)"
    m = re.fullmatch(r"(\d{8})T(\d{6})(Z?)", value)
    if not m:
        return None, None
    try:
        local = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    except ValueError:
        return None, None
    if m.group(3):
        return local, None
    zone = zone_for(params.get("TZID"))
    if zone is None:
        label = params.get("TZID") or "timezone not stated"
        return None, f"{local:%Y-%m-%d %H:%M} ({label})"
    return local.replace(tzinfo=zone).astimezone(timezone.utc).replace(tzinfo=None), None


def parse_invite(text: str) -> Invite | None:
    if not text or "BEGIN:VEVENT" not in text.upper():
        return None
    invite = Invite()
    method = ""
    in_event = False
    nested = 0  # depth of blocks inside the event (VALARM), whose properties are skipped
    links: list[str] = []
    for line in _unfold(text):
        if not line:
            continue
        name, params, value = _split(line)
        block = value.strip().upper()
        if name == "METHOD":
            method = block
        elif name == "BEGIN" and block == "VEVENT" and not in_event:
            in_event = True
        elif not in_event:
            continue
        elif name == "BEGIN":
            nested += 1
        elif name == "END":
            if nested:
                nested -= 1
            elif block == "VEVENT":
                break
        elif nested:
            continue
        elif name == "SUMMARY":
            invite.title = _unescape(value)[:300] or None
        elif name == "DTSTART":
            invite.start, invite.start_local = _when(params, value)
        elif name == "DTEND":
            invite.end, _ = _when(params, value)
        elif name == "ORGANIZER":
            cn = params.get("CN")
            email = value.split(":", 1)[-1] if value.lower().startswith("mailto:") else value
            invite.organizer = (f"{cn} <{email}>" if cn else email)[:300] or None
        elif name == "LOCATION":
            invite.location = _unescape(value)[:300] or None
            links += _LINK.findall(value)
        elif name in ("URL", "X-GOOGLE-CONFERENCE", "DESCRIPTION", "X-ALT-DESC"):
            links += _LINK.findall(_unescape(value))
        elif name == "STATUS" and value.strip().upper() == "CANCELLED":
            invite.cancelled = True
    if method == "CANCEL":
        invite.cancelled = True
    invite.meeting_url = next((u.rstrip(".,;)>") for u in links if _MEETING_HOST.search(u)), None)
    if not (invite.title or invite.start or invite.start_local):
        return None
    return invite
