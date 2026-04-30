# Claude briefing — Leave Desk / esauhr

This file is for Claude. Read it first when you join this repo. It captures the
conventions, vocabulary, and gotchas that aren't obvious from the code alone,
so you can be useful from your first reply rather than spending the user's time
re-deriving context.

If anything below is wrong by the time you read it, trust the code over this
file — but flag the drift in your reply so the user can decide whether to
update this file.

---

## What this is

Internal HR portal for **Evergreen Shipping (KSA)**, an ~50-person logistics
company in Saudi Arabia. It tracks vacations, attendance, permissions
(short same-day absences), shift schedules, and a few HR-internal review
workflows. Built by Nadeem (admin / IT lead), used daily by Bashaier (HR
reviewer), department managers (LOG, BIZ, CSD, FIN, RYD, SUP), and staff.

**Live URL:** `esauhr.netlify.app` (Netlify auto-deploys `main`).
**Stack:** React 18 + Vite + Tailwind + Supabase (Postgres + Auth + Realtime),
no test framework currently. Build is `npm run build`, dev is `npm run dev`.

**Status as of this writing:** test environment with seeded data. Nadeem has
said the cutover to production data will come later — when staff are onboarded
en masse, decisions about Supabase project separation, employee CSV import,
PIN issuance, leave balance carryover, and DNS need to be made. We aren't
there yet.

---

## Roles and tab visibility

The role flags live on the `employees` row and propagate through `me` everywhere:

- **`is_admin`** — Nadeem (`H94152`). Sees everything.
- **`is_hr_reviewer`** — Bashaier (`H94830`). HR oversight role; sees the
  admin Dashboard but is not an admin. Can issue final SUP approval on shifts.
- **Manager** — anyone who is `manager_id` for at least one other employee.
  Sees ManagerDashboard and the Shifts tab.
- **Staff** — everyone else. Sees PersonalDashboard.

Tab gating lives in `buildTabs()` in `src/components/AppShell.jsx`. The
canonical order for a manager is: Dashboard, Requests, **Shifts**, Reviews,
Calendar. The Shifts tab is gated `isManager && !isAdmin && !isHrReviewer`.
Admin and HR reviewer manage shifts from their own dashboard surfaces.

**Hardcoded PSN allowlists exist** for the Attendance feature
(`['H94830', 'H94152']` in two places in `AppShell.jsx`). When onboarding
new admins/HR, search for `H94830` and update accordingly. The SUP team
allowlist `['H94830','H94458','H94330','H94712']` lives in `AttendanceView.jsx`.

---

## Authentication

Custom PIN-based auth on top of Supabase Auth, in `src/lib/psnAuth.js`. Each
employee has a 6-digit numeric PIN, stored as a bcrypt hash by Supabase Auth.
**PINs cannot be retrieved** — only reset (admin-only via the `admin_reset_pin`
RPC, surfaced as the "Reset PIN" button on each employee card). If the user
asks "show me Nadeem the PIN for X," the answer is no — push back politely
and explain Reset PIN is the right tool. This came up in an earlier session.

---

## Supabase schema gotchas

The migration files in `supabase/` are **not fully in sync with the live DB**.
The most important drift:

- `supabase/migration_attendance_violations.sql` defines `employee_shifts` as
  a **week-based** table with `sun_start`, `mon_start`, etc. columns. The live
  table is **per-day**: `(id, employee_id, shift_date, start_time, end_time,
  set_by, status, accepted_at, declined_at, decline_reason, notified_hr_at,
  created_at)` with a unique constraint on `(employee_id, shift_date)`. The
  per-day rebuild was done in Supabase Studio without a committed migration.
  If you re-bootstrap the DB, you'll need to rebuild this table manually.

When in doubt about the live schema, check what the code actually writes —
the writes are the source of truth.

---

## The shift workflow (the most-iterated feature)

Seven-stage flow, all on `employee_shifts`:

1. **Manager assigns** in `ManagerShiftCard` (Shifts tab). Upserts rows with
   `status='pending'`, `set_by=me.id`, all timestamps null. Conflict resolution
   on `(employee_id, shift_date)` so re-saves merge cleanly. Locked rows
   (`status='accepted'` or past dates) are skipped in the save loop.
2. **Staff sees the action card** on PersonalDashboard. AppShell fetches
   `status=eq.pending&employee_id=eq.me.id` and pushes that to the dashboard.
   Realtime sub on `employee_id` keeps it live.
