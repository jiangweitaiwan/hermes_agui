# Restored guard provenance

The fork's initial commit `5be5ce2e28a54687c377fc6c4b53544acf83f462`
includes `scripts/check` but omits six helpers it invokes. No deletion or prior
helper implementation exists in this fork's history.

Restored without policy changes from NousResearch/hermes-agent (same repository
license):

| Helpers | Upstream commit |
| --- | --- |
| check_os_marker_fakes.py, check_agents_md_size.py, check_lazy_deps_imports.py, check_profile_archive_boundary.py, check_blob_size.py | b738747fe8377555e7f44ae2ac6993bd02b7693f |
| check_line_endings.py | 9dc7e6a524fc0b0a88845ecfade5ed004fe27e9d |

The first reference's `scripts/check` matches this fork's checker except for
the line-endings entry introduced by the second reference. This avoids pulling
later upstream path moves into the fork. All original guard thresholds and
failure behavior are retained. The two git inventories in the lazy-deps helper
now have a bounded 60-second timeout to satisfy the fork's HX006 rule.
`code_health/ts_measure.py` discovers tracked
Node package roots so the existing engine measures the full changed-file set
even when there is no root Node package.
