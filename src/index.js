// Restless Spirits Society — multi-chain wallet verification bot
// One Node process runs BOTH the Discord bot and a small web verifier.
//
// Entry rule (free entry period):
//   A member gets in when the NATIVE coins across the wallets they prove they own
//   are worth MIN_USD ($1,000 by default) or more, on ANY supported chain.
//   Solana (SOL) + EVM (ETH on Ethereum/Base/Arbitrum, BNB on BNB Chain).
//   A Phantom user holding $500 SOL + $300 ETH + $200 BNB qualifies at $1,000.
//
// Flow:
//   1) A member runs /verify (or clicks Verify Wallet) in Discord.
//   2) The bot DMs them an ephemeral, one-time link to the web verifier.
//   3) On that page they link a Solana wallet, an EVM wallet, or both, and
//      SIGN A MESSAGE with each (read-only — never a transaction).
//   4) The server verifies every signature, reads native balances across chains,
//      prices them in USD, and grants Trencher if the total clears MIN_USD.
//
// Security notes:
//   • Users only ever sign a message. No transaction is ever requested. No seed phrase, ever.
//   • The link carries an HMAC-signed, 10-minute, single-use token bound to the Discord user ID,
//     so one person can't verify on behalf of another.
//   • Each wallet address can only be used by one Discord account (data/verified.json).
//   • Price and RPC failures fail CLOSED — we refuse rather than guess a balance.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Connection } from '@solana/web3.js';
import {
  createTokens, challengeMessage, checkSolanaProof, checkEvmProof, dbKey,
} from './auth.js';
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType,
} from 'discord.js';
import {
  getPrices, valueEvmAddress, valueSolanaAddress,
  totalUsd, describeHoldings,
} from './chains.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────
const {
  DISCORD_TOKEN, GUILD_ID, ROLE_ID, VERIFY_CHANNEL_ID,
  REQUIRE_ROLE_ID,                  // optional: member must already have this role (e.g. "Referral Verified")
  TICKET_STAFF_ROLE_ID,             // optional: role (besides admins) that can see & approve tickets
  LOG_CHANNEL_ID,                   // optional: private channel where every verify attempt / ticket event is logged
  REFERRAL_URL = 'https://trade.padre.gg/rk/rss',   // desktop / terminal users
  FOMO_URL = 'https://fomo.family/r/RSScabal',       // mobile users
  RPC_URL = 'https://api.mainnet-beta.solana.com',
  BASE_URL = 'http://localhost:3000',
  SESSION_SECRET = 'change-me',
  PORT = 3000,
} = process.env;

// The entry threshold, in US dollars, summed across every wallet a member links.
const MIN_USD = Number(process.env.MIN_USD ?? 1000);
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS ?? 100); // 0 = unlimited ("first N free")
const TICKET_CATEGORY = 'verification-tickets';
const SUPPORT_CATEGORY = 'support-tickets';

const usd = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

// ── Launch gate ─────────────────────────────────────────────────────────────
// Verification is CLOSED until launch. Flip VERIFY_OPEN=true (env) on release
// day to open the doors. Enforced on the Discord buttons AND server-side.
const VERIFY_OPEN = String(process.env.VERIFY_OPEN ?? 'false').toLowerCase() === 'true';
const DRY_RUN = String(process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';
const VERIFY_CLOSED_MSG = process.env.VERIFY_CLOSED_MSG
  || `🔒 **Verification isn't open yet.** Restless Spirits Society unlocks at launch — funded wallets (${usd(MIN_USD)}+ on any chain) claim the free spots first, then it goes paid. Watch the announcements and our X for the drop. 🕯️`;

if (!DRY_RUN) {
  for (const [k, v] of Object.entries({ DISCORD_TOKEN, GUILD_ID, ROLE_ID })) {
    if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
  }
}
if (SESSION_SECRET === 'change-me') {
  console.warn('⚠  SESSION_SECRET is still the default — set a long random value in production.');
}

const connection = new Connection(RPC_URL, 'confirmed');

// ── Tiny JSON store so a wallet can't be reused across accounts ─────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'verified.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
function loadDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } }
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ── One-time signed tokens (bind a link to a Discord user, 10 min TTL) ──────
const { makeToken, readToken } = createTokens(SESSION_SECRET);
const usedNonces = new Set();

