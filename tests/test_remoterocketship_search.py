import pytest

from app.job_sites.base import FetchContext
from app.job_sites.errors import ConnectionConfigError
from app.services.remoterocketship_search import (
    DEFAULT_JOB_TITLES,
    SearchLinkError,
    default_search,
    parse_search_link,
)

USER_SEARCH = (
    "https://www.remoterocketship.com/remote-jobs/?page=1&sort=DateAdded&locations=United+States"
    "&minSalary=120000&seniority=mid&employmentType=full-time%2Ccontract&jobTitle=AI%2520Engineer"
    "%2CApplication%2520Engineer%2CBackend%2520Engineer%2CCloud%2520Engineer%2CData%2520Engineer"
    "%2CFull-stack%2520Engineer%2CFrontend%2520Engineer%2CInfrastructure%2520Engineer"
    "%2CLLM%2520Engineer%2CMachine%2520Learning%2520Engineer%2CPlatform%2520Engineer"
    "%2CSoftware%2520Engineer"
)


def test_parses_the_double_encoded_site_link():
    search = parse_search_link(USER_SEARCH)
    assert search.job_titles == list(DEFAULT_JOB_TITLES)
    assert search.locations == ["United States"]
    assert search.min_salary == 120000
    assert search.seniority == ["mid"]
    assert search.employment_types == ["full-time", "contract"]
    assert search.ignored_params == []


def test_default_search_matches_the_saved_site_search():
    assert default_search().api_filters() == parse_search_link(USER_SEARCH).api_filters()


def test_unknown_values_and_params_are_dropped():
    search = parse_search_link(
        "remoterocketship.com/remote-jobs/?seniority=mid,boss&employmentType=gig&techStack=Python"
    )
    assert search.seniority == ["mid"]
    assert search.employment_types == []
    assert search.ignored_params == ["techStack"]
    assert "minSalaryFilter" not in search.api_filters()


@pytest.mark.parametrize("link", ["", "https://example.com/remote-jobs/?jobTitle=x"])
def test_rejects_non_remoterocketship_links(link):
    with pytest.raises(SearchLinkError):
        parse_search_link(link)


def test_connection_filters_use_the_search_link():
    from app.job_sites.plugins.remoterocketship import _filters

    filters = _filters(FetchContext(country_codes=("GB",), max_jobs=40), USER_SEARCH)
    assert filters["jobTitleFilters"] == list(DEFAULT_JOB_TITLES)
    assert filters["locationFilters"] == ["United States"]
    assert filters["seniorityFilters"] == ["mid"]
    assert filters["employmentTypeFilters"] == ["full-time", "contract"]
    assert filters["minSalaryFilter"] == 120000
    assert filters["sortBy"] == "DateAdded"
    assert filters["itemsPerPage"] == 40


def test_connection_filters_fall_back_to_preferred_country():
    from app.job_sites.plugins.remoterocketship import _filters

    ctx = FetchContext(country_codes=("CA",), max_jobs=40)
    assert _filters(ctx)["locationFilters"] == ["Canada"]
    no_location = "https://www.remoterocketship.com/remote-jobs/?jobTitle=Data%2520Engineer"
    filters = _filters(ctx, no_location)
    assert filters["locationFilters"] == ["Canada"]
    assert filters["jobTitleFilters"] == ["Data Engineer"]


def test_bad_search_link_is_a_config_error():
    from app.job_sites.plugins.remoterocketship import _filters

    with pytest.raises(ConnectionConfigError):
        _filters(FetchContext(), "https://example.com/jobs")


def test_remoterocketship_is_first_and_search_link_is_optional():
    from app.job_sites.registry import list_plugins

    plugin = list_plugins()[0]
    assert plugin.slug == "remoterocketship"
    fields = {f["key"]: f for f in plugin.catalog_dict()["credential_fields"]}
    assert fields["api_key"]["required"] is True
    assert fields["search_url"]["required"] is False
    assert fields["search_url"]["secret"] is False
