"""Country catalog for global job-location preferences.

Canonical country identifiers are ISO 3166-1 alpha-2 codes ("US", "GB", "DE"…).
The catalog maps location phrases (country names, common aliases, UK nations,
region tokens such as EU/EMEA/APAC/LATAM) to codes or code groups so the
location classifier and the resume country auto-detector share one vocabulary.
"""

from __future__ import annotations

# Display names for every supported preference country (frontend dropdown +
# human-readable exclusion reasons). Keys are ISO 3166-1 alpha-2 codes.
COUNTRY_NAMES: dict[str, str] = {
    "US": "United States", "CA": "Canada", "MX": "Mexico", "GB": "United Kingdom",
    "IE": "Ireland", "FR": "France", "DE": "Germany", "NL": "Netherlands",
    "BE": "Belgium", "LU": "Luxembourg", "CH": "Switzerland", "AT": "Austria",
    "ES": "Spain", "PT": "Portugal", "IT": "Italy", "GR": "Greece",
    "DK": "Denmark", "SE": "Sweden", "NO": "Norway", "FI": "Finland",
    "IS": "Iceland", "PL": "Poland", "CZ": "Czechia", "SK": "Slovakia",
    "HU": "Hungary", "RO": "Romania", "BG": "Bulgaria", "HR": "Croatia",
    "SI": "Slovenia", "RS": "Serbia", "BA": "Bosnia and Herzegovina",
    "AL": "Albania", "AD": "Andorra", "MT": "Malta", "CY": "Cyprus",
    "EE": "Estonia", "LV": "Latvia", "LT": "Lithuania", "UA": "Ukraine",
    "MD": "Moldova", "BY": "Belarus", "RU": "Russia", "GE": "Georgia (country)",
    "AM": "Armenia", "AZ": "Azerbaijan", "TR": "Turkey", "IL": "Israel",
    "AE": "United Arab Emirates", "SA": "Saudi Arabia", "QA": "Qatar",
    "KW": "Kuwait", "BH": "Bahrain", "OM": "Oman", "JO": "Jordan",
    "LB": "Lebanon", "IQ": "Iraq", "IR": "Iran", "SY": "Syria",
    "AF": "Afghanistan", "PK": "Pakistan", "IN": "India", "BD": "Bangladesh",
    "LK": "Sri Lanka", "NP": "Nepal", "MM": "Myanmar", "TH": "Thailand",
    "VN": "Vietnam", "KH": "Cambodia", "MY": "Malaysia", "SG": "Singapore",
    "ID": "Indonesia", "PH": "Philippines", "CN": "China", "HK": "Hong Kong",
    "MO": "Macau", "TW": "Taiwan", "JP": "Japan", "KR": "South Korea",
    "MN": "Mongolia", "KZ": "Kazakhstan", "UZ": "Uzbekistan",
    "AU": "Australia", "NZ": "New Zealand",
    "EG": "Egypt", "MA": "Morocco", "DZ": "Algeria", "LY": "Libya",
    "ET": "Ethiopia", "KE": "Kenya", "NG": "Nigeria", "GH": "Ghana",
    "CM": "Cameroon", "AO": "Angola", "ZA": "South Africa",
    "BR": "Brazil", "AR": "Argentina", "CL": "Chile", "CO": "Colombia",
    "PE": "Peru", "VE": "Venezuela", "EC": "Ecuador", "BO": "Bolivia",
    "PY": "Paraguay", "UY": "Uruguay", "CR": "Costa Rica", "PA": "Panama",
    "NI": "Nicaragua", "HN": "Honduras", "GT": "Guatemala", "SV": "El Salvador",
    "DO": "Dominican Republic", "CU": "Cuba", "JM": "Jamaica",
}

