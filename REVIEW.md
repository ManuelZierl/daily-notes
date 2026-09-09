# Daily Notes review — 2026-09-09

Reviewed `main` at `59b145d26e97a779bd98e17bed7d33435b7e0f75`.
There were no open pull requests when the review started.

## Scope

The review covered the host-managed data adapter, workspace mutations and task
hierarchies, Svelte editing/refresh/rollover paths, proposal parsing and receipt
handling, surface/LLM bridge, presentation state, package generation, release
scripts, workflows, and existing tests. Fixes stay in the external app: no host
privileges, new capabilities, permission changes, or storage-schema migrations.

The original suite passed (27 Vitest tests and 9 Node tests). Passing it did not
cover the failure interleavings below: the data.v2 test double did not paginate,
and mounted editor tests did not simulate edits during a delayed save.

## Fixed findings

| Priority | Failure | Fix and regression coverage |
| --- | --- | --- |
| High | Refresh reused the previous generation, so a normal external write left refresh stuck on a stale generation. | Start a fresh snapshot, pin only continuation pages, and expose explicit reload recovery. Test an external write, conflict, refresh, and subsequent edit. |
| High | Pagination replaced the adapter cache before all pages succeeded and before domain validation. A failed read could leave the store and its mutation baseline inconsistent. | Stage and validate the complete snapshot before publication. Test interrupted pages, generation changes, invalid parent references, and repeated cursors. |
| High | Independent autosaves and refreshes could overlap host batches or operate against different cached snapshots. | Serialize complete workspace operations, including draft creation and proposal checks. Failed operations do not poison the queue. |
| High | A second edit whose debounce elapsed during the first save was retained in memory but never automatically saved. | Drain newer note/task revisions after successful saves; stop on failure. Mounted tests reproduce both editor cases with delayed commits. |
| High | Host events assigned raw workspace data over dirty editor text. | Defer automatic workspace refresh while drafts are pending; preserve local edits on explicit reload. Test dirty and clean event-refresh paths. |
| High | A confirmed commit followed by a failed read was reported as a failed mutation, inviting users to repeat an already-created object. | Distinguish acknowledged success from reload failure. Retain the validated saved draft for display, keep host-record metadata unchanged, and block mutations until reload. Test both store-level task creation and mounted note creation/reload. |
| Medium | Completing a root through a proposal left gaps in active order, so a valid proposal failed workspace validation. Checked-root creation before unchecked creation had the same problem. | Normalize active roots and share archive cleanup with direct checkbox changes. Preserve checked descendants and remove transient blank leaves. |
| Medium | Removing an earlier blank child on archive left surviving child order invalid for restoration. | Normalize surviving archived siblings. Test archive and restore with a blank child before a meaningful child. |
| Medium | Queued proposals checked generation and replay receipts before preceding writes had completed. | Check generation and receipts inside the mutation queue. Guard proposal UI application before its first await. Test stale queued proposals and duplicate receipts. |
| Medium | Rollover advanced “today” before day creation succeeded; the next check then skipped the missing day. | Advance only after success, flush drafts before empty-row cleanup, avoid overlapping rollover calls, and retry failures. Do not interrupt navigation to an older day. |
| Medium | Proposal review concealed update text/completion effects and accepted inconsistent resource identities, while rejecting valid supplementary Unicode at the declared character limit. | Show proposed changes before Apply, require the canonical tasks resource, bound identifiers, and count Unicode code points consistently. |

## Verification

The updated suite has **53 Vitest tests** (26 additions) and **9 Node tests**.
The review added failing reproductions before implementing the core persistence,
editor, rollover, and proposal fixes. Additional tests cover successful recovery
and unchanged workflows.

Validation commands:

```sh
npm run check
npm test
npm run test:package-schema -- .kestral-contract/schemas/app.schema.json
npm run package:digest
npm run test:reproducible
```

The package-schema gate uses the repository's existing pinned Kestral contract
`82a983a268911e7a1958b4c6eab06dde334070b1`. `dist/` is rebuilt with the locked
dependencies; CI checks it against a clean rebuild. The PR's GitHub Actions run
is the authoritative result for the final published revision.

## Boundaries

Mounted UI tests run in jsdom with the host bridge/data.v2 test double. They are
not a manual Tauri/WebView install, real-host multi-window test, or release
qualification. The existing release-evidence workflow remains unchanged.

The acknowledged-commit recovery test deliberately distinguishes a received
success response followed by read failure from a lost commit acknowledgement.
This change does not claim end-to-end exactly-once behavior when the host commits
but its response never arrives; that needs a dedicated host-transport recovery
contract and real-host fault injection. Large-workspace performance and native
accessibility/layout verification also remain separate validation work.
