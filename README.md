# Restless Spirits Society — native-SOL verify bot

A small, self-hostable Discord bot that grants the **Trencher** role only to members whose
wallet holds **10+ native SOL**, proven by a **read-only wallet signature** (never a transaction).

Off-the-shelf tools (Guild.xyz, Collab.Land, Matrica, Vulcan, Solmate) can't gate on native SOL
balance — they only do SPL tokens or NFTs — so this does exactly that one job.

## How it works

Two requirements, both enforced before the bot grants the channel-unlocking **Trencher** role:

- **Referral (mandatory, first):** the member signs up via your Padre link and posts a screenshot in
  #verify. A mod gives them the **Referral Verified** role. (Set its ID as `REQUIRE_ROLE_ID`.)
- **10+ native SOL:** the member runs **`/verify`**, connects Phantom, and **signs a message**
  (read-only — no transaction, no seed phrase). The bot reads their native SOL balance over RPC.

Only when a member has *both* — the Referral Verified role **and** 10+ SOL — does the bot grant
**Trencher**, which unlocks the server. The **first 100** to pass get in (the `MAX_MEMBERS` cap);
after that the bot tells newcomers free entry has closed. Each wallet links to one Discord account.

> Prefer to gate on SOL only and treat the referral as honor-based? Leave `REQUIRE_ROLE_ID` blank.
> Want no cap? Set `MAX_MEMBERS=0`.

## What you need

- Node.js 18+
- A place to run it 24/7 that has a public HTTPS URL (Railway, Render, Fly.io, or any VPS).
  Wallet signing needs the page served over **https** in production.
- (Recommended) A free Solana RPC key from Helius / QuickNode / Triton — the public RPC is rate-limited.

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g. "RSS Verify").
2. Left sidebar → **Bot** → **Reset Token** → copy the token → this is `DISCORD_TOKEN` (keep it secret).
3. Still on **Bot**, enable **Server Members Intent** (required to assign roles).
4. Left sidebar → **OAuth2 → URL Generator**: tick **bot** and **applications.commands**, then under
   Bot Permissions tick **Manage Roles**. Copy the generated URL, open it, and add the bot to your server.
5. In Discord (with Developer Mode on: User Settings → Advanced → Developer Mode):
   - Right-click the server icon → **Copy Server ID** → `GUILD_ID` (already prefilled: `1528476753939398850`).
   - Right-click the **Trencher** role (Server Settings → Roles) → **Copy Role ID** → `ROLE_ID`.
   - Create a **Referral Verified** role (mods grant this after the Padre screenshot) →
     Copy its ID → `REQUIRE_ROLE_ID`. (Leave blank to gate on SOL only.)
   - Right-click **#verify** → **Copy Channel ID** → `VERIFY_CHANNEL_ID` (optional).
6. **Important:** in Server Settings → Roles, drag the bot's own role **above** the Trencher role,
   or it won't be allowed to assign it.

## 2. Configure

```bash
cp .env.example .env
# then fill in DISCORD_TOKEN, ROLE_ID, RPC_URL, BASE_URL, SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → SESSION_SECRET
```

Set `BASE_URL` to the public URL your host gives you (e.g. `https://rss-verify.up.railway.app`).

## 3. Run

```bash
npm install
npm start
```

You should see `Bot online as …` and `Web verifier on …`. In Discord run **`/setup`** in #verify once
to post the Verify button, or members can just use **`/verify`**.

## Deploy notes

- **Railway/Render:** point it at this repo, set the env vars in the dashboard, start command `npm start`,
  and use the app's public URL as `BASE_URL`. Add a small persistent volume for `data/` if you want the
  one-wallet-per-account records to survive restarts.
- Keep `DISCORD_TOKEN` and `SESSION_SECRET` secret — never commit `.env`.

## Honest limitations

- **Point-in-time check.** Balance is read at verify time. Someone could borrow 10 SOL, verify, then move
  it out. If you want ongoing enforcement, add a scheduled re-check that removes the role when a wallet
  drops below the threshold (not included here to keep it simple).
- Uses the public RPC by default — fine for low volume, but add a real RPC key for a launch.
- This grants the role for the **10-SOL** requirement only. The **referral** requirement stays a manual
  mod check (screenshot in #verify), exactly as set up in the server.
