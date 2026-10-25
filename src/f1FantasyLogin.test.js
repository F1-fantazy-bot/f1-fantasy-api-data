const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');

const FANTASY = 'https://fantasy.formula1.com';
const IDENTITY = 'https://id.formula1.com';
const STATE = 'private-dynamic-authorization-state';
const EMAIL = 'fixture@example.invalid';
const PASSWORD = 'private-fixture-password';
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

// Real Chromium, but every request is intercepted, including unexpected hosts.
// Only human pacing and failure timeouts are shortened; DOM/actionability,
// redirects, form submission, cookies, and in-page fetch all run in the browser.
function pacedLocator(locator) {
  return new Proxy(locator, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (['waitFor', 'click', 'textContent'].includes(key)) {
          args[0] = { ...args[0], timeout: 1200 };
        }
        const result = value.apply(target, args);
        return ['Locator', 'FrameLocator'].includes(result?.constructor?.name)
          ? pacedLocator(result)
          : result;
      };
    },
  });
}

function pacedPage(page) {
  return new Proxy(page, {
    get(target, key) {
      if (key === 'waitForTimeout')
        return (ms) => target.waitForTimeout(Math.min(ms, 25));
      if (key === 'waitForURL')
        return (url, options) =>
          target.waitForURL(url, { ...options, timeout: 1200 });
      if (key === 'keyboard')
        return { type: (text) => target.keyboard.type(text, { delay: 1 }) };
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        return ['Locator', 'FrameLocator'].includes(result?.constructor?.name)
          ? pacedLocator(result)
          : result;
      };
    },
  });
}

function consentMarkup({ redirect = false, delay = 0 } = {}) {
  return `<script>
    window.addEventListener('message', e => {
      if (e.data !== 'accepted') return;
      document.querySelector('iframe').remove();
      ${redirect ? `location.href = '${IDENTITY}/authorize?state=${STATE}';` : ''}
    });
    setTimeout(() => {
      const frame = document.createElement('iframe');
      frame.title = 'SP Consent Message';
      frame.src = 'https://consent.fixture.invalid/';
      frame.style = 'position:fixed;inset:0;width:100%;height:100%;z-index:999;background:white';
      document.body.append(frame);
    }, ${delay});
  </script>`;
}

function loginMarkup(legacy = false, delayedConsent = false) {
  const name = legacy ? 'Login' : 'username';
  return `<button onclick="location.href='https://unexpected.fixture.invalid/'">Sign In</button>
    <form id="${legacy ? 'legacyLogin' : 'loginForm'}" method="post"
      action="${IDENTITY}/submit?state=${STATE}">
      <label for="email">Email address</label><input id="email" name="${name}">
      <button type="button">Intervening control</button>
      <label for="password">Password</label><input id="password" name="password" type="password">
      <button type="submit">Sign In</button>
    </form>
    ${delayedConsent ? consentMarkup({ delay: 40 }) : ''}`;
}

