# Scheduling work in this workspace

Use `lemmacomputer-crontab`, not `/usr/bin/crontab`, so the schedule is saved
under the persistent workspace home and restored after a restart.

- Keep scripts, results, and logs under `/home/kasm-user/.lemmacomputer/`.
- Use absolute paths. Cron does not load an interactive shell profile.
- Wrap every job with `lemmacomputer-cron-run JOB_ID TIMEOUT_SECONDS ...`; it
  prevents overlapping runs, bounds runtime, and rotates the persistent log.
- Set `CRON_TZ=Area/City` in the crontab when the schedule is not UTC.
- Run Claude with `lemmacomputer-claude -p`, Codex with
  `lemmacomputer-codex exec`, and Hermes through `lemmacomputer-hermes` or its
  native cron feature.

Example:

```cron
CRON_TZ=Asia/Singapore
15 9 * * 1-5 lemmacomputer-cron-run weekday-note 600 /home/kasm-user/.lemmacomputer/scripts/weekday-note.sh
```

The workspace lifecycle controls execution: closing the browser does not stop
jobs, Stop pauses all jobs, restart resumes future runs without catch-up, and
Delete permanently removes schedules, scripts, logs, and results.
