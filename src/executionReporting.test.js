const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const api = require('./f1FantasyApiService');
const storage = require('./azureBlobStorageService');
const telegram = require('./telegramService');
const { runExecution } = require('../index');

const originalApi = { ...api };
const originalDownload = storage.downloadDataFromAzureStorage;
const originalBot = telegram.bot;
const originalReport = telegram.notifyFailureReport;
const originalExitCode = process.exitCode;
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
let messages, reports, uploads, events, localErrors;
const entry = {
  user_guid: 'opaque-private-account',
  user_name: 'private-login-name',
  team_name: 'Test_[team]*🏎',
  team_no: 2,
  cur_rank: 1,
  cur_points: 20,
};

function teamState(md = 18) {
  return {
    mdid: md,
    userTeam: [
      {
        teamno: 2,
        boosterid: null,
        fttourgdid: 1,
        team_info: { teamVal: 100, maxTeambal: 110, userSubsleft: 3 },
        playerid: Array.from({ length: 7 }, (_, i) => ({
          id: i + 1,
          playerpostion: i + 1,
        })),
      },
    ],
  };
}

beforeEach(() => {
  messages = [];
  reports = [];
  uploads = [];
  events = [];
  localErrors = [];
  process.exitCode = 0;
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args) => localErrors.push(args.join(' '));
  // Every F1 entry point defaults to a guard, so these tests cannot scrape.
  for (const name of Object.keys(originalApi)) {
    api[name] = () => {
      throw new Error(`Unexpected F1 call: ${name}`);
    };
  }
  api.init = async () => {};
  api.close = async () => {
    events.push('cleanup started');
    await Promise.resolve();
    events.push('cleanup complete');
  };
  api.getSession = () => ({ SocialId: 999 });
  api.getWebConfig = async () => ({
    Data: {
      constraints: { GamedayId: 18 },
      boosters: [
        { BoosterId: 1, BoosterName: 'LIMITLESS' },
        { BoosterId: 2, BoosterName: 'WILDCARD' },
      ],
    },
  });
  api.getRaceSchedule = async () => ({
    Data: {
      fixtures: [
        { GamedayId: 18, SubstitutionsAllowed: 2, MaxSubstitutionsCF: 1 },
      ],
    },
  });
  api.getLeagues = async () => [
    { league_type: 'Private', league_code: 'TEST', league_name: 'Test' },
  ];
  api.getLeagueInfo = async () => ({
    leagueId: 1,
    leagueName: 'Test',
    memberCount: 1,
  });
  api.getLeagueLeaderboard = async () => [entry];
  api.getOpponentGameDays = async () => ({ mdDetails: { 17: { pts: 20 } } });
  api.getOpponentTeam = async (guid, md) => teamState(md);
  api.getDrivers = async () =>
    Array.from({ length: 7 }, (_, i) => ({
      PlayerId: i + 1,
      DisplayName: `Player ${i + 1}`,
      Value: 10,
      PositionName: i < 5 ? 'DRIVER' : 'CONSTRUCTOR',
    }));
  storage.downloadDataFromAzureStorage = async () => null;
  telegram.bot = {
    sendMessage: async (chatId, text, options) => {
      messages.push({ chatId, text, options });
      return { message_id: messages.length };
    },
  };
  telegram.notifyFailureReport = async (diagnostics) => {
    assert(events.includes('cleanup complete'));
    events.push('report');
    reports.push(diagnostics.formatFailureReport());
    return originalReport.call(telegram, diagnostics);
  };
});

afterEach(() => {
  Object.assign(api, originalApi);
  storage.downloadDataFromAzureStorage = originalDownload;
  telegram.bot = originalBot;
  telegram.notifyFailureReport = originalReport;
  process.exitCode = originalExitCode;
  Object.assign(console, originalConsole);
});

function execute(mode, overrides = {}) {
  return runExecution({
    mode,
    env: { AZURE_STORAGE_CONNECTION_STRING: 'mock-storage' },
    services: {
      upload: async (...args) => uploads.push(args),
      ...overrides,
    },
  });
}

