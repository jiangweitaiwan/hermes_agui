"""ADC identity for trusted service destinations; business authorization stays separate."""

from functools import lru_cache
from urllib.parse import urlsplit


@lru_cache(maxsize=16)
def _request():
    from google.auth.transport.requests import Request

    return Request()


def identity_headers(audience, *, timeout=None):
    from google.oauth2.id_token import fetch_id_token

    address = urlsplit(audience)
    if address.scheme != "https" or not address.hostname or address.username or address.query or address.fragment:
        raise ValueError("Service audience must be an HTTPS service URL")
    request = _request()
    if timeout is not None:
        def request(**kwargs):
            kwargs["timeout"] = timeout
            return _request()(**kwargs)
    return {"X-Hermes-Service-Identity": fetch_id_token(request, audience)}
