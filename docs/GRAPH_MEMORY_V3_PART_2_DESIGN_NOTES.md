# Part 2 design notes

Base HEAD: afde2e67b53d5684792d6447ffcc03d7f53fe9a6 (Part 1 accepted per user).
Existing unrelated deletions and edits are preserved. No cloud deployment or paid model calls.

The runtime consumes Part 1's issued-scope structuredQuery/validateNet rather than opening a new read API.
Storyteller is an optional bounded read-only adapter; absence or invalid output uses an extractive deterministic story.
Grounding is deliberately stricter than arbitrary paraphrase: exact authorized description/section, references and confidence,
no extra summary, events or warnings. All required claims must survive validation; the context packer prunes whole claims.
Natural-language paraphrase validation cannot establish attribution or causal truth, so this version accepts ordering only.

After model await, validateNet rebuilds the entire authorized view. Any change invalidates generated prose and rebuilds
from the fresh Net. Records group only the same source Bot and visibility, preserve real session/document provenance,
and include original quotes, event IDs, attribution and structured effective time. No new record schema or graph writes.

Runtime deadline is distinct from V2 query timeout. The same cancellation signal reaches structured retrieval, Storyteller
and revalidation. Scope rejection never invokes fallback. Parser failure and V1 namespace invoke the original V2 path;
read/revalidation unavailability returns empty memory. An empty structured Net falls back to authorized V2 fragments,
which also preserves V1 namespaces without changing Part 1 contracts.

Validation also checks the total serialized model input (98304 bytes), not only Net size.
The 32768-byte model output bound is separate from the final 4096-byte context budget.
In-flight models that ignore cancellation retain their concurrency slot until settlement;
repeated timeouts cannot start unbounded model calls.
