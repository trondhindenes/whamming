// Seed a running Whamming with fake sessions so you can see the UI. Usage: npm run demo
const BASE = process.env.WHAMMING_URL || `http://127.0.0.1:${process.env.WHAMMING_PORT || 4477}`;
// Neutral example paths (also used for the README screenshots).
const P = '/Users/you/projects';

const put = (id, body) =>
  fetch(`${BASE}/api/sessions/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

await put('api-auth', { folder: `${P}/storefront-api`, branch: 'eng-412-oauth-refresh', agent: 'claude-code', status: 'working',
  title: 'Refresh OAuth tokens before expiry', links: [{ url: 'https://linear.app/acme/issue/ENG-412/refresh-tokens' }] });
await put('api-auth', { note: 'Added token refresh middleware, writing tests' });
await put('api-flaky', { folder: `${P}/storefront-api`, branch: 'fix/flaky-checkout-test', agent: 'claude-code', status: 'waiting',
  title: 'Fix flaky checkout integration test', detail: 'The test depends on a shared Stripe sandbox. Should I mock Stripe entirely, or keep the sandbox and add retries?',
  links: [{ url: 'https://github.com/acme/storefront-api/issues/981' }] });
await put('web-a11y', { folder: `${P}/storefront-web`, branch: 'eng-398-a11y-nav', agent: 'claude-code', status: 'working',
  title: 'Keyboard navigation for mega menu', links: [{ url: 'https://linear.app/acme/issue/ENG-398/a11y-nav' }, { url: 'https://github.com/acme/storefront-web/pull/1204' }] });
await put('web-deps', { folder: `${P}/storefront-web`, branch: 'chore/deps', agent: 'claude-code', status: 'idle',
  title: 'Bump React Router to v8', links: [{ url: 'https://github.com/acme/storefront-web/pull/1199' }] });
await put('infra-dns', { folder: `${P}/infra`, branch: 'main', agent: 'pi', status: 'error',
  title: 'Migrate DNS zone to new provider', detail: 'pulumi up failed: zone already exists in target account. Needs manual cleanup.' });
await put('docs-adr', { folder: `${P}/infra/docs`, agent: 'claude-code', status: 'done', title: 'Write ADR for secrets rotation',
  links: [{ url: 'https://github.com/acme/infra/pull/77' }] });

await fetch(`${BASE}/api/sessions/api-flaky/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ from: 'api-auth', body: 'Heads up: I am touching src/payments/client.ts for token refresh, avoid editing it for now.' }) });

const task = (id, key, body) =>
  fetch(`${BASE}/api/sessions/${id}/tasks/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
await task('web-a11y', 'audit-aria', { title: 'Audit ARIA roles in nav components', status: 'working' });
await task('web-a11y', 'voiceover', { title: 'VoiceOver pass on the mega menu', status: 'working', detail: 'Checking focus order' });
await task('web-a11y', 'lint-a11y', { title: 'Fix jsx-a11y lint warnings', status: 'done' });

console.log(`Seeded demo sessions into ${BASE}`);
