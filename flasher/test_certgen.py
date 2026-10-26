"""Tests für die Zertifikatserzeugung (EC P-256, SAN, 10 Jahre)."""

import datetime as dt

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from certgen import VALIDITY_DAYS, generate_self_signed


@pytest.fixture(scope="module")
def pair():
    return generate_self_signed("WoWScanner")


def _cert(pem):
    return x509.load_pem_x509_certificate(pem.encode("ascii"))


def test_returns_pem_strings(pair):
    cert_pem, key_pem = pair
    assert cert_pem.startswith("-----BEGIN CERTIFICATE-----")
    assert key_pem.startswith("-----BEGIN PRIVATE KEY-----")  # PKCS#8


def test_key_is_ec_p256_and_matches_certificate(pair):
    cert_pem, key_pem = pair
    cert = _cert(cert_pem)
    assert isinstance(cert.public_key(), ec.EllipticCurvePublicKey)
    assert cert.public_key().curve.name == "secp256r1"
    key = serialization.load_pem_private_key(key_pem.encode("ascii"), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    assert key.curve.name == "secp256r1"
    pub_from_key = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    pub_from_cert = cert.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    assert pub_from_key == pub_from_cert


def test_common_name_is_lowercase_hostname(pair):
    cert = _cert(pair[0])
    assert cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == "wowscanner"
    assert cert.issuer == cert.subject  # selbst signiert


def test_san_contains_hostname_dot_local(pair):
    cert = _cert(pair[0])
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert san.get_values_for_type(x509.DNSName) == ["wowscanner.local"]


def test_valid_for_about_ten_years(pair):
    cert = _cert(pair[0])
    not_before = getattr(cert, "not_valid_before_utc", None) or cert.not_valid_before.replace(tzinfo=dt.timezone.utc)
    not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after.replace(tzinfo=dt.timezone.utc)
    span = not_after - not_before
    assert dt.timedelta(days=VALIDITY_DAYS) <= span <= dt.timedelta(days=VALIDITY_DAYS, hours=1)
    assert VALIDITY_DAYS >= 3650


def test_is_server_auth_leaf_certificate(pair):
    cert = _cert(pair[0])
    eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ExtendedKeyUsageOID.SERVER_AUTH in eku
    basic = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
    assert basic.ca is False


def test_signature_is_valid_for_own_key(pair):
    cert = _cert(pair[0])
    cert.public_key().verify(cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(cert.signature_hash_algorithm))


def test_each_call_creates_a_new_key():
    assert generate_self_signed("wowscanner")[1] != generate_self_signed("wowscanner")[1]


def test_empty_hostname_is_rejected():
    with pytest.raises(ValueError):
        generate_self_signed("   ")
