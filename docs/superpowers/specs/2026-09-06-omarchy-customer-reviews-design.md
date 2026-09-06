# Omarchy Customer Reviews Plugin Design

Date: 2026-09-06
Status: approved in conversation; waiting for spec review
Plugin id: `ryuhzk.customer-reviews`
Display name: Customer Reviews
Repository: `~/Work/omarchy-customer-reviews`

## Goal

An Omarchy bar plugin that lists App Store customer reviews for selected apps,
lets the user reply from the panel, shows an unreplied count on the bar, and
sends a desktop notification when a new review appears on a watched app.

Version 1 is Apple only. Google Play is a later store adapter behind the same
CLI and panel contract. The Play adapter, Play credentials, and a store
switcher are out of scope for the first implementation.

## Success criteria

1. A first-run panel explains how to create an App Store Connect API key
   (Issuer ID, Key ID, `.p8`) and can save those values locally.
2. After credentials work, the plugin lists apps from App Store Connect.
3. The user picks which apps to watch. The bar badge and notifications use
   only that list.
4. The inbox can switch among watched apps, lists reviews newest first, and
   can show unreplied-only.
5. The user can type a reply in the panel and submit it through the official
   Customer Review Responses API.
6. A background service polls every 3 hours and notifies on new reviews
   for watched apps, including five-star reviews. Opening the panel loads
   the active app's reviews once; that click load does not notify.
7. Secrets never appear in QML process output, `shell.json`, or notifications.

## Non-goals (v1)

- Google Play reviews or replies
- Translating reviews or replies
- Canned / saved reply templates
- Editing an existing Apple reply in place (Apple does not support PATCH)
- Webhooks or push from Apple (ASC has none for customer reviews)
- Multi-team App Store Connect accounts in one config file

## Architecture

Follow the existing `~/Work` Omarchy plugins:

| Piece | Pattern taken from |
| --- | --- |
| Manifest + `Panel.qml` bar widget | `omarchy-translation`, `omarchy-server-status` |
| `Service.qml` always loaded | `omarchy-lyrics` (`bar.shell.serviceFor(moduleName)`) |
| Bun + TypeScript CLI, JSON on stdout | `omarchy-server-status`, `omarchy-tea-flow` |
| Private config outside the plugin tree | `omarchy-translation` (`~/.config/<name>/`) |

```text
BarWidget / Panel.qml
        │
        │  bar.shell.serviceFor("ryuhzk.customer-reviews")
        ▼
   Service.qml
        ├── Timer 3h ──► bun backend/customer-reviews.ts poll
        │                 (badge + notifications only)
        └── click-open ──► bun backend/customer-reviews.ts reviews list
                           (inbox load once, no notify)

   Panel actions ──► bun backend/customer-reviews.ts <command>

   Config/cache: ~/.config/omarchy-customer-reviews/
                 ~/.cache/omarchy-customer-reviews/
```

QML never talks to Apple. Every network call and every read of the `.p8` file
happens in the Bun CLI.

## Repository layout

```text
omarchy-customer-reviews/
  manifest.json
  package.json
  check
  LICENSE
  README.md
  BarWidget.qml
  Panel.qml
  Service.qml
  backend/
    customer-reviews.ts # CLI entry
    apple.ts            # App Store Connect JWT + HTTP
    config.ts           # load/save ~/.config/omarchy-customer-reviews
    model.ts            # shared types and JSON envelopes
    store.ts            # cache + seen-review ids
  tests/
    apple.test.ts
    config.test.ts
    store.test.ts
  docs/superpowers/specs/
    2026-09-06-omarchy-customer-reviews-design.md
```

`package.json` matches the Bun plugins:

- `"name": "omarchy-customer-reviews"`
- `"type": "module"`
- `"packageManager": "bun@1.4.2"`
- `bun test` for tests
- `bun build backend/customer-reviews.ts --target=bun` as the compile check

