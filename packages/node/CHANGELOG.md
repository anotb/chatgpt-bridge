# Changelog

## 0.8.2

- Replaces existing composer draft text with the exact requested prompt instead of blocking new submissions.
- Accepts zero-turn ChatGPT home pages whose composer restores draft text.
- Replaces the handcrafted atomic composer-envelope predicate with one direct visible Send click followed by rendered-turn reconciliation.
- Tracks ChatGPT's current structural composer-pill mode control for Power discovery.
- Fixed exact multiline prompt verification against ChatGPT's contenteditable paragraph structure.
- Reads zero-pill prompts from the live editor and retains clone-based inline tool-pill stripping.
- Preserves rendered-turn ownership and at-most-one Send activation.

## 0.8.1

- Fixed current ChatGPT Power discovery when the attachment and Power controls coexist as composer menus.
- Verifies the unique Power trigger's visible label against the dynamically discovered active slider mode.
- Preserves exact composer ownership, durable recovery, and at-most-one Send activation.

## 0.8.0

- Replaced the legacy public surface with `createChatGPTBridge`, `submit`, `collect`, `run`, and `inspectTargets`.
- Removed the backend protocol, command registry, Work/Responses layers, locales, review workflows, Python parity, and compatibility exports.
- Added a direct visible-browser port, durable caller operation IDs, one atomic whole-envelope Send activation, metadata-only polling, and exact assistant-owned output/artifacts.
- Replaced chooser-driven upload with one exact background composer-input handoff and exact ordered multi-file readiness.
- Added exact active tool-set verification, both turn baselines, stable final identities, lossless clipboard gating, artifact-only generated-image ownership, and explicit bounded artifact-transfer results.

## 0.7.20

- Fresh AskPro briefly waits for a provisional WEB route to become canonical
  before strict existing-conversation proof, avoiding a first-call resume;
  final full capture drops superseded metadata-only poll warnings.

## 0.7.19

- Fresh AskPro workflows now open a dedicated ChatGPT tab instead of reusing
  arbitrary existing tab state; the path is live-qualified through a verified
  Pro submission and duplicate-safe same-archive completion.

## 0.7.18

- After claiming an existing background tab, exact canonical recovery now waits
  for its conversation DOM to hydrate before strict prompt proof; it does not
  navigate, open a new tab, or resubmit.

## 0.7.17

- Exact canonical recovery may try one already-matching alternate tab after the
  first returns the recognized ownership conflict; it never relists, navigates,
  creates, or resubmits, and every other error remains terminal.

## 0.7.16

- Internal recovery may select among duplicate tabs for the same canonical
  conversation, then re-verifies exact prompt and tab affinity; generic
  ambiguity remains strict, with no duplicate open or resubmit.

## 0.7.15

- Claimed-tab page-state checks no longer reference an unavailable
  `HTMLElement` runtime global, so authenticated recovery continues without
  false unresponsive blockers.

## 0.7.14

- Older archives with a legacy claim-handle tab identity now reclaim
  provider-first with a safe legacy fallback, avoiding another handoff loop.

## 0.7.13

- A fresh host claims an exact provider-matched open tab before repeating stale
  controlled-metadata handoff, preventing a handoff loop without opening or
  submitting duplicates.

## 0.7.12

- Hands a stale controlled tab back to Chrome so a later same-archive,
  fresh-host resume can reclaim the exact tab and conversation.
- Distinguishes a pre-submit checkpoint, which may continue to the first
  submit, from intent or receipt recovery, which never resubmits.
- Documents a 5–10 minute outer host envelope and prose-only polling backoff
  while preserving duplicate-tab and submit-once protections.

## 0.7.11

- Enforces canonical conversation and visible-tab affinity across AskPro
  attachment, submission, polling, complete response capture, Pro verification,
  and artifact handling, with structured blockers on drift.
- Requires a unique exact-prompt match when reconciling provisional `WEB:`
  receipts and uses a persisted tab ID only to disambiguate otherwise identical
  candidates; exact resumes claim an existing tab instead of opening duplicates.
- Writes configuration, redacted report, and receipt provenance before the
  terminal outcome, and makes a late provenance failure authoritative through
  `archive-commit-failure.json` when that marker can be persisted.
- Retains packet inventory and all safety exclusions when
  `includeChangedFiles` disables source snapshots, and narrows generic
  credential-directory matching so ordinary application source and fixtures
  remain reviewable while hard-secret filenames and provider stores stay out.
- Treats a visible, exact login control outside message content as logged out,
  while authenticated structural account, history, composer, and conversation
  evidence prevents brittle false negatives.

## 0.7.10

- Uses Node's OS platform signal and the kernel `SystemRoot` device path for
  exact Windows PID checks when a restricted host omits the process shim's
  signal or environment fields; no shell or `PATH` lookup is used.
- Uses a five-minute no-heartbeat timeout as an availability fallback only for
  an already-submitted, non-resubmittable review when process liveness is
  unavailable or ambiguous in a restricted browser host; demonstrably live
  owners remain locked regardless of lease age and pre-submit archives remain
  fail-closed.