// ── Grant the role in Discord ───────────────────────────────────────────────
// Returns { granted, already, full, needsPrereq }. Enforces the "first N free" cap.
async function grantRole(discordId) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(discordId);
  if (member.roles.cache.has(ROLE_ID)) return { already: true };
  // Referral is a hard prerequisite: a mod must have granted REQUIRE_ROLE_ID first.
  if (REQUIRE_ROLE_ID && !member.roles.cache.has(REQUIRE_ROLE_ID)) return { needsPrereq: true };
  if (MAX_MEMBERS > 0) {
    await guild.members.fetch();                        // populate cache so the count is accurate
    const role = await guild.roles.fetch(ROLE_ID);
    if (role && role.members.size >= MAX_MEMBERS) return { full: true };
  }
  await member.roles.add(ROLE_ID, `Verified ${usd(MIN_USD)}+ in native coins (+ referral)`);
  return { granted: true };
}


// ── Owner visibility: audit log + live counts ───────────────────────────────
// Every verification attempt (pass or fail, and why) and every ticket event is
// posted as an embed to LOG_CHANNEL_ID, so the owner never has to guess who got
// in, who bounced, and how many seats are left.
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const LOG_COLORS = { ok: 0x2dd478, fail: 0xff6b6b, info: 0x5865f2, warn: 0xffa848 };

async function logEvent(level, title, fields = [], description = '') {
  if (!LOG_CHANNEL_ID || !client.isReady()) return;
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    const embed = new EmbedBuilder().setTitle(title).setColor(LOG_COLORS[level] ?? LOG_COLORS.info).setTimestamp();
    if (description) embed.setDescription(description);
    const clean = fields.filter((f) => f && f.value !== undefined && f.value !== null && String(f.value).length)
      .map((f) => ({ name: f.name, value: String(f.value).slice(0, 1000), inline: f.inline ?? true }));
    if (clean.length) embed.addFields(clean);
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('log channel send failed:', e.message);
  }
}

/** Live numbers for /stats and for the success log line. */
async function getCounts() {
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.members.fetch();
  const trencher = await guild.roles.fetch(ROLE_ID);
  const referral = REQUIRE_ROLE_ID ? await guild.roles.fetch(REQUIRE_ROLE_ID).catch(() => null) : null;
  const db = loadDB();
  const openTickets = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText && /^ticket:/.test(c.topic || '')).size;
  const openSupport = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText && /^support:/.test(c.topic || '')).size;
  return {
    members: guild.memberCount,
    trenchers: trencher ? trencher.members.size : 0,
    referralVerified: referral ? referral.members.size : null,
    walletsLinked: Object.keys(db).length,
    accountsLinked: new Set(Object.values(db)).size,
    openTickets, openSupport,
  };
}

function seatsLine(c) {
  return MAX_MEMBERS > 0 ? `${c.trenchers}/${MAX_MEMBERS} (${Math.max(0, MAX_MEMBERS - c.trenchers)} left)` : `${c.trenchers} (no cap)`;
}

// ── Web verifier ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health / diagnostics — safe to hit publicly, exposes no secrets.
app.get('/api/health', async (_req, res) => {
  try {
    const prices = await getPrices();
    res.json({ ok: true, minUsd: MIN_USD, verifyOpen: VERIFY_OPEN, prices });
  } catch (e) {
    res.status(503).json({ ok: false, minUsd: MIN_USD, verifyOpen: VERIFY_OPEN, error: e.message });
  }
});

// The page asks for the exact message to sign.
app.get('/api/challenge', (req, res) => {
  if (!VERIFY_OPEN) return res.status(200).json({ ok: false, error: "Verification opens at launch — it isn't live yet. Watch the RSS announcements for the drop. 🕯️" });
  const payload = readToken(req.query.token);
  if (!payload) return res.status(400).json({ ok: false, error: 'This verification link is invalid or expired. Run /verify again in Discord.' });
  res.json({ ok: true, message: challengeMessage(payload), minUsd: MIN_USD });
});