async function fixture(t, options = {}) {
  const context = await browser.newContext({
    offline: true,
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(1500);
  await context.addInitScript(() => {
    globalThis.__fixtureFetches = [];
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      globalThis.__fixtureFetches.push({ url, ...options });
      return fetch(url, options);
    };
  });
  const counts = {
    launches: 0,
    sessions: 0,
    submissions: 0,
    fantasy: 0,
    closes: 0,
  };
  const unexpected = [];
  let submitted;
  const session = Object.hasOwn(options, 'session')
    ? options.session
    : { GUID: 'opaque-session-0-123' };
  await context.route('**/*', async (route) => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      const html = (body) => route.fulfill({ contentType: 'text/html', body });
      // Fulfilled HTTP redirects bypass Playwright routing for the next hop.
      // Use browser redirects so every hop remains intercepted with networking offline.
      const redirect = (location) =>
        html(`<script>location.replace(${JSON.stringify(location)})</script>`);
      if (url.hostname === 'consent.fixture.invalid') {
        return html(
          "<button onclick=\"parent.postMessage('accepted', '*')\">ACCEPT ALL</button>",
        );
      }
      if (url.hostname === 'account.formula1.com') {
        assert.match(request.url(), /account\.formula1\.com\//);
        if (options.navigationFailure) return route.abort('failed');
        if (options.legacy) return html(loginMarkup(true));
        if (
          options.consent === 'before' ||
          options.consent === 'delayed-before'
        )
          return html(
            `<body>${consentMarkup({ redirect: true, delay: options.consent === 'before' ? 0 : 80 })}</body>`,
          );
        return redirect(`${IDENTITY}/authorize?state=${STATE}`);
      }
      if (url.origin === IDENTITY) {
        // The dynamically issued authorization query must survive until submission.
        if (url.pathname === '/authorize') {
          assert.equal(url.searchParams.get('state'), STATE);
          return html(
            options.missingForm
              ? '<p>Identity service unavailable</p>'
              : loginMarkup(false, options.consent === 'after'),
          );
        }
        if (url.pathname === '/submit') {
          assert.equal(request.method(), 'POST');
          assert.equal(url.searchParams.get('state'), STATE);
          counts.submissions++;
          submitted = Object.fromEntries(
            new URLSearchParams(request.postData()),
          );
          assert.equal(submitted[options.legacy ? 'Login' : 'username'], EMAIL);
          assert.equal(submitted.password, PASSWORD);
          if (options.rejected)
            return html(
              `<form id="loginForm"><p role="alert">${options.rejected}</p></form>`,
            );
          return redirect(options.redirect || `${FANTASY}/en/`);
        }
        if (url.pathname === '/returned-to-identity')
          return html('<p>Session lost</p>');
      }
      if (url.origin === FANTASY) {
        if (url.pathname === '/en/') {
          counts.fantasy++;
          if (options.finalNavigationFailure && counts.fantasy > 1)
            return route.abort('failed');
          if (options.finalRedirect && counts.fantasy > 1)
            return redirect(`${IDENTITY}/returned-to-identity`);
          return route.fulfill({
            contentType: 'text/html',
            body: '<p>Fantasy</p>',
            headers: {
              'set-cookie': 'fixture-auth=yes; Path=/; Secure; SameSite=Lax',
            },
          });
        }
        if (url.pathname === '/services/session/login') {
          counts.sessions++;
          assert.equal(request.method(), 'POST');
          assert.match(request.headers().cookie, /fixture-auth=yes/);
          assert.equal(request.postDataJSON().optType, 1);
          return route.fulfill({
            status: options.sessionHttpError ? 500 : 200,
            contentType: 'application/json',
            body: JSON.stringify(
              options.sessionHttpError || { Data: { Value: session } },
            ),
          });
        }
        if (url.pathname === '/feeds/v2/schedule/raceday_en.json') {
          return route.fulfill({ json: { Data: { fixtures: [] } } });
        }
      }
      if (options.redirect && request.url().startsWith(options.redirect))
        return html('<p>Wrong origin</p>');
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    } catch (error) {
      unexpected.push(error.message);
      await route.abort('failed').catch(() => {});
    }
  });
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(require.resolve('./f1FantasyApiService'), 'utf8'),
    {
      module,
      URL,
      process: {
        env: { F1_FANTASY_EMAIL: EMAIL, F1_FANTASY_PASSWORD: PASSWORD },
      },
      require: (name) =>
        name === 'playwright'
          ? {
              chromium: {
                launch: async () => {
                  counts.launches++;
                  return {
                    newContext: async () => ({
                      newPage: async () => pacedPage(await context.newPage()),
                    }),
                    close: async () => {
                      await context.close();
                      counts.closes++;
                    },
                  };
                },
              },
            }
          : require(name),
    },
    { filename: require.resolve('./f1FantasyApiService') },
  );
  t.after(async () => {
    await module.exports.close();
    await context.close();
    assert.deepEqual(
      unexpected,
      [],
      'all browser traffic must stay in the fixture',
    );
  });
  return {
    api: module.exports,
    counts,
    session,
    fetches: () =>
      context.pages()[0].evaluate(() => globalThis.__fixtureFetches),
  };
}