3. **Staff opens `ShiftAcknowledgmentModal`** by tapping the green "Shift
   schedule — awaiting your acknowledgment" card. The modal is **neutral
   (Calendar icon, no fairy/whimsy)** — fairy-style copy is reserved
   exclusively for `BashaierTasksCard` and triggers a child-safety-style
   refusal everywhere else. Don't let it leak.
4. **Staff accepts or declines.** Decline reason is a 2-option dropdown:
   "Already on approved leave" / "Personal commitment — unable to attend".
   Free-text decline is intentionally removed; don't add it back. On accept:
   `status='accepted'`, `accepted_at=now()`, `notified_hr_at` stays null.
5. **Bashaier (SUP) sees `PendingShiftApprovalsCard`** on her dashboard. It
   queries `status=eq.accepted&notified_hr_at=is.null`. Self-hides when empty.
6. **Bashaier clicks "Approve all"** — single PATCH stamps `notified_hr_at`
   on every visible row. Realtime echoes everywhere. Wording is
   "Approve" everywhere, never "Review" — that distinction matters to
   the user, who keeps reminding us.
7. **Manager sees APPROVED BY SUP tile increment** in
   `ManagerShiftStatusCard`. **Staff sees the row flip from blue AWAITING
   SUP to green APPROVED BY SUP** in `StaffShiftStatusCard`, without
   needing to refresh.

**Vocabulary the user enforces:**
- "Approve" not "Review" in the shift flow.
- "SUP (Bashaier)" is the final approver — wording on every customer-facing
  surface should make that explicit.
- "Roster issued" / "dispatched" / "acknowledged" / "approved" — that's the
  workflow vocabulary in the manager save toast.

**Lock semantics:** an accepted shift becomes immutable. UI gates editing
with `isLocked = isPast || isAccepted`. The save loop has a defense-in-depth
check `if (d < today || s?.status === 'accepted') return;` so even a stale
state can't overwrite an accepted row.

**Window:** both the manager status panel and the staff progress card show
a rolling 30-day window of past activity. Don't shrink without asking.

---

## UI conventions

### Card families

There are **two visually distinct card families**, both with hover lift:

**`.esau-card`** — paper info cards. The canonical family, exported as `Card`
from `Dashboard.jsx`. Used for "Out of office today", "Pending requests",
"Upcoming leaves", "Pending shift approvals", "Reports for Mr John", every
PIN requests modal card. Style: `rounded-xl border p-5 esau-card` with
`borderColor: var(--border-soft)` and `background: '#FFFDF7'`. Hover lifts
3px with `border-color: #D4C7AB`. CSS lives in `src/styles/index.css`.

**`.esau-badge`** — colorful tile cards, recently rebranded to share the
`#FFFDF7` chrome but distinct via colored count pills + small accent dots.
Used by the KPI strip at the top of admin Dashboard (TOTAL STAFF, ON LEAVE,
etc.) and the Headcount-by-department grid. Same hover lift but a slightly
lighter shadow profile.

There's also a **`Tile`** primitive exported from `Dashboard.jsx` —
introduced in `e0725d0` to deduplicate the 6 KPI tiles. Use it for any new
tile-shaped surface on the dashboard. Signature:
`<Tile label sublabel count accentDark accentTint onClick>{children}</Tile>`.

When the user asks for cosmetic alignment, the answer is almost always
"this surface needs to use `esau-card` (or `Tile`) and inherit canonical
chrome." Don't invent new card styles.

### Small text rule (per user memory)

Small/secondary/muted text — labels, subtitles, captions, percentages, kicker
text — must use **`#0A0A0A` or `#1F1B16` (near-black)**. Never warm greys
like `#9C9385` / `#9D6B53` or cool greys like `#737373`. This applies to
all current and future updates.

Brand-accent colors **on dept codes, status pills, count pills** stay
colored — don't flatten those. The accent dot in card headers is also fine
to keep colored as a small dose of identity.

### Other conventions