- Revalidates the generation-specific ownership marker during cleanup so a
  delayed release cannot remove a successor's lease.

## 0.7.9

- Falls back to an exact Windows PID query when the runtime cannot determine
  archive-lease owner liveness with a process signal probe.
- Reclaims only a proven-dead owner's lease; live or ambiguous owners
  remain locked so concurrent resumes still fail closed.
- Resolves the Windows process tool from the trusted system directory and uses
  a generation-specific directory lease to preserve concurrent-owner safety.

## 0.7.8

- Treats a claim conflict as a miss only for generic preferred-tab discovery,
  allowing new workflows and doctor checks to use a fresh ChatGPT home tab.
- Preserves strict claim conflicts for exact existing-tab targets and AskPro
  resumes, with regressions covering both paths.

## 0.7.7

- Canonicalizes confirmed provisional AskPro receipts to a prompt-identical
  visible UUID conversation during resume without resubmission.
- Detects the current authenticated Chat DOM from multiple structural signals
  and pauses resumably when an existing canonical tab is temporarily claimed.
- Adds regressions for canonical timeout recovery, authenticated-page
  classification, duplicate-tab prevention, and dead-owner lease reclamation.

## 0.7.6

- Ensures a successful exact-artifact release gate schedules the stable GitHub
  release when optional npm publication is disabled.

## 0.7.5

- Retains deletion and rename evidence in working-tree review packets, carries
  successful command warnings through the workflow, and tolerates known
  visible prompt presentation wrappers during duplicate-safe resume.
- Narrows over-broad environment/template and source-token exclusions without
  weakening credential-file and credential-directory protection.
- Verifies exact checksummed release assets rather than rebuilding them during
  downstream package smoke and publication jobs.

## 0.7.4

- Batches committed Git blob reads for full-repository packets after the same
  secret, generated-file, file-mode, and size preflight checks.
- Avoids two Git process launches per committed source while retaining NUL-safe
  filename handling and exact requested-head evidence.

## 0.7.3

- Normalizes bounded partial polling snapshots from an actively generating Pro
  answer to the review workflow's resumable `in_progress` outcome.
- Preserves terminal handling for explicitly stopped partial responses.

## 0.7.2

- Adds ergonomic committed and first-commit full-repository packets with an
  opt-in working-tree overlay for committed repositories.
- Hardens packet privacy, NUL-safe path handling, packet budgets/fences,
  immutable resume bindings, terminal fallback outcomes, and renewable leases.
- Preserves caller-defined AskPro questions instead of narrowing the workflow
  to diff reviews or a mandatory output schema.

## 0.7.1

- Treats a completed archive's final artifact manifest as authoritative on
  resume, preventing unrelated current-page artifacts from changing the result.

## 0.7.0

- Publishes the stable SDK as `chatgpt-pro-review-bridge`.
- Includes flexible AskPro questions, repository-backed review packets,
  same-thread follow-ups, bounded resume, strict Pro verification, and complete
  Markdown and artifact capture.

## 0.6.0-beta.9

- Avoids false in-progress results from unrelated generic cancel controls in
  the current Chat UI.

## 0.6.0-beta.8

- Recovers archives whose previous bounded browser call was interrupted while
  creating its lease record.

## 0.6.0-beta.7

- Adds `thread` targeting for new AskPro questions so follow-ups retain strict
  Pro verification, exactly-once submission, and bounded resume behavior.

## 0.6.0-beta.6

- Adds visible-history recovery for provisional Chat conversation IDs.
- Makes archive leases resilient to process-ID reuse after bounded browser
  calls exit.
- Restores lexical containment checks before validation-path canonicalization.

## 0.6.0-beta.5

- Documents the distinction between one bounded poll invocation and the
  unbounded same-archive resume loop used for long Pro work.

## 0.6.0-beta.4

- Uses a 20-second default metadata wait so a bounded browser host can return
  and release its archive lease before the next resume call.

## 0.6.0-beta.3

- Recovers archive ownership when a bounded browser evaluator is still exiting
  at the start of the next resume call.

## 0.6.0-beta.2

- Handles platform path aliases before enforcing validation-output containment
  without following a symbolic-link leaf.
- Updates audited development-only transitive dependencies.

## 0.6.0-beta.1

- Promotes the context-free AskPro workflow after deterministic and live
  alpha qualification.
- Pins generated runtime line endings for Windows source-install parity.

## 0.6.0-alpha.14

- Supports repository-free Pro questions with exact prompt submission, no packet
  attachment step, and the same durable completion/resume workflow.
- Recovers an interrupted workflow when its recorded lease owner has exited.

## 0.6.0-alpha.13

- Tightens strict Pro verification and prompt-to-response ownership proof after
  incorporating the completed live Pro review's concrete findings.

## 0.6.0-alpha.12

- Compares prompt-identical visible user turns modulo whitespace layout so DOM
  line-break flattening does not prevent safe same-thread resume.

## 0.6.0-alpha.11

- Resumes a prompt-identical currently visible Chat conversation before history
  search, preserving the same-thread and no-resubmit guarantees.

