# Daily Notes

Daily Notes is an ordinary external Kestral app for a fast, local-first daily
workspace. It opens one page per local calendar date, keeps one shared
hierarchical task list above every day, stores plain-text or Markdown note
blocks, and offers explicit LLM-assisted drafts.

App ID: `kestral.daily-notes`

Daily Notes is not bundled with Kestral. Its `dist/` directory installs through
the same package review, grant, sandboxed-surface, Run, and provenance path
available to third-party apps.

## Daily entries and shared tasks

A daily entry contains only that date's note blocks. Its stable ID is
`day-YYYY-MM-DD`, and repeated startup or rollover calls cannot create a second
entry for the same local date.

Tasks are separate app-level entities. The same active list appears above every
daily entry; changing days never copies or moves tasks. The left navigation
groups entries into **Last 7 days**, **Last 30 days**, and **Older**. **Today**
always returns to the current local date.

When the local date changes while the app is open, Daily Notes creates the new
entry. It switches automatically only if the user was viewing the prior current
day. Browsing an older day is not interrupted.

The surface remembers the last selected day in private, revisioned presentation
state and restores it when reopened. Missing or malformed presentation state
falls back to today; notes, tasks, and daily entries remain authoritative
host-managed data.

## Keyboard controls

- The task list is one multiline editor: every non-empty physical line is one
  task. Its checkbox follows the line's visible nesting depth instead of staying
  in a fixed left gutter. The active empty line shows a decorative, muted
  checkbox at its current depth. Task descriptions are intentionally
  single-line; notes remain multiline.
- Type `- [ ] Task text` or `- [x] Task text` on the final blank line. After a
  short typing pause, the Markdown marker becomes a structured task and real
  checkbox. Whitespace variants and uppercase `X` are normalized.
- Press **Enter** in a non-empty task line to focus an unchecked sibling at the
  same depth. In the middle of the list this inserts an optimistic line; on the
  last task it reuses the trailing draft instead of creating two blank rows. A
  nested task therefore stays nested rather than returning to the root.
  Persistence continues in the background; a failed create keeps the draft
  visible and offers a retry.
- Press **Enter** or **Backspace** in an empty leaf line to remove it and move
  the caret to the preceding task. Empty rows with descendants are never
  deleted.
- Press **Tab** to indent a task under its preceding sibling. Tab also nests the
  empty trailing draft without moving focus out of Daily Notes.
- Press **Shift+Tab** to outdent it one level.
- Press **Escape**, then **Tab** to leave the editor by keyboard.
- **Backspace** at the start of a non-empty line and **Delete** at its end merge
  adjacent task lines. Deleting a selection across several lines applies one
  atomic edit; selecting the complete editor removes every active task. Any
  unselected descendants remain in their visible relative hierarchy.
- **Arrow keys** use native multiline-editor navigation. Selection can span
  several tasks for ordinary copy, and remains on the same task text after
  indentation changes.
- Paste multiple Markdown or plain-text task lines into the final blank line to
  import their order and indentation hierarchy. Markdown checkbox markers also
  preserve checked state. Mixed non-marker text is retained as one task per
  non-empty line rather than discarded.

Task moves operate on explicit `parent_id` relationships. Descendants stay
attached to their parent, cycles are rejected, and nesting is capped at eight
levels so the interface remains usable. Tab and Shift+Tab also work on empty
task lines and restore the same text-relative caret or selection after the
move.

## Archive semantics

Only checking a **root task** archives a tree. Checking a child changes that
child only and leaves the whole tree active. A root can be checked even when
some children remain unchecked.

Archiving retains the complete meaningful subtree and every descendant's
individual checked state. Transient empty leaf rows are discarded rather than
becoming archived `Empty task` records. The Archive disclosure is collapsed by
default, shows complete trees with the newest archive date first, and offers
**Restore tree** plus an immediate **Undo last archive** action. Restoring
unchecks the root while preserving checked descendants. Archived tasks are
never age-deleted.

## Notes

Each date owns an ordered list of multiline note blocks. Text and Markdown
syntax are preserved without rich-text conversion. Changes autosave and the
surface reports `Unsaved changes`, `Saved locally`, or `Save failed`.

Every block has an accessible disclosure button. Collapsed blocks use the first
non-empty line as a truncated preview. The full note-header label is a large
collapse target, and its state changes immediately while persistence completes.
Collapse saves pending edits first without sending duplicate save requests;
**Collapse all**, **Expand all**, and the icon-only **Add note** action support
the common workflow. Every open note has accessible copy-all, fit-content, and
delete icon buttons. Deleting a note requires an object-local confirmation in
the Daily Notes surface before the direct action runs.

