# Hermes Gateway executor design

This is a design and an in-repo executor module. **Hermes Master owns Gateway cron and profile wiring; neither is configured here.** Meta publishing and token refresh remain stubbed. The server exposes exactly seven MCP tools; scheduling adds no tools and starts no background worker.

## Due-post job

Suggested cadence: every minute (`* * * * *`), timezone **Asia/Hong_Kong**. The Gateway's job configuration is out of scope; the cron expressions here describe the intended jobs, not a generated Hermes configuration.

`schedule_post` stores a future UTC `publish_at` in SQLite. A date-time with no offset is interpreted in Hong Kong time. It never creates a Threads container: containers expire after 24 hours, so creation belongs to execution time.

For an integration embedded in the **owning server process**, bind the module to the existing core service:

```ts
import { ScheduledExecutor } from './dist/scheduler/executor.js';

// Reuse the existing QueueService instance owned by the MCP server.
const executor = new ScheduledExecutor(service);
const runDueScheduled = (now: Date) => executor.runDueScheduled(now);

// Gateway cron callback supplies the actual current instant.
const results = await runDueScheduled(new Date());
```

`runDueScheduled(now)` selects scheduled posts whose time is at or before `now`, oldest first. The core rechecks state, due time, and recorded approval under its mutation lock, then executes the same publish path as `publish_now`: upload an image when present → create container → check status → publish → store media ID → delete the hosted image. Canceled or rescheduled posts are skipped. One failed publish does not prevent the next due post from running. Repeated or overlapping runs on the same service do not publish a post twice.

A separate **Hermes Gateway cron process should call the owning MCP server**, rather than open another writer on its database:

1. Call `list_queue(state="scheduled")` and select `publish_at <= now`.
2. Call `publish_now(id)` for each due approved scheduled post, allowing up to six minutes for container polling. Treat state/approval rejections as reconciliation events; never create drafts or call `approve_draft` in this executor.
3. Reconcile results through `list_queue`; retain a failed post for explicit retry. Do not implicitly retry failed posts on every tick.

The Gateway owns delivery of due requests and must coordinate cancellation with its cron dispatch. `publish_now` also permits an approved post and intentional early publication of a scheduled post. For atomic cancellation/due checks, use the embedded `ScheduledExecutor`; the seven-tool MCP contract has no separate “publish only if still due” command.

Run **one owning service/process per SQLite file**. SQLite makes individual record writes atomic; it does not lock a remote publishing workflow across processes. No standalone `executor:once` CLI is supplied, to avoid accidentally opening a second publisher beside the stdio server. This repo's executor is ready to bind to the owner process when Hermes Master implements that integration.

## Failure and retry

- A client throw, invalid container status, timeout, upload failure, or missing media ID records `failed` and `last_error`. A failed attempt is never labeled published.
- `publish_now` or `schedule_post` on a previously approved failed post first persists `failed → approved` with a `retry` history event, preserving who approved it and when. A publish retry then creates a fresh container at execution time.
- The executor only scans scheduled posts. Failed posts require an explicit publish retry or rescheduling decision.
- A returned media ID is saved before image deletion. A deletion failure adds `image_cleanup_error` and leaves `published` and its media ID intact. Missing Blob credentials make cleanup a no-op, while image upload requires configuration.
- Remote exactly-once delivery, recovery after a crash between a remote response and a database write, and ambiguous remote results require live reconciliation in Task 1c. Do not infer publication from container creation alone.

## Weekly token-refresh job stub

Suggested cadence: Monday at 09:00 (`0 9 * * 1`), timezone **Asia/Hong_Kong**. The spike describes refreshing long-lived tokens once they are at least 24 hours old and doing so weekly. The live path will be:

```text
GET https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token
```

The OAuth token must be supplied securely in Task 1c. Never log a token, full credential-bearing request, or response containing replacement credentials. Gateway credential persistence and renewal scheduling remain Hermes Master's work.

```ts
import { refreshThreadsToken } from './dist/scheduler/token-refresh.js';

const result = await refreshThreadsToken();
// { status: 'not-configured', message: 'Token refresh not configured … Task 1c …' }
```

The current function reads no credentials, performs no HTTP, changes no token, and always returns `not-configured`. The job must report that status instead of claiming a refresh succeeded. It is not an MCP tool and no cron registration is performed here.
