"""Send committed Host turn evidence to the Runtime Graph ingestion contract."""

import argparse
import json
import logging
import re
from time import sleep
from urllib.parse import urlsplit

from hermes_agui.storage.run_outbox import PostgresRunOutbox

_MAX_EVIDENCE = 512 * 1024
# Match the Runtime's credential patterns before writing an additional evidence object.
_SENSITIVE = re.compile(
    r"(?:\b(?:sk-[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b|-----BEGIN .*PRIVATE KEY|"
    r"(?:password|api[_ -]?key|authorization|密碼|金鑰)\s*[:=]\s*\S+|Bearer\s+\S+)",
    re.IGNORECASE,
)


def _key(profiles, scope, revision):
    return f"{profiles.prefix}/{scope.object_namespace()}/{revision}/completion.json"


def stage_evidence(profiles, scope, revision, turn, result):
    answer = result.get("final_response")
    if not isinstance(answer, str) or not answer.strip():
        return None
    if any(len(value.encode("utf-8")) > limit or "\0" in value for value, limit in (
        (turn.text, 16384), (answer, 65536), (turn.thread_id, 512), (turn.run_id, 512),
    )):
        return None
    if _SENSITIVE.search(f"{turn.text}\n{answer}"):
        return None
    payload = {
        "namespace": {"projectId": scope.project, "principal": scope.principal,
                      "botId": scope.bot, "visibility": "bot_private"},
        "runId": turn.run_id, "threadId": turn.thread_id, "messageId": turn.message_id,
        "user": turn.text, "assistants": [{"id": "final", "text": answer}],
    }
    return profiles.objects.create(_key(profiles, scope, revision), json.dumps(payload).encode())


class GraphCompletionDispatcher:
    def __init__(self, profiles, client, url, token, audience=None):
        address = urlsplit(url)
        secure = address.scheme == "https" or (
            address.scheme == "http" and address.hostname in {"localhost", "127.0.0.1", "::1"}
        )
        if (not secure or not address.hostname or address.username is not None
                or address.path != "/internal/graph/completions" or address.query or address.fragment):
            raise ValueError("Invalid Runtime Graph completion URL")
        if len(token) < 32 or not token.isascii() or any(not 33 <= ord(c) <= 126 for c in token):
            raise ValueError("Invalid Runtime Graph completion token")
        if audience is not None:
            identity = urlsplit(audience)
            if (address.scheme != "https" or identity.scheme != "https" or identity.netloc != address.netloc
                    or identity.path not in {"", "/"} or identity.query or identity.fragment):
                raise ValueError("Completion audience must match its HTTPS destination")
        self.profiles, self.client, self.url, self.token = profiles, client, url, token
        self.audience = audience

    def deliver(self, event):
        if event.evidence_generation is None:
            return
        body = self.profiles.objects.read(_key(self.profiles, event.scope, event.profile_revision),
                                          event.evidence_generation, limit=_MAX_EVIDENCE)
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        if self.audience:
            from hermes_agui.cloud_identity import identity_headers

            headers.update(identity_headers(self.audience))
        response = self.client.post(
            self.url, content=body, follow_redirects=False,
            headers=headers,
        )
        if response.status_code != 204:
            raise RuntimeError("Runtime did not acknowledge Graph completion")


def main():
    import os

    import httpx

    from hermes_agui.storage.host_settings import load_adapters, open_host_pool

    parser = argparse.ArgumentParser(description="Dispatch committed Host completions to Graph ingestion")
    parser.add_argument("--prefix", default="profiles")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--audience", help="Runtime HTTPS service audience for Google identity")
    args = parser.parse_args()
    # Delivery keys use the scope persisted by the writer. The worker handles
    # completions from every scope in its Host database.
    pool, profiles = load_adapters(args.prefix)
    outbox = PostgresRunOutbox(pool)
    with httpx.Client(timeout=10, trust_env=False) as client:
        dispatcher = GraphCompletionDispatcher(
            profiles, client, os.environ["AGUI_GRAPH_COMPLETION_URL"],
            os.environ["AGUI_GRAPH_COMPLETION_TOKEN"], audience=args.audience,
        )
        try:
            open_host_pool(pool)
            if args.once:
                outbox.dispatch_once(dispatcher, lease_seconds=300)
                return
            while True:
                try:
                    if outbox.dispatch_once(dispatcher, lease_seconds=300) is not None:
                        continue
                except Exception:  # health: allow BLE001 -- database/HTTP errors can include credentials
                    logging.warning("Graph completion dispatch failed")
                sleep(1)
        finally:
            pool.close()


if __name__ == "__main__":
    main()