## 0.6.0-alpha.10

- Routes provisional ambiguous receipts through visible history recovery before
  browser bootstrap while retaining the no-resubmit guarantee.

## 0.6.0-alpha.9

- Preserves the canonical post-submit Chat thread and makes ambiguous visible
  submission evidence explicitly resumable without allowing a resend.

## 0.6.0-alpha.8

- Fixes cross-platform npm launcher path resolution in the release gates.
- Removes heuristic packet-content scanning and structured-findings parsing,
  while making instruction, caller, and related-test expansion opt-in.

## 0.6.0-alpha.7

- Adds flexible `reviews.askPro`, rendered-prompt reconciliation, ambiguous
  receipt recovery without resubmission, Pro no-op selection, opt-in setting
  restoration, and explicitly confirmed `messages.stop` support.

## 0.6.0-alpha.6

- Hardens visible uploads, origin checks, packet provenance and secret
  exclusion, crash-safe exactly-once submission, archive-bound resume,
  concurrent archive leases, artifact identity, blocker scoping, and terminal
  provenance publication.

## 0.6.0-alpha.5

- Prevents untracked local `.codex/` archives and task state from recursively
  entering review packets, while retaining tracked `.codex/` repository files
  and explicit exclusion provenance.
- Uses the Chrome bridge's scoped CDP capability only to open Chat's hidden
  file input with a user gesture; the approved chooser remains responsible for
  transferring absolute local paths, including large review packets.
- Reports native-pipe disconnects and unavailable upload surfaces separately
  from explicit Chrome/Codex permission denials.

## 0.6.0-alpha.4

- Treats `plugins/*/runtime/node/*.mjs` as deterministic generated artifacts:
  they remain listed in the review manifest but are excluded from packet source
  snapshots and diffs in favor of the source plus bundle-parity evidence.

## 0.6.0-alpha.3

- Adds strictly verified selection through the current five-position Chat
  power slider, with the current Advanced effort picker as a fallback.
- Updates file attachment for Chat's focusable upload command-palette row and
  handles early chooser timeouts without unhandled rejections.
- Makes archived submission evidence authoritative for bounded resume and
  checkpoints the stable conversation ID recovered from visible Chat history.
- Keeps Pro active across `in_progress` results, reads full Markdown once, and
  restores the prior visible setting only for terminal results.
- Normalizes current download-prefixed artifact controls, supports workbook
  previews, and checkpoints each verified artifact for duplicate-free resume.
- Makes immutable archive writes idempotent for equal content while rejecting
  changed content, and prefers controlled tabs before external tab claims.
- Replaces canary marker and synthetic-artifact checks with full-response hash
  agreement and exactly-one-visible-user-turn verification.

## 0.6.0-alpha.2

- Fixes logged-out shell detection so visible login walls fail closed as
  `login_required` instead of being masked by generic navigation markers.

## 0.6.0-alpha.1

- Adds the resumable, exactly-once `chatgpt.reviews.codeReview` workflow with
  deterministic review packets, strict visible Chat Pro verification, full
  Markdown capture, provenance archives, and verified setting restoration.
- Adds visible artifact baselines, complete delta downloads (including
  duplicate same-name files), collision-safe archive names, and SHA-256
  manifests.
- Adds portable plugin packaging and a bounded live canary while preserving the
  visible-session boundary and fail-closed model/fallback behavior.

## 0.5.1-alpha.1

- Fixes current Chat/Work switching through the visible surface-radio group and
  preserves older selector fallbacks.
- Correctly identifies checked Work home state, active Work tasks, and the
  current compound Work configuration opener.
- Adds reusable live-smoke coverage for Chat/Work routing, strict configuration
  verification, Work start/status/wait/read/steer/artifacts, and Work-backed
  Runner and Responses paths.

## 0.5.0-alpha.1

- Adds `experience.detect/open`, `configuration.inspect/apply`, and the Work task lifecycle command group.
- Adds scoped Chat/Work selector profiles, strict configuration postcondition verification, and sanitized profile fixtures.
- Adds runner/Responses experience and configuration inputs plus milestone events.
- Preserves existing `mode`, `modes.set/get`, commands, package imports, and wire fields for backward compatibility.

## 0.3.0-alpha.1

- Hardens mode-menu detection and selection against thread/sidebar action menus, with locale-registry-backed thread-action vetoes and container-scoped menu enumeration.
- Adds the `modes.get` primitive and post-selection verification warnings on `modes.set`.
- Rewrites wait polling around a single combined DOM snapshot per poll; response text is fetched once at completion instead of every poll.
- Adds Windows and Linux clipboard capture with DOM fallback.
- Fixes report `createdAt` to honor the injected clock for deterministic fixtures.

## 0.2.0-alpha.1

- Adds Windows-safe host path validation and cross-platform backend gates.
- Adds localized ChatGPT selector support through the locale-label registry.
- Adds untrusted-output safety envelopes and integrity sidecar verification helpers.

## 0.1.0-alpha.1

- Initial public alpha package metadata and source layout.
