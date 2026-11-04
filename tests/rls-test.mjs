// Checks supabase.sql in a throwaway in-memory Postgres (PGlite): each person sees and changes only their own rows.
// Usage (from a folder where `npm i @electric-sql/pglite` was run):  node rls-test.mjs ../supabase.sql
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const sql = fs.readFileSync(process.argv[2] || '../supabase.sql', 'utf8');
const db = new PGlite();
let failed = false;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' -> ' + extra : '')); if (!cond) failed = true; };
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';

// stand-ins for what Supabase already provides
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  insert into auth.users values ('${A}'), ('${B}');
`);
await db.exec(sql);
await db.exec(sql);   // running it twice must be fine
ok('setup script runs twice without errors', true);

const as = async (uid, role = 'authenticated') => {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ''}', false); set role ${role};`);
};
const tryq = async (q, params) => { try { return { r: await db.query(q, params) }; } catch (e) { return { e: e.message }; } };

await as(A);
let x = await tryq(`insert into public.docs (id, data) values ('b1', '{"name":"Rent"}')`);
ok('A can add a bill (user_id filled in automatically)', !x.e, x.e);
x = await tryq(`insert into public.docs (user_id, id, data) values ('${B}', 'evil', '{}')`);
ok('A cannot add a row for B', !!x.e && /row-level security/.test(x.e), x.e);

await as(B);
await tryq(`insert into public.docs (id, data) values ('b1', '{"name":"B rent"}')`);
x = await tryq(`select user_id, id, data from public.docs`);
ok('B sees only B’s rows', x.r && x.r.rows.length === 1 && x.r.rows[0].user_id === B && x.r.rows[0].data.name === 'B rent', JSON.stringify(x.r && x.r.rows));
x = await tryq(`update public.docs set data = '{"name":"hacked"}' where user_id = '${A}'`);
ok('B cannot change A’s rows', x.r && x.r.affectedRows === 0, JSON.stringify(x.r && x.r.affectedRows) + (x.e || ''));
x = await tryq(`delete from public.docs where user_id = '${A}'`);
ok('B cannot delete A’s rows', x.r && x.r.affectedRows === 0);
x = await tryq(`insert into public.docs (user_id, id, data) values ('${A}', 'b1', '{"name":"steal"}') on conflict (user_id, id) do update set data = excluded.data`);
ok('B cannot take over A’s row with an upsert', !!x.e, x.e);

await as(A);
x = await tryq(`select id, data from public.docs`);
ok('A still has the original, unchanged row', x.r && x.r.rows.length === 1 && x.r.rows[0].data.name === 'Rent', JSON.stringify(x.r && x.r.rows));
x = await tryq(`insert into public.docs (user_id, id, data) values ('${A}', 'b1', '{"name":"Rent 2"}') on conflict (user_id, id) do update set data = excluded.data`);
ok('A can edit own bill with an upsert (what the app does)', !x.e, x.e);
x = await tryq(`select data from public.docs`);
ok('editing updates the row', x.r && x.r.rows[0].data.name === 'Rent 2', JSON.stringify(x.r && x.r.rows));
x = await tryq(`delete from public.docs where id = 'b1'`);
ok('A can delete own bill', x.r && x.r.affectedRows === 1);

x = await tryq(`insert into public.docs (id, data) values ('${'x'.repeat(65)}', '{}')`);
ok('over-long ids are refused', !!x.e, x.e);
x = await tryq(`insert into public.docs (id, data) values ('arr', '[1,2]')`);
ok('data must be an object', !!x.e, x.e);
x = await tryq(`insert into public.docs (id, data) values ('big', jsonb_build_object('s', repeat('a', 25000)))`);
ok('huge documents are refused', !!x.e, x.e);

await as(null, 'anon');
x = await tryq(`select * from public.docs`);
ok('not signed in: no access to read', !!x.e, x.e);
x = await tryq(`insert into public.docs (user_id, id, data) values ('${A}', 'anon1', '{}')`);
ok('not signed in: no access to write', !!x.e, x.e);

await db.exec('reset role');
x = await tryq(`select count(*)::int as n from public.docs`);
ok('B’s row survived everything above', x.r.rows[0].n === 1, JSON.stringify(x.r.rows));
await db.exec(`delete from auth.users where id = '${B}'`);
x = await tryq(`select count(*)::int as n from public.docs`);
ok('deleting an account removes its rows', x.r.rows[0].n === 0, JSON.stringify(x.r.rows));

process.exit(failed ? 1 : 0);
