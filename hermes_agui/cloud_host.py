"""Cloud ingress configuration; IAM is enforced by private Cloud Run ingress."""

import os

from starlette.middleware.trustedhost import TrustedHostMiddleware


def configure_cloud_host(app, value, storage):
    if value is None:
        return app
    if os.environ.get("STORAGE_EMULATOR_HOST"):
        raise ValueError("Cloud Host forbids storage emulator")
    if not isinstance(value, dict) or set(value) != {"hosts"}:
        raise ValueError("cloud requires an explicit hosts allowlist")
    hosts = value["hosts"]
    if not isinstance(hosts, list) or not hosts or any(not isinstance(host, str) or not host or "*" in host for host in hosts):
        raise ValueError("Configure exact cloud hosts")
    if storage is None or os.environ.get("AGUI_STORAGE_BACKEND") != "gcp":
        raise ValueError("Cloud Host requires durable storage")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)
    app.state.cloud = True
    return app
