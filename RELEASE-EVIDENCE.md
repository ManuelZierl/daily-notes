# Lifecycle Evidence

This repository publishes the format-1 evidence document required for a
promoted external Kestral app. The document is an attestation produced after a
real manual host run. The workflow validates the attestation and package
identity; it does not run Kestral or Tauri tests. Dispatch requires the exact
app `source_commit` and an explicit `tauri_tested: true` manual attestation.

## Two-Commit Boundary

Use the clean app source commit that produced `dist/` as the evidence source
commit. The Kestral release record is filled in by a later metadata-only core
commit, so the core commit that was tested is not changed to record its own
hash or evidence URL. Do not combine those two core commits.

## Manual Observations

Before dispatching **Release evidence**, run the lifecycle checks against the
exact `dist/` package, exact app `source_commit`, and exact Kestral host commit
named in the dispatch inputs. Set `tauri_tested` to `true` only after the real
Tauri run. Keep the workflow's `observations` input as this exact JSON shape.
Every check is required, must have `status: "passed"`, and must describe what
the retained run proved:

```json
{
  "tested_at": "2026-08-06T12:00:00Z",
  "platforms": ["windows-x86_64", "linux-x86_64"],
  "lifecycle": {
    "package_inspection": { "status": "passed", "observation": "..." },
    "permission_denial": { "status": "passed", "observation": "..." },
    "activation": { "status": "passed", "observation": "..." },
    "representative_action": { "status": "passed", "observation": "..." },
    "restart": { "status": "passed", "observation": "..." },
    "update_data_preservation": { "status": "passed", "observation": "..." },
    "disable_enable": { "status": "passed", "observation": "..." },
    "keep_data_uninstall": { "status": "passed", "observation": "..." },
    "purge_data_uninstall": { "status": "passed", "observation": "..." }
  }
}
```

The observations must cover:

1. Package inspection without executing package code: confirm the Daily Notes
   app ID, version, declared host-managed collections, `llm-provider` grant,
   Chat proposal grant, and the declared backend authority summary.
2. Permission denial: deny one requested grant and confirm the denied grant is
   absent and the denied operation is unavailable.
3. Activation: approve the intended grants, activate Daily Notes, and confirm
   today's day entry, hierarchical tasks, and plain-text note blocks load.
4. Representative action: create or update a task, edit a note block, and use
   **Ask AI** to produce a reviewable task proposal through the normal Kestral
   action path; confirm applying the proposal changes tasks only after review.
5. Restart: restart Kestral and confirm Daily Notes activates with the same
   day, task tree, note blocks, and applied-proposal history.
6. Update data preservation: update the package and confirm existing days,
   task hierarchy and completion state, note blocks, and applied-proposal
   records remain readable; record any declared migration result.
7. Disable and re-enable: disable Daily Notes, confirm its capabilities and
   requested authority are unavailable while disabled, then re-enable it and
   confirm data remains present.
8. Keep-data uninstall: uninstall while keeping app data, reinstall the exact
   package, and confirm the day entry, tasks, notes, and applied-proposal
   records return without being recreated.
9. Purge-data uninstall: uninstall with **Purge app data** and confirm package
   data, app config, and app secrets are absent while normal Runs and artifacts
   retain provenance.

The input rejects unknown fields, missing checks, duplicate platforms, malformed
timestamps, failed statuses, and empty observations. `workflow_url` is not an
input: the generator derives it from `GITHUB_SERVER_URL`,
`GITHUB_REPOSITORY`, and `GITHUB_RUN_ID`.

## Dispatch Gates

The workflow checks out Kestral's public schema at pinned commit
`82a983a268911e7a1958b4c6eab06dde334070b1` into `.kestral-contract`; it never
uses a parent-relative schema path. It verifies the clean checked-out app HEAD,
app ID and version, the expected canonical package digest, extension
contributions, and the generated evidence shape. The package CI and this
workflow also rebuild `dist/` and require no generated diff. The generator
accepts every backend declaration that has passed the pinned app schema; it
does not infer or require a backend-free package.

Dispatch with a lowercase 40-hex `source_commit`, `tauri_tested: true`, and a
new `release_tag` matching the workflow's conservative tag syntax. Start the
dispatch from a ref whose `GITHUB_SHA` is the same `source_commit`; a mismatch
is rejected. The tag must not already exist as either a GitHub release or
`refs/tags/<tag>` on the remote. Publication creates a new GitHub release and
uploads an asset whose name includes the app version and source commit.
Existing releases and assets are never overwritten.

The evidence asset is suitable for pinning from Kestral's release record by its
immutable release URL and SHA-256 bytes. It does not bundle the app or grant
the app special authority.
