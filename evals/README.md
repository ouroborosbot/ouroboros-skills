# Skill evaluations

These files are behavior contracts for external agent runs.

Regex prose checks can remain textually correct while composed runtime behavior regresses; these cases preserve external-run contracts, while CI validates schema, coverage, and source freshness only.

CI does not run or judge a model.

A real behavior claim requires an external harness result whose complete, current receipt passes `verify`.

Declared source completeness is a maintainer-reviewed mapping that the script cannot infer; any change to a declared owner requires review.

The pilot fingerprints each declared owner as a whole file; do not add section or anchor extraction unless whole-file review becomes insufficient.

Run `node scripts/skill-evals.cjs validate`, `node scripts/skill-evals.cjs fingerprint evals/investigation-boundaries.json`, or `node scripts/skill-evals.cjs verify path/to/result.json`. The fingerprint command prints both hashes a receipt must carry; use its output instead of reserializing the contract.

Add scenarios from observed regressions, not to inflate counts.
