require('dotenv').config();

const { fetchAllLeaguesData } = require('./src/fetchLeagueData');
const { fetchAllLeaguesLocked } = require('./src/fetchLockedLeagueData');
const { uploadDataToAzureStorage } = require('./src/azureBlobStorageService');
const telegramService = require('./src/telegramService');
const f1Api = require('./src/f1FantasyApiService');

const { ExecutionDiagnostics } = require('./src/weeklyDiagnostics');
const { sanitize } = require('./src/reportSanitizer');
const { loadLockedCaptureWindow } = require('./src/lockedCaptureWindow');

async function runWeekly(diagnostics, services, env) {
  const { leagues: allLeagues, prices } =
    await services.fetchWeekly(diagnostics);

  if (!allLeagues || allLeagues.length === 0) {
    throw new Error('No league data fetched');
  }

  console.log(`\nFetched ${allLeagues.length} leagues:`);
  allLeagues.forEach(({ league }) =>
    console.log(
      `  - ${league.leagueName} (${league.leagueCode}): ${league.teams.length} teams`,
    ),
  );

  if (prices) {
    console.log(
      `Prices snapshot @ md${prices.matchdayId}: ${prices.drivers.length} drivers, ${prices.constructors.length} constructors`,
    );
  } else {
    console.log('Prices snapshot: (unavailable — see warnings above)');
  }

  diagnostics.setStage('upload');
  if (env.AZURE_STORAGE_CONNECTION_STRING) {
    for (const { league, teamsData } of allLeagues) {
      diagnostics.setStage('upload', {
        league: league.leagueCode,
        blob: 'league-standings.json',
      });
      await services.upload(league, league.leagueCode);
      diagnostics.setStage('upload', {
        league: league.leagueCode,
        blob: 'teams-data.json',
      });
      await services.upload(teamsData, league.leagueCode, 'teams-data.json');
    }

    if (prices) {
      // Container-root upload (no `leagues/<code>/` prefix) — driver and
      // constructor prices are league-agnostic.
      diagnostics.setStage('upload', { blob: 'prices.json' });
      await services.upload(prices, null, 'prices.json');
    } else {
      console.log('⚠️  Skipping prices.json upload — no prices snapshot');
    }
  } else {
    console.log(
      '\n⚠️  AZURE_STORAGE_CONNECTION_STRING not set — skipping blob upload',
    );
  }

  diagnostics.setStage('notification');
  await services.telegram.notifySuccess(
    allLeagues.map(({ league }) => league),
    prices,
    allLeagues.map(({ teamsData }) => teamsData),
  );
}

async function skipLocked(diagnostics, services, window) {
  const reason = window.reason || 'The active locked matchday changed';
  if (window.status === 'unknown')
    diagnostics.record(
      'Locked capture window unverifiable — writes skipped',
      {},
      window.error,
    );
  else diagnostics.recordInfo('Locked capture window closed — writes skipped');
  console.log(`ℹ️ Locked scrape skipped: ${reason}`);
  await services.telegram.notifySkippedLocked(reason);
}