for (const mode of ['weekly', 'locked']) {
  for (const stage of ['login', 'league discovery', 'fetch', 'upload']) {
    test(`${mode}: fatal ${stage} failure reports mode, stage, and sanitized stack after cleanup`, async () => {
      const failure = new Error(
        'upstream failure password=private-password https://private.example/token?secret=abc',
      );
      failure.stack = `${failure.message}\n    at failingOperation (/Users/private-person/project/index.js:12:3)`;
      const overrides = {};
      if (stage === 'login')
        api.init = async () => {
          throw failure;
        };
      if (stage === 'league discovery')
        api.getLeagues = async () => {
          throw failure;
        };
      if (stage === 'fetch') {
        overrides[mode === 'weekly' ? 'fetchWeekly' : 'fetchLocked'] = async (
          diagnostics,
        ) => {
          diagnostics.setStage('fetch');
          throw failure;
        };
      }
      if (stage === 'upload')
        overrides.upload = async () => {
          throw failure;
        };
      const result = await execute(mode, overrides);
      assert.equal(result.error, failure);
      assert.equal(process.exitCode, 1);
      assert.equal(reports.length, 1);
      assert.match(reports[0], new RegExp(`${mode} execution failed`));
      assert(reports[0].includes(`stage=${stage}`));
      assert.match(reports[0], /at failingOperation/);
      assert.match(reports[0], /project\/index.js:12:3/);
      for (const secret of [
        'private-password',
        'private-person',
        'private.example',
      ]) {
        assert.equal(reports[0].includes(secret), false);
      }
      assert.deepEqual(
        [...new Set(messages.map((m) => m.chatId))],
        ['-1002298860617', '-5167373779'],
      );
      assert(messages.every((m) => m.options.parse_mode === undefined));
      if (stage !== 'upload') assert.equal(uploads.length, 0);
      if (stage === 'upload') assert.match(reports[0], /league=TEST.*blob=/);
    });
  }

  test(`${mode}: healthy execution uploads existing blobs and sends no failure report`, async () => {
    const result = await execute(mode);
    assert.equal(result.error, null);
    assert.equal(process.exitCode, 0);
    assert.equal(reports.length, 0);
    assert.equal(uploads.length, mode === 'weekly' ? 3 : 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /fetched successfully/);
  });

  test(`${mode}: partial team and league errors are grouped with at most three examples`, async () => {
    api.getLeagues = async () => [
      { league_type: 'Private', league_code: 'TEST', league_name: 'Test' },
      { league_type: 'Private', league_code: 'BAD', league_name: 'Bad' },
      { league_type: 'Private', league_code: 'WORSE', league_name: 'Worse' },
    ];
    const info = api.getLeagueInfo;
    api.getLeagueInfo = async (code) => {
      if (code !== 'TEST') throw new Error('league request failed');
      return info(code);
    };
    api.getLeagueLeaderboard = async () =>
      Array.from({ length: 6 }, (_, i) => ({
        ...entry,
        team_name: `Team ${i}`,
      }));
    api.getOpponentGameDays = async () => {
      throw new Error(`request failed for ${entry.user_guid}`);
    };
    const result = await execute(mode);
    assert.equal(process.exitCode, 0);
    assert.equal(result.error, null);
    assert.equal(reports.length, 1);
    const category =
      mode === 'weekly'
        ? 'Race scores fetch failed'
        : 'Locked game days fetch failed — team skipped';
    const issue = result.diagnostics.issues.get(category);
    assert.equal(issue.count, 6);
    assert.equal(issue.examples.length, 3);
    assert.equal(
      result.diagnostics.issues.get(
        mode === 'weekly'
          ? 'League fetch failed'
          : 'Locked league fetch failed',
      ).count,
      2,
    );
    assert.equal(reports[0].includes(entry.user_guid), false);
    assert.equal(reports[0].includes('Team 3'), false);
    assert.match(reports[0], /at api.getOpponentGameDays/);
    if (mode === 'locked')
      assert.match(messages[0].text, /partially available/);
  });
}

test('weekly: expected opponent absence and successful reconstruction remain informational', async () => {
  api.getOpponentTeam = async (guid, md) =>
    md === 18 ? { Meta: { Success: false, RetVal: -1 } } : teamState(md);
  const result = await execute('weekly');
  assert(
    result.diagnostics.information.has('Reconstructed race-start baselines'),
  );
  assert.equal(reports.length, 0);
  assert.equal(result.diagnostics.hasFailures(), false);
});

test('weekly: unavailable prices produce one consolidated report before any upload', async () => {
  api.getDrivers = async () => {
    throw new Error('price feed unavailable');
  };
  await execute('weekly');
  assert.equal(uploads.length, 0);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Global prices fetch failed/);
  assert.match(reports[0], /refusing weekly uploads/);
});

test('session identifiers are redacted from cleanup errors in outgoing reports', async () => {
  api.init = async () => ({
    GUID: 'opaque-session-guid',
    SocialId: 'private-social-id',
  });
  api.close = async () => {
    events.push('cleanup complete');
    throw new Error('cleanup opaque-session-guid private-social-id');
  };
  await execute('locked');
  assert.equal(reports[0].includes('opaque-session-guid'), false);
  assert.equal(reports[0].includes('private-social-id'), false);
});

