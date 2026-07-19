# Restless Spirits Society — deployment walkthrough

Everything below is done by you (it needs your bot token, your host, and your account).
Values already known: **GUILD_ID = 1528476753939398850**, referral **https://trade.padre.gg/rk/rss**.

---

## Phase 0 — Verify your Discord email (2 min)
Discord may refuse to let you add a bot until your account email is confirmed.
- Look for the green "check your email" banner at the top of Discord → click **Resend Email**.
- Open the email from Discord → click **Verify Email**. Done.

## Phase 1 — Turn on Developer Mode (30 sec)
You need this to copy IDs.
- Discord → **User Settings** (gear, bottom-left) → **Advanced** → toggle **Developer Mode** on.

## Phase 2 — Create the bot application (5 min)
1. Go to <https://discord.com/developers/applications> → **New Application** → name it `RSS Verify` → Create.
2. Left sidebar → **Bot**.
   - Click **Reset Token** → **Copy**. This is your `DISCORD_TOKEN`. Treat it like a password — never share or commit it.
   - Scroll to **Privileged Gateway Intents** → turn ON **Server Members Intent** → Save.
3. Left sidebar → **OAuth2** → **URL Generator**:
   - Under **Scopes** tick: `bot` and `applications.commands`.
   - Under **Bot Permissions** tick: **Manage Roles** (and **Send Messages** + **Embed Links**).
   - Copy the **Generated URL** at the bottom, paste it in a new tab, pick **Restless Spirits Society**, Authorize.

## Phase 3 — Fix the role order (1 min) — IMPORTANT
A bot can only assign roles that sit **below** its own role.
- Discord → **Server Settings → Roles**.
- Drag the bot's role (it'll be named after the app, e.g. "RSS Verify") **above** both **Trencher** and **Referral Verified**.

## Phase 4 — Collect the IDs (2 min)
With Developer Mode on, right-click each and "Copy ID":
- **Trencher** role (Server Settings → Roles → right-click) → this is `ROLE_ID`.
- **Referral Verified** role → this is `REQUIRE_ROLE_ID`.
- **#verify** channel → this is `VERIFY_CHANNEL_ID` (optional).
- `GUILD_ID` is already `1528476753939398850`.

## Phase 5 — Fill in .env (2 min)
In the project folder, copy `.env.example` to `.env` and fill it in:
```
DISCORD_TOKEN=（from Phase 2）
GUILD_ID=1528476753939398850
ROLE_ID=（Trencher role ID）
REQUIRE_ROLE_ID=（Referral Verified role ID）
VERIFY_CHANNEL_ID=（#verify ID, optional）
MIN_SOL=10
MAX_MEMBERS=100
RPC_URL=https://api.mainnet-beta.solana.com
BASE_URL=（your public URL from Phase 6 — set this AFTER you deploy）
PORT=3000
SESSION_SECRET=（run the command below）
```
Generate the secret:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Phase 6 — Deploy it (this is the real work)
The bot must run 24/7 and have a public **https** URL (needed for wallet signing).

### Easiest reliable path: Railway (~$5/mo, always-on)
1. Put the project on GitHub: create a free account at github.com → **New repository** → upload the
   contents of the `rss-verify-bot` folder (drag the files into the "uploading files" box). **Do not upload `.env`.**
2. Go to <https://railway.app> → sign in with GitHub → **New Project** → **Deploy from GitHub repo** → pick your repo.
3. Railway auto-detects Node and runs `npm install` then `npm start`.
4. **Variables** tab → add every line from your `.env` (except leave BASE_URL for now).
5. **Settings → Networking → Generate Domain** → copy the `https://…up.railway.app` URL.
6. Set `BASE_URL` to that URL (Variables tab) → the app redeploys.

> Render's free tier "sleeps" after inactivity, which drops the bot — avoid it for an always-on bot.
> A cheap VPS (DigitalOcean/Hetzner, ~$5/mo) also works: `npm install && npm start` behind a domain with https.
> Not a coder? Hand the zip + this guide to any dev friend — it's ~15 minutes for them.

### Local test first (optional, free)
On your own computer with Node 18+: `npm install` then `npm start`. With `BASE_URL=http://localhost:3000`
you can test the whole flow yourself before paying for a host (wallet signing works on localhost).

## Phase 7 — Switch it on (2 min)
1. When it's running you'll see `Bot online as …` in the logs.
2. In Discord, go to **#verify** and run **`/setup`** once → it posts the green **Verify Wallet** button.
3. Test it yourself: give your own account the **Referral Verified** role, click **Verify Wallet**,
   sign the message with a wallet holding 10+ SOL → you should receive **Trencher** and see the hidden channels.

## Phase 8 — Day-to-day (how it runs)
- A newcomer signs up via your referral link and posts a screenshot in **#verify**.
- A **mod** checks it and gives them the **Referral Verified** role (right-click the member → Roles).
- The member clicks **Verify Wallet** / runs `/verify` → the bot confirms 10+ SOL → grants **Trencher**.
- After 100 Trenchers, the bot tells newcomers free entry has closed (change `MAX_MEMBERS` to reopen).

## Tips
- Use a real RPC (free Helius/QuickNode key) in `RPC_URL` before you promote the server — the public RPC is rate-limited.
- The balance is checked at verify time; if you want the role auto-removed when a wallet drops below 10 SOL,
  that's a periodic re-check we can add later.
- Keep `DISCORD_TOKEN` and `SESSION_SECRET` secret. Never commit `.env` to GitHub.
