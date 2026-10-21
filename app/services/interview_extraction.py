"""Turn hiring emails into structured interview steps.

A keyword prefilter keeps job alerts, newsletters and unrelated mail away from
the LLM; the LLM then classifies the remaining messages and pulls out company,
role, round, time and next steps. Everything returned is validated here so the
sync code only ever sees clean values.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.llm_client import chat_completion_with_empty_retry, get_llm_client_for_user
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

LLM_JOB_TYPE = "interview_mail"
BATCH_SIZE = 6
BODY_CHARS = 3500

KINDS = (
    "recruiter_screen",
    "assessment",
    "technical",
    "behavioral",
    "hiring_manager",
    "onsite",
    "final",
    "offer",
    "rejection",
    "scheduling",
    "application_received",
    "other",
)
STATUSES = ("scheduled", "needs_scheduling", "action_required", "completed", "cancelled", "info")

_SIGNALS = re.compile(
    r"\b(interview\w*|phone screen|screening call|recruiter call|intro(ductory)? call|"
    r"hiring manager|on-?site|panel|technical (round|screen|assessment)|coding (challenge|test|exercise)|"
    r"take[- ]home|assessment|hackerrank|codility|codesignal|karat|"
    r"availability|time slots?|schedul\w+|calendly|goodtime|reschedul\w+|"
    r"next steps?|next round|move forward|moving forward|"
    r"offer letter|job offer|offer of employment|pleased to offer|"
    r"unfortunately|not (be )?moving forward|other candidates|regret to inform|decided not to proceed|"
    r"invitation:)",
    re.IGNORECASE,
)
# Application confirmations. Job boards send these from addresses that also
# send alerts (jobs-noreply@linkedin.com), so a match here skips the sender check.
_APPLIED_SIGNALS = re.compile(
    r"(thanks? (you )?for (applying|your application|submitting your application)|"
    r"application (was |has been )?(received|submitted|sent|confirmation)|"
    r"(received|receipt of) your application|your application (to|for|at|was sent|has been)|"
    r"successfully (applied|submitted)|you applied (to|for)|application submitted)",
    re.IGNORECASE,
)
_NOISE_SENDERS = re.compile(
    r"(jobalerts?|job-alerts?|jobs-noreply|jobs-listings|newsletter|digest|marketing|promo|"
    r"notifications?@(linkedin|indeed|glassdoor|ziprecruiter)|noreply@(medium|substack))",
    re.IGNORECASE,
)
_NOISE_SUBJECTS = re.compile(
    r"(job alert|jobs? (you might|for you|recommended)|new jobs? (match|for)|recommended jobs|"
    r"is hiring|apply now|top job picks|webinar|newsletter|% off|sale ends)",
    re.IGNORECASE,
)
# Teams and Outlook invites carry only the meeting title and a join link.
_MEETING = re.compile(
    r"(teams\.microsoft\.com/|microsoft teams meeting|zoom\.us/(j|my)/|meet\.google\.com/|webex\.com/|\bmeeting id\b)",
    re.IGNORECASE,
)
_COMPANY_SUFFIX = re.compile(
    r"[,.]?\s+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|plc|pty|s\.a|sa|ag|bv)\.?$",
    re.IGNORECASE,
)


def is_candidate(subject: str | None, snippet: str | None, sender: str | None, *, invite: bool = False) -> bool:
    """Cheap check: could this email be about an application or interview process?

    ``invite`` is true when the email carries a calendar invitation; with a
    meeting link, that is enough to let the model decide.
    """
    subject = subject or ""
    if _NOISE_SUBJECTS.search(subject):
        return False
    if _APPLIED_SIGNALS.search(subject):
        return True
    if _NOISE_SENDERS.search(sender or ""):
        return False
    if invite:
        return True
    text = f"{subject}\n{snippet or ''}"
    return bool(_SIGNALS.search(text) or _APPLIED_SIGNALS.search(text) or _MEETING.search(text))


def company_key(name: str | None) -> str:
    """Normalised company name for grouping ('Acme, Inc.' and 'ACME' match)."""
    value = (name or "").strip().lower()
    for _ in range(2):
        value = _COMPANY_SUFFIX.sub("", value).strip()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


SYSTEM_PROMPT = """You read a job seeker's emails and extract interview pipeline steps.

For each email return one result. Return ONLY JSON:
{"results": [{
  "id": "<email id>",
  "relevant": true|false,
  "company": "<hiring company, not the ATS or agency tool>"|null,
  "role": "<job title>"|null,
  "kind": "recruiter_screen|assessment|technical|behavioral|hiring_manager|onsite|final|offer|rejection|scheduling|application_received|other",
  "status": "scheduled|needs_scheduling|action_required|completed|cancelled|info",
  "title": "<short name of this step, e.g. 'Technical interview with Jane'>",
  "scheduled_at": "<ISO 8601 with UTC offset>"|null,
  "duration_minutes": <int>|null,
  "meeting_url": "<video call link>"|null,
  "location": "<address or 'Phone'>"|null,
  "interviewers": "<names>"|null,
  "next_step": "<what the candidate should do next>"|null,
  "remaining_steps": ["<later rounds the email mentions>"],
  "summary": "<one sentence, max 200 characters>"
}]}

