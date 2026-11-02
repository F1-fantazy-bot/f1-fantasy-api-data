// Read-only production-response validation. Does not import the execution,
// upload or Telegram modules, and never runs a weekly/locked scrape.
require('dotenv').config();
process.env.AZURE_STORAGE_CONNECTION_STRING = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.LOG_CHANNEL_ID = '';
process.env.ERRORS_CHANNEL_ID = '';
const api = require('../src/f1FantasyApiService');
const { CHIPS, extractChipUsage } = require('../src/chips');
async function main() {
  const summary = { checked: 0, known: 0, unknown: 0, failed: 0, missingOrMalformed: {} };
  try {
    await api.init();
    const leagues = (await api.getLeagues()).filter((league) => league.league_type === 'Private');
    const seen = new Set();
    for (const league of leagues) {
      const info = await api.getLeagueInfo(league.league_code);
      for (const team of await api.getLeagueLeaderboard(info.leagueId)) {
        const teamNo = team.team_no || 1;
        const key = `${team.user_guid}:${teamNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        summary.checked++;
        try {
          const data = await api.getOpponentGameDays(team.user_guid, teamNo, teamNo);
          const result = extractChipUsage(data);
          summary[result.chipUsageStatus]++;
          for (const chip of CHIPS) {
            // Validate each flag through the exact extraction contract.
            const single = Object.fromEntries(CHIPS.map((item) => [item.takenFlag, item === chip ? data?.[item.takenFlag] : 0]));
            if (extractChipUsage(single).chipUsageStatus === 'unknown') summary.missingOrMalformed[chip.takenFlag] = (summary.missingOrMalformed[chip.takenFlag] || 0) + 1;
          }
        } catch {
          summary.failed++;
        }
      }
    }
    console.log(JSON.stringify(summary));
    if (summary.unknown || summary.failed || !summary.checked) process.exitCode = 1;
  } finally {
    await api.close();
  }
}
main().catch(() => { console.error('Chip response validation failed; no uploads or notifications were attempted.'); process.exitCode = 1; });
