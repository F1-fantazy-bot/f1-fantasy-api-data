require('dotenv').config();

const { fetchLeagueData } = require('./src/fetchLeagueData');
const { uploadDataToAzureStorage } = require('./src/azureBlobStorageService');
const telegramService = require('./src/telegramService');
const f1Api = require('./src/f1FantasyApiService');

(async () => {
  try {
    const data = await fetchLeagueData();
    console.log('\nFetched data summary:', JSON.stringify(data, null, 2).substring(0, 500));

    if (!data || !data.teams || data.teams.length === 0) {
      throw new Error('Invalid or missing data structure');
    }

    if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
      await uploadDataToAzureStorage(data);
    } else {
      console.log('\n⚠️  AZURE_STORAGE_CONNECTION_STRING not set — skipping blob upload');
    }

    await telegramService.notifySuccess(data);
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
