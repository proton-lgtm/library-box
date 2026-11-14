# Public-history privacy review

Reviewed on 2026-11-14. Read-only inspection of Git history and historical content; identifiers and candidate secret values are deliberately omitted.

## Findings

No confirmed actionable findings.

A non-no-reply author/committer email appears on 27 commits reachable through the reviewed public heads/tags (example: `9e1f6b51`). The repository owner subsequently confirmed that this is a fake email, so it is not treated as a personal-data exposure. Historical attribution remains recoverable even when later commits use a GitHub no-reply address.

No confirmed live credentials or other accidental project PII were identified in the inspected text. This is not proof that none exists.

## Scope and evidence

- Verified the remote's 4 advertised heads and 5 tags with `git ls-remote`. Their 34 distinct reachable commits were already present in the audited local history. Both annotated tags use no-reply attribution.
- Inspected 176 local refs and 338 reachable commits, extended to 341 commits including reflogs. Local agent refs explain why this scope is larger than public history.
- Inspected 615 reachable historical blobs (556 text, 59 binary inventoried), one additional reflog text blob, and locally OCR-checked four historical screenshots.
- A later unreachable-object inventory contained 655 blobs: 478 text blobs were scanned, while 177 binary blobs were excluded from text analysis. The earlier inventory had 622 blobs; unreachable object counts can change during active local work.
- Generic workstation-account paths in local configuration/build traces were not established to be personal identities or publicly published. Sample unmapped blobs: `c9e39d5effc7`, line 6, and `83068596e11e`, line 45. Original paths and commit associations were not recoverable.
- Inspected the historical bundled extension ZIP at commit `0bd0e616` in memory, without executing or extracting it to disk: 781 entries (376 text, 281 binary, 124 empty), approximately 26.8 MB uncompressed. Candidate matches were third-party contacts, licenses or filter-list syntax. No nested archives, unsafe entry names or size-bound skips were encountered. That archive is absent at the reviewed HEAD and not reachable through the currently advertised public heads/tags.
- Credential-shaped fixtures were reviewed as synthetic test inputs, not reported as live credentials. Other email matches were examples, dependency notices, third-party attribution or asset filenames.

## Limitations

Pattern matching and OCR can miss data. Binary payloads were not comprehensively decoded. GitHub pull-request refs, deleted remote history, forks, release downloads, Actions artifacts and GitHub caches were not audited. Unreachable local objects are not evidence that their contents were ever public.

## Recommendations

- Use GitHub no-reply commit attribution for future commits if personal-email privacy is desired; existing no-reply usage does not erase earlier attribution.
- Enable GitHub secret scanning and push protection where available.
- No confirmed credential exposure from this review warrants credential rotation. No public history was rewritten, no identifiers were removed, and nothing was pushed as part of the audit.
- If historical email removal is later requested, agree the affected refs and coordinate any history rewrite with collaborators. Rewriting cannot guarantee removal from forks, clones or caches.
