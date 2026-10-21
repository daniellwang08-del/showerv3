import pytest

from app.services.location_display import display_location, standardize_location


def _places(location: str) -> list[str]:
    return standardize_location(location).places


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # The forms the jobs table promises.
        ("Kent, WA", ["Kent, WA, US"]),
        ("Anywhere in the US", ["All, US"]),
        ("California", ["CA, US"]),
        ("CA", ["CA, US"]),
        ("USA", ["All, US"]),
        ("Toronto", ["Toronto, ON, CA"]),
        ("Toronto, ON, CA", ["Toronto, ON, CA"]),
        ("Berlin, Germany", ["Berlin, DE"]),
        ("London", ["London, UK"]),
        # Spellings seen in production.
        ("Seattle, Washington, United States", ["Seattle, WA, US"]),
        ("VIRTUAL, WA, US, 00000", ["WA, US"]),
        ("US-AZ - Phoenix", ["Phoenix, AZ, US"]),
        ("RESTON, VIRGINIA, 20191", ["Reston, VA, US"]),
        ("Brooklyn Park, Minnesota", ["Brooklyn Park, MN, US"]),
        ("Johnson City, TN", ["Johnson City, TN, US"]),
        ("King of Prussia, Pennsylvania, United States of America", ["King of Prussia, PA, US"]),
        ("ST. LOUIS, MISSOURI, 63146", ["St. Louis, MO, US"]),
        ("EL SEGUNDO, CALIFORNIA,", ["El Segundo, CA, US"]),
        ("COLUMBUS,", ["Columbus, OH, US"]),
        ("Columbus, GA", ["Columbus, GA, US"]),
        ("Paris, TX", ["Paris, TX, US"]),
        ("Wilmington, DE", ["Wilmington, DE, US"]),
        ("New York, NY. US.", ["New York, NY, US"]),
        ("NEW YORK, NEW YORK", ["New York, NY, US"]),
        ("Spokane, Washington", ["Spokane, WA, US"]),
        ("Cambridge, MA USA", ["Cambridge, MA, US"]),
        ("ORLANDO FLORIDA", ["Orlando, FL, US"]),
        ("Katherine Johnson IV&V Facitlity, Fairmont WV", ["Fairmont, WV, US"]),
        ("US-WI-Greenville", ["Greenville, WI, US"]),
        ("US-California", ["CA, US"]),
        ("Work At Home-Ohio", ["OH, US"]),
        ("Country: United States of America, City: US NC Charlotte", ["Charlotte, NC, US"]),
        ("Telecommuter FL", ["FL, US"]),
        ("Prague 8", ["Prague, CZ"]),
        ("Brasil", ["All, BR"]),
        ("Berlin is ideal", ["Berlin, DE"]),
    ],
)
def test_single_place(raw: str, expected: list[str]) -> None:
    assert _places(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["Washington, D.C.", "Washington D.C", "Washington DC", "Washington, District of Columbia, United States"],
)
def test_washington_dc_is_the_city(raw: str) -> None:
    assert _places(raw) == ["Washington, DC, US"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("WA / Troy, Michigan", ["WA, US", "Troy, MI, US"]),
        ("San Francisco, New York", ["San Francisco, CA, US", "New York, NY, US"]),
        ("New York, New York; Miami, Florida; USA", ["New York, NY, US", "Miami, FL, US"]),
        ("Madison, WI / USA IL / USA WI Milwaukee", ["Madison, WI, US", "IL, US", "Milwaukee, WI, US"]),
        ("Canada / United States", ["All, CA", "All, US"]),
        ("Chicago, IL; Canada", ["Chicago, IL, US", "All, CA"]),
        ("Czech Republic-Prague / Poland", ["Prague, CZ", "All, PL"]),
    ],
)
def test_lists(raw: str, expected: list[str]) -> None:
    assert _places(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # A subdivision code between a foreign city and its country is not a US state.
        ("Amsterdam, NH, NL / Cologne, NW, DE / Poznań, 30, PL", ["Amsterdam, NL", "Cologne, DE", "Poznań, PL"]),
        ("München, Bayern, DE / Munich, Bayern, DE", ["München, Bayern, DE", "Munich, Bayern, DE"]),
        ("München, BY, Germany", ["München, DE"]),
        ("Berlin, DE", ["Berlin, DE"]),
        ("Warsaw, 14, PL", ["Warsaw, PL"]),
        ("Seville, Andalusia, Spain", ["Seville, Andalusia, ES"]),
        ("Montreal, US, Canada", ["Montreal, QC, CA"]),
    ],
)
def test_foreign_codes(raw: str, expected: list[str]) -> None:
    assert _places(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("United States (Excluding AL, CO, LA)", ["All, US"]),
        ("San Diego, CA, START YOUR APPLICATION, RATE ANALYST", ["San Diego, CA, US"]),
        ("San Francisco, we're a LinkedIn Top Startup, valued at over", ["San Francisco, CA, US"]),
        ("Any city, TX, US, 99999, Req ID, 37652, Work Mode, Virtual", ["TX, US"]),
        ("Portugal - Nationwide", ["All, PT"]),
        ("the East or Central USA Only", ["All, US"]),
        ("South Jordan / Draper, UT", ["Draper, UT, US"]),
        ("ARDMORE AVE, FORT WAYNE,, INDIANA, 7775", ["Fort Wayne, IN, US"]),
    ],
)
def test_noise_is_dropped(raw: str, expected: list[str]) -> None:
    assert _places(raw) == expected


def test_countries_follow_the_places() -> None:
    result = standardize_location("Toronto, CA / New York, US / London, GB")
    assert result.places == ["Toronto, ON, CA", "New York, NY, US", "London, UK"]
    assert result.countries == ["CA", "US", "GB"]


def test_worldwide_and_regions_have_no_flag() -> None:
    assert display_location("Global").places == ["Worldwide"]
    assert display_location("Anywhere").countries == []
    assert display_location("EMEA").places == ["EMEA"]


def test_no_place_named_falls_back_to_inferred_country() -> None:
    result = display_location("Remote", "remote")
    assert result.places == ["All, US"]
    assert result.countries == ["US"]
    assert result.inferred is True


def test_unresolved_text_keeps_its_name_without_flag() -> None:
    result = display_location("Waukesha")
    assert result.places == ["Waukesha"]
    assert result.countries == []
