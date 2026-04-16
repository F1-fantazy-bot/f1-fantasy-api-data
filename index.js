require('dotenv').config();

const { fetchAllLeaguesData } = require('./src/fetchLeagueData');
const { uploadDataToAzureStorage } = require('./src/azureBlobStorageService');
const telegramService = require('./src/telegramService');
const f1Api = require('./src/f1FantasyApiService');

(async () => {
  try {
    const allLeagues = await fetchAllLeaguesData();

    if (!allLeagues || allLeagues.length === 0) {
      throw new Error('No league data fetched');
    }

    console.log(`\nFetched ${allLeagues.length} leagues:`);
    allLeagues.forEach((l) => console.log(`  - ${l.leagueName} (${l.leagueCode}): ${l.teams.length} teams`));

    if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
      for (const league of allLeagues) {
        await uploadDataToAzureStorage(league, league.leagueCode);
      }
    } else {
      console.log('\n⚠️  AZURE_STORAGE_CONNECTION_STRING not set — skipping blob upload');
    }

    await telegramService.notifySuccess(allLeagues);
  } catch (error) {
    const errorMessage = error.stack || error.message;
    console.error('Error:', errorMessage);

    try {
      await telegramService.notifyError(error);
    } catch (telegramError) {
      console.error('Failed to send error notification:', telegramError.message);
    }

    process.exit(1);
  } finally {
    await f1Api.close();
  }
})();