// Verify signature(s) → sum native balances in USD → grant role.
app.post('/api/verify', async (req, res) => {
  try {
    if (!VERIFY_OPEN) return res.status(200).json({ ok: false, error: "Verification isn't open yet — it unlocks at launch. Watch the RSS announcements." });

    const body = req.body || {};
    const payload = readToken(body.token);
    if (!payload) return res.status(400).json({ ok: false, error: 'Link invalid or expired. Run /verify again in Discord.' });
    if (usedNonces.has(payload.nonce)) return res.status(400).json({ ok: false, error: 'This link was already used. Run /verify again.' });

    const message = challengeMessage(payload);
    const who = `<@${payload.id}> (${payload.id})`;
    // One log line per attempt, whatever the outcome.
    const walletField = (ws) => ws.map((w) => `${w.kind === 'solana' ? 'SOL' : 'EVM'} ${short(w.address)}`).join('\n');
    const bounce = (reason, extra = []) => logEvent('fail', '❌ Verify failed', [{ name: 'Member', value: who, inline: false }, { name: 'Reason', value: reason, inline: false }, ...extra]);

    // Accept { solana:{publicKey,signature}, evm:{address,signature} }.
    // Older clients posted { publicKey, signature } at the top level — still works.
    const solanaProof = body.solana ?? (body.publicKey ? { publicKey: body.publicKey, signature: body.signature } : null);
    const evmProof = body.evm ?? null;
    if (!solanaProof && !evmProof) {
      return res.status(400).json({ ok: false, error: 'Link at least one wallet before verifying.' });
    }

    // 1) Prove ownership of every wallet the member submitted.
    const wallets = [];
    try {
      if (solanaProof) {
        const pubkey = checkSolanaProof(message, solanaProof.publicKey, solanaProof.signature);
        wallets.push({ kind: 'solana', address: pubkey.toBase58(), pubkey });
      }
      if (evmProof) {
        const address = checkEvmProof(message, evmProof.address, evmProof.signature);
        wallets.push({ kind: 'evm', address });
      }
    } catch (e) {
      bounce(`Signature check failed — ${e.message}`);
      return res.status(400).json({ ok: false, error: e.message });
    }

    // 2) One wallet per Discord account.
    const db = loadDB();
    for (const w of wallets) {
      const owner = db[dbKey(w.address)];
      if (owner && owner !== payload.id) {
        bounce(`Wallet already linked to another account: <@${owner}>`, [{ name: 'Wallets', value: walletField(wallets), inline: false }]);
        return res.status(400).json({ ok: false, error: 'One of these wallets is already linked to another Discord account.' });
      }
    }

    // 3) Price the native coins across every supported chain.
    let prices;
    try { prices = await getPrices(); }
    catch (e) {
      console.error('price feed down:', e.message);
      logEvent('warn', '⚠️ Price feed down', [{ name: 'Member', value: who, inline: false }, { name: 'Error', value: e.message, inline: false }]);
      return res.status(503).json({ ok: false, error: 'Our price feed is temporarily unreachable, so we can\'t value your wallet right now. Try again in a few minutes.' });
    }

    const holdings = [];
    const degraded = [];
    for (const w of wallets) {
      try {
        const r = w.kind === 'solana'
          ? await valueSolanaAddress(connection, w.pubkey, prices)
          : await valueEvmAddress(w.address, prices);
        holdings.push(...r.holdings);
        degraded.push(...r.failed);
      } catch (e) {
        console.error(`balance read failed for ${w.address}:`, e.message);
        logEvent('warn', '⚠️ Balance read failed', [{ name: 'Member', value: who, inline: false }, { name: 'Wallet', value: `${w.kind} ${short(w.address)}` }, { name: 'Error', value: e.message, inline: false }]);
        return res.status(503).json({ ok: false, error: 'We couldn\'t read your balance right now — the chain node is not responding. Try again in a few minutes.' });
      }
    }

    // Prices move every second and floating-point sums carry dust, so don't turn
    // someone away over a fraction of a cent at the line.
    const total = totalUsd(holdings);
    if (total < MIN_USD - 0.01) {
      bounce(`Below threshold — holds $${total.toFixed(2)}, needs ${usd(MIN_USD)}`, [
        { name: 'Wallets', value: walletField(wallets), inline: false },
        { name: 'Holdings', value: describeHoldings(holdings) || '(nothing)', inline: false },
        ...(degraded.length ? [{ name: 'Unreachable chains', value: degraded.join(', '), inline: false }] : []),
      ]);
      const detail = holdings.length ? ` (${describeHoldings(holdings)})` : '';
      const note = degraded.length ? ` We couldn't reach ${degraded.join(' and ')} just now — if you hold there, try again shortly.` : '';
      return res.status(200).json({
        ok: false,
        error: `These wallets hold about $${total.toFixed(2)}${detail} — you need ${usd(MIN_USD)} to get in. Link another wallet and try again.${note}`,
        usd: total, holdings,
      });
    }

    // 4) Grant the role (referral prerequisite + "first N free" cap) and record the wallets.
    const result = await grantRole(payload.id);
    if (result.needsPrereq) {
      bounce(`Balance OK ($${total.toFixed(2)}) but no Referral Verified role yet`, [{ name: 'Wallets', value: walletField(wallets), inline: false }]);
      return res.status(200).json({ ok: false, error: 'You still need the Referral Verified role. Open a ticket in the verify channel, post your signup screenshot, and a mod will approve you — then verify your wallet again.' });
    }
    if (result.full) {
      bounce(`Balance OK ($${total.toFixed(2)}) but all ${MAX_MEMBERS} free seats are taken`, [{ name: 'Wallets', value: walletField(wallets), inline: false }]);
      return res.status(200).json({ ok: false, error: `The first ${MAX_MEMBERS} spots are full — free entry has closed.` });
    }
    usedNonces.add(payload.nonce);
    for (const w of wallets) db[dbKey(w.address)] = payload.id;
    saveDB(db);
    getCounts().then((c) => logEvent('ok', result.already ? '✅ Re-verified (already Trencher)' : '✅ New Trencher', [
      { name: 'Member', value: who, inline: false },
      { name: 'Total', value: `$${total.toFixed(2)}` },
      { name: 'Seats', value: seatsLine(c) },
      { name: 'Wallets', value: walletField(wallets), inline: false },
      { name: 'Holdings', value: describeHoldings(holdings), inline: false },
    ])).catch((e) => console.error('log after grant failed:', e.message));
    return res.json({ ok: true, usd: total, holdings, already: result.already });
  } catch (e) {
    console.error('verify error:', e);
    return res.status(500).json({ ok: false, error: 'Something went wrong granting the role. Ping a mod.' });
  }
});

