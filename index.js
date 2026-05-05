require('dotenv').config();

const { fetchAllLeaguesData } = require('./src/fetchLeagueData');
const { fetchAllLeaguesLocked } = require('./src/fetchLockedLeagueData');
const { uploadDataToAzureStorage } = require('./src/azureBlobStorageService');
const telegramService = require('./src/telegramService');
const f1Api = require('./src/f1FantasyApiService');

const MODE = (process.env.MODE || 'weekly').toLowerCase();

async function runWeekly() {
  const allLeagues = await fetchAllLeaguesData();

  if (!allLeagues || allLeagues.length === 0) {
    throw new Error('No league data fetched');
  }

  console.log(`\nFetched ${allLeagues.length} leagues:`);
  allLeagues.forEach(({ league }) =>
    console.log(
      `  - ${league.leagueName} (${league.leagueCode}): ${league.teams.length} teams`,
    ),
  );

  if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    for (const { league, teamsData } of allLeagues) {
      await uploadDataToAzureStorage(league, league.leagueCode);
      await uploadDataToAzureStorage(
        teamsData,
        league.leagueCode,
        'teams-data.json',
      );
    }
  } else {
    console.log(
      '\n⚠️  AZURE_STORAGE_CONNECTION_STRING not set — skipping blob upload',
    );
  }

  await telegramService.notifySuccess(allLeagues.map(({ league }) => league));
}

async function runLocked() {
  const allLeagues = await fetchAllLeaguesLocked();

  if (!allLeagues || allLeagues.length === 0) {
    throw new Error('No locked league data fetched');
  }

  const totalBlobs = allLeagues.reduce((acc, r) => acc + r.blobs.length, 0);
  console.log(
    `\nFetched ${allLeagues.length} leagues, ${totalBlobs} locked-matchday blob(s):`,
  );
  allLeagues.forEach(({ league, blobs }) =>
    console.log(
      `  - ${league.leagueName} (${league.leagueCode}): ${blobs.length} blob(s) — ${blobs
        .map((b) => b.blobName)
        .join(', ') || '(none)'}`,
    ),
  );

  if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    for (const { league, blobs } of allLeagues) {
      for (const { blobName, payload } of blobs) {
        await uploadDataToAzureStorage(payload, league.leagueCode, blobName);
      }
    }
  } else {
    console.log(
      '\n⚠️  AZURE_STORAGE_CONNECTION_STRING not set — skipping blob upload',
    );
  }

  await telegramService.notifySuccessLocked(allLeagues);
}

(async () => {
  try {
    console.log(`MODE=${MODE}`);

    if (MODE === 'locked') {
      await runLocked();
    } else if (MODE === 'weekly') {
      await runWeekly();
    } else {
      throw new Error(`Unknown MODE "${MODE}". Expected "weekly" or "locked".`);
    }
  } catch (error) {
    const errorMessage = error.stack || error.message;
    console.error('Error:', errorMessage);

    try {
      await telegramService.notifyError(error);
    } catch (telegramError) {
      console.error(
        'Failed to send error notification:',
        telegramError.message,
      );
    }

    process.exit(1);
  } finally {
    await f1Api.close();
  }
})();
