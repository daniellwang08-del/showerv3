import json
import re
from app.core.config import get_settings
from app.core.openai_client import get_openai_client
from app.core.logging import get_logger
from app.core.exceptions import AIParsingError
from app.models.schemas import JobDescriptionSchema
from app.services.job_content_cleaner import plain_text_from_document_html

logger = get_logger(__name__)

EXTRACTION_PROMPT = """Extract job posting information from the following content and return a JSON object with these fields:
- title: Job title (required, string)
- company: Company name (string or null)
- location: Job location (string or null)
- employment_type: Full-time, Part-time, Contract, etc. (string or null)
- salary_range: Salary information if mentioned (string or null). Prefer one concise range or short phrase; avoid pasting long multi-state tables.
- description: Full job description text (required, string)
- responsibilities: List of job responsibilities (array of strings)
- requirements: List of job requirements/qualifications (array of strings)
- benefits: List of benefits if mentioned (array of strings)
- remote_policy: Remote work policy if mentioned (string or null)
- experience_level: Required experience level (string or null)
- industry: Industry/sector (string or null)

Return ONLY valid JSON without any markdown formatting or explanation.

Content:
{content}"""

MAX_CONTENT_LENGTH = 50000


class AIParser:
    def __init__(self):
        self._settings = get_settings()

    async def parse(self, content: str) -> tuple[JobDescriptionSchema, float]:
        client = get_openai_client()
        truncated_content = self._prepare_content_for_llm(content)

        try:
            response = await client.chat.completions.create(
                model=self._settings.openai_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a job posting parser. Extract structured information from job postings accurately.",
                    },
                    {
                        "role": "user",
                        "content": EXTRACTION_PROMPT.format(content=truncated_content),
                    },
                ],
                temperature=self._settings.openai_temperature,
                max_tokens=self._settings.openai_max_tokens,
                response_format={"type": "json_object"},
            )

            result_text = response.choices[0].message.content
            if not result_text:
                raise AIParsingError("Empty response from AI model")

            parsed_data = json.loads(result_text)
            confidence = self._calculate_confidence(parsed_data)

            # Validate if content looks like a job posting
            title = parsed_data.get("title")
            description = parsed_data.get("description", "")
            if not title and len(description) < 50:
                raise AIParsingError("Content does not appear to contain job posting information")

            job_data = JobDescriptionSchema(
                title=title or "Unknown Position",
                company=parsed_data.get("company"),
                location=parsed_data.get("location"),
                employment_type=parsed_data.get("employment_type"),
                salary_range=parsed_data.get("salary_range"),
                description=description or "No description available",
                responsibilities=parsed_data.get("responsibilities", []),
                requirements=parsed_data.get("requirements", []),
                benefits=parsed_data.get("benefits", []),
                remote_policy=parsed_data.get("remote_policy"),
                experience_level=parsed_data.get("experience_level"),
                industry=parsed_data.get("industry"),
            )

            logger.info(
                "ai_parsing_success",
                title=job_data.title,
                confidence=confidence,
            )

            return job_data, confidence

        except json.JSONDecodeError as e:
            logger.error("ai_parsing_json_error", error=str(e))
            raise AIParsingError(f"Failed to parse AI response: {e}")
        except Exception as e:
            logger.error("ai_parsing_failed", error=str(e))
            raise AIParsingError(str(e))

    def _looks_like_html_document(self, content: str) -> bool:
        """Heuristic: full-page HTML vs plain text from a field."""
        if not content or len(content) < 80:
            return False
        head = content[:8000].lower()
        if "<html" in head or "<body" in head or "<!doctype html" in head:
            return True
        return content.count("<") > 25 and "</" in content

    def _prepare_content_for_llm(self, content: str) -> str:
        """
        Raw tag-stripping + 50k cap puts cookie banners and footers first on many SPAs (e.g. Workable),
        so the real JD never reaches the model. Prefer semantic plain text for HTML documents.
        """
        if not content:
            return ""
        s = content.strip()
        if self._looks_like_html_document(s):
            plain = plain_text_from_document_html(s)
            if len(plain) >= 80:
                s = plain
            else:
                s = self._strip_tags_flat(s)
        else:
            s = self._strip_tags_flat(s)
        if len(s) > MAX_CONTENT_LENGTH:
            logger.debug("ai_parser_content_truncated", original_length=len(s), max_length=MAX_CONTENT_LENGTH)
            s = s[:MAX_CONTENT_LENGTH] + "..."
        return s

    def _strip_tags_flat(self, content: str) -> str:
        content = re.sub(r"<script[^>]*>.*?</script>", "", content, flags=re.DOTALL | re.IGNORECASE)
        content = re.sub(r"<style[^>]*>.*?</style>", "", content, flags=re.DOTALL | re.IGNORECASE)
        content = re.sub(r"<[^>]+>", " ", content)
        content = re.sub(r"\s+", " ", content)
        return content.strip()

    def _calculate_confidence(self, data: dict) -> float:
        score = 0.0
        if data.get("title") and data["title"] != "Unknown Position":
            score += 0.25
        if data.get("description") and len(data["description"]) > 100:
            score += 0.25
        if data.get("company"):
            score += 0.15
        if data.get("location"):
            score += 0.1
        if data.get("requirements") and len(data["requirements"]) > 0:
            score += 0.1
        if data.get("responsibilities") and len(data["responsibilities"]) > 0:
            score += 0.1
        if data.get("salary_range") or data.get("employment_type"):
            score += 0.05
        return min(score, 1.0)


_ai_parser: AIParser | None = None


async def init_ai_parser() -> None:
    global _ai_parser
    _ai_parser = AIParser()
    settings = get_settings()
    if settings.openai_api_key:
        try:
            get_openai_client()
            logger.info("ai_parser_initialized", model=settings.openai_model)
        except AIParsingError:
            logger.warning("ai_parser_skipped", reason="openai_api_key_not_configured")
    else:
        logger.warning("ai_parser_skipped", reason="openai_api_key_not_configured")


def get_ai_parser() -> AIParser:
    if not _ai_parser:
        raise AIParsingError("AI parser not initialized")
    return _ai_parser
