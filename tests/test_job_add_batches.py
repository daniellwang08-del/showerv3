from app.services.job_add_batches import initial_scope_from_default, normalize_share_default, normalize_share_scope


def test_normalize_share_default():
    assert normalize_share_default("ask") == "ask"
    assert normalize_share_default("TEAM") == "team"
    assert normalize_share_default("nope") == "private"
    assert normalize_share_default(None) == "private"


def test_initial_scope_from_ask_stays_private():
    assert initial_scope_from_default("ask") == "private"
    assert initial_scope_from_default("all") == "all"
    assert initial_scope_from_default("team") == "team"


def test_normalize_share_scope():
    assert normalize_share_scope("users") == "users"
    assert normalize_share_scope("bogus") == "private"