test('missing storage configuration preserves dry-run upload behavior', async () => {
  await runExecution({
    mode: 'locked',
    env: {},
    services: {
      upload: async () => {
        throw new Error('Dry run must not upload');
      },
    },
  });
  assert.equal(process.exitCode, 0);
  assert.equal(reports.length, 0);
});

test('locked: failed candidate probes recovered by fallback do not create failure reports', async () => {
  api.getOpponentTeam = async (guid, md) => {
    if (md === 18) throw new Error('future candidate unavailable');
    return teamState(md);
  };
  const result = await execute('locked');
  assert.equal(reports.length, 0);
  assert(
    result.diagnostics.information.has('Locked candidate probe recovered'),
  );
  assert.equal(uploads[0][0].matchdayId, 17);
});

test('locked: exhausted candidates report request stacks and unavailable state without changing success status', async () => {
  api.getOpponentTeam = async () => {
    throw new Error('candidate request failed');
  };
  const result = await execute('locked');
  assert.equal(result.error, null);
  assert.equal(process.exitCode, 0);
  assert.equal(uploads.length, 0);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Locked candidate request failed: 2/);
  assert.match(reports[0], /matchday=18/);
  assert.match(reports[0], /at api.getOpponentTeam/);
  assert.match(reports[0], /Locked team state unavailable/);
  assert.match(reports[0], /No usable locked snapshots produced: 1/);
  assert.match(messages[0].text, /partially available/);
});

test('locked: missing data has descriptive reasons without invented stacks', async () => {
  api.getOpponentGameDays = async () => ({ mdDetails: {} });
  const result = await execute('locked');
  assert.equal(reports.length, 1);
  assert.match(reports[0], /No locked matchdays available — team skipped/);
  assert.equal(
    result.diagnostics.issues.values().next().value.examples[0].stack,
    null,
  );
  assert.match(reports[0], /No usable locked snapshots produced/);
});

test('locked: empty discovery remains fatal and explicitly reports no snapshots', async () => {
  api.getLeagues = async () => [];
  await execute('locked');
  assert.equal(process.exitCode, 1);
  assert.match(reports[0], /No usable locked snapshots produced/);
});

for (const kind of ['chip', 'roster', 'incomplete roster']) {
  test(`locked: ${kind} resolution is reported and uploads keep existing behavior`, async () => {
    if (kind === 'chip')
      api.getOpponentGameDays = async () => ({
        mdDetails: { 17: { pts: 20 } },
        get isWildcardtaken() {
          throw new Error('invalid chip payload');
        },
      });
    if (kind === 'roster')
      api.getDrivers = async () => {
        throw new Error('roster feed unavailable');
      };
    if (kind === 'incomplete roster') api.getDrivers = async () => [];
    await execute('locked');
    assert.equal(process.exitCode, 0);
    assert.equal(uploads.length, 1);
    assert.equal(reports.length, 1);
    assert.match(
      reports[0],
      kind === 'chip'
        ? /Locked chip extraction failed/
        : kind === 'roster'
          ? /Locked roster resolution failed/
          : /Locked roster or prices incomplete/,
    );
    assert.match(messages[0].text, /partially available/);
  });
}

for (const originalFailure of [false, true]) {
  test(`cleanup failure ${originalFailure ? 'preserves the original failure' : 'sets fatal status'} and is included in the single report`, async () => {
    const scrapeError = new Error('original login failure');
    const cleanupError = new Error('cleanup failed');
    if (originalFailure)
      api.init = async () => {
        throw scrapeError;
      };
    api.close = async () => {
      events.push('cleanup complete');
      throw cleanupError;
    };
    const result = await execute('weekly');
    assert.equal(result.error, originalFailure ? scrapeError : cleanupError);
    assert.equal(process.exitCode, 1);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /weekly execution failed/);
    assert.match(reports[0], /Browser cleanup failed/);
    assert.match(reports[0], /stage=cleanup/);
    if (originalFailure) assert.match(reports[0], /original login failure/);
  });
}

test('delivery failure never replaces the original scrape error or prevents cleanup', async () => {
  const failure = new Error('original failure');
  api.init = async () => {
    throw failure;
  };
  telegram.notifyFailureReport = async () => {
    throw new Error('token=private-delivery-token');
  };
  const result = await execute('locked');
  assert.equal(result.error, failure);
  assert(events.includes('cleanup complete'));
  assert.equal(process.exitCode, 1);
  assert.equal(
    localErrors.join('\n').includes('private-delivery-token'),
    false,
  );
});
