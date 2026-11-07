---
name: m365-timesheet
description: "Weekly timesheet generation from M365 Copilot, cross-checked against local case folders and Dataverse"
---

# M365 Timesheet Skill

This skill lets you (the AI Coding Agent) or the user generate a consultant timesheet for a
date range by asking M365 Copilot (Claude Opus) to mine Outlook, Teams and calendar activity,
and then **verifying every number locally** against the case folders under `CASES_ROOT` and
against the Dataverse cases the user works on.

The run is intentionally **CRM-first**: Copilot starts from the CRM case list (plus portal
comments and status-comment history), then expands with M365 discovery for meetings/emails/chats
and work not tied to a CRM case.

It is the sibling of `m365-case-intake` and reuses its browser profile and Playwright driver.

## Division of responsibilities

This is the rule the whole design depends on:

| Actor | Responsibility |
| --- | --- |
| M365 Copilot (Claude Opus) | Mine Outlook / Teams / calendar for the range and **print** one `json` block of granular evidence items plus metadata. Nothing else. |
| The local Node.js scripts | Re-derive every total, enforce every formatting rule, reconcile against git history and Dataverse, and render the CSV and markdown report. |

Copilot is never asked to compute roll-ups, count characters, split months, or write files.
Its arithmetic is never trusted: the validator recomputes it. If Copilot answers "I cannot
write to your local drive", that is a contract violation caused by a local path leaking into
the prompt, not a limitation — `prompt_builder.js` throws before that can happen.

## Initial setup

Before the first run, guide the user through setup:

1. `cd` to `C:/Users/<user>/.copilot/skills/m365-timesheet`.
2. Run `npm install` (Playwright is also resolved from the sibling `m365-case-intake` skill if
   it is not installed locally).
3. **Do not run setup blindly.** Ask the user interactively for:
   - Full name and work email
   - `CASES_ROOT` — the folder holding `<Client>/<CASE-ID> - <Title>` (e.g. `C:/Users/Name/Source`)
   - Timezone the timesheet is submitted in (e.g. `US/Eastern`)
   - Hours per working day (e.g. `8`) and the working days
   - Whether non-billable/internal time should be included
   - Client aliases used in emails (e.g. `ACME=Acme Corporation`)
   - Whether to query Dataverse, and if so the org URL and the `az` config dir
4. Write `config.json` (start from `config.example.json`).
5. Run `npm run setup` to log into M365 Copilot once in the persistent browser profile.

The date range is **never** stored in config — it is passed per run.

## Usage

```bash
npm run timesheet -- "last week"              # full run against M365 Copilot
npm run timesheet -- "2026-08-31..2026-09-04" # explicit ISO range
npm run timesheet -- "last week" --dry-run    # build and print the prompt, send nothing
npm run timesheet -- "last week" --no-crm     # skip Dataverse
npm run timesheet -- "last week" --hours 7.5  # override the daily quota for this run
npm run timesheet -- "last week" --from-file logs/latest_response.md  # re-parse a saved reply

npm run evidence -- "last week"   # only the local git / file scan
npm run cases                     # only the Dataverse case list
npm run prompt -- "last week"     # only render the prompt
npm test                          # unit tests
```

Accepted ranges: `last week`, `this week`, `this month`, `last month`, `past 10 days`,
`past 2 weeks`, `2026-08-31..2026-09-04`, `2026-08-31 to 2026-09-04`. Ambiguous slash dates
(`03/09/2026`) are rejected on purpose.

## Output contract

