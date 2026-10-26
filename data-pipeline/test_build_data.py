"""Offline tests for build_data.py. No network access is used."""
import json
from datetime import datetime, timezone

import pytest

import build_data as bd


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def ext(name, value, display=None):
    return {"name": name, "displayName": display or name, "value": value}


CARD_PRODUCT = {
    "productId": 1001,
    "name": "Thrall, Warchief",
    "cleanName": "Thrall-Warchief",
    "imageUrl": "https://img.example/1001.jpg",
    "categoryId": 13,
    "groupId": 24,
    "url": "https://www.tcgplayer.com/product/1001",
    "modifiedOn": "2026-10-25T00:00:00",
    "imageCount": 1,
    "presaleInfo": {},
    "extendedData": [
        ext("Number", "001", "Number"),
        ext("Rarity", "Legendary", "Rarity"),
        ext("CardType", "Hero", "Card Type"),
        ext("Class", "Warrior", "Class"),
        ext("Cost", "7", "Cost"),
        ext("CardText", "Short text", "Card Text"),
        ext("FlavorText", "Flavor", "Flavor Text"),
        ext("Lore", "x" * 121, "Lore"),
        ext("Health", "x" * 120, "Health"),
    ],
}

SEALED_PRODUCT = {
    "productId": 2002,
    "name": "Booster Box",
    "imageUrl": "https://img.example/2002.jpg",
    "url": "https://www.tcgplayer.com/product/2002",
    "extendedData": [ext("Description", "24 packs", "Description")],
}

NUMBER_ONLY_PRODUCT = {
    "productId": 3003,
    "name": "Lowercase Card",
    "extendedData": [ext("number", "5", "number")],
}

RARITY_DISPLAY_ONLY_PRODUCT = {
    "productId": 4004,
    "name": "Display Only",
    "extendedData": [ext("X1", "Rare", "Rarity")],
}

GROUP = {
    "groupId": 24,
    "name": "Rise of the Horde",
    "abbreviation": "ROTH",
    "isSupplemental": False,
    "publishedOn": "2026-01-01T00:00:00",
    "modifiedOn": "2026-10-01T00:00:00",
    "categoryId": 13,
}

PRICE_ROWS = [
    {"productId": 1001, "lowPrice": 1.5, "midPrice": 2.0, "highPrice": 9.0,
     "marketPrice": 1.8, "directLowPrice": None, "subTypeName": "Normal"},
    {"productId": 1001, "lowPrice": 3.0, "midPrice": 4.0, "highPrice": 9.0,
     "marketPrice": 3.5, "directLowPrice": None, "subTypeName": "Foil"},
    {"productId": 1001, "lowPrice": 0.1, "midPrice": 0.2, "highPrice": 0.3,
     "marketPrice": 0.15, "directLowPrice": None, "subTypeName": "Holofoil"},
    {"productId": 2002, "lowPrice": 50, "midPrice": 55, "highPrice": 60,
     "marketPrice": 52, "directLowPrice": None, "subTypeName": "Normal"},
    {"productId": 1001, "lowPrice": None, "midPrice": None, "highPrice": None,
     "marketPrice": None, "directLowPrice": None, "subTypeName": "Normal"},
]

ECB_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
  xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time="2026-10-23">
      <Cube currency="USD" rate="1.1000"/>
      <Cube currency="CHF" rate="0.9200"/>
      <Cube currency="GBP" rate="0.8800"/>
      <Cube currency="PLN" rate="4.4000"/>
    </Cube>
  </Cube>
