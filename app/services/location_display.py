"""Standard display form for job locations: "City, ST, CC".

Job boards write the same place a dozen ways ("Kent, WA", "Seattle,
Washington, United States", "VIRTUAL, WA, US, 00000", "US-AZ - Phoenix",
"Anywhere in the U.S."). The jobs table shows one form so rows line up and
every recognised place carries a country code and flag:

- "Kent, WA"                         -> "Kent, WA, US"
- "California" / "CA"                -> "CA, US"
- "Anywhere in the US" / "USA"       -> "All, US"
- "Toronto"                          -> "Toronto, ON, CA"
- "Berlin, Germany"                  -> "Berlin, DE"

Places that cannot be resolved keep their cleaned text and get no flag.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

from app.services.country_catalog import (
    CITIES_BY_LENGTH,
    CITY_TO_CODE,
    COUNTRY_NAMES,
    PHRASE_TO_CODE,
    REGION_GROUPS,
    SUBDIVISION_TO_CODE,
)

US_STATES: dict[str, str] = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI",
    "wyoming": "WY", "district of columbia": "DC", "d.c": "DC", "puerto rico": "PR",
}
US_STATE_CODES = frozenset(US_STATES.values()) | {"GU", "VI", "AS", "MP"}

# Major cities whose state is not in doubt, so "Seattle" reads "Seattle, WA, US".
US_CITY_STATE: dict[str, str] = {
    "new york": "NY", "new york city": "NY", "nyc": "NY", "manhattan": "NY", "brooklyn": "NY",
    "bronx": "NY", "san francisco": "CA", "sf": "CA", "bay area": "CA", "sf bay area": "CA",
    "silicon valley": "CA", "palo alto": "CA", "mountain view": "CA", "sunnyvale": "CA",
    "cupertino": "CA", "menlo park": "CA", "redwood city": "CA", "san jose": "CA",
    "oakland": "CA", "berkeley": "CA", "los angeles": "CA", "santa monica": "CA",
    "pasadena": "CA", "irvine": "CA", "san diego": "CA", "sacramento": "CA",
    "san mateo": "CA", "santa clara": "CA", "foster city": "CA", "playa vista": "CA",
    "el segundo": "CA", "seattle": "WA", "bellevue": "WA", "redmond": "WA",
    "kirkland": "WA", "austin": "TX", "dallas": "TX", "houston": "TX", "fort worth": "TX",
    "san antonio": "TX", "plano": "TX", "irving": "TX", "frisco": "TX", "boston": "MA",
    "somerville": "MA", "greater boston": "MA", "chicago": "IL", "denver": "CO",
    "boulder": "CO", "atlanta": "GA", "alpharetta": "GA", "miami": "FL", "tampa": "FL",
    "orlando": "FL", "jacksonville": "FL", "phoenix": "AZ", "washington dc": "DC",
    "washington d.c.": "DC", "philadelphia": "PA", "pittsburgh": "PA", "detroit": "MI",
    "ann arbor": "MI", "minneapolis": "MN", "st paul": "MN", "st. paul": "MN",
    "raleigh": "NC", "durham": "NC", "charlotte": "NC", "research triangle": "NC",
    "nashville": "TN", "salt lake city": "UT", "las vegas": "NV", "cleveland": "OH",
    "cincinnati": "OH", "indianapolis": "IN", "baltimore": "MD", "bethesda": "MD",
    "milwaukee": "WI", "honolulu": "HI", "anchorage": "AK", "boise": "ID",
    "albuquerque": "NM", "oklahoma city": "OK", "tulsa": "OK", "omaha": "NE",
    "des moines": "IA", "princeton": "NJ", "jersey city": "NJ", "reston": "VA",
    "mclean": "VA", "tysons": "VA", "herndon": "VA", "arlington va": "VA",
    "norfolk": "VA", "virginia beach": "VA", "st. louis": "MO", "st louis": "MO",
    "washington dc": "DC", "washington d.c": "DC", "columbus": "OH",
    "san francisco bay area": "CA",
}
CA_CITY_PROVINCE: dict[str, str] = {
    "toronto": "ON", "ottawa": "ON", "mississauga": "ON", "waterloo": "ON", "kitchener": "ON",
    "vancouver": "BC", "burnaby": "BC", "montreal": "QC", "montréal": "QC",
    "quebec city": "QC", "calgary": "AB", "edmonton": "AB", "winnipeg": "MB", "halifax": "NS",
}
_CITY_ALIASES = {
    "nyc": "New York", "new york city": "New York", "sf": "San Francisco", "new york": "New York",
    "washington dc": "Washington", "washington d.c": "Washington", "washington d.c.": "Washington",
    "bay area": "San Francisco Bay Area", "sf bay area": "San Francisco Bay Area",
    "san francisco bay area": "San Francisco Bay Area",
}
_WORLDWIDE = frozenset({
    "worldwide", "global", "anywhere", "any location", "work from anywhere", "anywhere in the world",
    "remote worldwide", "remote global", "remote anywhere", "fully distributed", "international",
})
# Whole tokens that are field labels, not places.
_SKIP_TOKENS = frozenset({"city", "country", "state", "region", "location", "locations"})
# Names that are both a state and a city. Read as the city; a lone one becomes the state.
_STATE_OR_CITY = frozenset({"new york", "washington"})

# Shown instead of the ISO code where the ISO code reads oddly.
_DISPLAY_CODE = {"GB": "UK"}

_EXTRA_COUNTRY_WORDS = {
    "us": "US", "u.s": "US", "can": "CA", "gbr": "GB", "deu": "DE", "españa": "ES",
    "espana": "ES", "deutschland": "DE", "the us": "US", "america": "US", "brasil": "BR",
    "bra": "BR", "nederland": "NL", "bgr": "BG", "ind": "IN", "north macedonia": "MK",
    "prt": "PT", "irl": "IE", "fra": "FR", "nld": "NL", "esp": "ES", "ita": "IT", "pol": "PL",
    "mex": "MX", "aus": "AU", "che": "CH", "swe": "SE", "rou": "RO", "ukr": "UA", "isr": "IL",
}
_ALL_COUNTRY_TOKENS = {
    "nationwide", "us nationwide", "all states", "any state", "multiple states", "national", "us national",
}
_REGION_LABELS = {
    "eu": "EU", "emea": "EMEA", "mea": "MEA", "apac": "APAC", "latam": "Latin America",
    "dach": "DACH", "benelux": "Benelux", "nordics": "Nordics",
}

# Words that never name a place on their own. Removed from a token before it is
# read, so "New York Office" is "New York" and "Telecommuter TN" is "TN".
_FILLER = frozenset("""
    remote hybrid onsite on-site virtual telecommuter telecommute office offices hub home
    working work at from based out of in within across the only anywhere any location locations
    other country countries state region role this is for duration such as preferred
    flexible national nationwide continental statewide travel commercial hours est pst
    multiple various one plaza campus headquarters hq metropolitan metro area areas greater
    unavailable unknown n/a na none tbd li w or and but our with ideally preferably market
    homeworker home-based arrangement distributed remoto telework teleworker all inc llc ltd corp
    work@home worksite offsite remotely req requisition posted date amer noam time zone zones worker a an
