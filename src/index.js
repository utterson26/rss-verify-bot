// Restless Spirits Society — native-SOL verification bot
// One Node process runs BOTH the Discord bot and a small web verifier.
//
// Flow:
//   1) A member runs /verify (or clicks the Verify button) in Discord.
//   2) The bot DMs them an ephemeral, one-time link to the web verifier.
//   3) On that page they connect Phantom and SIGN A MESSAGE (read-only — never a transaction).
//   4) The server verifies the signature, reads the wallet's NATIVE SOL balance via RPC,
//      and if it's >= MIN_SOL it grants the Trencher role.
//
// Security notes:
//   • Users only ever signMessage(). No transaction is ever requested. No seed phrase is ever asked for.
//   • The link carries an HMAC-signed, 10-minute, single-use token bound to the Discord user ID,
//     so one person can't verify on behalf of another.
//   • Each wallet can only be used by one Discord account (stored in data/verified.json).

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, PermissionFlagsBits, MessageFlags,
} from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────
const {
  DISCORD_TOKEN, GUILD_ID, ROLE_ID, VERIFY_CHANNEL_ID,
  REQUIRE_ROLE_ID,                  // optional: member must already have this role (e.g. "Referral Verified")
  RPC_URL = 'https://api.mainnet-beta.solana.com',
  BASE_URL = 'http://localhost:3000',
  SESSION_SECRET = 'change-me',
  PORT = 3000,
} = process.env;
const MIN_SOL = Number(process.env.MIN_SOL ?? 10);
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS ?? 100); // 0 = unlimited ("first N free")

for (const [k, v] of Object.entries({ DISCORD_TOKEN, GUILD_ID, ROLE_ID })) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
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
const TTL_MS = 10 * 60 * 1000;
const usedNonces = new Set();
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function hmac(data) { return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url'); }

function makeToken(discordId) {
  const payload = { id: discordId, nonce: crypto.randomBytes(12).toString('hex'), exp: Date.now() + TTL_MS };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}
function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(body)))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload?.id || !payload?.nonce || !payload?.exp) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}
// The exact text the user signs. Rebuilt server-side so the client can't tamper with it.
function challengeMessage({ id, nonce }) {
  return [
    'Restless Spirits Society — wallet verification',
    '',
    `Discord ID: ${id}`,
    `Nonce: ${nonce}`,
    '',
    'Signing this only proves you own this wallet.',
    'It is a read-only signature and can never move your funds.',
  ].join('\n');
}

// ── Grant the role in Discord ───────────────────────────────────────────────
// Returns { granted, already, full }. Enforces the "first N members free" cap.
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
  await member.roles.add(ROLE_ID, 'Verified 10+ native SOL (+ referral)');
  return { granted: true };
}

// ── Web verifier ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// The page asks for the exact message to sign.
app.get('/api/challenge', (req, res) => {
  const payload = readToken(req.query.token);
  if (!payload) return res.status(400).json({ ok: false, error: 'This verification link is invalid or expired. Run /verify again in Discord.' });
  res.json({ ok: true, message: challengeMessage(payload), minSol: MIN_SOL });
});

// Verify signature → check balance → grant role.
app.post('/api/verify', async (req, res) => {
  try {
    const { token, publicKey, signature } = req.body || {};
    const payload = readToken(token);
    if (!payload) return res.status(400).json({ ok: false, error: 'Link invalid or expired. Run /verify again in Discord.' });
    if (usedNonces.has(payload.nonce)) return res.status(400).json({ ok: false, error: 'This link was already used. Run /verify again.' });

    // 1) Verify the wallet actually signed our exact message.
    let pubkey, ok;
    try {
      const msg = new TextEncoder().encode(challengeMessage(payload));
      pubkey = new PublicKey(publicKey);
      ok = nacl.sign.detached.verify(msg, bs58.decode(signature), pubkey.toBytes());
    } catch { ok = false; }
    if (!ok) return res.status(400).json({ ok: false, error: 'Signature check failed. Make sure you signed with the wallet you connected.' });

    // 2) One wallet per Discord account.
    const db = loadDB();
    const owner = db[publicKey];
    if (owner && owner !== payload.id) {
      return res.status(400).json({ ok: false, error: 'This wallet is already linked to another Discord account.' });
    }

    // 3) Read NATIVE SOL balance.
    const lamports = await connection.getBalance(pubkey, 'confirmed');
    const sol = lamports / LAMPORTS_PER_SOL;
    if (sol < MIN_SOL) {
      return res.status(200).json({ ok: false, error: `This wallet holds ${sol.toFixed(3)} SOL — you need at least ${MIN_SOL}.`, sol });
    }

    // 4) Grant the role (referral prerequisite + "first N free" cap) and record the wallet.
    const result = await grantRole(payload.id);
    if (result.needsPrereq) {
      return res.status(200).json({ ok: false, error: 'You still need the Referral Verified role. Post your Padre signup screenshot in #verify, wait for a mod to approve you, then run /verify again.' });
    }
    if (result.full) {
      return res.status(200).json({ ok: false, error: `The first ${MAX_MEMBERS} spots are full — free entry has closed.` });
    }
    usedNonces.add(payload.nonce);
    db[publicKey] = payload.id;
    saveDB(db);
    return res.json({ ok: true, sol, already: result.already });
  } catch (e) {
    console.error('verify error:', e);
    return res.status(500).json({ ok: false, error: 'Something went wrong granting the role. Ping a mod.' });
  }
});

app.listen(PORT, () => console.log(`Web verifier on ${BASE_URL} (port ${PORT})`));

// ── Discord bot ──────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const commands = [
  new SlashCommandBuilder().setName('verify').setDescription('Verify your Solana wallet holds 10+ SOL and unlock the server.'),
  new SlashCommandBuilder().setName('setup').setDescription('(Admin) Post the Verify Wallet button in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

function verifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_wallet').setLabel('Verify Wallet').setStyle(ButtonStyle.Success).setEmoji('✅'),
  );
}
async function sendLink(interaction) {
  const url = `${BASE_URL}/?token=${makeToken(interaction.user.id)}`;
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content:
      `**Verify your wallet** (link expires in 10 minutes, only you can see this):\n${url}\n\n` +
      `You'll connect your wallet and **sign a message** — this is read-only and never moves funds. ` +
      `We never ask for your seed phrase and never request a transaction.`,
  });
}

client.once('clientReady', async () => {
  console.log(`Bot online as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'verify') return sendLink(interaction);
    if (interaction.isButton() && interaction.customId === 'verify_wallet') return sendLink(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      const embed = new EmbedBuilder()
        .setTitle('✅ Verify to enter')
        .setDescription(`Click below, connect your Solana wallet, and **sign a message** (read-only — never a transaction) to prove you hold **${MIN_SOL}+ SOL**. You'll get the Trencher role automatically.`)
        .setColor(0x2dd478);
      await interaction.channel.send({ embeds: [embed], components: [verifyRow()] });
      await interaction.reply({ content: 'Posted the Verify button.', flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    console.error('interaction error:', e);
    if (interaction.isRepliable() && !interaction.replied) {
      interaction.reply({ content: 'Something went wrong — try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
