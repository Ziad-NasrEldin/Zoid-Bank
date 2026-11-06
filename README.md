# Zoid Bank

<p align="center">
  <img src="docs/hero.png" alt="Zoid Bank dashboard" width="900">
</p>

A local-first finance companion that turns bank SMS alerts into an evidence-backed ledger — without leaving your Mac Mini.

**Who it's for.** Anyone who wants a private view of Bank Al Ahly and Banque Misr activity, recurring payments, and reviewable imports on one machine — with nothing uploaded.

## What you get

- Incoming Bank Al Ahly and Banque Misr alerts become structured ledger events
- Recurring payment projections built only from approved debit evidence
- A Review Queue so ambiguous alerts never quietly inflate totals
- Read-only Messages access — nothing is sent, marked read, edited, deleted, or uploaded
- A native macOS window plus a local dashboard for everyday use

## Try it

A public preview of the dashboard: [financial-transactions-vert.vercel.app](https://financial-transactions-vert.vercel.app)

The full companion (Messages bridge + native window) is still local-only:

```bash
npm start
```

Open [http://127.0.0.1:4173/?variant=settings](http://127.0.0.1:4173/?variant=settings).

Messages bridge, production package, LaunchAgent install, and the native app live in [docs/local-setup.md](docs/local-setup.md).

## How it works

A read-only macOS helper opens `~/Library/Messages/chat.db`. The bridge binds only to `127.0.0.1:4317`. Validated transaction patterns are approved automatically; OTPs and notices are ignored; ambiguous alerts go to Review Queue. Recurring signals are observations, not scheduled payments — the dashboard never executes a payment.

---

Built by [Ziad Ahmed](https://github.com/Ziad-NasrEldin) at [MaVoid](https://mavoid.com).

[Website](https://mavoid.com) · [LinkedIn](https://linkedin.com/in/ziad-ahmed-634202332) · [GitHub](https://github.com/Ziad-NasrEldin)

For an always-on Mac Mini bridge, run `npm run messages:install` once from this project.
It installs a per-user macOS LaunchAgent that starts the read-only bridge at login and restarts it if it exits.
Use `npm run messages:uninstall` to remove that agent.
The production dashboard Settings page can also start, stop, restart, and inspect this LaunchAgent without a terminal.

## Run the local Messages bridge

In a second terminal, run:

`bash
npm run messages:bridge
`

The bridge listens only on `127.0.0.1:4317`.

Open Settings and select `Scan Mac Messages`.

The first scan reads the approved sender profiles and stores structured ledger events, the original bank-alert message, and a redacted review preview in the local authoritative ledger file at `~/Library/Application Support/Zoid Bank/ledger.json`.
The dashboard keeps only a reconciled browser cache of that ledger, while the native shell mirrors preferences but never mirrors ledger data into `UserDefaults`.
That source message stays on this Mac Mini and is shown only from its linked transaction-details page.

Settings includes `Automatic ingestion` as an explicit on/off switch.
When it is on, the local bridge polls the read-only Messages source and commits a staged ledger update only after the complete page scan succeeds.
The local kill switch `HARBOR_AUTO_INGEST_KILL_SWITCH=1` disables background ingestion even when the saved setting is on.
The bridge follows exact `dateNanoseconds:rowID` cursors between helper pages so records after the first 500 do not starve.
The Messages source accepts reads only and never writes to `chat.db`.

Display currencies default to EGP.
USD and EUR conversions appear only after a user saves a positive manual EGP-per-unit rate in Settings.
When no manual rate is available, the dashboard shows the source amount and does not invent a conversion.

## Messages bridge controls and recovery

Open [http://127.0.0.1:4180/?variant=settings](http://127.0.0.1:4180/?variant=settings) to manage the persistent bridge from the local production dashboard.

Use `Start bridge` to build the read-only helper and load it for the signed-in macOS user.

Use `Retry connection` after restoring Full Disk Access or when the service stops responding.

Use `Open Full Disk Access` to jump to the exact macOS privacy pane when Messages access is blocked.

Use `Stop bridge` to stop new Messages capture without changing existing local ledger entries.

The status panel distinguishes a stopped service, a missing helper, missing Messages permission, an incompatible Messages database, a timeout, and an unexpected reader failure.

Bridge controls are accepted only from the same local dashboard origin and both services remain bound to `127.0.0.1`.

## Approved source profiles

- Bank Al Ahly: `BanK-AlAhly` and `Bank-AlAhly`.
- Banque Misr: `Banque Misr`.

Only validated transaction patterns are eligible for automatic approval.

OTP messages, account notices, maintenance notices, and other non-transaction alerts are ignored.

Ambiguous financial alerts are routed to Review Queue.

## Recurring projection

The Recurring view derives observations only from approved debit events in the local Messages ledger.

Merchant names are normalized for grouping, while cadence, amount tolerance, evidence count, and status are calculated locally.

Signals are observations rather than scheduled payments, and the dashboard never executes a payment.

In Transactions, an approved imported debit can be converted through Make recurring into a separate manual local rule.

Manual rules do not add evidence, change bank totals, sync to the cloud, or execute payments.

## Safety boundary

The macOS helper opens `~/Library/Messages/chat.db` read-only.

The helper does not write to the Messages database.

The bridge has no cloud endpoint and binds only to the local machine.

The source parser records sender profile, parser version, direction, amount, date, category, and an audit decision.

## Verify the implementation

`bash
npm test
npm run build
`

The Swift source helper is built into the ignored `.harbor/` folder by `npm run messages:build`.
