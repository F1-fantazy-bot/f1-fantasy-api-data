const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WeeklyDiagnostics } = require('./weeklyDiagnostics');
const telegram = require('./telegramService');

test('diagnostics group repeated issues, bound examples, and redact sensitive errors', () => {
  const diagnostics = new WeeklyDiagnostics();
  assert.equal(diagnostics.format(), null);
  diagnostics.currentMatchdayId = 18;
  const oldPassword = process.env.F1_FANTASY_PASSWORD;
  process.env.F1_FANTASY_PASSWORD = 'test-sensitive-password';
  try {
    for (let n = 0; n < 33; n++) {
      diagnostics.record(
        'Upcoming team response rejected',
        { team: `Team_${n}`, requested: 18 },
        new Error(
          'GET /services/user/opponentteam/private-guid/18 failed test-sensitive-password',
        ),
      );
    }
    const report = diagnostics.formatDetails({ preview: true });
    assert.match(report, /PREVIEW/);
    assert.match(report, /Current F1 matchday: 18/);
    assert.match(report, /Upcoming team response rejected: 33/);
    assert.equal(report.includes('private-guid'), false);
    assert.equal(report.includes('test-sensitive-password'), false);
    assert.equal(report.includes('Team_3'), false);
    assert.equal(diagnostics.issues.values().next().value.samples.length, 3);
  } finally {
    if (oldPassword === undefined) delete process.env.F1_FANTASY_PASSWORD;
    else process.env.F1_FANTASY_PASSWORD = oldPassword;
  }
});

test('Telegram sends bounded plain-text previews only to the existing bugs channel', async () => {
  const originalBot = telegram.bot;
  const messages = [];
  telegram.bot = {
    sendMessage: async (chatId, text, options) => {
      messages.push({ chatId, text, options });
      return { message_id: messages.length };
    },
  };
  try {
    assert.deepEqual(
      await telegram.notifyWeeklyDiagnostics(new WeeklyDiagnostics()),
      [],
    );
    assert.equal(messages.length, 0);
    const diagnostics = new WeeklyDiagnostics();
    for (let n = 0; n < 20; n++) {
      diagnostics.record(
        `Failure ${n}`,
        { team: '[Team_name]*'.repeat(25) },
        new Error('x'.repeat(500)),
      );
    }
    const sent = await telegram.notifyWeeklyDiagnostics(diagnostics, {
      preview: true,
    });
    assert.equal(sent.length, 1);
    assert(messages[0].text.length < 600);
    assert.equal(messages[0].text.includes('[Team_name]'), false);
    assert.equal(sent.length, messages.length);
    for (const message of messages) {
      assert.equal(message.chatId, '-5167373779');
      assert.equal(message.options.parse_mode, undefined);
      assert(message.text.length <= 4096);
      assert.match(message.text, /^F1_FANTASY_API: 🧪 PREVIEW/);
    }
  } finally {
    telegram.bot = originalBot;
  }
});

test('a stale run produces a short problem and impact summary', () => {
  const diagnostics = new WeeklyDiagnostics();
  diagnostics.currentMatchdayId = 18;
  for (let n = 0; n < 33; n++) {
    diagnostics.record('Upcoming team response rejected', {
      accountId: 'private',
      requested: 18,
    });
    diagnostics.record('Historical team fallback — transfers may be stale', {
      selected: 17,
    });
    diagnostics.record(
      'Team snapshot matchday differs from current F1 matchday',
      { current: 18, selected: 17 },
    );
  }
  diagnostics.record('Price feed matchday differs from current F1 matchday', {
    current: 18,
    selected: 17,
  });
  const message = diagnostics.format({ preview: true });
  assert(message.length < 500);
  assert.match(message, /33 team snapshots/);
  assert.match(message, /Prices are from race 17/);
  assert.match(message, /Historical transfer counts/);
  assert.equal(message.includes('accountId'), false);
  assert.equal(message.includes('apiRetVal'), false);
});

test('success notification distinguishes partial current data from complete results', async () => {
  const originalBot = telegram.bot;
  const messages = [];
  telegram.bot = {
    sendMessage: async (chatId, text) => {
      messages.push(text);
      return { message_id: 1 };
    },
  };
  try {
    const league = { leagueName: 'Test', teams: [{}, {}] };
    const current = {
      teamStateStatus: 'current',
      transfersRemaining: 0,
      budget: 100,
      drivers: Array.from({ length: 5 }, () => ({ price: 10 })),
      constructors: Array.from({ length: 2 }, () => ({ price: 10 })),
    };
    await telegram.notifySuccess([league], null, [
      {
        teams: [
          current,
          {
            teamStateStatus: 'historical',
            transfersRemaining: null,
            budget: null,
          },
        ],
      },
    ]);
    assert.match(messages[0], /Weekly data partially available/);
    assert.match(messages[0], /1\/2 snapshots/);
    await telegram.notifySuccess([league], null, [{ teams: [current] }]);
    assert.match(messages[1], /League data fetched successfully/);
    await telegram.notifySuccess([league], null, [
      {
        teams: [
          {
            ...current,
            transfersRemaining: 3,
            transfersStatus: 'calculated-race-start',
          },
        ],
      },
    ]);
    assert.match(messages[2], /Weekly data partially available/);
    assert.match(messages[2], /Calculated race-start transfers: 1/);
    await telegram.notifySuccess([league], null, [
      {
        teams: [
          {
            ...current,
            transfersRemaining: null,
            transfersStatus: 'unlimited',
          },
        ],
      },
    ]);
    assert.match(messages[3], /League data fetched successfully/);
  } finally {
    telegram.bot = originalBot;
  }
});

test('short diagnostics describe calculated transfers without claiming they are live or unknown', () => {
  const diagnostics = new WeeklyDiagnostics();
  diagnostics.currentMatchdayId = 18;
  for (let i = 0; i < 30; i++) {
    diagnostics.record('Current team state unavailable');
    diagnostics.record('Calculated race-start transfers');
  }
  const message = diagnostics.format();
  assert(message.length < 500);
  assert.match(
    message,
    /Transfers calculated for 30 snapshots at race start; current usage is unknown/,
  );
  assert.equal(
    message.includes('current transfers and budgets are unknown'),
    false,
  );
});
