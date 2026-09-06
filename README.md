# Omarchy Customer Reviews

Read and reply to App Store customer reviews from the Omarchy bar.

The plugin lists reviews for the apps you watch, lets you reply in the
panel, shows an unreplied count on the bar, and sends a desktop
notification when a new review appears. Version 1 is Apple only. Google
Play is a later store adapter behind the same command shape.

```text
bar click → load inbox once
service   → poll every 3 hours → badge + notifications
panel     → bun backend/customer-reviews.ts → App Store Connect
```

## Features

- First-run setup for an App Store Connect API key
- Watch one or more apps from the team the key can see
- Inbox with app chips, unreplied filter, and in-panel replies
- Bar label `Reviews` or `Reviews N`
- Desktop notifications for new reviews on watched apps
- Historical reviews are seeded on first poll and do not notify

## Requirements

- Omarchy Shell with third-party plugin support
- [Bun](https://bun.sh) 1.4 or newer
- An App Store Connect API key with the **Customer Support** or **Admin** role

## Create an API key

1. Open [App Store Connect](https://appstoreconnect.apple.com) → Users and Access → Integrations → App Store Connect API.
2. Note the **Issuer ID**.
3. Create a key. Give it the Customer Support role if you want to reply.
   Admin also works. Marketing or Developer can read some data but cannot reply.
4. Download the `.p8` file. Apple only shows it once.
5. Copy the **Key ID**.
6. Open the plugin, paste Issuer ID and Key ID, choose the `.p8`, and save.

The plugin copies the key to `~/.config/omarchy-customer-reviews/` with
mode `0600`. The PEM never appears in panel output.

## Install

```sh
omarchy plugin add https://github.com/ryuhzk/omarchy-reviews.git --enable
```

## Usage

- Left-click: open the panel and load the active app once
- Escape: close the panel
- Setup: save Issuer ID, Key ID, and the `.p8`
- Apps: choose which apps update the badge and notifications
- Inbox: switch apps, filter unreplied, write a reply, or delete a reply

Apple cannot edit a reply in place. Delete it, then submit a new one.

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
directory only if you also want to discard the API key and watch list.

## Settings

| Setting            | Default | Meaning                                              |
| ------------------ | ------: | ---------------------------------------------------- |
| `panelWidth`       |   `720` | Popup width                                          |
| `pollIntervalSec`  | `10800` | Background poll interval (1–12 hours, default 3)     |
| `unrepliedOnly`    |  `true` | Inbox opens on unreplied reviews                     |

Opening the panel always loads once. The 3-hour poll only updates the
badge and notifications.

## Privacy

Credentials stay on this machine. The backend talks only to
`api.appstoreconnect.apple.com`. Review ids already shown or notified
are stored under `${XDG_CACHE_HOME:-~/.cache}/omarchy-customer-reviews`.

## Development

```bash
./check
```

It runs `bun test`, compiles the CLI, validates the manifest, refuses
CJK in user-visible files, and runs `qmllint` when available.