Rules:
- relevant=true only for emails about the candidate's own application or interview process with an employer or recruiter. Job alerts, marketing, newsletters and generic recruiter outreach without a process are relevant=false.
- kind "application_received" (status "info") is a confirmation that the candidate's application was submitted or received, including job board confirmations such as "Your application was sent to Acme". company is the employer the candidate applied to (not LinkedIn, Indeed, Workday, Greenhouse or another tool) and role is the job title applied for. When the application went through a recruiting platform or agency ("Your application through Clera"), company is the employer named in the email, not the platform. "Your application was viewed" and similar updates are kind "other". Account creation or welcome emails, email or profile verification, reminders to finish an application that was not submitted, and surveys are kind "other" unless they also say the application was received.
- kind: the step the email is about. A request to pick a time is kind "scheduling" with status "needs_scheduling" unless the round type is clear, then use that round's kind with status "needs_scheduling".
- status: "scheduled" when a date and time are confirmed, "needs_scheduling" when they ask for availability or a booking link, "action_required" when the candidate must do something else (complete an assessment, sign, reply), "cancelled" for cancellations, "completed" for thank-you notes after a round, otherwise "info".
- company: when a staffing agency or recruiting firm runs the process and does not name the employer, use the agency's name (for example "Onward Search") rather than null.
- A "Calendar invitation attached" block is the event from the email's .ics file. A meeting invite from an employer or recruiter, even one titled only with the company or role, is that round with status "scheduled" (or "cancelled" when it says so); take its time, link and organizer from the block. Personal and non-hiring meetings are relevant=false.
- scheduled_at: only when the email states a concrete date and time. Resolve relative dates ("tomorrow") from the email's received time. If no timezone is given, use the candidate timezone provided.
- Never invent companies, times, links or people. Use null when unsure.
"""


def _user_message(messages: list[dict[str, Any]], tz_name: str) -> str:
    parts = [f"Candidate timezone: {tz_name}", ""]
    for m in messages:
        parts.append(
            "\n".join(
                [
                    f"=== Email id: {m['id']}",
                    f"Received: {m.get('received_iso') or 'unknown'}",
                    f"From: {m.get('from') or ''}",
                    f"Subject: {m.get('subject') or ''}",
                    "",
                    (m.get("body") or m.get("snippet") or "")[:BODY_CHARS],
                ]
            )
        )
    return "\n\n".join(parts)


def _clean_str(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit] if value else None


def _tz(tz_name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def parse_scheduled_at(value: Any, tz_name: str | None) -> datetime | None:
    """ISO string from the model as naive UTC; naive input is read in the user's timezone."""
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_tz(tz_name))
    if not 2000 <= dt.year <= 2100:
        return None
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def normalize_result(raw: Any, tz_name: str | None) -> dict[str, Any] | None:
    """Validated extraction for one email, or None when it isn't usable."""
    if not isinstance(raw, dict) or not raw.get("relevant"):
        return None
    company = _clean_str(raw.get("company"), 300)
    if not company or not company_key(company):
        return None
    kind = raw.get("kind") if raw.get("kind") in KINDS else "other"
    status = raw.get("status") if raw.get("status") in STATUSES else "info"
    scheduled_at = parse_scheduled_at(raw.get("scheduled_at"), tz_name)
    if status == "scheduled" and scheduled_at is None:
        status = "info"
    duration = raw.get("duration_minutes")
    duration = int(duration) if isinstance(duration, (int, float)) and 5 <= duration <= 600 else None
    url = _clean_str(raw.get("meeting_url"), 1000)
    if url and not url.lower().startswith(("https://", "http://")):
        url = None
    steps = raw.get("remaining_steps")
    remaining = [s for s in (_clean_str(x, 120) for x in steps) if s][:6] if isinstance(steps, list) else []
    return {
        "company": company,
        "role": _clean_str(raw.get("role"), 300),
        "kind": kind,
        "status": status,
        "title": _clean_str(raw.get("title"), 300),
        "scheduled_at": scheduled_at,
        "duration_minutes": duration,
        "meeting_url": url,
        "location": _clean_str(raw.get("location"), 500),
        "interviewers": _clean_str(raw.get("interviewers"), 500),
        "next_step": _clean_str(raw.get("next_step"), 500),
        "remaining_steps": remaining,
        "summary": _clean_str(raw.get("summary"), 400),
    }


def parse_results(text: str) -> dict[str, Any]:
    """Map email id -> raw result from the model's JSON."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    data = json.loads(raw)
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        return {}
    return {str(r.get("id")): r for r in results if isinstance(r, dict) and r.get("id") is not None}


async def extract_batch(
    user_id: str, messages: list[dict[str, Any]], *, tz_name: str
) -> dict[str, dict[str, Any] | None]:
    """Classify up to BATCH_SIZE emails. Returns id -> normalised result (None = not relevant)."""
    if not messages:
        return {}
    client = await get_llm_client_for_user(user_id, job_type=LLM_JOB_TYPE)
    text, _ = await chat_completion_with_empty_retry(
        client,
        observe=LLM_JOB_TYPE,
        job_type=LLM_JOB_TYPE,
        raise_on_empty=False,
        model=get_settings().openai_model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _user_message(messages, tz_name)},
        ],
        response_format={"type": "json_object"},
        temperature=0.1,
    )
    try:
        by_id = parse_results(text)
    except (json.JSONDecodeError, ValueError, AttributeError) as e:
        logger.warning("interview_extract_bad_json", error=str(e), size=len(messages))
        return {}
    return {m["id"]: normalize_result(by_id.get(m["id"]), tz_name) for m in messages}