User-visible QML, `manifest.json`, and README stay English-only, same lint
rule as `omarchy-lyrics`.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "ryuhzk.customer-reviews",
  "name": "Customer Reviews",
  "kinds": ["service", "bar-widget"],
  "keepLoaded": true,
  "entryPoints": {
    "service": "Service.qml",
    "barWidget": "BarWidget.qml"
  }
}
```

`Panel.qml` is opened from `BarWidget.qml`, not as a separate kind.

Bar widget settings:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `panelWidth` | integer | `720` | Popup width, 420–1100 |
| `pollIntervalSec` | integer | `10800` | Background poll interval, 3600–43200 (1–12 hours, default 3) |
| `unrepliedOnly` | boolean | `true` | Inbox default filter |

Watch-list and credentials are not widget settings. They live in the private
config file so `shell.json` never holds secrets or a large app list.

## Private config and cache

Config file: `~/.config/omarchy-customer-reviews/config.env`  
Mode: `0600` on the file, `0700` on the directory  
Atomic write: temp file in the same directory, then rename

Keys:

```text
ASC_ISSUER_ID=
ASC_KEY_ID=
ASC_PRIVATE_KEY_PATH=
WATCHED_APP_IDS=
ACTIVE_APP_ID=
```

`WATCHED_APP_IDS` is a comma-separated list of App Store Connect app ids
(the ASC resource id, not the numeric App Store id).  
`ACTIVE_APP_ID` is the last inbox selection.

The `.p8` stays where the user downloaded it, or is copied to
`~/.config/omarchy-customer-reviews/AuthKey_<KEY_ID>.p8` with mode `0600` if
the user picked a file through the panel. The config stores only the path.

Cache directory: `~/.cache/omarchy-customer-reviews/`

| File | Purpose |
| --- | --- |
| `apps.json` | Last successful app list |
| `reviews-<appId>.json` | Last successful review page per app |
| `seen.json` | Review ids already notified |

`config` and `apps` commands never print `ASC_PRIVATE_KEY_PATH` contents,
the PEM, or a JWT. They may print whether a key file exists and whether
the last token mint succeeded.

## App Store Connect

Auth: ES256 JWT, `aud=appstoreconnect-v1`, lifetime 15 minutes, minted in
`apple.ts` with Bun/Node `crypto`. Reuse a token until 60 seconds before
expiry.

Base URL: `https://api.appstoreconnect.apple.com`

| CLI need | API |
| --- | --- |
| List apps | `GET /v1/apps?limit=200` |
| List reviews | `GET /v1/apps/{id}/customerReviews?include=response&sort=-createdDate` |
| Create reply | `POST /v1/customerReviewResponses` |
| Remove reply | `DELETE /v1/customerReviewResponses/{id}` |

Required key role: Customer Support or Admin. The empty-state copy must say
this. A Marketing or Developer key that can list apps but cannot reply is
treated as configured-for-read; `reply` then returns a structured 403.

Pagination: first page only on each poll (`limit=50`). The panel shows a
"Load more" control that passes the ASC `links.next` URL into
`reviews list --next <url>`. Load-more is inbox-only. The bar badge is the
sum of unreplied reviews on the latest first page of each watched app. The
badge does not include extra pages the user loaded in the inbox, and it
does not walk historical pages on each poll.

Reply body: 1–4000 characters, matching Apple's documented limit. Empty
submit is rejected in the CLI before the HTTP call.

Apple cannot update a response. The panel offers "Delete reply" which calls
`DELETE`, then the user can write a new one.

## CLI contract

`#!/usr/bin/env bun`  
Every command prints one JSON object to stdout. Errors also use that
envelope and a non-zero exit code.

```text
{ "ok": true, "data": ... }
{ "ok": false, "error": { "code": "auth|forbidden|network|config|apple|usage", "message": "..." } }
```

Commands:

| Command | Result `data` |
| --- | --- |
| `config show` | `{ configured, issuerId, keyId, keyPathExists, watchedAppIds, activeAppId }` — no secrets |
| `config set --issuer <id> --key-id <kid> --key <path>` | same as `show` after save |
| `apps` | `{ apps: [{ id, name, bundleId, sku }] }` |
| `watch --ids <id,id>` | `{ watchedAppIds }` |
| `reviews list --app <id> [--unreplied] [--next <url>]` | `{ appId, reviews, next }` |
| `reviews reply --review <id> --body <text>` | `{ reviewId, responseId }` |
| `reviews delete-reply --response <id>` | `{ responseId }` |
| `poll` | `{ unrepliedCount, newReviews: [{ appId, appName, reviewId, rating, title }] }` |

`poll`:

1. Load config. If not configured, return `{ unrepliedCount: 0, newReviews: [] }`
   with `ok: true` and `configured: false`.
2. For each watched app, fetch the first review page.
3. Count reviews with no included response.
4. Any review id not in `seen.json` is a new review.
5. After a successful poll, add those ids to `seen.json`.
6. Do not mark a review seen on a failed fetch for that app.

The service, not the CLI, calls `notify-send`. This keeps tests free of
desktop side effects.

## QML surfaces

### Service.qml

Always loaded. Owns the background poll timer (`pollIntervalSec` from the
bar widget, default 10800 / 3 hours, pushed the same way lyrics pushes
overlay settings). The timer is the only automatic Apple traffic. It
updates the bar badge and may send notifications.

Opening the panel is a separate, user-triggered load: one `reviews list`
for the active app. That path never sends notifications. After a
successful click load, fetched review ids are added to `seen.json` so
the next background poll does not notify for reviews the user already
opened.

Exposed to the widget:

- `configured: bool`
- `unrepliedCount: int`
- `statusText: string`
- `lastError: string`
- `refresh()`
- `pollNow()`

