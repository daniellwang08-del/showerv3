from datetime import datetime, timedelta, timezone

import pytest

from app.services import nylas_service, verification_codes
from app.services.verification_codes import extract_code, mentions_company


GREENHOUSE_BODY = """Hi Nathan,

Copy and paste this code into the security code field on your application:

8TG4jLy3

After you enter the code, resubmit your application.
This code will expire in 15 minutes."""


def test_greenhouse_code_on_its_own_line():
    assert extract_code("Security code for your application to Acme", GREENHOUSE_BODY) == "8TG4jLy3"


def test_inline_numeric_code():
    assert extract_code("Verify your email", "Your verification code is 482913. It expires in 10 minutes.") == "482913"


def test_code_in_subject_only():
    assert extract_code("Your one-time passcode: 739201", "") == "739201"


def test_shouty_letter_code():
    assert extract_code("Confirm your application", "Your confirmation code: QXTRWB") == "QXTRWB"


def test_ignores_mail_without_code_keywords():
    assert extract_code("Thanks for applying to Acme", "We received your application on 2026-10-19. Ref 48291.") is None


def test_skips_years_and_plain_words():
    text = "Your security code expires in 2026. Please enter the code below.\nZ7Q9K2"
    assert extract_code("Security code", text) == "Z7Q9K2"


def test_company_matching():
    assert mentions_company("Acme, Inc.", "Security code for your application to Acme")
    assert mentions_company("Stripe", "no-reply@stripe.com")
    assert not mentions_company("Acme", "Security code for your application to Globex")
    assert not mentions_company(None, "anything")


@pytest.mark.asyncio
async def test_find_code_prefers_matching_company(monkeypatch):
    now = int(datetime.now(timezone.utc).timestamp())
    messages = [
        {"id": "m2", "subject": "Security code for your application to Globex", "snippet": "", "from": [{"email": "no-reply@us.greenhouse-mail.io"}], "date": now},
        {"id": "m1", "subject": "Security code for your application to Acme", "snippet": "", "from": [{"email": "no-reply@us.greenhouse-mail.io"}], "date": now - 30},
    ]
    bodies = {"m2": GREENHOUSE_BODY.replace("8TG4jLy3", "GLOBEX99"), "m1": GREENHOUSE_BODY}

    async def fake_list(grant_id, *, received_after, max_messages):
        return messages

    async def fake_get(grant_id, message_id):
        return {"body": bodies[message_id]}

    monkeypatch.setattr(nylas_service, "list_messages", fake_list)
    monkeypatch.setattr(nylas_service, "get_message", fake_get)

    since = datetime.now(timezone.utc) - timedelta(minutes=2)
    found = await verification_codes.find_code("g", since=since, company="Acme")
    assert found and found["code"] == "8TG4jLy3"
    assert "Acme" in found["subject"]

    again = await verification_codes.find_code("g", since=since, company="Acme", exclude={"8TG4jLy3"})
    assert again is None
