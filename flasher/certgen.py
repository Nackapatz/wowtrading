"""Erzeugt ein selbst signiertes EC-P-256-Zertifikat für den ESP8266-HTTPS-Server."""

from __future__ import annotations

import datetime as _dt
from typing import Optional, Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

VALIDITY_DAYS = 3650  # rund 10 Jahre


def generate_self_signed(hostname: str, now: Optional[_dt.datetime] = None) -> Tuple[str, str]:
    """Liefert (zertifikat_pem, schluessel_pem) für CN=hostname, SAN DNS hostname.local.

    Der Schlüssel wird als PKCS#8-PEM ausgegeben (BEGIN PRIVATE KEY).
    """
    host = hostname.strip().lower()
    if not host:
        raise ValueError("Hostname darf nicht leer sein.")

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    if now is None:
        now = _dt.datetime.now(_dt.timezone.utc)

    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - _dt.timedelta(minutes=5))  # Uhrenabweichung tolerieren
        .not_valid_after(now + _dt.timedelta(days=VALIDITY_DAYS))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(f"{host}.local")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
    )
    cert = builder.sign(private_key=key, algorithm=hashes.SHA256())

    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    return cert_pem, key_pem
