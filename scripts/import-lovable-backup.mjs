#!/usr/bin/env node
// Imports the Lovable Cloud (Supabase/Postgres) backup into MongoDB.
//
// 1. Turn the .backup file into plain SQL (needs pg_restore 18, e.g. via Docker):
//      docker run --rm -v "C:\path\to\folder:/dump" postgres:18 pg_restore --data-only -f /dump/data.sql /dump/<name>.backup
// 2. Preview, then import (reads MONGODB_URI / MONGODB_DB from .env.local):
//      node --env-file=.env.local scripts/import-lovable-backup.mjs C:\path\to\folder\data.sql --dry-run
//      node --env-file=.env.local scripts/import-lovable-backup.mjs C:\path\to\folder\data.sql
//
// Safe to run more than once: every row is upserted by its key, so a second run
// updates instead of duplicating. User IDs and bcrypt password hashes are kept,
// so people sign in with their existing passwords and memberships stay linked.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const [file, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
if (!file) {
  console.error('Usage: node --env-file=.env.local scripts/import-lovable-backup.mjs <data.sql> [--dry-run]');
  process.exit(1);
}

/** Parses every `COPY schema.table (cols) FROM stdin;` block of a pg_restore plain-SQL file. */
export function parseCopyBlocks(sql) {
  const tables = new Map();
  const lines = sql.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = /^COPY ([\w."]+) \(([^)]*)\) FROM stdin;$/.exec(lines[i]);
    if (!head) continue;
    const name = head[1].replaceAll('"', '');
    const columns = head[2].split(',').map((c) => c.trim().replaceAll('"', ''));
    const rows = [];
    for (i++; i < lines.length && lines[i] !== '\\.'; i++) {
      const values = lines[i].split('\t').map(unescapeCopy);
      rows.push(Object.fromEntries(columns.map((c, j) => [c, values[j] ?? null])));
    }
    tables.set(name, rows);
  }
  return tables;
}

/** Postgres COPY text format: \N is NULL; backslash escapes for control characters. */
function unescapeCopy(value) {
  if (value === '\\N') return null;
  return value.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/g, (_, oct, hex, ch) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[ch] ?? ch;
  });
}