Copilot must reply with exactly one fenced ` ```json ` block and no prose.

Required keys: `range`, `evidence_items`, `discovered_ids`, `verify`, `assumptions`
(optionally `context_only`, `evidence_notes`, and `needs_case_confirmation`).

The JSON is evidence-only. The skill composes final timesheet rows locally, then validates
0.25 increments, two decimals, daily quotas, one row per client/day, description length and
internal-line policies before writing outputs.

Description policy for multi-case rows: compose concise per-case snippets and render them as
`CAS-123: ...; CAS-456: ...` within the same 255-char maximum.

For internal-systems rows (e.g. `INT-0001`), keep the ticket in `Tickets/Cases` but do not
force the `INT-*` identifier into the Description text.

When running this skill inside Copilot chat (agent execution), apply this mandatory loop for
description quality:
1. Validate max length with code (`<=255`).
2. If any row exceeds 255, compact that row with the same agent AI (semantic rewrite, not raw
   string truncation), preserving case IDs and evidence intent.
3. Re-run validation.
4. If still >255, fall back to deterministic clause compaction and validate again.

Model fallback policy:
1. First attempt selects Claude Opus.
2. If generation fails because Opus is unavailable (weekly priority cap message) or the Opus
   selector cannot be applied, retry once without forcing model selection (use current/default).

If a non-internal activity has no case number, it must be surfaced for user confirmation
before submission (never silently left as `N/A`).

When a recurring activity must always map to a known case, define `CASE_ID_OVERRIDES` in
`config.json` with `{ client, match, caseId }` entries. `match` is a pipe-separated list of
keywords tested against project+description (example: `disposition|chevron`).

## What is verified locally

`validator.js` re-checks the rules the prompt asked for:

- hours are positive multiples of `0.25` with two decimals
- every working day ties to the daily quota
- at most one row per client per day
- descriptions are <= 255 characters
- billable + non-billable equals the period total

A case folder is not always one checkout: `local_evidence.js` resolves each folder's real git
(or directory-junction/symlink) target and groups folders that share one repository before
scanning, so a linked git worktree or an old-name alias pointing at the same case never
double-counts its commits or gets dropped from the case the folder name actually belongs to.

`reconcile.js` then compares three independent sources and emits findings:

| Finding | Meaning |
| --- | --- |
| `MISSING_LOCAL_WORK` | git commits or touched files exist for a case on a day with no timesheet row (blocking when backed by commits) |
| `NO_EVIDENCE` | a timesheet row has no local and no CRM support |
| `CRM_WORK_NOT_BILLED` | you personally changed the case or answered the client in the portal on a day with no timesheet row (blocking) |
| `CRM_ACTIVITY_NOT_BILLED` | a case was modified in range with no time booked (fallback when per-case detail is unavailable) |
| `CLIENT_MISMATCH` | the row's client disagrees with the case's client in Dataverse |
| `UNKNOWN_CASE` | a case ID in the timesheet is not in the folders nor in Dataverse |
| `DISCOVERED_ID_CONFIRMATION_REQUIRED` | Copilot found a new ID; user confirmation is required before billing (blocking) |
| `MISSING_CASE_ID_CONFIRMATION` | a non-internal row has no case ID (`N/A`), so user confirmation is required (blocking) |
| `MONTH_BOUNDARY` | the range spans two months, so per-month CSVs were also written |

## Resolving blocking findings interactively

An exit-code-2 run (blocking reconciliation findings) is not something to silently patch and
re-render. When it happens:

1. Walk through every blocking finding **one at a time** with `ask_user` — never dump the
   whole list and ask for one blanket decision. Each finding gets its own short explanation
   plus a clear, specific question.
2. Back every claim with concrete evidence before asking: pull the actual git commit
   timestamps (`git log --since/--until --pretty=...`) or touched-file names for the case in
   question, so the user judges real scope (a 20-minute commit span vs. a 6-hour span) instead
   of guessing from a bare commit count.
3. Every working day must still sum to the daily quota, so crediting a previously-missing case
   means shrinking something else that same day. Propose a specific, already-balanced set of
   numbers (showing the before/after per client) and ask for confirmation, rather than asking
   an open "how many hours?" and leaving the rebalance unresolved. Prefer trimming rows already
   flagged low-confidence (`VERIFY - insufficient evidence`, an anomalous calendar duration)
   before touching rows with solid evidence.
4. If the user explicitly delegates a choice ("you decide", "whatever makes sense"), make one
   reasoned, evidence-backed pick and state why — don't re-ask the same open question.
5. `discovered_ids` entries render as blocking findings regardless of their `status` text.
   Once the user has decided (exclude it, or it's already covered by an existing ticket), clear
   `discovered_ids` / `needs_case_confirmation` / `verify` to `[]` and record the resolution as
   a dated entry in `assumptions` instead — otherwise the report keeps re-flagging a decision
   that has already been made.
6. For a finding that is correct but already handled under a different label (e.g. local
   evidence tags a folder with its raw directory name but the time is intentionally billed
   under "Internal"), use `meta.reconciliation_suppress` (`{code, client|caseId, dates}`)
   instead of editing the evidence to force a match — the suppression keeps the real label and
   still clears the finding, with the reasoning kept in `assumptions`.

## Final review before declaring the timesheet done

Validation and reconciliation passing (exit code 0, after the interactive pass above) is
necessary but not sufficient. Before telling the user the timesheet is ready:

1. Walk through the range **one working day at a time**. For each day, show every row's
   client, hours and full description, then ask "is this day fine, or does something need
   adjusting?" before moving to the next day — don't present the whole week at once for one
   global yes/no.
2. Apply whatever the user asks for that day (shift hours between clients, trim a detail out
   of a description, etc.) and re-run validate/reconcile/render before moving on, so each day
   is confirmed against the current numbers, not a stale draft.
3. Once every day has been explicitly confirmed, post the **full day-by-day table** (every
   row: date, client, hours, description) in the chat reply — not only the per-client weekly
   roll-up. The roll-up is a good addition on top of that table, not a replacement for it.

## Submission-ready copy-paste format

After every day is confirmed, the user may still have to retype each row by hand into a
separate corporate timesheet system that does not take the CSV directly. For that workflow,
offer (in chat, once the data is final) this format instead of only the markdown table:

- Group rows under a human day header, e.g. "Monday 11-02".
- For each row, a one-line label: `- <Client> (<Hours>h, <N>c):` where `<N>` is the exact
  character count of the string that follows, not of the description alone when the row has
  ticket IDs.
- Immediately below, the exact text to paste in its own fenced code block, so the chat UI's
  per-block copy button does the work. This is the same string the CSV's Description column
  holds: ticket IDs are never dropped, and multi-case rows keep the
  `CAS-123: ...; CAS-456: ...` format.
- The character count is a convenience readout of the 255-char rule the validator already
  enforces, not a separate rule; recompute it from the actual row data, never by hand.

## What the CRM contributes

The case list alone only proves a case exists. Two further sources date the work:

- **Portal comments** (`adx_portalcomment`) — the client-facing conversation. An
  *Outgoing* comment is the consultant writing; an *Incoming* one only proves the case was
  live. Attachment-only and empty comments are dropped.
- **Field audit history** (`RetrieveRecordChangeHistory`) — every audited change with its
  timestamp and author. The status comment field (`CRM_STATUS_COMMENT_FIELD`, `new_xpoinfo`
  in this org) is effectively a dated diary: *"9/3 - Deployed to TEST & UAT. Awaiting Angie's
  validation and PROD approval."* Both the old and new text are captured.

A day only counts as the consultant's own when they authored the change or the outgoing
comment, which is what makes `CRM_WORK_NOT_BILLED` trustworthy enough to block.

## Two identities, two Azure profiles

Some Dataverse orgs have two enabled `systemuser` records for the same person: a tenant
member identity and a guest identity that actually owns the open cases (and any personal
saved views). A token authenticates exactly one of them, which is why a personal view saved
by the guest identity can return **403** to the other.

Each identity therefore gets its own Azure CLI profile directory, listed in
`CRM_AZURE_CONFIG_DIRS`; the collector queries every profile and merges the results. On top
of that, `resolveIdentities()` finds sibling `systemuser` records by `domainname` and runs
the fallback queries for each, so the case list is still correct with only one profile.

**The tenant must be pinned.** A guest identity only resolves inside its host tenant. Log in
without `--tenant` and the CLI issues a token for the user's home tenant, and Dataverse
answers *"The user is not a member of the organization."* Pin the real tenant in
`CRM_TENANT_ID` (and in the login step below) — watch for an org display name shared by more
than one tenant in the account picker, since picking the wrong one silently authenticates
against the wrong tenant. With the right tenant pinned, the guest identity can read its own
saved view, so `CRM_VIEW_ID` works and no fallback is needed for it.

Interactive login is never launched from a script. To add a secondary identity's profile the
user runs, in their own terminal:

```powershell
.\set-account-secondary-identity.ps1 -Login
```

This reads `CRM_TENANT_ID`, `CRM_URL` and the target profile directory straight out of
`config.json` (see `config.example.json`), so it is not tied to any one org or tenant.

Saved-view rows are re-fetched with our own attribute set (`hydrateIncidents`), because a
view only selects the columns its author chose.

## Outputs

Written to `output/`:

- `timesheet-<start>_<end>.csv` — the submittable CSV
- `timesheet-<start>_<end>--YYYY-MM.csv` — one per month when the range crosses a boundary
- `timesheet-<start>_<end>.md` — report with sections A) timesheet, B) roll-ups, C) CSV,
  D) discovered IDs, E) items to verify, F) reconciliation findings

`logs/latest_prompt.md` and `logs/latest_response.md` are kept for every run so a reply can be
re-parsed without spending another Copilot round trip.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Timesheet produced and validated with no blocking findings |
| 1 | Output contract violated or validation failed — nothing written |
| 2 | Timesheet written, but blocking reconciliation findings need review |
| 3 | Run failure (login, navigation, Copilot error) |

## The two-identity CRM note

See "Two identities, two Azure profiles" above. `CRM_VIEW_ID` is normally left blank because
the personal view belongs to the guest identity; the built-in fallback queries reproduce the
"Cases I'm working on" contents without depending on the view.

## Safety guarantees

- The skill only ever **reads** from `CASES_ROOT`. It never writes, commits, or modifies a case
  folder, honouring the workspace `AGENTS.md`.
- No local absolute path is ever placed in the prompt (`buildPrompt` throws if one appears).
- Dataverse access is read-only (`GET` only).
- Nothing is written to `output/` unless the contract and the validator both pass.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "I cannot write to your local drive" | A local path leaked into the prompt. `buildPrompt` should have caught it — check a newly edited template. |
| Contract violation with prose | The model drifted. Re-run; the prompt states the contract twice. |
| 403 / 404 on the configured view | The view belongs to the other identity, or the tenant is not pinned. Check `CRM_TENANT_ID`. |
| "The user is not a member of the organization" | The token was issued for the home tenant. Log in with `-Login` on the wrapper, which pins `--tenant`. |
| CRM returns 0 cases | `az` session expired. Re-run `az login` with `AZURE_CONFIG_DIR` set to `CRM_AZURE_CONFIG_DIR`. |
| Many `MISSING_LOCAL_WORK` findings | Usually real: the day's work was not reflected in the timesheet. Review section F before submitting. |
| The same commits appear duplicated across several folders for one case | Two folders share one git repo: a linked worktree (sibling `wt-<case>-<slug>` or a nested `.worktrees/<branch>`) or a directory junction/symlink alias (e.g. an old `CAS-PENDING` name left pointing at the case once it got its real number). `local_evidence.js` groups folders by their resolved common git directory specifically to prevent this — if it still happens, check that `resolveGitLink()` can read the new folder's `.git` file/`commondir`. |
| Login page appears mid-run | Re-run `npm run setup` to refresh the persistent profile. |

## Internal architecture

```
scripts/
  run_timesheet.js     orchestrator and CLI
  setup.js             one-time interactive M365 login
  build_prompt.js      render the prompt only
  collect_evidence.js  local git / file scan only
  list_cases.js        Dataverse query only
  parse.js             re-parse a saved reply
  lib/
    config.js            load, validate, defaults
    date_range.js        natural-language and ISO range parsing
    local_evidence.js    client detection, git log, file mtimes, timezone conversion
    dataverse_cases.js   az token, multi-profile and identity resolution, FetchXML fallbacks
    crm_case_detail.js   portal comments and field audit history per case
    prompt_builder.js    template rendering with leak and placeholder guards
    response_contract.js fence extraction, RFC4180 CSV parsing, refusal detection
    validator.js         re-derives every rule the prompt asked for
    reconcile.js         timesheet vs local evidence vs CRM
    render.js            CSV, per-month CSVs, markdown report
    playwright_runner.js drives M365 Copilot on the shared browser profile
```