async function runLocked(diagnostics, services, env) {
  diagnostics.setStage('login');
  const session = await services.api.init();
  diagnostics.protect(session?.GUID, session?.SocialId, session?.UserId);
  diagnostics.setStage('capture window');
  const window = await services.captureWindow(services.api);
  if (window.status !== 'open') {
    await skipLocked(diagnostics, services, window);
    return;
  }
  const allLeagues = await services.fetchLocked(diagnostics, window.matchdayId);

  if (!allLeagues || allLeagues.length === 0) {
    throw new Error('No locked league data fetched');
  }

  const totalBlobs = allLeagues.reduce((acc, r) => acc + r.blobs.length, 0);
  if (
    totalBlobs === 0 &&
    !diagnostics.issues.has('No usable locked snapshots produced')
  ) {
    diagnostics.record('No usable locked snapshots produced');
  }
  console.log(
    `\nFetched ${allLeagues.length} leagues, ${totalBlobs} locked-matchday blob(s):`,
  );
  allLeagues.forEach(({ league, blobs }) =>
    console.log(
      `  - ${league.leagueName} (${league.leagueCode}): ${blobs.length} blob(s) — ${
        blobs.map((b) => b.blobName).join(', ') || '(none)'
      }`,
    ),
  );

  diagnostics.setStage('upload');
  if (env.AZURE_STORAGE_CONNECTION_STRING) {
    for (const { league, blobs } of allLeagues) {
      for (const { blobName, payload } of blobs) {
        diagnostics.setStage('upload', {
          league: league.leagueCode,
          blob: blobName,
          matchday: payload.matchdayId,
        });
        const latestWindow = await services.captureWindow(services.api);
        if (
          payload.matchdayId !== window.matchdayId ||
          blobName !== `locked/matchday_${window.matchdayId}.json`
        ) {
          await skipLocked(diagnostics, services, {
            status: 'unknown',
            reason: 'Locked snapshot does not match the verified capture race',
          });
          return;
        }
        if (
          latestWindow.status !== 'open' ||
          latestWindow.matchdayId !== window.matchdayId
        ) {
          await skipLocked(diagnostics, services, latestWindow);
          return;
        }
        await services.upload(payload, league.leagueCode, blobName);
      }
    }
  } else {
    console.log(
      '\n⚠️  AZURE_STORAGE_CONNECTION_STRING not set — skipping blob upload',
    );
  }

  diagnostics.setStage('notification');
  await services.telegram.notifySuccessLocked(allLeagues, {
    degraded: diagnostics.hasFailures(),
  });
}

// Delivery happens once, after cleanup, so partial and fatal failures share a report.
// Dependencies are injectable for offline execution tests; CLI defaults are unchanged.
async function runExecution({
  mode = (process.env.MODE || 'weekly').toLowerCase(),
  env = process.env,
  services = {},
} = {}) {
  services = {
    fetchWeekly: fetchAllLeaguesData,
    fetchLocked: fetchAllLeaguesLocked,
    upload: uploadDataToAzureStorage,
    telegram: telegramService,
    api: f1Api,
    captureWindow: loadLockedCaptureWindow,
    ...services,
  };
  const diagnostics = new ExecutionDiagnostics(mode);
  let failure = null;
  try {
    console.log(`MODE=${mode}`);
    if (mode === 'locked') {
      await runLocked(diagnostics, services, env);
    } else if (mode === 'weekly') {
      await runWeekly(diagnostics, services, env);
    } else {
      diagnostics.setStage('mode selection');
      throw new Error(`Unknown MODE "${mode}". Expected "weekly" or "locked".`);
    }
  } catch (error) {
    failure = error;
    diagnostics.record('Fatal execution failure', {}, error);
    console.error(
      'Error:',
      sanitize(
        error.stack || error.message || error,
        diagnostics.sensitiveValues,
      ),
    );
    process.exitCode = 1;
  } finally {
    diagnostics.setStage('cleanup');
    try {
      await services.api.close();
    } catch (error) {
      diagnostics.record('Browser cleanup failed', {}, error);
      console.error(
        'Browser cleanup failed:',
        sanitize(
          error.stack || error.message || error,
          diagnostics.sensitiveValues,
        ),
      );
      failure ||= error;
      process.exitCode = 1;
    }
    diagnostics.logToConsole();
    try {
      if (diagnostics.hasFailures())
        await services.telegram.notifyFailureReport(diagnostics);
    } catch (error) {
      // Notification transport must never replace the scrape/cleanup outcome.
      console.error(
        'Failed to send failure report:',
        sanitize(error.message || error, diagnostics.sensitiveValues),
      );
    }
  }
  return { diagnostics, error: failure };
}

if (require.main === module) {
  runExecution();
}

module.exports = { runExecution };