Note editors can be resized vertically. A manually chosen height survives
collapsing and unfolding that note during the current app session. The
icon-only **Expand to fit content** action grows an open note to its full text
height so the note does not need its own scrollbar.

The shared task editor supports native selection and copy across several tasks,
plus atomic replacement or deletion of a cross-task selection.
The task-header copy action additionally copies the complete active hierarchy
as Markdown with checkbox markers. Search results identify their content type
and navigate to the exact note or task: Daily Notes opens the owning day or
archive, expands a collapsed note, scrolls the target into view, and selects
the matching text where the target is editable.

Reads, automatic rollover, text autosave, disclosure persistence, and transient
empty-row cleanup use the owning surface's private host-managed data store and
do not create capabilities, grants, or Runs. Chat's proposal capability is the
only app capability and is consumer-granted to Chat with `requires-approval`.

## LLM actions and permissions

Daily Notes never contacts a model provider directly and never requests or
stores an API key. Its sandboxed surface invokes Kestral's
`llm-provider/llm.generate` capability under a non-expiring,
`requires-approval` grant. Every call is a normal attributable Kestral Run.

- **Summarize day** returns a draft that can only be inserted as a new note.
- **Extract tasks** validates structured proposals, then lets the user select
  which root tasks to create in one atomic batch.
- **Rewrite** shows original and proposed text and offers **Replace original**,
  **Insert as new note**, or **Cancel**. Translation requires a target language.

Every suggestion retains the source date. Inserting a summary or rewrite after
navigating still targets that source day, and replacing a rewritten note is
refused if the note changed after generation. Confirmation is serialized so a
double click cannot apply one suggestion twice.

No LLM result mutates local data before explicit confirmation. Provider errors,
permission refusals, and invalid structured output remain visible while all
original notes and tasks stay unchanged. The optional **Include active tasks**
checkbox controls whether task text is sent with a day summary or extraction.

## Chat task proposals

Daily Notes declares one bounded `propose-task-changes` capability for Chat.
Chat can propose up to 32 task additions or updates against the `tasks`
collection generation. The payload is strict, reviewable, and never performs a
closed-surface mutation. Kestral records the proposal as a typed
`task-change-proposal` artifact under the approved Chat grant.

On load and refresh, Daily Notes lists its own artifacts and shows pending
proposals in a compact **Task proposals** review area. **Apply** rechecks the
artifact target generation, validates every task-tree invariant, and commits
the task changes plus an `applied` receipt in one data.v2 batch. **Reject**
commits only a `rejected` receipt. Stale, malformed, already handled, and
conflicting proposals remain visibly refused; they are never silently rebased
or applied twice.

## Local storage

Daily Notes is backend-free. Its sandboxed frontend uses Kestral's
`window.appHost.data.v2` store. The package declares host-managed collections
for `days`, `tasks`, `notes`, and `applied-proposals`. Domain rules, validation,
ordering, imports, archive behavior, and conflict handling run in the frontend.

The app-local adapter currently assumes these data.v2 wire shapes so the host
implementation can change without spreading protocol details through the app:

```ts
readSnapshot({ expectedGeneration?, reads: [
  { kind: "record-get", collection, id },
  { kind: "record-list", collection, query?: { after?, limit? } }
]}) // { generation, results } in read order
beginBatch({ expectedGeneration, mutationId, operations: [
  { kind: "create", collection, value },
  { kind: "replace", collection, id, expectedRevision, value },
  { kind: "delete", collection, id, expectedRevision }
]}) // { batchId, generation, documents: [] }
appendBatchOperations({ batchId, mutationId, operations }) // <=64 each
commitBatch({ batchId, mutationId }) // { generation }
abortBatch({ batchId, mutationId })
```

`record-get` results are `{ kind: "record-get", record: record | null }`; list
results are `{ kind: "record-list", records, nextAfter }`. A record is exactly
`{ id, revision, createdAt, updatedAt, value }`; `id` is the host UUID and
revisions/timestamps are host-owned. Every append, commit, and abort has its
own deterministic retry-safe `mutationId`. The app stores its stable
relationship IDs inside `value` and uses decimal `rank` strings for tasks and
notes, avoiding broad renumbering. Every mutation is staged, generation-CAS
checked, and committed atomically; a stale generation/revision or failed final
commit never overwrites the previous state. Large imports append chunks of at
most 64 operations to one batch.