for (const consent of ['absent', 'before', 'delayed-before', 'after']) {
  test(`identity login with ${consent} consent, duplicate Sign In and changed Tab order`, async (t) => {
    const { api, counts, session, fetches } = await fixture(t, { consent });
    const result = await api.init();
    assert.equal(result.GUID, session.GUID);
    assert.equal(api.getSession(), result);
    assert.equal(counts.submissions, 1);
    assert.equal(counts.sessions, 1);
    await api.getRaceSchedule({ fresh: true });
    const requests = await fetches();
    assert.equal(requests.at(-1).cache, 'no-store');
    assert.equal(requests.at(-1).credentials, 'include');
  });
}

test('legacy login explicitly targets password and scopes the submit button', async (t) => {
  const { api, counts } = await fixture(t, { legacy: true });
  await api.init();
  assert.equal(counts.sessions, 1);
});

test('concurrent and repeated init reuse one authenticated browser and session', async (t) => {
  const { api, counts } = await fixture(t);
  const [first, second] = await Promise.all([api.init(), api.init()]);
  assert.equal(first, second);
  assert.equal(await api.init(), first);
  assert.equal(api.getSession(), first);
  assert.equal(counts.launches, 1);
  assert.equal(counts.submissions, 1);
  assert.equal(counts.sessions, 1);
  await api.close();
  assert.equal(api.getSession(), null);
  assert.equal(counts.closes, 1);
});

test('credential rejection reports a bounded sanitized message and no session', async (t) => {
  const { api, counts } = await fixture(t, {
    rejected: `Incorrect credentials ${EMAIL} ${PASSWORD} https://id.formula1.com/authorize?state=${STATE} ${'x'.repeat(1500)}`,
  });
  await assert.rejects(api.init(), (error) => {
    assert.match(error.message, /Login rejected: Incorrect credentials/);
    assert(error.message.length < 300);
    for (const secret of [EMAIL, PASSWORD, STATE])
      assert(!error.stack.includes(secret));
    return true;
  });
  assert.equal(api.getSession(), null);
  assert.equal(counts.sessions, 0);
});

for (const options of [
  { missingForm: true },
  { navigationFailure: true },
  { redirect: 'https://fantasy.formula1.com.attacker.invalid/en/' },
  { redirect: 'http://fantasy.formula1.com/en/' },
  { finalNavigationFailure: true },
  { finalRedirect: true },
]) {
  test(`failed login cannot obtain a session: ${Object.keys(options)[0]} ${options.redirect || ''}`, async (t) => {
    const { api, counts } = await fixture(t, options);
    await assert.rejects(api.init(), /F1 authentication failed \(login\)/);
    assert.equal(api.getSession(), null);
    assert.equal(counts.sessions, 0);
  });
}

for (const session of [
  null,
  {},
  { GUID: '' },
  { GUID: '   ' },
  { GUID: 123 },
  { GUID: 'null' },
  { GUID: '../bad' },
  { GUID: 'x'.repeat(513) },
]) {
  test(`invalid Fantasy session is rejected: ${JSON.stringify(session).slice(0, 55)}`, async (t) => {
    const { api } = await fixture(t, { session });
    await assert.rejects(api.init(), /Fantasy session.*No usable session GUID/);
    assert.equal(api.getSession(), null);
  });
}

test('session HTTP failure is sanitized before leaving authentication', async (t) => {
  const { api } = await fixture(t, {
    sessionHttpError: {
      message: `${PASSWORD} ${EMAIL} https://private.invalid/?state=${STATE}`,
    },
  });
  await assert.rejects(api.init(), (error) => {
    assert.match(error.message, /Fantasy session.*HTTP 500/);
    for (const secret of [EMAIL, PASSWORD, STATE])
      assert(!error.stack.includes(secret));
    return true;
  });
});