</gesmes:Envelope>
"""


class FakeClient:
    """Stands in for TcgClient. Per-group failures are given as exceptions."""

    def __init__(self, groups, products=None, prices=None, failing=(), ecb=ECB_XML,
                 price_date="2026-10-26T10:00:00Z"):
        self._groups = groups
        self._products = products or {}
        self._prices = prices or {}
        self._failing = set(failing)
        self._ecb = ecb
        self._price_date = price_date

    def last_updated(self):
        return self._price_date

    def groups(self):
        return self._groups

    def products(self, group_id):
        if group_id in self._failing:
            raise bd.PipelineError(f"boom {group_id}")
        return self._products.get(group_id, [])

    def prices(self, group_id):
        if group_id in self._failing:
            raise bd.PipelineError(f"boom {group_id}")
        return self._prices.get(group_id, [])

    def ecb_xml(self):
        return self._ecb


class FakeResponse:
    def __init__(self, payload=None, text="", content=b""):
        self._payload = payload
        self.text = text
        self.content = content

    def json(self):
        return self._payload

    def raise_for_status(self):
        pass


class FakeSession:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append({"url": url, "headers": headers, "timeout": timeout})
        return self.responses[url]


# ---------------------------------------------------------------------------
# Card filtering
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "product, expected",
    [
        (CARD_PRODUCT, True),
        (NUMBER_ONLY_PRODUCT, True),
        (RARITY_DISPLAY_ONLY_PRODUCT, True),
        (SEALED_PRODUCT, False),
        ({"productId": 5, "extendedData": []}, False),
        ({"productId": 6}, False),
    ],
)
def test_is_single_card(product, expected):
    assert bd.is_single_card(product) is expected


# ---------------------------------------------------------------------------
# Compact mapping
# ---------------------------------------------------------------------------

def test_build_card_maps_core_fields():
    card = bd.build_card(CARD_PRODUCT, GROUP)
    assert card["p"] == 1001
    assert card["n"] == "Thrall, Warchief"
    assert card["g"] == 24
    assert card["s"] == "Rise of the Horde"
    assert card["sc"] == "ROTH"
    assert card["num"] == "001"
    assert card["r"] == "Legendary"
    assert card["t"] == "Hero"
    assert card["img"] == "https://img.example/1001.jpg"
    assert card["u"] == "https://www.tcgplayer.com/product/1001"


def test_build_card_compacts_extra_by_display_name():
    x = bd.build_card(CARD_PRODUCT, GROUP)["x"]
    assert x["Class"] == "Warrior"
    assert x["Cost"] == "7"
    assert x["Health"] == "x" * 120  # exactly at the limit is kept


def test_build_card_extra_excludes_number_rarity_type():
    x = bd.build_card(CARD_PRODUCT, GROUP)["x"]
    assert "Number" not in x
    assert "Rarity" not in x
    assert "Card Type" not in x
    assert "CardType" not in x


def test_build_card_drops_long_text_fields():
    x = bd.build_card(CARD_PRODUCT, GROUP)["x"]
    assert "Card Text" not in x
    assert "Flavor Text" not in x
    assert "Lore" not in x  # value longer than 120 characters


def test_build_card_missing_fields_are_none():
    card = bd.build_card(RARITY_DISPLAY_ONLY_PRODUCT, GROUP)
    assert card["num"] is None
    assert card["t"] is None
    assert card["r"] == "Rare"
    assert card["x"] == {}  # Rarity lives in r, not in x


def test_build_card_matches_names_case_insensitively():
    card = bd.build_card(NUMBER_ONLY_PRODUCT, GROUP)
    assert card["num"] == "5"


# ---------------------------------------------------------------------------
# Price aggregation
# ---------------------------------------------------------------------------

def test_aggregate_prices_keeps_every_subtype_name_as_delivered():
    prices = bd.aggregate_prices(PRICE_ROWS, {"1001", "2002"})
    assert prices["2002"] == {"Normal": [52.0, 50.0, 55.0]}
    # All subtypes kept with their exact names; the later duplicate Normal row loses.
    assert prices["1001"]["Normal"] == [1.8, 1.5, 2.0]
    assert prices["1001"]["Foil"] == [3.5, 3.0, 4.0]
    assert prices["1001"]["Holofoil"] == [0.15, 0.1, 0.2]
    assert set(prices["1001"]) == {"Normal", "Foil", "Holofoil"}


def test_aggregate_prices_skips_only_empty_subtype_name():
    rows = [
        {"productId": 5, "marketPrice": 1, "lowPrice": 1, "midPrice": 1, "subTypeName": ""},
        {"productId": 5, "marketPrice": 2, "lowPrice": 2, "midPrice": 2},
        {"productId": 5, "marketPrice": 3, "lowPrice": 3, "midPrice": 3,
         "subTypeName": "Reverse Holofoil"},
    ]
    assert bd.aggregate_prices(rows) == {"5": {"Reverse Holofoil": [3.0, 3.0, 3.0]}}


def test_aggregate_prices_filters_to_card_ids():
    prices = bd.aggregate_prices(PRICE_ROWS, {"2002"})
    assert list(prices) == ["2002"]


def test_aggregate_prices_without_filter_keeps_all_card_subtypes():
    prices = bd.aggregate_prices(PRICE_ROWS)
    assert set(prices) == {"1001", "2002"}


def test_aggregate_prices_null_values_stay_null():
    rows = [{"productId": 9, "marketPrice": None, "lowPrice": "bad",
             "midPrice": 2, "subTypeName": "foil"}]
    assert bd.aggregate_prices(rows) == {"9": {"foil": [None, None, 2.0]}}


# ---------------------------------------------------------------------------
# ECB rates
# ---------------------------------------------------------------------------

def test_parse_ecb_reads_date_and_rates():
    date, eur = bd.parse_ecb(ECB_XML)
    assert date == "2026-10-23"
    assert eur == {"USD": 1.1, "CHF": 0.92, "GBP": 0.88, "PLN": 4.4}


def test_rates_per_usd_conversion():
    date, eur = bd.parse_ecb(ECB_XML)
    doc = bd.rates_per_usd(date, eur)
    assert doc["date"] == "2026-10-23"
    assert doc["base"] == "USD"
    rates = doc["rates"]
    assert rates["USD"] == 1.0
    assert rates["EUR"] == pytest.approx(1 / 1.1, abs=1e-6)
    assert rates["CHF"] == pytest.approx(0.92 / 1.1, abs=1e-6)
    assert rates["PLN"] == pytest.approx(4.4 / 1.1, abs=1e-6)


def test_rates_without_usd_raises():
    with pytest.raises(bd.PipelineError):
        bd.rates_per_usd("2026-10-23", {"CHF": 0.92})


def test_parse_ecb_rejects_empty_document():
    with pytest.raises(bd.PipelineError):
        bd.parse_ecb(b"<Envelope/>")


# ---------------------------------------------------------------------------
# Collection and failure threshold
# ---------------------------------------------------------------------------

def _groups(n):
    return [{"groupId": i, "name": f"Set {i}", "abbreviation": f"S{i}"} for i in range(1, n + 1)]


def test_collect_aborts_below_half_success():
    groups = _groups(4)
    client = FakeClient(groups, failing={2, 3, 4})  # only group 1 works: 25 %
    with pytest.raises(bd.CollectionAborted):
        bd.collect_catalog(client)


def test_collect_accepts_exactly_half_success():
    groups = _groups(4)
    client = FakeClient(groups, failing={3, 4})  # 50 % is not below 50 %
    catalog = bd.collect_catalog(client)
    assert catalog.ok_groups == 2
    assert catalog.failed_group_ids == [3, 4]
    assert catalog.failed_groups == 2


def test_collect_skips_failed_group_and_keeps_others():
    groups = [GROUP, {"groupId": 99, "name": "Broken", "abbreviation": "BR"}] + _groups(2)
    products = {24: [CARD_PRODUCT, SEALED_PRODUCT]}
    prices = {24: PRICE_ROWS}
    client = FakeClient(groups, products, prices, failing={99})
    catalog = bd.collect_catalog(client)
    assert [c["p"] for c in catalog.cards] == [1001]
    assert catalog.prices["1001"]["Normal"][0] == 1.8
    assert "2002" not in catalog.prices  # sealed product excluded
    assert catalog.failed_group_ids == [99]


def test_collect_raises_when_no_groups():
    with pytest.raises(bd.CollectionAborted):
        bd.collect_catalog(FakeClient([]))


def test_collect_skips_group_with_malformed_product():
    groups = [GROUP, {"groupId": 7, "name": "Other", "abbreviation": "O"}]
    bad = {"name": "no productId", "extendedData": [ext("Number", "1")]}
    client = FakeClient(groups, {24: [CARD_PRODUCT], 7: [bad]}, {24: PRICE_ROWS})
    catalog = bd.collect_catalog(client)
    assert [c["p"] for c in catalog.cards] == [1001]
    assert catalog.failed_group_ids == [7]


# ---------------------------------------------------------------------------
# Fetch layer (fake session, no network)
# ---------------------------------------------------------------------------

def test_tcg_client_sends_user_agent_and_sleeps():
    session = FakeSession({
        bd.GROUPS_URL: FakeResponse({"success": True, "errors": [], "results": [GROUP]}),
    })
    slept = []
    client = bd.TcgClient("UA-test/1.0", session=session, delay=0.15, sleep=slept.append)
    assert client.groups() == [GROUP]
    assert session.calls[0]["headers"] == {"User-Agent": "UA-test/1.0"}
    assert slept == [0.15]


def test_tcg_client_rejects_success_false():
    session = FakeSession({
        bd.GROUPS_URL: FakeResponse({"success": False, "errors": ["nope"], "results": []}),
    })
    client = bd.TcgClient("UA", session=session, sleep=lambda s: None)
    with pytest.raises(bd.PipelineError):
        client.groups()


def test_tcg_client_last_updated_strips_text():
    url = bd.LAST_UPDATED_URL
    session = FakeSession({url: FakeResponse(text="2026-10-26T10:00:00Z\n")})
    client = bd.TcgClient("UA", session=session, sleep=lambda s: None)
    assert client.last_updated() == "2026-10-26T10:00:00Z"


def test_tcg_client_builds_category_urls():
    session = FakeSession({
        f"{bd.TCG_BASE}/tcgplayer/13/24/products": FakeResponse({"success": True, "results": []}),
        f"{bd.TCG_BASE}/tcgplayer/13/24/prices": FakeResponse({"success": True, "results": []}),
    })
    client = bd.TcgClient("UA", session=session, sleep=lambda s: None)
    client.products(24)
    client.prices(24)
    assert [c["url"] for c in session.calls] == [
        "https://tcgcsv.com/tcgplayer/13/24/products",
        "https://tcgcsv.com/tcgplayer/13/24/prices",
    ]


def test_user_agent_string_uses_repo_env(monkeypatch):
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    assert bd.user_agent_string() == "WoWCardPriceScanner/1.0 (+https://github.com/owner/repo)"


# ---------------------------------------------------------------------------
# End to end (offline)
# ---------------------------------------------------------------------------

def test_run_writes_all_outputs(tmp_path):
    groups = [GROUP, {"groupId": 99, "name": "Broken", "abbreviation": "BR"}] + _groups(2)
    client = FakeClient(groups, {24: [CARD_PRODUCT, SEALED_PRODUCT]}, {24: PRICE_ROWS},
                        failing={99})
    out = tmp_path / "site" / "data"
    site = tmp_path / "site"
    now = datetime(2026, 10, 26, 6, 0, tzinfo=timezone.utc)

    summary = bd.run(client, out_dir=out, site_dir=site, now=now)

    assert summary["cards"] == 1
    cards = json.loads((out / "cards.json").read_text(encoding="utf-8"))
    assert cards["generatedAt"] == "2026-10-26T06:00:00Z"
    assert len(cards["cards"]) == 1 and cards["cards"][0]["p"] == 1001

    prices = json.loads((out / "prices.json").read_text(encoding="utf-8"))
    assert prices["priceDate"] == "2026-10-26T10:00:00Z"
    assert "1001" in prices["prices"]

    rates = json.loads((out / "rates.json").read_text(encoding="utf-8"))
    assert rates["base"] == "USD" and rates["rates"]["USD"] == 1.0

    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    assert meta["cardCount"] == 1
    assert meta["groupCount"] == 3
    assert meta["failedGroups"] == 1
    assert len(meta["sources"]) == 2

    index = (site / "index.html").read_text(encoding="utf-8")
    assert 'lang="de"' in index
    assert "data/cards.json" in index


def test_run_aborts_without_writing(tmp_path):
    client = FakeClient(_groups(4), failing={1, 2, 3})
    out = tmp_path / "site" / "data"
    with pytest.raises(bd.CollectionAborted):
        bd.run(client, out_dir=out, site_dir=tmp_path / "site")
    assert not out.exists()
    assert not (tmp_path / "site" / "index.html").exists()


def test_main_returns_nonzero_on_abort(monkeypatch, tmp_path):
    client = FakeClient(_groups(2), failing={1, 2})
    monkeypatch.setattr(bd, "TcgClient", lambda **kwargs: client)
    code = bd.main(["--out", str(tmp_path / "site" / "data")])
    assert code == 1