On `poll` JSON with `newReviews.length > 0`, send one desktop notification
per new review:

- app: `Customer Reviews`
- title: `{appName} · {rating}★`
- body: review title, or the first 120 characters of the review body if the
  title is empty

If a single poll returns more than five new reviews, send one digest
notification instead: `{n} new reviews` plus the first five titles. This
avoids a notification storm after first setup.

The first successful poll after install seeds `seen.json` and does **not**
notify for historical reviews. Only later polls notify.

### BarWidget.qml

Left click toggles `Panel.qml`. Opening the panel (closed → open) loads
the inbox once for `ACTIVE_APP_ID`, or the first watched app if that is
empty. Closing the panel does not fetch. Clicking again while the panel
is already open only closes it.

The bar uses the short label `Reviews` so the widget stays narrow. The
plugin display name remains `Customer Reviews`.

Bar label:

- Not configured: `Reviews`
- Configured, zero unreplied: `Reviews`
- Configured, N unreplied: `Reviews N`

### Panel.qml

Three states, one panel:

1. **Setup** — numbered App Store Connect steps, fields for Issuer ID and
   Key ID, file picker for the `.p8`, Save. On success, move to Apps.
2. **Apps** — checklist of ASC apps. Save writes `WATCHED_APP_IDS`. At least
   one app is required before the inbox is usable. A "Change credentials"
   link returns to Setup.
3. **Inbox** — app chips for watched apps, unreplied filter toggle, review
   list, selected review (stars, date, territory, body, existing reply),
   reply textarea, Submit, Delete reply when a response exists. The first
   paint after open is the click load. Switching an app chip loads that
   app once. A Retry control repeats the same list fetch. The inbox does
   not auto-refresh on a short timer.

Escape closes the panel. Tab / Shift+Tab keep the usual neighboring-panel
behavior.

All user-visible strings are English.

## Error handling

| Case | UI |
| --- | --- |
| No config | Setup state, no badge, no notifications |
| Missing or unreadable `.p8` | Setup error: "Private key file is missing or unreadable" |
| JWT or 401 | Setup / inbox banner: "App Store Connect rejected the key" |
| 403 on reply | Inbox: "This key cannot reply. Recreate it with Customer Support or Admin." |
| 409 reply already exists | Refresh that review; show the existing reply |
| Network / timeout | Banner + Retry; keep last cached list |
| Partial poll (one app fails) | Badge uses successful apps; banner names the failed app |
| Empty watched list | Apps state, badge 0 |

Timeouts: 20 seconds per HTTP request. No automatic retry loop in the CLI.
Retries are the panel Retry button, the next click-open load, switching
app chips, and the next 3-hour timer tick.

## Security

- Config dir `0700`, config and copied `.p8` `0600`
- QML `Process` stdout is JSON without secrets
- `config show` redacts path contents; it may show the key path string so
  the user can confirm the file location
- README tells the user to create a dedicated Customer Support key, not
  share an Admin key used for shipping
- No telemetry, no third-party host besides `api.appstoreconnect.apple.com`

## Testing

`./check` must:

1. `bun test`
2. `bun build backend/customer-reviews.ts --target=bun --outdir=<tmp>`
3. `omarchy plugin validate "$ROOT"`
4. `jq` asserts on `manifest.json` id, kinds, and entry points
5. Fail if CJK characters appear in QML, `manifest.json`, or README
6. `qmllint` when available

Automated tests (no live Apple calls):

- JWT header/payload claims and expiry window
- Config round-trip, file modes, refusal to echo PEM
- Review JSON mapping, unreplied detection, `include=response`
- `seen.json` seeding: first poll reports `newReviews: []` after seed
- Second poll reports only unseen ids
- Reply request body shape and empty-body rejection
- Digest threshold: six new reviews produce six items in JSON; notification
  digest is a QML concern and is not asserted in the CLI tests

## Install (after implementation)

Follow the official Omarchy plugin commands from
https://plugins.omarchy.org/develop.html — no symlinks inside the plugin
folder:

```sh
omarchy plugin add https://github.com/ryuhzk/omarchy-reviews.git --enable
omarchy plugin remove ryuhzk.customer-reviews
```

## Implementation order

1. Manifest, `package.json`, `check`, empty QML shells
2. `config.ts` + `config` CLI + tests
3. `apple.ts` JWT + mocked HTTP + `apps` / `reviews` / `reply`
4. `store.ts` + `poll`
5. `Service.qml` poll + notifications
6. `BarWidget.qml` badge
7. `Panel.qml` setup, apps, inbox, reply
8. README and local symlink install

## Later: Google Play

Keep store-specific code behind `apple.ts`. A future `play.ts` should expose
the same `apps`, `list`, `reply`, and `poll` shapes. Do not add a store
switcher or Play fields in v1.