The `applied-proposals` collection stores one receipt per Chat proposal. A
receipt is written in the same batch as an applied task change, or alone for a
rejection, so a proposal cannot be applied twice.

The previous pre-alpha `daily-notes-v1.json` backend format is intentionally not
read or migrated. Installing this backend-free `0.2.1` package starts the new
host-managed v2 collections; any pre-alpha data must be exported or retained by
the user before switching packages. This discontinuity is intentional because
no released-data compatibility promise exists yet.

The frontend domain model remains:

```json
{
  "version": 1,
  "entries": [],
  "tasks": [],
  "notes": []
}
```

Daily entries, tasks, and note blocks use stable app IDs and deterministic rank ordering.
Each task description occupies one physical line; hierarchy remains explicit
`parent_id` metadata rather than whitespace in storage.
The loader rejects unknown fields, unsupported versions, duplicate dates or
IDs within an entity collection, non-canonical day IDs, missing parents,
cycles, hierarchy overflow, inconsistent completion/archive trees, ambiguous
ordering, and orphan notes.
Malformed host records fail with a located adapter error and are not replaced
with an empty workspace. Mutations clone and validate the complete state before
constructing one atomic data.v2 batch.
The surface keeps newer local typing authoritative while a prior save is in
flight, so delayed workspace snapshots cannot roll text back.

Task descriptions are limited to 500 characters, note blocks and Markdown
imports to 100,000 characters, one import to 1,000 tasks, and the complete
stored workspace to 16 MiB. Daily Notes rejects excess input rather than
silently truncating user content. AI context is separately capped at 200,000
characters before anything is sent to the configured provider.

Host-managed records survive ordinary app updates and disable/uninstall. Kestral
owns retention and **Purge app data** removes them.

## Build and test

Node.js 22.19.0 is required only for building and testing this repository. The
installed package is backend-free: it starts no Node.js runtime, native process,
MCP server, or other app-owned backend.

```sh
npm ci
npm run check
npm test
npm run test:package-schema -- /path/to/versioned/kestral/schemas/app.schema.json
npm run package:digest
npm run test:reproducible
```

`npm run build` compiles the self-contained Svelte surface, generates bundled-
dependency notices, writes checksums, and replaces the installable `dist/`
package only after a complete staged build. No backend source, runtime,
migration command, MCP declaration, or backend dependency is packaged.
The package ships the app license and third-party notices as integrity-listed
assets.
CI checks `app.json` against the public Kestral package schema obtained from a
pinned Git commit; it does not depend on a parent checkout or local Kestral
source path. `npm run package:digest` prints the host-compatible package digest:
the SHA-256 of sorted `app.json` and declared assets, each framed with its
little-endian UTF-8 path length and byte length before its exact bytes.
The test suite covers frontend tree invariants, rank ordering, atomic request
construction, generation/revision conflicts, adapter validation, LLM proposal
safety, package/schema consistency, backend absence, responsive markup, and
two-build reproducibility.

The sandbox surface uses Kestral's injected semantic `--color-*` variables and
defines no app-owned palette. Light, Dark, and custom color profiles therefore
apply without rebuilding Daily Notes.

## Installation

1. Run `npm ci && npm run build` in this repository.
2. In Kestral, open **Apps → Install an app**.
3. Choose **Local folder** and select this repository or its `dist/` directory.
4. Choose **Review app**. Kestral shows this package's declared publisher as
   **Unsigned**, because no detached publisher signature is included. Publisher
   metadata does not grant authority; a valid signature changes the identity
   verdict, and a trusted signing key is required for **Trusted** status.
5. Review the **No native backend** runtime summary, the package digest, the
   host-managed collections, and both requested **requires-approval** grants:
   Daily Notes may call `llm-provider/llm.generate` with no provider data scope,
   and Chat may submit reviewable task proposals with an all-resources scope.
   Approve or deny each grant in the trusted prompt.
6. Choose **Install app**, then open **Daily Notes** from the installed-app
   navigation. The minimum supported host is Kestral `0.1.0-alpha.1`.

The custom Svelte surface remains a separate `allow-scripts` opaque-origin
iframe with no Tauri, filesystem, kernel, credential, or direct network access.

## Known limitations

- Note blocks append in creation order; drag/drop and manual note reordering are
  intentionally omitted from the core keyboard workflow.
- Search is local substring search without ranking or advanced query syntax.
- LLM quality and structured-output support depend on the configured provider;
  malformed extraction output is rejected instead of guessed at.
- There is no cloud sync, collaboration, reminders, due dates, labels, rich-text
  editing, or permanent archived-task deletion.