# Location phrase (normalized lowercase) → ISO code. Multi-word phrases must be
# matched before shorter ones by callers that scan text (the classifier sorts
# by length). Bare "us"/"america" handling stays in the classifier because it
# needs word-boundary and "latin america" guards.
PHRASE_TO_CODE: dict[str, str] = {
    "united states of america": "US", "united states": "US", "u.s.a.": "US",
    "u.s.a": "US", "usa": "US", "u.s.": "US", "us-only": "US", "us only": "US",
    "canada": "CA", "mexico": "MX",
    "united kingdom": "GB", "great britain": "GB", "uk": "GB", "u.k.": "GB",
    "u.k": "GB", "england": "GB", "scotland": "GB", "wales": "GB",
    "northern ireland": "GB",
    "ireland": "IE", "france": "FR", "germany": "DE",
    "netherlands": "NL", "the netherlands": "NL", "holland": "NL",
    "belgium": "BE", "luxembourg": "LU", "switzerland": "CH", "austria": "AT",
    "spain": "ES", "portugal": "PT", "italy": "IT", "greece": "GR",
    "denmark": "DK", "sweden": "SE", "norway": "NO", "finland": "FI",
    "iceland": "IS", "poland": "PL", "czech republic": "CZ", "czechia": "CZ",
    "slovakia": "SK", "hungary": "HU", "romania": "RO", "bulgaria": "BG",
    "croatia": "HR", "slovenia": "SI", "serbia": "RS", "bosnia": "BA",
    "albania": "AL", "andorra": "AD", "malta": "MT", "cyprus": "CY",
    "estonia": "EE", "latvia": "LV", "lithuania": "LT", "ukraine": "UA",
    "moldova": "MD", "belarus": "BY", "russia": "RU", "georgia": "GE",
    "armenia": "AM", "azerbaijan": "AZ", "turkey": "TR", "israel": "IL",
    "united arab emirates": "AE", "uae": "AE", "saudi arabia": "SA",
    "qatar": "QA", "kuwait": "KW", "bahrain": "BH", "oman": "OM",
    "jordan": "JO", "lebanon": "LB", "iraq": "IQ", "iran": "IR", "syria": "SY",
    "afghanistan": "AF", "pakistan": "PK", "india": "IN", "bangladesh": "BD",
    "sri lanka": "LK", "nepal": "NP", "myanmar": "MM", "thailand": "TH",
    "vietnam": "VN", "viet nam": "VN", "cambodia": "KH", "malaysia": "MY",
    "singapore": "SG", "indonesia": "ID", "philippines": "PH", "china": "CN",
    "hong kong": "HK", "macau": "MO", "taiwan": "TW", "japan": "JP",
    "korea": "KR", "south korea": "KR", "mongolia": "MN", "kazakhstan": "KZ",
    "uzbekistan": "UZ", "australia": "AU", "new zealand": "NZ",
    "egypt": "EG", "morocco": "MA", "algeria": "DZ", "libya": "LY",
    "ethiopia": "ET", "kenya": "KE", "nigeria": "NG", "ghana": "GH",
    "cameroon": "CM", "angola": "AO", "south africa": "ZA",
    "brazil": "BR", "argentina": "AR", "chile": "CL", "colombia": "CO",
    "peru": "PE", "venezuela": "VE", "ecuador": "EC", "bolivia": "BO",
    "paraguay": "PY", "uruguay": "UY", "costa rica": "CR", "panama": "PA",
    "nicaragua": "NI", "honduras": "HN", "guatemala": "GT",
    "el salvador": "SV", "dominican republic": "DO", "cuba": "CU",
    "jamaica": "JM",
}

