"""Graph delivery preserves the Host source clock across delayed outbox ingestion."""
from datetime import UTC, datetime
import json
from types import SimpleNamespace

from hermes_agui.storage.completion_delivery import stage_evidence


def test_completion_source_time_is_explicit_and_durable():
    recorded = []
    profiles = SimpleNamespace(
        prefix="profiles",
        objects=SimpleNamespace(create=lambda key, body: recorded.append(json.loads(body)) or "generation"),
    )
    scope = SimpleNamespace(project="p", principal="owner", bot="a", object_namespace=lambda: "opaque")
    turn = SimpleNamespace(text="Research a finding", thread_id="t", run_id="r", message_id="m")
    result = {"final_response": "Research finding: durable source timestamps preserve event anchors."}
    assert stage_evidence(profiles, scope, "revision", turn, result,
                          reference_time=datetime(2026, 11, 3, 8, tzinfo=UTC)) == "generation"
    assert recorded[0]["referenceTime"] == {"instant": "2026-11-03T08:00:00.000Z", "timezone": "UTC"}
    stage_evidence(profiles, scope, "legacy", turn, result)
    assert "referenceTime" not in recorded[1]
