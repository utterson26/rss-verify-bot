# Restless Spirits Society — multi-chain verify bot

A small, self-hostable Discord bot that grants the **Trencher** role only to members whose wallets
hold **$1,000+ in native coins on any supported chain**, proven by a **read-only wallet signature**
(never a transaction).

Supported today: **SOL** on Solana · **ETH** on Ethereum, Base and Arbitrum · **BNB** on BNB Chain.

Off-the-shelf tools (Guild.xyz, Collab.Land, Matrica, Vulcan, Solmate) gate on token or NFT holdings,
not on a dollar-denominated native balance summed across chains — so this does exactly that one job.

## How it works

Two requirements, both enforced before the bot grants the channel-unlocking **Trencher** role:

- **Referral (mandatory, first):** the member signs up through your referral link and posts a
  screenshot in #verify. A mod gives them the **Referral Verified** role. (Set its ID as
  `REQUIRE_ROLE_ID`.) Desktop members are pointed at **Padre** (`REFERRAL_URL`), phone members at
  **FOMO** (`FOMO_URL`).
- **$1,000+ in native coins:** the member runs **`/verify`**, links a Solana wallet, an EVM wallet,
  or both, and **signs a message** with each (read-only — no transaction, no seed phrase). The bot
  reads the native balance of every linked address on every supported chain, prices it in USD, and
  adds it up.

A member holding $500 of SOL, $300 of ETH and $200 of BNB qualifies at $1,000 — the sum is what
counts, not any single chain.

Only when a member has *both* — the Referral Verified role **and** $1,000+ — does the bot grant
**Trencher**, which unlocks the server. The **first `MAX_MEMBERS`** to pass get in; after that the
bot tells newcomers free entry has closed. Each wallet address links to one Discord account.

> Prefer to skip the referral step? Leave `REQUIRE_ROLE_ID` blank.
> Want no cap? Set `MAX_MEMBERS=0`. Different threshold? Set `MIN_USD`.

### Why native coins only

Tokens and memecoins are deliberately **not** counted. Pricing arbitrary tokens needs a paid
indexer, and thin-liquidity tokens make the threshold trivially gameable — anyone can mint a token,
seed a tiny pool, and "hold" a fake $1M. Native coins have deep, real markets, so $1,000 of SOL or
ETH means what it says.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required.** Bot token. |
| `GUILD_ID` / `ROLE_ID` | — | **Required.** Server ID and the Trencher role ID. |
| `MIN_USD` | `1000` | Entry threshold in US dollars, summed across all linked wallets. |
| `MAX_MEMBERS` | `100` | Free spots. `0` = unlimited. **Set this to `50` to match the 50-seat story.** |
| `VERIFY_OPEN` | `false` | Launch gate. Flip to `true` on release day. |
| `REQUIRE_ROLE_ID` | — | Referral Verified role. Blank = no referral step. |
| `REFERRAL_URL` | Padre link | Shown to members trading on a PC / terminal. |
| `FOMO_URL` | FOMO link | Shown to members trading on their phone. |
| `TICKET_STAFF_ROLE_ID` | — | Extra role (besides admins) that can see and approve tickets. |
| `SESSION_SECRET` | — | Long random string; signs the one-time verify links. |
| `BASE_URL` | localhost | Public HTTPS URL of this service. |
| `RPC_URL` | public Solana RPC | Solana RPC. Use a Helius/QuickNode key for a launch. |
| `ETH_RPC_URL` `BSC_RPC_URL` `BASE_RPC_URL` `ARB_RPC_URL` | publicnode.com | Per-chain EVM RPCs. |
| `COINGECKO_API_KEY` | — | Optional CoinGecko Pro key; without it the free endpoint is used. |
| `DRY_RUN` | `false` | Serve only the verify page, no Discord — for local styling. |

## What you need

- Node.js 18+
- A place to run it 24/7 with a public HTTPS URL (Render, Railway, Fly.io, any VPS).
  Wallet signing needs the page served over **https** in production.
- (Recommended) A free Solana RPC key from Helius / QuickNode / Triton — the public RPC is rate-limited.

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g. "RSS Verify").
2. Left sidebar → **Bot** → **Reset Token** → copy the token → this is `DISCORD_TOKEN` (keep it secret).
3. Still on **Bot**, enable **Server Members Intent** (required to assign roles).
4. Left sidebar → **OAuth2 → URL Generator**: tick **bot** and **applications.commands**, then under
   Bot Permissions tick **Manage Roles**. Copy the generated URL, open it, and add the bot to your server.
5. In Discord (with Developer Mode on: User Settings → Advanced → Developer Mode):
   - Right-click the server icon → **Copy Server ID** → `GUILD_ID`.
   - Right-click the **Trencher** role (Server Settings → Roles) → **Copy Role ID** → `ROLE_ID`.
   - Create a **Referral Verified** role (mods grant this after the signup screenshot) →
     Copy its ID → `REQUIRE_ROLE_ID`. (Leave blank to gate on balance only.)
   - Right-click **#verify** → **Copy Channel ID** → `VERIFY_CHANNEL_ID` (optional).
6. **Important:** in Server Settings → Roles, drag the bot's own role **above** the Trencher role,
   or it won't be allowed to assign it.

## 2. Configure

```bash
cp .env.example .env
# fill in DISCORD_TOKEN, ROLE_ID, BASE_URL, SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → SESSION_SECRET
```

## 3. Run

```bash
npm install
npm run check     # confirms every RPC and the price feed are reachable from this machine
npm test          # signature + threshold unit tests
npm start
```

You should see `Bot online as …` and `Web verifier on …`. In Discord run **`/setup`** in #verify once
to post the Verify button, or members can just use **`/verify`**.

`npm run check` also values real wallets if you pass them:

```bash
node scripts/check.js 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

## Health endpoint

`GET /api/health` returns the current threshold, whether verification is open, and live prices —
useful as an uptime check. It exposes no secrets.

## Deploy notes

- **Render/Railway:** point it at this repo, set the env vars in the dashboard, start command
  `npm start`, and use the app's public URL as `BASE_URL`. Add a small persistent volume for `data/`
  so the one-wallet-per-account records survive restarts.
- Keep `DISCORD_TOKEN` and `SESSION_SECRET` secret — never commit `.env`.
- After deploying, hit `/api/health` once. If prices are unreachable from your host, **every**
  verification will be refused until that's fixed.

## Honest limitations

- **Point-in-time check.** Balance is read at verify time. Someone could borrow $1,000, verify, then
  move it out. Ongoing enforcement would need a scheduled re-check that strips the role when a wallet
  drops below the threshold (not included, to keep this simple).
- **Native coins only** — a wallet holding $50k of memecoins and no SOL will not qualify. That is a
  deliberate trade-off (see above), not an oversight.
- **Fails closed.** If the price feed or a chain's RPC is unreachable, the bot refuses rather than
  guessing. A member on a chain that's temporarily down is told to try again shortly.
- **One EVM address covers all EVM chains** — the same address is checked on Ethereum, Base,
  Arbitrum and BNB Chain. A member using different addresses per chain can only link one of them
  per verification.
- Public RPCs by default — fine for low volume, but get real RPC keys before a launch.
