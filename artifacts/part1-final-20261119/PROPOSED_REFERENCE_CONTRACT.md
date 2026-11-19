# Proposed acceptance wording correction — owner approval required

`agent/runtime_reference.py:8` (introduced in `00b72ae`) appends signed, run-local reference records to a provider request copy of the current user message. It deliberately preserves the system prompt and stored transcript. Existing native tests require the system prompt to remain equal across runs and the injected record to disappear on the next request.

The acceptance document §5.4 instead requires shared knowledge in system context. Moving untrusted records into the system prompt would change the existing security and prompt-cache contract. No Core change is proposed.

Concrete test proposal: [proposed-runtime-reference.patch](proposed-runtime-reference.patch). It handles multipart input; verifies B cannot see A's knowledge before sharing; checks the exact untrusted-data heading, full knowledge, project_shared visibility, source Bot/run provenance; and confirms B's system prompt remains unchanged and contains none of the injected knowledge. Original native memory, skill, transcript, ACK, scope and disable checks stay in place. The implementation will extract the reference assertion into a fixture helper if needed to meet CC limits.

Proposed §5.4 wording: B can retrieve explicitly shared knowledge and the actual LLM request contains it in an independent run-local untrusted reference part, with verified source/provenance; the system prompt remains unchanged. The trusted user query contains no copied knowledge. C remains denied after reconstruction.

Until owner approval, G6 and Part 1 remain unaccepted. This file and patch are proposals only; no production behavior or frozen candidate source was changed.

## Owner decision

2026-11-19: owner approved acceptance under the existing run-local untrusted reference contract. The implementation will validate the existing session reference format and bind its Bot/thread and active revision to Graph provenance, without changing Core.
