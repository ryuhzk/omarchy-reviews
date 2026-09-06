# Customer Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Omarchy bar plugin that lists and replies to App Store customer reviews for selected apps, with a 3-hour background badge/notification poll and a one-shot inbox load on click.

**Architecture:** QML never talks to Apple. `Service.qml` polls every 3 hours via `bun backend/customer-reviews.ts poll`. Opening the panel runs `reviews list` once. Credentials and watch list live in `~/.config/omarchy-customer-reviews/config.env` (0600). Google Play is out of scope.

**Tech Stack:** Omarchy / Quickshell QML, Bun 1.4.2, TypeScript, `node:crypto` ES256 JWT, `bun:test`, App Store Connect API.

**Spec:** `docs/superpowers/specs/2026-09-06-omarchy-customer-reviews-design.md`

## Global Constraints

- Plugin id is exactly `ryuhzk.customer-reviews`; display name `Customer Reviews`; bar short label `Reviews`.
- User-visible QML, `manifest.json`, and README stay English-only (no CJK).
- No npm dependencies. Bun + TypeScript only. `packageManager` is `bun@1.4.2`.
- JWT: ES256, `aud=appstoreconnect-v1`, 15-minute lifetime, `dsaEncoding: "ieee-p1363"`.
- Config dir `0700`, `config.env` and copied `.p8` `0600`. CLI JSON never includes PEM or JWT.
- Background poll default `10800` seconds (3 hours). Click-open loads inbox once and does not notify.
- First successful poll seeds `seen.json` and does not notify for historical reviews.
- Reply body 1–4000 characters. Apple replies are create or delete, never PATCH.
- Tests never call the live App Store Connect API.

## File structure

| File | Responsibility |
| --- | --- |
| `manifest.json` | Plugin contract |
| `package.json` | Bun package + scripts |
| `check` | Full local gate |
| `LICENSE` | MIT, same as other ryuhzk plugins |
| `README.md` | English install and setup |
| `backend/model.ts` | Types and JSON envelopes |
| `backend/config.ts` | Load/save private config |
| `backend/apple.ts` | JWT, HTTP, review mapping |
| `backend/store.ts` | Cache + seen ids + poll |
| `backend/customer-reviews.ts` | CLI |
| `tests/*.test.ts` | bun:test |
| `Service.qml` | 3h poll + notifications |
| `BarWidget.qml` | Badge + panel toggle |
| `Panel.qml` | Setup, apps, inbox, reply |

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `manifest.json`, `LICENSE`, `.gitignore`, `check`

- [ ] **Step 1: Write scaffold files** matching `omarchy-server-status` / `omarchy-lyrics`.
- [ ] **Step 2: `omarchy plugin validate` after QML shells exist** (Task 6). Until then keep check focused on bun test + build + jq.

---

### Task 2: Config

**Files:**
- Create: `backend/model.ts`, `backend/config.ts`, `tests/config.test.ts`

**Produces:**
- `loadConfig(dir)`, `saveConfig(dir, patch)`, `showConfig(dir)`, `isConfigured(config)`
- Keys: `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_PRIVATE_KEY_PATH`, `WATCHED_APP_IDS`, `ACTIVE_APP_ID`

- [ ] **Step 1: Write failing tests** for round-trip, 0600 mode, refusal to echo PEM, `configured` false when key missing.
- [ ] **Step 2: Implement config** with atomic write + chmod.
- [ ] **Step 3: `bun test tests/config.test.ts`**

---

### Task 3: Apple JWT and mapping

**Files:**
- Create: `backend/apple.ts`, `tests/apple.test.ts`

**Produces:**
- `mintJwt({ issuerId, keyId, pem, nowMs })`
- `mapApps(payload)`, `mapReviews(payload)`, `replyRequest(reviewId, body)`, `classifyHttpStatus(status)`

- [ ] **Step 1: Write failing JWT + mapping tests** using a generated P-256 key.
- [ ] **Step 2: Implement apple.ts** with injected `fetch` for HTTP tests.
- [ ] **Step 3: `bun test tests/apple.test.ts`**

---

### Task 4: Store and poll

**Files:**
- Create: `backend/store.ts`, `tests/store.test.ts`

**Produces:**
- `runPoll({ configDir, cacheDir, fetchApps, fetchReviews })`
- First poll seeds seen and returns `newReviews: []`
- Second poll returns only unseen ids
- Failed app fetch does not mark that app's reviews seen

- [ ] **Step 1: Write failing poll tests**
- [ ] **Step 2: Implement store.ts**
- [ ] **Step 3: `bun test tests/store.test.ts`**

---

### Task 5: CLI

**Files:**
- Create: `backend/customer-reviews.ts`

**Produces:** one JSON envelope per command listed in the spec. `--compact` writes minified JSON. Exit 0 on `ok: true`, exit 1 on `ok: false`, exit 2 on usage.

- [ ] **Step 1: Write CLI tests** invoking the entry with `Bun.spawn` against temp dirs.
- [ ] **Step 2: Implement the CLI**
- [ ] **Step 3: `bun test` and `bun build backend/customer-reviews.ts --target=bun`**

---

### Task 6: QML

**Files:**
- Create: `Service.qml`, `BarWidget.qml`, `Panel.qml`

Follow `omarchy-lyrics` (service + BarWidget + Panel) and `omarchy-translation` (Process + FileDialog + settings fields).

- [ ] **Step 1: Service** — 3h timer, `poll`, `notify-send` only on later polls, digest if more than 5 new reviews.
- [ ] **Step 2: BarWidget** — `Reviews` / `Reviews N`, left click toggles panel.
- [ ] **Step 3: Panel** — Setup / Apps / Inbox; click-open loads list once; reply and delete-reply.
- [ ] **Step 4: `./check`** including `omarchy plugin validate` and `qmllint`.

---

### Task 7: README and local install

- [ ] **Step 1: Write README** with ASC key steps, install, remove.
- [ ] **Step 2: Symlink into `~/.config/omarchy/plugins/ryuhzk.customer-reviews` and enable.**
- [ ] **Step 3: Run `./check`**

## Self-review

- Spec sections map to tasks: auth/setup (2, 6), apps/watch (2, 5, 6), inbox/reply (3, 5, 6), 3h poll + click load (4, 6), security (2, 5), tests (2–5, check).
- No Play store switcher in v1.
- Types stay in `model.ts` and are imported by later files.