app.listen(PORT, () => console.log(`Web verifier on ${BASE_URL} (port ${PORT}) — threshold ${usd(MIN_USD)}`));

// ── Discord bot ──────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const commands = [
  new SlashCommandBuilder().setName('verify').setDescription(`Verify your wallet holds ${usd(MIN_USD)}+ on any chain and unlock the server.`),
  new SlashCommandBuilder().setName('setup').setDescription('(Admin) Post the Verify Wallet button in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('supportpanel').setDescription('(Admin) Post the "Open a Ticket" support button in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('stats').setDescription('(Admin) Live numbers: Trenchers, seats left, tickets, wallets, price feed.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket').setLabel('Submit Referral Proof').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
    new ButtonBuilder().setCustomId('verify_wallet').setLabel('Verify Wallet').setStyle(ButtonStyle.Success).setEmoji('✅'),
  );
}

// Desktop members sign up on Padre; phone members sign up on FOMO.
function referralLines() {
  const lines = [`💻 **On a PC / using a terminal →** sign up on **Padre**: ${REFERRAL_URL}`];
  if (FOMO_URL) lines.push(`📱 **On your phone →** sign up on **FOMO**: ${FOMO_URL}`);
  return lines.join('\n');
}

// A member is "staff" if they can Manage the Server (admins/mods) or hold the optional staff role.
function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (TICKET_STAFF_ROLE_ID && member.roles.cache.has(TICKET_STAFF_ROLE_ID)) return true;
  return false;
}

