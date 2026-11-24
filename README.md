# Tennis Pro Novi Sad — Telegram booking app

A Telegram Mini App for booking tennis courts and coaching sessions at a club in Novi Sad. Built and run for the 2026 summer season: two courts, two coaches, 10–14+ coaching sessions a day.

**Problem.** Bookings, cancellations and reschedules were handled by hand in chats. Freed slots got lost and coaches lost paid sessions.

**Solution.** Players book inside Telegram. Coaches get every change instantly. When a regular player cancels, the freed slot is announced and can be rebooked right away.

## Features

**Players**
- Book a coaching session or a court rental (1, 1.5 or 2 h) on a live calendar of both courts
- "My bookings": cancel or reschedule up to 12 h before the start
- Reminder 3 h before the session, with cancel and reschedule buttons
- Invite an opponent through Telegram sharing
- Short intake form for the coach (level, racket, notes); string-job requests
- Russian and Serbian interface; phone number saved after the first booking

**Coaches**
- Schedule view of both courts with player details
- Close slots (vacation, court busy)
- Propose new times for an existing booking; the player picks one in the bot chat
- Offer a slot to a player from the client base
- Personal notifications for every new booking, cancellation and reschedule

## Architecture

```
Telegram ──► Mini App (index.html on GitHub Pages)
               │  fetch, with Telegram initData
               ▼
         Apps Script web app (server/Code.gs) ──► Google Sheets
               │                                   (bookings, clients)
               ▼
         Telegram Bot API ──► messages and buttons to players and coaches

Time triggers: polling for bot updates every minute · reminders every hour · cleanup weekly
```

| Part | Tech |
|---|---|
| Frontend | Single-page HTML/CSS/JS, Telegram WebApp SDK, hosted on GitHub Pages |
| Backend | Google Apps Script web app (`doGet` / `doPost`) |
| Storage | Google Sheets: `Брони` (bookings), `Клиенты` (clients) |
| Messaging | Telegram Bot API: `sendMessage`, inline keyboards, `getUpdates` |

## Engineering notes

- **Authentication.** Every write is checked on the server: the Telegram `initData` signature is verified with HMAC-SHA256 and a 24-hour freshness window. The user id is taken from the signature, never from the request body. The public `GET` returns only slot occupancy, no names or phones.
- **No double bookings.** Writes run under `LockService`. Conflicts are checked on the server on 30-minute slots, so 1.5-hour rentals work. Notifications are sent after the lock is released to keep requests fast.
- **Webhook → polling.** Apps Script answers every request with HTTP 302, and Telegram webhooks do not follow redirects, so Telegram kept re-sending the same updates and users got duplicate messages. The bot now polls `getUpdates` every minute and stores the offset with retries.
- **Holds.** Times a coach proposes are held for 30 minutes so nobody else books them while the player decides. Expired holds are released by the hourly trigger.
- **Data hygiene.** Cancelled bookings are soft-deleted (status `cancelled`). Rows older than 30 days are removed weekly.

## Deploy

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Create a Google Sheet, open **Extensions → Apps Script** and paste `server/Code.gs`.
3. In **Project Settings → Script Properties** add `TOKEN` with the bot token.
4. Set `ADMIN_CHAT_IDS`, `COACH_IDS` and `COACH_CHAT` at the top of `Code.gs`.
5. **Deploy → New deployment → Web app**: execute as me, access: anyone. Copy the `/exec` URL into `SCRIPT_URL` in `index.html`.
6. Run once by hand: `switchToPolling()`, `setupReminderTrigger()`, `setupCleanupTrigger()`.
7. Publish `index.html` on GitHub Pages and set it as the bot's Mini App URL in @BotFather.

After any change to `Code.gs`: **Deploy → Manage deployments → Edit → New version**, otherwise the `/exec` URL keeps serving the old code.

## Next: winter season

The winter version needs several venues and courts that are not leased by the coaches. That means moving from a fixed court → coach mapping to a venue / resource model with shared availability.
