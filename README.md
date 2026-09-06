# Omarchy Customer Reviews

Read and reply to App Store and Google Play customer reviews from the
Omarchy bar.

The plugin lists reviews for the apps you watch, lets you reply in the
panel, shows an unreplied count on the bar, and sends a desktop
notification when a new review appears. Apple and Play can be enabled
independently. The same product on both stores is shown as one row.

```text
bar click → load inbox once
service   → poll every 3 hours → badge + notifications
panel     → bun backend/customer-reviews.ts → App Store Connect / Google Play
```

## Features

- First-run setup for an App Store Connect API key and/or a Google Play service account
- Watch one or more apps; iOS and Android editions of the same product share a row
- Inbox with store icons, version, unreplied filter, and in-panel replies
- Bar badge is a star plus the unreplied count
- Desktop notifications for new reviews on watched apps
- Historical reviews already fetched stay in a local SQLite cache

Apple can delete a reply and post a new one. Play can update a reply in
place and cannot delete it. Play’s API only returns commented production
reviews from the last 7 days; older Play reviews remain if they were
already cached.

## Requirements

- Omarchy Shell with third-party plugin support
- [Bun](https://bun.sh) 1.4 or newer
- For Apple: an App Store Connect API key with the **Customer Support** or **Admin** role
- For Play: a Google Cloud service account invited in Play Console with **Reply to reviews**

## Configure App Store Connect

1. Open [App Store Connect](https://appstoreconnect.apple.com) → Users and Access → Integrations → App Store Connect API.
2. Note the **Issuer ID**.
3. Create a key. Give it the Customer Support role if you want to reply.
   Admin also works. Marketing or Developer can read some data but cannot reply.
4. Download the `.p8` file. Apple only shows it once.
5. Copy the **Key ID**.
6. Open the plugin, paste Issuer ID and Key ID, choose the `.p8`, and save.

The plugin copies the key to `~/.config/omarchy-customer-reviews/` with
mode `0600`. The PEM never appears in panel output.

## Configure Google Play

Official walkthrough:
[Getting Started](https://developers.google.com/android-publisher/getting_started)
and
[Reply to Reviews](https://developers.google.com/android-publisher/reply-to-reviews).

1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate)
   or pick an existing one.
2. Enable
   [Google Play Android Developer API](https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com).
3. Optional: also enable
   [Play Developer Reporting API](https://console.cloud.google.com/apis/library/playdeveloperreporting.googleapis.com)
   so the plugin can list your Play apps. If you skip this, add a package
   name on the Apps page.
4. Open [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts),
   create one, then **Keys → Add key → JSON**.
5. In [Play Console → Users and permissions](https://play.google.com/console/developers/users-and-permissions),
   invite the service account email. Grant **Reply to reviews** and access
   to the apps you want.
6. Click the bar widget. On Setup (or **Change credentials**), choose the
   JSON you just downloaded and click **Save service account**.

The plugin copies that file to
`~/.config/omarchy-customer-reviews/play-service-account.json` with mode
`0600`. The private key never appears in panel output.

## Install

```sh
omarchy plugin add https://github.com/ryuhzk/omarchy-reviews.git --enable
```

## Usage

- Left-click: open the panel and load the active app once
- Escape: close the panel
- Setup: save an Apple `.p8`, a Play service-account JSON, or both
- Apps: choose which apps update the badge and notifications. One card
  can cover both stores. If Play does not list an app, add its package
  name (`com.example.app`)
- Inbox: switch apps, filter unreplied, write a reply, delete an Apple
  reply, or update a Play reply

## Configure

```sh
omarchy bar move ryuhzk.customer-reviews --section center
```

## Remove

```sh
omarchy plugin remove ryuhzk.customer-reviews
```

This unregisters the plugin and deletes the installed checkout. Private
settings stay in `~/.config/omarchy-customer-reviews/`. Remove that
directory only if you also want to discard the API keys and watch list.

## Settings

| Setting            | Default | Meaning                                              |
| ------------------ | ------: | ---------------------------------------------------- |
| `panelWidth`       |   `720` | Popup width                                          |
| `pollIntervalSec`  | `10800` | Background poll interval (1–12 hours, default 3)     |
| `unrepliedOnly`    | `false` | Inbox opens on all reviews; Unreplied is a filter    |

Opening the panel always loads once. The 3-hour poll only updates the
badge and notifications.

## Privacy

Credentials stay on this machine. The backend talks only to
`api.appstoreconnect.apple.com`, `oauth2.googleapis.com`,
`androidpublisher.googleapis.com`, and optionally
`playdeveloperreporting.googleapis.com`. Review ids already shown or
notified are stored under `${XDG_CACHE_HOME:-~/.cache}/omarchy-customer-reviews`,
including an `inbox.sqlite` snapshot of reviews already fetched. Opening
the panel shows that snapshot first, then refreshes it from the stores.

## Development

```bash
./check
```

It runs `bun test`, compiles the CLI, validates the manifest, refuses
CJK in user-visible files, and runs `qmllint` when available.
