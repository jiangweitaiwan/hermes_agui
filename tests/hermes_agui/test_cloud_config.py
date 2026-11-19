"""Trusted cloud configuration parses without creating resources or using credentials."""

from pathlib import Path

import pytest
from fastapi import FastAPI

from hermes_agui.cloud_host import configure_cloud_host
from hermes_agui.host import load_host


def test_cloud_host_requires_durable_backend(monkeypatch):
    monkeypatch.setenv("AGUI_STORAGE_BACKEND", "local")
    with pytest.raises(ValueError, match="durable"):
        configure_cloud_host(FastAPI(), {"hosts": ["host.run.app"]}, None)
    monkeypatch.setenv("AGUI_STORAGE_BACKEND", "gcp")
    with pytest.raises(ValueError, match="exact"):
        configure_cloud_host(FastAPI(), {"hosts": ["*.run.app"]}, object())


def test_host_template_uses_real_configuration_parser(monkeypatch):
    monkeypatch.setenv("AGUI_STORAGE_BACKEND", "gcp")
    for key in ("AGUI_HOST_MANAGEMENT_TOKEN", "OPENROUTER_API_KEY", "AGUI_DELEGATION_TOKEN"):
        monkeypatch.setenv(key, "local-test-value")
    monkeypatch.setattr("hermes_agui.storage.host_settings.load_adapters", lambda prefix: (object(), object()))
    observed = {}

    def build(bots, **options):
        observed.update(options)
        return FastAPI()

    monkeypatch.setattr("hermes_agui.server.create_host", build)
    app = load_host(Path(__file__).resolve().parents[2] / "deploy/gcp/host.example.yaml")
    assert app.state.cloud
    assert observed["management"].templates["assistant"].toolsets == ("memory", "skills")
    assert observed["delegation"].audience == "https://RUNTIME_SERVICE.run.app"
    assert observed["storage"].graph_completions
