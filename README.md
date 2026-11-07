# m365-timesheet

Generate a consultant timesheet for a date range by asking M365 Copilot (Claude Opus) to mine
Outlook, Teams and calendar activity. The prompt is CRM-first: it starts from the CRM "cases
I'm working on" baseline, then discovers meetings/emails/chats and non-case work. Every number
is verified locally against your case folders' git history and against Dataverse.

Copilot only produces structured data. All arithmetic, formatting rules, roll-ups,
reconciliation and rendering happen locally, so the model's arithmetic is never trusted.

## Quick start

```bash
npm install
# create config.json from config.example.json, then log in once:
npm run setup

npm run timesheet -- "last week"
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run timesheet -- "<range>"` | Full run: prompt, Copilot, validate, reconcile, render |
| `npm run timesheet -- "<range>" --dry-run` | Build and print the prompt, send nothing |
| `npm run timesheet -- "<range>" --from-file <path>` | Re-parse a saved reply |
| `npm run timesheet -- "<range>" --no-crm` | Skip Dataverse |
| `npm run timesheet -- "<range>" --hours 7.5` | Override the daily quota for this run |
| `npm run evidence -- "<range>"` | Local git / file scan only |
| `npm run cases` | Dataverse case list only |
| `npm run prompt -- "<range>"` | Render the prompt only |
| `npm test` | Unit tests |

Ranges: `last week`, `this week`, `this month`, `last month`, `past 10 days`, `past 2 weeks`,
`2026-08-31..2026-09-04`, `2026-08-31 to 2026-09-04`.

## Configuration

`config.json` (see `config.example.json`):

| Key | Meaning |
| --- | --- |
| `USER_NAME`, `USER_EMAIL` | Who the timesheet is for |
| `CASES_ROOT` | Folder holding `<Client>/<CASE-ID> - <Title>` |
| `TIMEZONE` | Timezone the timesheet is submitted in |
| `HOURS_PER_DAY`, `WORKING_DAYS` | Daily quota and which days count |
| `INCLUDE_NON_BILLABLE` | Whether internal time is included |
| `CASE_ID_OVERRIDES` | Force a case ID when client/work-pattern matches (e.g., a recurring meeting always tied to one case) |
| `CLIENT_ALIASES` | Alias to client name, e.g. `ACME=Acme Corporation` |
| `FOLDER_TO_CLIENT` | Local folder name to official client name |
| `CRM_ENABLED`, `CRM_ORG_URL`, `CRM_AZURE_CONFIG_DIR`, `CRM_VIEW_ID` | Dataverse access |
| `CRM_AZURE_CONFIG_DIRS` | One Azure CLI profile per identity; all are queried and merged |
| `CRM_TENANT_ID` | Tenant the org lives in; required for a guest identity |
| `CRM_STATUS_COMMENT_FIELD` | Field whose audit history is read as the case diary (`new_xpoinfo`) |
| `CRM_DETAIL_MAX_CASES` | How many cases get portal comments and audit history |
| `PROMPT_EVIDENCE_CHARS` | Per-block cap on evidence sent to Copilot (default 10000) |
| `SHOW_TIMESHEET_IN_CHAT` | Print the generated timesheet table to stdout/chat after each run (default `true`) |
| `COPILOT_REPLY_TIMEOUT_MINUTES` | Max minutes to wait for Copilot reply before failing capture (default `20`) |

The date range is never stored in config; it is passed per run.

## Outputs

- `output/timesheet-<start>_<end>.csv` — the submittable CSV
- `output/timesheet-<start>_<end>--YYYY-MM.csv` — per month when the range crosses a boundary
- `output/timesheet-<start>_<end>.md` — full report, sections A) through F)
- `logs/latest_prompt.md`, `logs/latest_response.md` — kept for re-parsing

## Exit codes

`0` clean · `1` contract or validation failure (nothing written) · `2` written but blocking
reconciliation findings · `3` run failure.

## Notes

- Read-only against `CASES_ROOT` and Dataverse. It never modifies a case folder.
- Playwright is resolved from the sibling `m365-case-intake` skill if not installed locally,
  and both skills share one persistent browser profile, so you log in once.
- In chat-driven runs, oversized descriptions are first compacted semantically by the agent AI
  and then revalidated; deterministic compaction remains as a final safety fallback.
- If Opus is unavailable (weekly limit or model menu failure), the runner automatically retries
  once without forcing model selection (uses the current/default model).
- Blocking reconciliation findings are resolved interactively, one at a time, with the user —
  and the timesheet is walked day-by-day for final confirmation before it's done. See
  "Resolving blocking findings interactively" and "Final review before declaring the timesheet
  done" in `SKILL.md`.
- See `SKILL.md` for the output contract, the reconciliation rules, the two-identity CRM note
  and troubleshooting.