/** "2026-11-12 10:09:10.123+00" -> Date */
function ts(value) {
  if (value === null || value === undefined || value === '') return null;
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Unreadable timestamp: ${value}`);
  return date;
}
const int = (v) => (v === null ? 0 : Number.parseInt(v, 10));
const lower = (v) => (v ?? '').trim().toLowerCase();

const tables = parseCopyBlocks(readFileSync(file, 'utf8'));
const rows = (name) => tables.get(name) ?? [];
if (!tables.has('auth.users') || !tables.has('public.sub_accounts')) {
  console.error('This file has no auth.users or public.sub_accounts data. Run pg_restore with --data-only on the whole backup.');
  process.exit(1);
}

// ---- Better Auth users + credential accounts (same UUIDs, same bcrypt hashes) ----
const users = [];
const accounts = [];
for (const u of rows('auth.users')) {
  if (!u.email || u.deleted_at || u.is_anonymous === 't') continue;
  let meta = {};
  try { meta = JSON.parse(u.raw_user_meta_data ?? '{}') ?? {}; } catch { /* ignore */ }
  const createdAt = ts(u.created_at) ?? new Date();
  const updatedAt = ts(u.updated_at) ?? createdAt;
  const email = lower(u.email);
  users.push({ _id: u.id, name: meta.full_name || meta.name || email.split('@')[0], email, emailVerified: !!u.email_confirmed_at, image: null, createdAt, updatedAt });
  if (u.encrypted_password) {
    accounts.push({ accountId: u.id, providerId: 'credential', userId: u.id, password: u.encrypted_password, createdAt, updatedAt });
  }
}

// ---- Application data: same field names as the Postgres columns ----
const data = {
  agencies: rows('public.agencies').map((r) => ({ id: r.id, name: r.name, created_at: ts(r.created_at) })),
  agency_memberships: rows('public.agency_memberships').map((r) => ({ agency_id: r.agency_id, user_id: r.user_id, role: r.role })),
  sub_accounts: rows('public.sub_accounts').map((r) => ({
    id: r.id, agency_id: r.agency_id, client_id: r.client_id, name: r.name, timezone: r.timezone || 'Europe/London',
    monthly_video_limit: int(r.monthly_video_limit), created_at: ts(r.created_at),
  })),
  sub_account_memberships: rows('public.sub_account_memberships').map((r) => ({
    sub_account_id: r.sub_account_id, user_id: r.user_id, role: r.role, revoked_at: ts(r.revoked_at),
  })),
  sub_account_invitations: rows('public.sub_account_invitations').map((r) => ({
    id: r.id, sub_account_id: r.sub_account_id, email: lower(r.email), role: r.role, token_hash: r.token_hash, invited_by: r.invited_by,
    expires_at: ts(r.expires_at), accepted_at: ts(r.accepted_at), revoked_at: ts(r.revoked_at), created_at: ts(r.created_at),
  })),
  sub_account_jobs: rows('public.sub_account_jobs').map((r) => ({ job_id: r.job_id, sub_account_id: r.sub_account_id, created_at: ts(r.created_at) })),
  video_reservations: rows('public.video_reservations').map((r) => ({
    id: r.id, sub_account_id: r.sub_account_id, user_id: r.user_id, month_key: r.month_key, requested: int(r.requested), charged: int(r.charged),
    job_id: r.job_id, state: r.state, created_at: ts(r.created_at),
  })),
};
const keys = {
  agencies: ['id'], agency_memberships: ['agency_id', 'user_id'], sub_accounts: ['id'], sub_account_memberships: ['sub_account_id', 'user_id'],
  sub_account_invitations: ['id'], sub_account_jobs: ['job_id'], video_reservations: ['id'],
};

console.log(`Found in backup: ${users.length} users (${accounts.length} with passwords)`);
for (const [name, docs] of Object.entries(data)) console.log(`  ${name}: ${docs.length}`);
const unverified = users.filter((u) => !u.emailVerified).length;
if (unverified) console.log(`Note: ${unverified} user(s) never confirmed their email; they must confirm before signing in.`);

// Every membership must point at a user that exists, or that person would silently lose access.
const userIds = new Set(users.map((u) => u._id));
const orphans = [...data.agency_memberships, ...data.sub_account_memberships].filter((m) => !userIds.has(m.user_id));
if (orphans.length) console.warn(`Warning: ${orphans.length} membership row(s) point at users missing from the backup.`);

if (dryRun) {
  console.log('Dry run: nothing was written.');
  process.exit(0);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Run with: node --env-file=.env.local ...');
  process.exit(1);
}
const client = new MongoClient(uri, { appName: 'mavera-import' });
try {
  const db = client.db(process.env.MONGODB_DB || 'mavera');
  if (users.length) {
    await db.collection('user').bulkWrite(users.map((u) => ({ replaceOne: { filter: { _id: u._id }, replacement: u, upsert: true } })), { ordered: false });
  }
  if (accounts.length) {
    // Keep an existing account _id on re-runs; only new rows get a fresh UUID.
    await db.collection('account').bulkWrite(accounts.map((a) => ({
      updateOne: { filter: { userId: a.userId, providerId: 'credential' }, update: { $set: a, $setOnInsert: { _id: randomUUID() } }, upsert: true },
    })), { ordered: false });
  }
  for (const [name, docs] of Object.entries(data)) {
    if (!docs.length) continue;
    await db.collection(name).bulkWrite(docs.map((doc) => ({
      updateOne: { filter: Object.fromEntries(keys[name].map((k) => [k, doc[k]])), update: { $set: doc }, upsert: true },
    })), { ordered: false });
  }
  console.log('Import finished.');
  for (const name of ['user', 'account', ...Object.keys(data)]) {
    console.log(`  ${name}: ${await db.collection(name).countDocuments()} documents in MongoDB`);
  }
} finally {
  await client.close();
}
