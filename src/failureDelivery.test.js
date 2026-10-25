const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const telegram = require('./telegramService');
const { ExecutionDiagnostics } = require('./weeklyDiagnostics');
const { sanitize } = require('./reportSanitizer');
const originalBot = telegram.bot;
const originalError = console.error;
let messages, errors;

beforeEach(() => {
  messages = [];
  errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  telegram.bot = {
    sendMessage: async (chatId, text, options) => {
      messages.push({ chatId, text, options });
      return { message_id: messages.length };
    },
  };
});

afterEach(() => {
  telegram.bot = originalBot;
  console.error = originalError;
});

test('failure reports redact credentials, connection strings, identifiers, URLs and private paths while keeping stack frames', async () => {
  const diagnostics = new ExecutionDiagnostics('locked');
  const originalPassword = process.env.F1_FANTASY_PASSWORD;
  process.env.F1_FANTASY_PASSWORD = 'environment-password';
  try {
    diagnostics.protect('opaque-private-guid', 'private-account-name');
    const error = new Error('environment-password');
    error.stack = [
      'Error: environment-password opaque-private-guid private-account-name',
      'password=inline-password token=inline-token accountId=hash-value social_id=12345 user_guid=opaque-user GUID=opaque-login-guid userId=private-user-id',
      'AccountName=storageaccount;AccountKey=storagekey;EndpointSuffix=core.windows.net',
      'https://private.host/path?secret=private-query',
      'Bearer private-bearer-token someone@private.example',
      '12345678:long_unconfigured_telegram_token_value',
      'abcdef123456 11111111-1111-1111-1111-111111111111',
      '    at scrape (/Users/secret-mac-user/project/src/fetch.js:42:7)',
      '    at fetch (/home/secret-linux-user/project/index.js:10:3)',
      '    at close (C:\\Users\\secret-windows-user\\project\\index.js:9:1)',
    ].join('\n');
    diagnostics.setStage('fetch');
    diagnostics.record(
      'Locked roster resolution failed',
      {
        league: 'TEST',
        team: '🏎_[team]*',
        accountId: 'context-account',
        matchday: 18,
      },
      error,
    );
    await telegram.notifyFailureReport(diagnostics);
    assert.equal(messages.length, 2);
    for (const { text, options } of messages) {
      assert.match(text, /^F1_FANTASY_API: ⚠️ locked execution/);
      assert.match(text, /stage=fetch.*league=TEST.*matchday=18/);
      assert.match(
        text,
        /at scrape \(\/\[private-user\]\/project\/src\/fetch.js:42:7\)/,
      );
      assert.equal(options.parse_mode, undefined);
      for (const secret of [
        'environment-password',
        'opaque-private-guid',
        'private-account-name',
        'inline-password',
        'inline-token',
        'hash-value',
        '12345',
        'opaque-user',
        'opaque-login-guid',
        'private-user-id',
        'storageaccount',
        'storagekey',
        'private.host',
        'private-query',
        'private-bearer-token',
        'someone@private.example',
        'long_unconfigured',
        'abcdef123456',
        '11111111-1111',
        'secret-mac-user',
        'secret-linux-user',
        'secret-windows-user',
        'context-account',
      ])
        assert.equal(text.includes(secret), false, secret);
    }
  } finally {
    if (originalPassword === undefined) delete process.env.F1_FANTASY_PASSWORD;
    else process.env.F1_FANTASY_PASSWORD = originalPassword;
  }
});

test('large stacks, Markdown, Unicode and individually oversized lines use bounded plain-text multipart delivery', async () => {
  const diagnostics = new ExecutionDiagnostics('weekly');
  for (let n = 0; n < 5; n++) {
    const error = new Error(`failure ${n}`);
    error.stack = `Error: failure ${n}\n    at frame_${n} (/home/private-user/project/fetch.js:1:1)\n${'x_[]*🏎'.repeat(2500)}`;
    diagnostics.record('Large upstream errors', { team: `Team ${n}` }, error);
  }
  await telegram.notifyFailureReport(diagnostics);
  const first = messages.filter(
    (message) => message.chatId === '-1002298860617',
  );
  const second = messages.filter((message) => message.chatId === '-5167373779');
  assert(first.length > 3);
  assert.deepEqual(
    first.map((m) => m.text),
    second.map((m) => m.text),
  );
  for (const message of messages) {
    assert(message.text.length < 4096);
    assert.equal(message.options.parse_mode, undefined);
    assert.match(message.text, /^F1_FANTASY_API: Failure report \d+\/\d+\n/);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        message.text,
      ),
      false,
    );
  }
  const report = first.map((message) => message.text).join('\n');
  assert.match(report, /Large upstream errors: 5/);
  assert.match(report, /\[stack truncated\]/);
  assert.match(report, /frame_2/);
  assert.equal(report.includes('frame_3'), false);
  assert.equal(report.includes('private-user/project'), false);
});

test('preview delivery also handles a single oversized line and preserves Unicode', async () => {
  await telegram.notifyWeeklyDiagnostics(
    { format: () => '🏎[]_*'.repeat(3000) },
    { preview: true },
  );
  assert(messages.length > 2);
  for (const message of messages) {
    assert.equal(message.chatId, '-5167373779');
    assert(message.text.length < 4096);
    assert.equal(message.options.parse_mode, undefined);
    assert.match(message.text, /PREVIEW — Weekly diagnostics/);
  }
});

for (const failingDestination of ['-1002298860617', '-5167373779']) {
  test(`a rejected ${failingDestination} destination still attempts the other and logs only sanitized errors`, async () => {
    const diagnostics = new ExecutionDiagnostics('locked');
    diagnostics.protect('opaque-delivery-account');
    diagnostics.record('Locked state unavailable');
    telegram.bot.sendMessage = async (chatId, text, options) => {
      messages.push({ chatId, text, options });
      if (chatId === failingDestination)
        throw new Error(
          'token=private-transport-token https://api.telegram.org/private opaque-delivery-account',
        );
      return {};
    };
    await telegram.notifyFailureReport(diagnostics);
    assert.deepEqual(
      messages.map((m) => m.chatId),
      ['-1002298860617', '-5167373779'],
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].includes('private-transport-token'), false);
    assert.equal(errors[0].includes('api.telegram.org'), false);
    assert.equal(errors[0].includes('opaque-delivery-account'), false);
  });
}

test('known identifiers discovered later are removed from earlier collected examples', () => {
  const diagnostics = new ExecutionDiagnostics();
  diagnostics.record(
    'Early request failed',
    {},
    new Error('opaque-later-account'),
  );
  diagnostics.protect('opaque-later-account');
  assert.equal(
    diagnostics.formatFailureReport().includes('opaque-later-account'),
    false,
  );
});

test('missing bot remains an explicit local skip and does not throw', async () => {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  telegram.bot = null;
  try {
    const diagnostics = new ExecutionDiagnostics('locked');
    diagnostics.record('No usable locked snapshots produced');
    await telegram.notifyFailureReport(diagnostics);
    assert.equal(messages.length, 0);
    assert.equal(logs.length, 2);
    assert(logs.every((line) => line.includes('[Telegram skip]')));
  } finally {
    console.log = originalLog;
  }
});

test('sanitization retains readable multiline stack structure', () => {
  assert.equal(
    sanitize('Error: failed\n    at fetch (/home/person/app/index.js:1:2)'),
    'Error: failed\n    at fetch (/[private-user]/app/index.js:1:2)',
  );
});