_EU_CODES = frozenset({
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
    "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
    "SI", "ES", "SE",
})
_EUROPE_CODES = _EU_CODES | frozenset({
    "GB", "CH", "NO", "IS", "RS", "BA", "AL", "AD", "UA", "MD", "BY", "TR",
})
_MEA_CODES = frozenset({
    "AE", "SA", "QA", "KW", "BH", "OM", "JO", "LB", "IL", "IQ", "IR", "SY",
    "TR", "EG", "MA", "DZ", "LY", "ET", "KE", "NG", "GH", "CM", "AO", "ZA",
})
_APAC_CODES = frozenset({
    "AU", "NZ", "CN", "JP", "KR", "IN", "SG", "MY", "TH", "VN", "PH", "ID",
    "HK", "TW", "KH", "MM", "NP", "BD", "LK", "PK", "KZ", "UZ", "MN", "MO",
})
_LATAM_CODES = frozenset({
    "MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC", "BO", "PY", "UY", "CR",
    "PA", "NI", "HN", "GT", "SV", "DO", "CU", "JM",
})

# Region token (normalized lowercase) → set of codes the token covers. A job
# posted for a region is eligible when the user prefers ANY country in it.
REGION_GROUPS: dict[str, frozenset[str]] = {
    "eu": _EU_CODES,
    "europe": _EUROPE_CODES,
    "emea": _EUROPE_CODES | _MEA_CODES,
    "mea": _MEA_CODES,
    "middle east": _MEA_CODES,
    "apac": _APAC_CODES,
    "asia": _APAC_CODES,
    "asia pacific": _APAC_CODES,
    "latam": _LATAM_CODES,
    "latin america": _LATAM_CODES,
    "south america": frozenset({"BR", "AR", "CL", "CO", "PE", "VE", "EC", "BO", "PY", "UY"}),
    "north america": frozenset({"US", "CA", "MX"}),
    "americas": _LATAM_CODES | frozenset({"US", "CA"}),
    "oceania": frozenset({"AU", "NZ"}),
    "nordics": frozenset({"DK", "SE", "NO", "FI", "IS"}),
    "dach": frozenset({"DE", "AT", "CH"}),
    "benelux": frozenset({"BE", "NL", "LU"}),
}

# Subdivision (region after "City, …") → country code, for comma-format
# locations where the country itself is not named ("Toronto, Ontario").
# Only unambiguous names/abbreviations are listed; US states have dedicated
# handling in the classifier. Keys are matched case-insensitively for names
# and exactly (upper) for abbreviations in the comma-region position.
SUBDIVISION_TO_CODE: dict[str, str] = {
    # Canada — provinces and territories
    "ontario": "CA", "quebec": "CA", "québec": "CA", "british columbia": "CA",
    "alberta": "CA", "manitoba": "CA", "saskatchewan": "CA",
    "nova scotia": "CA", "new brunswick": "CA", "newfoundland": "CA",
    "newfoundland and labrador": "CA", "prince edward island": "CA",
    "yukon": "CA", "nunavut": "CA", "northwest territories": "CA",
    "ON": "CA", "QC": "CA", "BC": "CA", "AB": "CA", "MB": "CA", "SK": "CA",
    "NS": "CA", "NB": "CA", "YT": "CA", "NU": "CA",
    # Australia — states and territories (ambiguous abbrevs SA/WA/NT omitted)
    "new south wales": "AU", "queensland": "AU", "tasmania": "AU",
    "western australia": "AU", "south australia": "AU",
    "australian capital territory": "AU", "victoria": "AU",
    "NSW": "AU", "QLD": "AU", "VIC": "AU", "TAS": "AU", "ACT": "AU",
}

# Tokens that mean the posting is open to any country.
WORLDWIDE_TOKENS = frozenset({
    "worldwide", "global", "anywhere", "international", "work from anywhere",
    "remote worldwide", "remote global", "remote anywhere", "fully distributed",
})