// Open a PRIVATE ticket channel where the member posts their referral screenshot.
async function openTicket(interaction) {
  if (!VERIFY_OPEN) return interaction.reply({ content: VERIFY_CLOSED_MSG, flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const user = interaction.user;

  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.topic === `ticket:${user.id}`,
  );
  if (existing) {
    return interaction.editReply({ content: `You already have an open ticket: <#${existing.id}> — post your screenshot there.` });
  }

  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === TICKET_CATEGORY,
  );
  if (!category) {
    category = await guild.channels.create({ name: TICKET_CATEGORY, type: ChannelType.GuildCategory });
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (TICKET_STAFF_ROLE_ID) {
    overwrites.push({ id: TICKET_STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: (`verify-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '') || `verify-${user.id}`).slice(0, 90),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `ticket:${user.id}`,
    permissionOverwrites: overwrites,
  });

  const embed = new EmbedBuilder()
    .setTitle('🎫 Referral verification')
    .setDescription(
      `Welcome <@${user.id}>!\n\n` +
      `Pick the one that matches how you trade:\n\n${referralLines()}\n\n` +
      `Then post a **screenshot of your signup** right here. A mod will review it and grant you ` +
      `**Referral Verified** — after that you can verify your wallet.\n\n` +
      `⚠️ You only ever **sign a message** later — never approve a transaction, never share your seed phrase.`,
    )
    .setColor(0x2dd478);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('approve_ticket').setLabel('Approve (Referral Verified)').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
  await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [row] });
  logEvent('info', '🎫 Referral ticket opened', [{ name: 'Member', value: `<@${user.id}> (${user.id})` }, { name: 'Channel', value: `<#${channel.id}>` }]);
  return interaction.editReply({ content: `✅ Your private ticket is open: <#${channel.id}> — post your screenshot there.` });
}

// Staff clicks Approve → grants Referral Verified to the ticket's owner.
async function approveTicket(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: 'Only staff can approve tickets.', flags: MessageFlags.Ephemeral });
  }
  const topic = interaction.channel?.topic || '';
  const openerId = topic.startsWith('ticket:') ? topic.slice(7) : null;
  if (!openerId) {
    return interaction.reply({ content: 'This does not look like a verification ticket.', flags: MessageFlags.Ephemeral });
  }
  if (!REQUIRE_ROLE_ID) {
    return interaction.reply({ content: 'No Referral Verified role is configured (REQUIRE_ROLE_ID).', flags: MessageFlags.Ephemeral });
  }
  const member = await interaction.guild.members.fetch(openerId).catch(() => null);
  if (!member) {
    return interaction.reply({ content: 'That member seems to have left the server.', flags: MessageFlags.Ephemeral });
  }
  await member.roles.add(REQUIRE_ROLE_ID, 'Referral proof approved via ticket');
  logEvent('ok', '🟢 Referral approved', [{ name: 'Member', value: `<@${openerId}> (${openerId})` }, { name: 'Approved by', value: `<@${interaction.user.id}>` }]);
  return interaction.reply({ content: `✅ Approved — <@${openerId}> now has **Referral Verified** and can hit **Verify Wallet** to finish. You can close this ticket.` });
}

// Staff clicks Close → deletes the ticket channel.
async function closeTicket(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: 'Only staff can close tickets.', flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ content: '🔒 Closing this ticket in 5 seconds…' });
  logEvent('info', '🔒 Ticket closed', [{ name: 'Channel', value: `#${interaction.channel?.name}` }, { name: 'Closed by', value: `<@${interaction.user.id}>` }]);
  setTimeout(() => interaction.channel?.delete('Ticket closed').catch(() => {}), 5000);
}