- **No emojis in copy** unless the user has used them or the design clearly
  warrants (the shift schedule card uses 🏖️ etc. inside the colored count
  pills — that's a deliberate dashboard touch).
- **Serif `text-lg`** is the canonical card title size. Don't go bigger.
- **`var(--evergreen-500)`** is the brand green used for accent dots on
  positive/info cards. **`var(--clay)`** is the warm orange-red for
  warning/decline states.

---

## supabaseClient quirks

`src/supabaseClient.js` has a family of **`direct*`** helpers
(`directGet`, `directPatch`, `directPatchQuery`, `directPost`, `directDelete`)
that bypass `supabase-js` and hit PostgREST directly with `fetch`. They exist
because supabase-js was observed to **wedge silently** on certain writes
(particularly bulk updates and complex `.update().in()` chains), leaving the
spinner spinning forever. Direct fetch with an `AbortController` timeout is
the workaround.

If you're writing data, **use the `direct*` helpers**. Don't reach for
`supabase.from(...).update(...)` — you'll re-introduce the wedge. The only
exceptions are realtime channels (use `supabase.channel(...)`) and
`supabase.auth.*` calls.

`AbortError` from the timeout is translated to a friendly message
("The request timed out. Please check your connection and try again.") via
`translateAbort()` in the same file — `8d9c1d1` added this. Don't unwrap it.

Token caching: a single `_cachedToken` is held at module scope and refreshed
via `supabase.auth.onAuthStateChange`. Don't call `getSession()` per-request;
that's what wedged things originally.

---

## Realtime channel naming

Each component owns a uniquely-named channel so they don't collide. The
established pattern:

- `pending-shifts-${me.id}` — `AppShell.jsx`, staff's pending fetch
- `staff-shift-status-${me.id}` — `StaffShiftStatusCard`, staff's progress card
- `mgr-shift-status-${me.id}` — `ManagerShiftStatusCard`, manager's panel
- `hr-pending-shift-approvals` — `PendingShiftApprovalsCard`, singleton
- `reg-req-count` — singleton, registration request count
- `leave-desk-live` — singleton, the main team-data refresh channel

When you add a new realtime sub, follow the pattern and pick a unique name.

---

## Commit message style

Verbose. The user values commit messages that explain the **why**, not just
the what. Rough template:

```
type(scope): one-line summary

Paragraph explaining the motivation — what was wrong before, what
this fixes, who's affected.

Bullet list of the actual changes when there are several.

Notes on edge cases handled, things deliberately left alone, any
follow-up work that's still owed.
```

Look at `8e836ed`, `645dd3a`, `e0725d0` for examples. Don't squash detail
out — these messages are the durable record of why the codebase looks the
way it does, and they help future-you (and future-Claude) catch up.

---

## Working with the user

A few things that have come up consistently:

- The user is in **KSA (Dammam)**, time zone GMT+3, no DST. When you compute
  date cutoffs assume local time matches the server's interpretation.
- Communication is direct. They send terse messages. Match the tone — no
  flowery preamble.
- They will sometimes re-send the **same screenshot or same prompt twice**
  if they think the previous turn missed it. Take that seriously. Don't
  assume "I already did this" — go check.
- They use **Claude in Chrome** for live UI verification. If they ask you to
  "test" or "check" something visually, you probably can't from inside
  Claude Code or claude.ai chat — you need to either (a) hand the task to
  Claude in Chrome via the connector, or (b) tell them honestly you can't
  verify visually and ask them to.
- **Hard-refresh matters.** CSS changes especially get cached. When in
  doubt, suggest `Cmd-Shift-R` / `Ctrl-Shift-R`.
- The user has had earlier sessions running in parallel. **Always
  `git pull --rebase origin main` first** before assuming what state the
  repo is in. There may be commits you didn't make.

---

## Outstanding / known items

As of `e0725d0`:

- **Production cutover plan** — not started. Decisions needed: same Supabase
  project (test data wipe) or new project (full migration), employees CSV
  source, PIN issuance plan, leave balance carryover, DNS for
  `hr.evergreen-shipping.com.sa` or similar.
- **Migration drift** — `employee_shifts` table in migration files is
  week-based; live table is per-day (see Schema gotchas above). At cutover
  time we should write a clean migration that matches the live shape.
- **Hardcoded PSN allowlists** for Attendance — `H94830` and `H94152` —
  should ideally be moved to a role flag on `employees` rather than a
  Set in `AppShell.jsx`. Not urgent.
- **Audit log retention** — currently grows forever. Decide a retention
  policy before production.
- **Shift workflow has not been browser-verified end-to-end in this
  session.** Static analysis is sound; live verification still owed.

---

## Quick orientation if you're new

```bash
git pull --rebase origin main
npm install
npm run dev   # local dev on http://localhost:5173
npm run build # production build, what Netlify runs
```

The most-touched files are `Dashboard.jsx` (admin/HR), `AppShell.jsx` (the
top-level router), `ManagerShiftCard.jsx` (shift editor), and
`PendingShiftApprovalsCard.jsx` (Bashaier's approval queue). If the user
mentions a card by name, it's almost always in `src/components/`.

When in doubt, ask. The user prefers a clarifying question over a
half-confident guess.