""".split())
_STREET_WORDS = frozenset(
    "ave avenue street st rd road blvd boulevard suite ste floor flr drive dr way parkway pkwy lane ln".split()
)
# "Req ID", "Job ID", "Work Mode": ATS field names, never places ("ID" is not Idaho here).
_FIELD_LABEL_RE = re.compile(r"(?i)^(?:req(?:uisition)?|job|posting)\s*(?:id|#|number)$|^work mode$")
_COMPASS = frozenset("east west north south central coast eastern western northern southern midwest".split())
# "United States (Excluding AL, CO, LA)": what follows names places the job is not in.
_EXCLUDE_RE = re.compile(r"(?i)\b(?:excluding|except|excludes|not available in|not open to)\b.*$")
# "Amsterdam, NH, NL" / "Belgrade, 00, RS": city, subdivision code, ISO country.
# The middle code reads as a US state otherwise, so it is dropped and the country forced.
_ISO_TRIPLE_RE = re.compile(
    r"(?<![^/;|])\s*([^,/;|]+?),\s*([A-Za-z0-9]{1,3}),\s*([A-Z]{2})\s*(?=[/;|]|$)"
)
# "USA WI Milwaukee", "US NC Charlotte": country and state written with spaces.
_SPACED_US_RE = re.compile(r"^(?:US|USA)\s+([A-Z]{2})(?:\s+(.+))?$")
# "Fairmont WV": a city and a state code without a comma.
_TRAILING_STATE_RE = re.compile(r"^([A-Z][\w.'\- ]{1,40}?)\s+([A-Z]{2})$")

_SEP_RE_CAPTURE = re.compile(
    r"\s*([,;|/\u2022\u00b7+()\[\]]|\s[-\u2013]\s|\n|\s(?:or|and|&)\s"
    r"|(?<=\b(?-i:[A-Z]{2}))(?<!\bST)(?<!\bFT)(?<!\bMT)\.\s)\s*",
    re.I,
)
_CODE_PAIR_RE = re.compile(r"^([A-Za-z]{2,3})[-\s]([A-Za-z]{2})$")
_LABEL_RE = re.compile(r"(?i)\b(?:city|state/region|state|region|country)\s*:\s*")
_WORD_RE = re.compile(r"[^\s]+")
_MAX_CHARS = 160


@dataclass
class Place:
    city: str | None = None
    region: str | None = None
    country: str | None = None
    # A country stated in the text, as opposed to one inferred from a state or city.
    explicit: bool = False


@dataclass
class LocationDisplay:
    places: list[str] = field(default_factory=list)
    countries: list[str] = field(default_factory=list)
    inferred: bool = False


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower()).strip(" .")


_NAME_TO_CODE = {name.lower(): code for code, name in COUNTRY_NAMES.items()}


def _country_of(token: str) -> str | None:
    key = _norm(token)
    if key in _EXTRA_COUNTRY_WORDS:
        return _EXTRA_COUNTRY_WORDS[key]
    if key in PHRASE_TO_CODE:
        return PHRASE_TO_CODE[key]
    return _NAME_TO_CODE.get(key)


def _is_filler(word: str) -> bool:
    return word.lower().strip(".:#()") in _FILLER


def _strip_filler(token: str) -> str:
    """Drop filler words from both ends ("Home Office New Jersey" -> "New Jersey").

    Inner words stay, so "King of Prussia" keeps its "of". A token made only of
    filler and compass words ("West Coast", "Central") becomes empty.
    """
    words = _WORD_RE.findall(token)
    if all(_is_filler(w) or w.lower() in _COMPASS for w in words):
        return ""
    while words and _is_filler(words[0]):
        words.pop(0)
    while words and _is_filler(words[-1]):
        words.pop()
    return " ".join(words).strip(" .:-#")


_LOWER_WORDS = frozenset({"of", "de", "la", "del", "da", "do", "upon", "the", "on"})


def _title(text: str) -> str:
    """Title-case a name typed in all caps or all lower case ("EL SEGUNDO" -> "El Segundo")."""
    if not (text.isupper() or text.islower()):
        return text
    words = []
    for i, word in enumerate(text.split()):
        lower = word.lower()
        if i and lower in _LOWER_WORDS:
            words.append(lower)
        elif lower.startswith("mc") and len(lower) > 3:
            words.append("Mc" + lower[2:].capitalize())
        else:
            words.append(word.capitalize())
    return " ".join(words)


def _tokens(raw: str) -> tuple[list[tuple[str, str]], bool]:
    """(piece, separator before it) for the location, and whether it looked like prose.

    The separator is "," for commas, "-" for spaced dashes and "/" for every
    list separator (slash, semicolon, pipe, bullet, "or", "and").
    """
    text = _LABEL_RE.sub("", raw.replace("\xa0", " ").replace("\u200b", ""))
    text = _EXCLUDE_RE.sub("", text)
    strict = len(text) > _MAX_CHARS
    text = text[:_MAX_CHARS]
    text = _ISO_TRIPLE_RE.sub(_iso_triple, text)
    out: list[tuple[str, str]] = []
    parts = _SEP_RE_CAPTURE.split(text)
    sep = "/"
    for i, piece in enumerate(parts):
        if i % 2 == 1:
            mark = piece.strip().lower()
            sep = "," if mark == "," else "-" if mark in ("-", "\u2013") else "/"
            continue
        if piece.endswith(":"):
            continue
        piece = re.sub(r"\s+\d+$", "", piece.strip(" .:-#'\""))
        if not piece:
            continue
        out.extend(_split_piece(piece, sep))
    return out, strict


def _is_place_word(text: str) -> bool:
    """A country, a US state name or an upper-case US state code."""
    key = _norm(text)
    return bool(_country_of(key)) or key in US_STATES or text.strip() in US_STATE_CODES


def _iso_triple(m: re.Match[str]) -> str:
    city, middle, code = m.group(1), m.group(2), m.group(3)
    if code == "US" or code not in COUNTRY_NAMES or (code == "CA" and not middle.isdigit()):
        return m.group(0)
    return f"{city}, @{code}"


def _split_piece(piece: str, sep: str) -> list[tuple[str, str]]:
    if _FIELD_LABEL_RE.search(piece):
        return []
    pair = _CODE_PAIR_RE.match(piece)
    if pair and (_country_of(pair.group(1)) or pair.group(1).upper() in US_STATE_CODES):
        return [(pair.group(1), sep), (pair.group(2), ",")]
    # "US-WI-Greenville", "US-California", "Work At Home-Ohio", "San Francisco-HQ".
    # Hyphenated names ("Winston-Salem") stay whole.
    dashed = [part.strip() for part in piece.replace("_", "-").split("-")]
    dashed = [part for part in dashed if part]
    if len(dashed) >= 2 and (
        _is_place_word(dashed[0])
        or all(
            _is_place_word(p) or not _strip_filler(p) or _known_city(_strip_filler(p)) == _norm(_strip_filler(p))
            for p in dashed
        )
    ):
        return [(dashed[0], sep)] + [(part, "-") for part in dashed[1:]]
    spaced = _SPACED_US_RE.match(piece)
    if spaced and spaced.group(1) in US_STATE_CODES:
        out = [("US", sep), (spaced.group(1), ",")]
        if spaced.group(2):
            out.append((spaced.group(2), "-"))
        return out
    words = piece.split()
    while len(words) > 1 and _is_filler(words[-1]):
        words.pop()
    for size in (1, 2, 3):
        if len(words) <= size:
            break
        head, tail = " ".join(words[:-size]), " ".join(words[-size:])
        if _country_of(tail):
            # "Central USA", "MA USA", "Boston USA". "South Jordan" is a city, not Jordan.
            if not _strip_filler(head) and (
                _country_of(tail) == "US" or not any(w.lower() in _COMPASS for w in head.split())
            ):
                return [(tail, sep)]
            if _is_place_word(head) or _known_city(head) == _norm(head):
                return [(head, sep), (tail, ",")]
        if _norm(tail) in US_STATES and _known_city(head) == _norm(head):
            # "ORLANDO FLORIDA"
            return [(head, sep), (tail, ",")]
    for size in (3, 2, 1):
        if len(words) <= size:
            continue
        head, tail = " ".join(words[:size]), " ".join(words[size:])
        if (
            _country_of(head)
            and _known_city(piece) != _norm(piece)
            and words[size][:1].isupper()
            and words[size].lower() not in ("city", "beach", "island", "springs")
        ):
            # "Brazil Sao Paulo", "USA Walnut Creek", "USA Worksite"
            return [(head, sep), (tail, "-")]
    trailing = _TRAILING_STATE_RE.match(piece)
    if trailing and trailing.group(2) in US_STATE_CODES and not _strip_filler(trailing.group(1)) == "":
        name = trailing.group(1)
        if not _country_of(name) and name.upper() not in US_STATE_CODES:
            return [(name, sep), (trailing.group(2), ",")]
    return [(piece, sep)]


def _known_city(text: str) -> str | None:
    key = _norm(text)
    if key in CITY_TO_CODE or key in US_CITY_STATE or key in CA_CITY_PROVINCE:
        return key
    for city in CITIES_BY_LENGTH:
        if re.search(rf"(?<![a-z]){re.escape(city)}(?![a-z])", key):
            return city
    return None


def _city_country(key: str) -> str | None:
    if key in US_CITY_STATE:
        return "US"
    if key in CA_CITY_PROVINCE:
        return "CA"
    return CITY_TO_CODE.get(key)


def _classify(token: str, strict: bool) -> tuple[str, str, str | None] | None:
    """(kind, value, country) for one token, or None to skip it.

    kind is "country", "all" (whole country), "state", "region", "group" or "city".
    """
    key = _norm(token)
    raw = token.strip()
    if raw.startswith("@"):
        return ("forced", raw[1:], raw[1:])
    if not key or any(ch.isdigit() for ch in key):
        return None
    if key in _ALL_COUNTRY_TOKENS:
        return ("country" if key.startswith("us ") else "all", "US", "US")
    if key in REGION_GROUPS:
        return ("group", _REGION_LABELS.get(key, _title(raw)), None)
    if key in _WORLDWIDE:
        return ("group", "Worldwide", None)
    if key in _STATE_OR_CITY:
        return ("city", _CITY_ALIASES.get(key, _title(raw)), "US")
    # US states first: "Atlanta, Georgia" is the state, not the country.
    if key in US_STATES:
        return ("state", US_STATES[key], "US")
    if raw.isupper() and raw in US_STATE_CODES:
        return ("state", raw, "US")
    code = _country_of(key)
    if code:
        return ("country", code, code)
    sub = SUBDIVISION_TO_CODE.get(key) or SUBDIVISION_TO_CODE.get(raw.upper())
    if sub:
        label = raw.upper() if len(raw) <= 3 else _title(raw)
        return ("region", label, sub)
    if len(key) == 2 and raw.isupper() and key.upper() in US_STATE_CODES:
        return ("state", key.upper(), "US")
    if len(key) == 2 and raw.isupper() and key.upper() in COUNTRY_NAMES:
        return ("country", key.upper(), key.upper())
    if key in CITY_TO_CODE or key in US_CITY_STATE or key in CA_CITY_PROVINCE:
        return ("city", _CITY_ALIASES.get(key) or _title(raw), _city_country(key))

    cleaned = _strip_filler(token)
    if not cleaned:
        return None
    if cleaned != raw:
        return _classify(cleaned, strict)

    words = cleaned.split()
    if len(words) >= 2 and words[-1].lower().strip(".") in _STREET_WORDS:
        return None
    prose = any(w[:1].islower() and len(w) > 2 for w in words)
    if prose:
        # "Berlin is ideal", "Candidates based Spain": keep the place the sentence names.
        for size in (2, 1):
            for i in range(len(words) - size + 1):
                if not words[i][:1].isupper():
                    continue
                code = _country_of(" ".join(words[i:i + size]))
                if code:
                    return ("country", code, code)
    if strict or prose or len(words) > 3 or len(raw.split()) > 4:
        # Run-on text: keep only a known city it mentions ("Reston Town Center featuring ...").
        city = _known_city(cleaned)
        if city:
            return ("city", _CITY_ALIASES.get(city) or _title(city), _city_country(city))
        return None
    if not re.fullmatch(r"[^\W\d_][\w .'\-]*", cleaned, re.U) or key in _SKIP_TOKENS:
        return None
    # Lower-case words are sentence text ("valued at over"), not a place name.
    if cleaned.islower():
        return None
    if cleaned.isupper() and len(cleaned) <= 3:
        return None
    return ("city", _title(cleaned), None)


def _upcoming(tokens: list[tuple[str, str]], index: int, strict: bool) -> tuple[str, str, str | None] | None:
    """Classification of the next token when a comma ties it to this one."""
    if index + 1 >= len(tokens) or tokens[index + 1][1] != ",":
        return None
    return _classify(tokens[index + 1][0], strict)


def _looks_like_name(token: str) -> bool:
    words = token.split()
    return 0 < len(words) <= 3 and all(w[:1].isupper() for w in words) and not any(ch.isdigit() for ch in token)


def _places(tokens: list[tuple[str, str]], strict: bool) -> tuple[list[Place], list[str]]:
    places: list[Place] = []
    groups: list[str] = []
    since_country = 0  # index of the first place still waiting for a stated country
    segment = 0  # index of the first place after the last list separator
    for index, (token, sep) in enumerate(tokens):
        if sep == "/":
            segment = len(places)
        hit = _classify(token, strict)
        upcoming = _upcoming(tokens, index, strict)
        if (
            hit is None
            and strict
            and upcoming
            and upcoming[0] in ("state", "country")
            and _looks_like_name(token)
            and _strip_filler(token) == token.strip()
        ):
            # Long lists run in strict mode, but "Broomfield, Colorado" is still a city.
            hit = ("city", token.strip(), None)
        if hit is None:
            continue
        kind, value, country = hit
        last = places[-1] if places else None
        if kind == "group":
            groups.append(value)
            continue
        if kind == "forced":
            if last and last.city:
                last.country, last.region, last.explicit = value, None, True
            else:
                places.append(Place(country=value, explicit=True))
            since_country = len(places)
            continue
        if (
            kind == "state"
            and len(token.strip()) == 2
            and last
            and last.city
            and last.region
            and last.region not in US_STATE_CODES
            and last.country in (None, value)
            and value in COUNTRY_NAMES
        ):
            # "Tucumán, Tucuman, AR": after a city and a non-US region, a code is the country.
            last.country, last.explicit = value, True
            since_country = len(places)
            continue
        if kind == "state" and last and last.country == value and value != "US":
            # "Berlin, DE" is Germany and "München, Bayern, DE" too, not Delaware.
            last.explicit = True
            since_country = len(places)
            continue
        if kind == "all" and last and last.country:
            # "Portugal - Nationwide": the whole of the country already named.
            continue
        if (
            kind == "country"
            and sep == ","
            and len(token.strip()) == 2
            and last
            and last.city
            and not last.explicit
            and last.country not in (None, value)
            and _city_country(_norm(last.city)) == last.country
        ):
            # "München, BY, Germany": a code that contradicts the city is its subdivision.
            continue
        if kind in ("country", "all"):
            # "Boston, MA / Madrid, ES": a country after a comma covers its own list entry.
            waiting = places[max(since_country, segment):] if sep == "," else places[since_country:]
            if kind == "country" and sep != ",":
                # "Prague / Poland": a listed country is its own entry; it only
                # completes places that have no country yet ("Boston / Chicago / US").
                waiting = [p for p in waiting if p.country is None]
            if kind == "country" and waiting:
                for p in waiting:
                    if p.country is None or (p.country == value) or not p.region:
                        p.country, p.explicit = value, True
            else:
                places.append(Place(country=value, explicit=True))
            since_country = len(places)
            continue
        if kind in ("state", "region"):
            if last and last.city and not last.region and sep in (",", "-"):
                city_key = _norm(last.city)
                # "New York, Connecticut": a state name followed by another state name
                # lists two states, not a city. "Washington, District of Columbia" is the city.
                if (
                    city_key in _STATE_OR_CITY
                    and kind == "state"
                    and _norm(token) in US_STATES
                    and value not in (US_STATES[city_key], "DC")
                ):
                    last.city, last.region, last.country = None, US_STATES[city_key], "US"
                    places.append(Place(region=value, country=country))
                    continue
                if last.country and last.country != country and last.explicit:
                    places.append(Place(region=value, country=country))
                    continue
                # "Berlin, DE" is Germany and "Bogota, CO" Colombia, not a US state.
                if kind == "state" and last.country and last.country != "US" and last.country == value:
                    last.explicit = True
                    continue
                last.region, last.country = value, country
                continue
            if last and last.region == value and not last.city:
                continue
            places.append(Place(region=value, country=country))
            continue
        # city
        if last and last.city and not last.region and sep == ",":
            key = _norm(token)
            last_key = _norm(last.city)
            own_region = US_CITY_STATE.get(last_key) or CA_CITY_PROVINCE.get(last_key)
            if key in _STATE_OR_CITY and own_region in (None, US_STATES[key]):
                # "Spokane, Washington", "New York, New York"
                last.region, last.country = US_STATES[key], "US"
                continue
            if country is None and (upcoming is None or upcoming[0] in ("country", "forced", "state")):
                # "Warsaw, Masovian Voivodeship", "Seville, Andalusia, Spain": an unknown
                # name after a city is its region, unless more unknown text follows.
                last.region = value
                continue
        known_state = US_CITY_STATE.get(_norm(value))
        if (
            last
            and sep in (",", "-")
            and last.region
            and not last.city
            and (last.country == country or country is None)
            and not last.explicit
            and (known_state is None or known_state == last.region)
        ):
            # "California - San Francisco", "US, CA, Santa Clara"
            last.city = value
            last.country = last.country or country
            continue
        if (
            last
            and sep == ","
            and last.city is None
            and last.region is None
            and last.country
            and country in (None, last.country)
            and (index == len(tokens) - 1 or tokens[index + 1][1] != "," or (upcoming and upcoming[0] == "state"))
        ):
            # "United States of America, Dayton": the city of the country just named.
            last.city = value
            continue
        dc = "DC" if _norm(token).startswith(("washington d.c", "washington dc")) else None
        places.append(Place(city=value, region=dc, country=country))
    return places, groups


def _fill_known_region(place: Place) -> None:
    if not place.city or place.region:
        return
    key = _norm(place.city)
    if key in _STATE_OR_CITY and key not in US_CITY_STATE:
        place.city, place.region, place.country = None, US_STATES[key], "US"
        return
    if place.country in (None, "US") and key in US_CITY_STATE:
        place.region, place.country = US_CITY_STATE[key], "US"
    elif place.country in (None, "CA") and key in CA_CITY_PROVINCE:
        place.region, place.country = CA_CITY_PROVINCE[key], "CA"


def _label(place: Place) -> str:
    code = _DISPLAY_CODE.get(place.country or "", place.country)
    parts = [p for p in (place.city, place.region) if p]
    if place.city and place.region and _norm(place.city) == _norm(place.region):
        parts = [place.city]
    if not parts:
        return f"All, {code}" if code else ""
    return ", ".join(parts + ([code] if code else []))


def standardize_location(location: str | None) -> LocationDisplay:
    """Standard places and their countries for a raw location string."""
    from app.services.job_location_parse import split_work_mode_from_location

    place_text, _mode = split_work_mode_from_location(location)
    raw = (place_text or "").strip()
    if not raw:
        return LocationDisplay()
    tokens, strict = _tokens(raw)
    places, groups = _places(tokens, strict)
    for place in places:
        _fill_known_region(place)

    specific = {p.country for p in places if (p.city or p.region) and p.country}
    kept = [p for p in places if p.city or p.region or p.country not in specific]
    # Next to resolved places, a name with no country is page text, not a place
    # ("San Diego, CA, START YOUR APPLICATION").
    if any(p.country for p in kept):
        kept = [p for p in kept if p.country]
    # "US-AZ - Phoenix" yields "AZ" and "Phoenix, AZ"; keep the one with the city.
    with_city = {(p.region, p.country) for p in kept if p.city}
    kept = [p for p in kept if p.city or (p.region, p.country) not in with_city]

    labels: list[str] = []
    countries: list[str] = []
    for place in kept:
        text = _label(place)
        if text and text not in labels:
            labels.append(text)
        if place.country and place.country not in countries:
            countries.append(place.country)
    if not labels and groups:
        labels = list(dict.fromkeys(groups))
    return LocationDisplay(places=labels, countries=countries)


@lru_cache(maxsize=8192)
def display_location(location: str | None, remote_policy: str | None = None) -> LocationDisplay:
    """What the Location column shows: standard places, country codes for the
    flags, and whether the country was inferred because the posting named none.

    Cached: the same few thousand strings repeat across every jobs page. Callers
    must not mutate the result.
    """
    from app.services.job_location_classifier import display_location_countries

    result = standardize_location(location)
    if result.places:
        return result
    if _norm(location or "") in _WORLDWIDE:
        return LocationDisplay(places=["Worldwide"])
    codes, inferred = display_location_countries(location, remote_policy)
    if codes:
        return LocationDisplay(
            places=[f"All, {_DISPLAY_CODE.get(c, c)}" for c in codes],
            countries=list(codes),
            inferred=inferred,
        )
    return LocationDisplay()
