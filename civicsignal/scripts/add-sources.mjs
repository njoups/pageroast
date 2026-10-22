// Adds RSS/Atom feeds to your CivicSignal organization, enables them and starts a first collection (local laptop use).
//   CS_URLS="https://a/rss https://b/feed" docker compose exec -T -e CS_EMAIL=you@example.test -e CS_PW="$CS_PW" -e CS_URLS api node --input-type=module - < scripts/add-sources.mjs
// Runs inside the api container: it talks to the API directly and acts only as the account you log in with.
const URLS = (process.env.CS_URLS ?? '').split(/\s+/).filter(Boolean);
const API = 'http://localhost:4000/api/v1';
const ORIGIN = (process.env.APP_ORIGINS ?? 'http://localhost:3000').split(',')[0].trim();
const BASIS = 'Uji coba internal di laptop lokal; ketentuan penerbit belum ditinjau.';
const h = { 'content-type': 'application/json', origin: ORIGIN };

const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: process.env.CS_EMAIL, password: process.env.CS_PW }) });
if (login.status !== 200) { console.log(`Login gagal (HTTP ${login.status}). Cek email/password.`); process.exit(1); }
const cookie = (login.headers.getSetCookie().find((c) => /cs_session=/.test(c)) ?? '').split(';')[0];
const me = await (await fetch(`${API}/auth/me`, { headers: { cookie } })).json();
const org = me.organizations?.[0];
if (!org) { console.log('Akun ini belum punya organisasi.'); process.exit(1); }
console.log(`Organisasi: ${org.name} (peran: ${org.role})\n`);

let ok = 0;
for (const url of URLS) {
  let host; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { console.log(`✗ ${url}  → bukan URL yang valid`); continue; }
  const name = `${host} ${new URL(url).pathname}`.slice(0, 120).trim();
  const r = await fetch(`${API}/organizations/${org.id}/sources`, { method: 'POST', headers: { ...h, cookie }, body: JSON.stringify({
    kind: 'feed', name, feedUrl: url, authorizationStatus: 'authorized', authorizationBasis: BASIS,
    permittedFields: ['title', 'url', 'published_at', 'excerpt'] }) });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 201) { console.log(`✗ ${url}  → ${body?.error?.message ?? 'HTTP ' + r.status}`); continue; }
  const en = await fetch(`${API}/organizations/${org.id}/sources/${body.id}/enable`, { method: 'POST', headers: { ...h, cookie } });
  const col = await fetch(`${API}/organizations/${org.id}/sources/${body.id}/collect`, { method: 'POST', headers: { ...h, cookie } });
  console.log(`✓ ${url}  (aktif: ${en.status === 200 ? 'ya' : 'HTTP ' + en.status}, pengambilan pertama: ${col.status === 202 ? 'dijadwalkan' : 'HTTP ' + col.status})`);
  ok++;
}
console.log(`\n${ok}/${URLS.length} sumber ditambahkan. Cek status di menu Sources dalam 1-2 menit.`);