# Phone dialing code → country, used only as a weak fallback signal when a
# resume has no usable location text. Ambiguous codes (+7, +44 territories,
# +1 Canada) resolve to the most common country for this product's users.
DIAL_CODE_TO_COUNTRY: dict[str, str] = {
    "1": "US", "44": "GB", "353": "IE", "33": "FR", "49": "DE", "31": "NL",
    "32": "BE", "352": "LU", "41": "CH", "43": "AT", "34": "ES", "351": "PT",
    "39": "IT", "30": "GR", "45": "DK", "46": "SE", "47": "NO", "358": "FI",
    "354": "IS", "48": "PL", "420": "CZ", "421": "SK", "36": "HU", "40": "RO",
    "359": "BG", "385": "HR", "386": "SI", "381": "RS", "380": "UA",
    "90": "TR", "972": "IL", "971": "AE", "966": "SA", "974": "QA",
    "965": "KW", "973": "BH", "968": "OM", "962": "JO", "961": "LB",
    "92": "PK", "91": "IN", "880": "BD", "94": "LK", "977": "NP",
    "66": "TH", "84": "VN", "855": "KH", "60": "MY", "65": "SG",
    "62": "ID", "63": "PH", "86": "CN", "852": "HK", "853": "MO",
    "886": "TW", "81": "JP", "82": "KR", "61": "AU", "64": "NZ",
    "20": "EG", "212": "MA", "27": "ZA", "234": "NG", "254": "KE",
    "233": "GH", "251": "ET", "52": "MX", "55": "BR", "54": "AR",
    "56": "CL", "57": "CO", "51": "PE", "58": "VE", "593": "EC",
    "591": "BO", "595": "PY", "598": "UY", "506": "CR", "507": "PA",
    "505": "NI", "504": "HN", "502": "GT", "503": "SV",
}

MAX_COUNTRY_PREFERENCES = 30

# Longest-first so multi-word phrases win over embedded shorter ones
# ("south korea" before "korea", "united arab emirates" before nothing).
PHRASES_BY_LENGTH: tuple[str, ...] = tuple(
    sorted(PHRASE_TO_CODE, key=len, reverse=True)
)

_NAME_TO_CODE = {name.strip().lower(): code for code, name in COUNTRY_NAMES.items()}


def is_supported_country(code: str) -> bool:
    return code.upper() in COUNTRY_NAMES


def country_display_name(code: str) -> str:
    return COUNTRY_NAMES.get(code.upper(), code.upper())


def normalize_country_input(value: str | None) -> str | None:
    """Coerce user input (code, name, or alias) into an ISO code, else None."""
    if not value or not str(value).strip():
        return None
    text = str(value).strip().lower()
    if len(text) == 2 and text.upper() in COUNTRY_NAMES:
        return text.upper()
    if text in _NAME_TO_CODE:
        return _NAME_TO_CODE[text]
    if text in PHRASE_TO_CODE:
        return PHRASE_TO_CODE[text]
    return None


def normalize_country_preferences(values: list[str] | None) -> list[str]:
    """Validate a preference list into deduped ISO codes (order preserved).

    Raises ValueError on unrecognized entries so the API can report them.
    """
    if not values:
        return []
    seen: set[str] = set()
    cleaned: list[str] = []
    invalid: list[str] = []
    for raw in values:
        code = normalize_country_input(raw)
        if code is None:
            invalid.append(str(raw))
            continue
        if code in seen:
            continue
        seen.add(code)
        cleaned.append(code)
        if len(cleaned) >= MAX_COUNTRY_PREFERENCES:
            break
    if invalid:
        raise ValueError(f"Unrecognized countries: {', '.join(invalid[:5])}")
    return cleaned


def available_countries() -> list[dict[str, str]]:
    """Sorted country options for the preferences UI."""
    return [
        {"code": code, "name": name}
        for code, name in sorted(COUNTRY_NAMES.items(), key=lambda kv: kv[1])
    ]


def describe_country_list(codes: list[str] | frozenset[str], *, max_names: int = 4) -> str:
    """Human-readable list for exclusion reasons, e.g. 'United States, Canada'."""
    ordered = sorted(codes) if not isinstance(codes, list) else codes
    names = [country_display_name(c) for c in ordered[:max_names]]
    suffix = "…" if len(ordered) > max_names else ""
    return ", ".join(names) + suffix