// Open a general-purpose SUPPORT ticket (any reason). Private channel, staff can close.
async function openSupportTicket(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const user = interaction.user;

  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.topic === `support:${user.id}`,
  );
  if (existing) {
    return interaction.editReply({ content: `You already have an open ticket: <#${existing.id}>.` });
  }

  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === SUPPORT_CATEGORY,
  );
  if (!category) {
    category = await guild.channels.create({ name: SUPPORT_CATEGORY, type: ChannelType.GuildCategory });
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (TICKET_STAFF_ROLE_ID) {
    overwrites.push({ id: TICKET_STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: (`ticket-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '') || `ticket-${user.id}`).slice(0, 90),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `support:${user.id}`,
    permissionOverwrites: overwrites,
  });

  const embed = new EmbedBuilder()
    .setTitle('🎫 Support ticket')
    .setDescription(
      `Hey <@${user.id}> — describe your question or issue here and a mod will help you out.\n\n` +
      `⚠️ Mods will never DM you first or ask for your seed phrase or a wallet transaction.`,
    )
    .setColor(0x5865f2);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
  await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [row] });
  return interaction.editReply({ content: `✅ Ticket opened: <#${channel.id}> — a mod will be with you shortly.` });
}

async function sendLink(interaction) {
  if (!VERIFY_OPEN) return interaction.reply({ content: VERIFY_CLOSED_MSG, flags: MessageFlags.Ephemeral });
  const url = `${BASE_URL}/?token=${makeToken(interaction.user.id)}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Open Verification Page').setStyle(ButtonStyle.Link).setURL(url).setEmoji('🔗'),
  );
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content:
      `Tap the button below to verify your wallet. **This link is private to you and expires in 10 minutes.**\n\n` +
      `You need **${usd(MIN_USD)}+ in native coins** — SOL, ETH or BNB, on Solana, Ethereum, Base, Arbitrum or BNB Chain. ` +
      `You can link a Solana wallet, an EVM wallet, or both, and we add them up.\n\n` +
      `You'll connect your wallet and **sign a message** — read-only, it never moves funds. ` +
      `We never ask for your seed phrase and never request a transaction.`,
    components: [row],
  });
}

client.once('clientReady', async () => {
  console.log(`Bot online as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
  if (LOG_CHANNEL_ID) {
    getCounts().then((c) => logEvent('info', '🟢 Bot online', [
      { name: 'Trenchers (seats)', value: seatsLine(c) },
      { name: 'Verification', value: VERIFY_OPEN ? `open · ${usd(MIN_USD)}` : 'closed' },
    ])).catch(() => {});
  } else {
    console.warn('LOG_CHANNEL_ID not set — verify attempts will not be posted to Discord.');
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'verify') return sendLink(interaction);
    if (interaction.isButton() && interaction.customId === 'verify_wallet') return sendLink(interaction);
    if (interaction.isButton() && interaction.customId === 'open_ticket') return openTicket(interaction);
    if (interaction.isButton() && interaction.customId === 'open_support') return openSupportTicket(interaction);
    if (interaction.isButton() && interaction.customId === 'approve_ticket') return approveTicket(interaction);
    if (interaction.isButton() && interaction.customId === 'close_ticket') return closeTicket(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === 'stats') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const c = await getCounts();
      let feed;
      try { const p = await getPrices(); feed = `✅ SOL $${p.solana.toFixed(2)} · ETH $${p.ethereum.toFixed(0)} · BNB $${p.binancecoin.toFixed(0)}`; }
      catch (e) { feed = `❌ down — ${e.message.slice(0, 120)}`; }
      const embed = new EmbedBuilder()
        .setTitle('📊 RSS live stats')
        .setColor(0x2dd478)
        .addFields(
          { name: 'Trenchers (seats)', value: seatsLine(c), inline: true },
          { name: 'Server members', value: String(c.members), inline: true },
          { name: 'Referral Verified', value: c.referralVerified === null ? 'n/a' : String(c.referralVerified), inline: true },
          { name: 'Wallets linked', value: `${c.walletsLinked} wallets · ${c.accountsLinked} accounts`, inline: true },
          { name: 'Open tickets', value: `${c.openTickets} verification · ${c.openSupport} support`, inline: true },
          { name: 'Verification', value: VERIFY_OPEN ? `🟢 open · threshold ${usd(MIN_USD)}` : '🔒 closed', inline: true },
          { name: 'Price feed', value: feed, inline: false },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'supportpanel') {
      const embed = new EmbedBuilder()
        .setTitle('🎫 Need help?')
        .setDescription('Open a private ticket for any reason — a question, a problem, a report, or a partnership. Tap the button below and a mod will help you.')
        .setColor(0x5865f2);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_support').setLabel('Open a Ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
      );
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: 'Posted the support panel.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      const embed = new EmbedBuilder()
        .setTitle('✅ Get verified to enter')
        .setDescription(
          `**Step 1 — Referral proof.** Tap **🎫 Submit Referral Proof** to open a private ticket.\n\n${referralLines()}\n\n` +
          `Drop a screenshot of your signup in the ticket and a mod approves you for **Referral Verified**.\n\n` +
          `**Step 2 — Wallet check.** Tap **✅ Verify Wallet**, connect your wallet, and **sign a message** ` +
          `(read-only — never a transaction) to prove you hold **${usd(MIN_USD)}+ in native coins**.\n` +
          `Any chain counts: **SOL** on Solana, **ETH** on Ethereum / Base / Arbitrum, **BNB** on BNB Chain. ` +
          `Link a Solana wallet, an EVM wallet, or both — we add them together. You'll get **Trencher** automatically.\n\n` +
          `⚠️ You only ever sign a message. Never approve a transaction, never share your seed phrase. Mods never DM first.`,
        )
        .setColor(0x2dd478);
      await interaction.channel.send({ embeds: [embed], components: [panelRow()] });
      await interaction.reply({ content: 'Posted the verification panel.', flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    console.error('interaction error:', e);
    if (interaction.isRepliable() && !interaction.replied) {
      interaction.reply({ content: 'Something went wrong — try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// DRY_RUN=true runs only the web verifier — handy for previewing/styling the
// verify page locally without Discord credentials. Role granting is disabled.
if (DRY_RUN) {
  console.log('DRY_RUN=true — Discord is not connected. The verify page is served, but no roles can be granted.');
} else {
  client.login(DISCORD_TOKEN).catch((e) => {
    console.error(`\nFATAL: Discord login failed — ${e.message}`);
    console.error('Check DISCORD_TOKEN. If you regenerated it in the Developer Portal, update it on Render and redeploy.\n');
    process.exit(1);
  });
}
