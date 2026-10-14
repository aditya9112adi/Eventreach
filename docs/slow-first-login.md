# Slow first sign-in

## Finding

The slow first sign-in is the hosting plan, not the sign-in code.

`render.yaml` deploys the API on Render's **free** plan, which puts a service to
sleep after about 15 minutes without traffic. The first request after that has
to wait for the service to wake; later requests are fast.

Measured against the deployed API on 2026-10-14 with three read-only `GET /health`
requests (no sign-in attempts, nothing sent or changed):

| Request | Time to first byte |
| --- | --- |
| 1 (service asleep) | **43.2 s** (DNS 0.09 s, TCP 0.15 s, TLS 0.74 s - the rest is the wake-up) |
| 2 | 0.55 s |
| 3 | 0.59 s |

### Why the existing keep-alive does not prevent it

`.github/workflows/keepalive.yml` is scheduled every 10 minutes, but GitHub
throttles scheduled workflows. The recent runs of "Keep backend warm" started
about every **3 to 9 hours**, not every 10 minutes:

```
2026-10-14 09:47   2026-10-14 04:41   2026-10-13 23:56   2026-10-13 20:39
2026-10-13 15:00   2026-10-13 07:02   2026-10-13 00:28   2026-10-12 17:51
```

Each run pings twice, five minutes apart, so the service is covered for roughly
10 minutes after each run and sleeps in the gaps. Whoever signs in first after a
gap pays the ~43 s wake-up. That matches the report: slow once, then normal.

## What was measured in the sign-in code

Local backend (compiled `dist`) against a throwaway local database, three boots,
12 sign-ins each. A local database has almost no network latency, so these
numbers show CPU and code cost only - **not** the Atlas round trips.

| Stage | Time |
| --- | --- |
| Process start to answering | 2.3 - 2.7 s (module loading) |
| Account lookup | ~2 ms |
| Password check (bcrypt, 10 rounds) | ~96 ms (about 93 % of the sign-in) |
| Token | ~0.6 ms |
| Audit write + profile | 3 - 5 ms |
| Whole sign-in, steady state | ~102 - 110 ms |
| First sign-in after boot | ~320 - 430 ms |
| Wrong password | ~100 - 108 ms |

Nothing in the sign-in code explains tens of seconds. The password hashing cost
is a security setting and was not changed.

## What changed

1. **Sign-in page starts the wake-up early.** Opening the page sends one
   `GET /health` (no credentials, no data, once per page load, answer ignored),
   so a sleeping server starts waking while the person types instead of when they
   press Sign In. This can save at most the time spent typing; the wake-up
   itself still takes as long as it takes. It is not a keep-alive: it is one
   request per page visit.
2. **The page says what is happening.** After 4 s it explains that the server is
   starting and can take up to a minute. The request has a 90 s timeout (longer
   than a cold start, but not endless) and failures name their cause: timeout,
   unreachable server, or the server's own message.
3. **One fewer request after sign-in.** The profile returned by the sign-in is
   used as is; the session restore that the new token triggered no longer asks
   `/auth/me` for the same profile again. A page load with a stored session still
   revalidates it.
4. **Timing logs.** Each sign-in writes one JSON line
   (`{"login_timing":{requestId,outcome,totalMs,stages}}`) with stage durations.
   It carries no email, password, token or profile data; `requestId` matches the
   `X-Request-Id` response header.
5. **Clear answer while the database is not connected.** Requests that need the
   database wait (up to 20 s, `DB_READY_WAIT_MS`) while it reconnects, then get a
   clear 503 with `Retry-After` instead of the driver's 10 s buffering ending in
   a generic 500. `/health` is unaffected.

Considered and not shipped: opening the port before the database connects. It
showed no measurable change and does not shorten a sign-in, which has to wait
for the database either way.

Sockets never block sign-in: the sign-in navigates as soon as the server
answers, and a failed socket connection only logs.

## What this cannot fix: the wake-up itself

Only the hosting choice removes it. Options (check current prices before
deciding):

| Option | Cost | Trade-off |
| --- | --- | --- |
| Render paid web service (always on) | a few dollars per month for the smallest paid instance | Removes the cold start and the ~15 min sleep. Simplest and most reliable. |
| External uptime monitor pinging `/health` every 5 minutes (e.g. UptimeRobot, cron-job.org) | free tiers exist | Keeps the free service awake without paying; depends on a third party, and free-tier terms can change. Runs 24/7, which uses more of the free instance hours. |
| Keep the GitHub Actions workflow | free | Evidently not reliable enough: GitHub throttles it to every few hours. |
| Move to a host without idle sleep | varies | Migration work. |

Nothing was changed on the hosting side, and no plan or environment variable was
touched.
