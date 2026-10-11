const TelegramBot = require('node-telegram-bot-api');

const LOG_CHANNEL_ID = '-1002298860617';
const ERRORS_CHANNEL_ID = '-5167373779';

class TelegramService {
  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      console.warn(
        '⚠️  TELEGRAM_BOT_TOKEN not set — Telegram notifications disabled',
      );
      this.bot = null;

      return;
    }

    this.bot = new TelegramBot(token);
  }

  async sendMessage(message, chatId = LOG_CHANNEL_ID, options = {}) {
    if (!this.bot) {
      console.log('[Telegram skip] Would send:', message.substring(0, 80));

      return;
    }

    try {
      const isChannelMessage =
        chatId === LOG_CHANNEL_ID || chatId === ERRORS_CHANNEL_ID;
      const formattedMessage = isChannelMessage
        ? `F1_FANTASY_API: ${message}`
        : message;

      const sent = await this.bot.sendMessage(chatId, formattedMessage, {
        parse_mode: 'Markdown',
        ...options,
      });
      console.log('Telegram notification sent successfully');

      return sent;
    } catch (error) {
      console.error('Failed to send Telegram notification:', error.message);
    }
  }

  async notifyWeeklyDiagnostics(diagnostics, { preview = false } = {}) {
    const message = diagnostics.format({ preview });
    if (!message) return [];

    // Plain text keeps team names and upstream errors from breaking Markdown.
    // Split at line boundaries to stay below Telegram's 4096-character limit.
    const chunks = [];
    let chunk = '';
    for (const line of message.split('\n')) {
      if (chunk.length + line.length + 1 > 3400) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += `${line}\n`;
    }
    if (chunk) chunks.push(chunk);

    const sent = [];
    for (const [index, part] of chunks.entries()) {
      const label = preview ? 'PREVIEW — ' : '';
      const heading =
        chunks.length > 1
          ? `${label}Weekly diagnostics ${index + 1}/${chunks.length}\n`
          : '';
      sent.push(
        await this.sendMessage(`${heading}${part}`, ERRORS_CHANNEL_ID, {
          parse_mode: undefined,
        }),
      );
    }

    return sent;
  }

  async notifySuccess(allLeagues, prices = null, teamSnapshots = []) {
    const leagues = Array.isArray(allLeagues) ? allLeagues : [allLeagues];
    const leagueLines = leagues
      .map((l) => `• ${l.leagueName} (${l.teams.length} teams)`)
      .join('\n');

    const pricesLine = prices
      ? `\nPrices @ md${prices.matchdayId}: ${prices.drivers.length} drivers, ${prices.constructors.length} constructors`
      : '';

    const teams = teamSnapshots.flatMap((snapshot) => snapshot.teams || []);
    const incomplete = teams.filter(
      (team) =>
        !['current', 'reconstructed-race-start'].includes(
          team.teamStateStatus,
        ) ||
        (!Number.isFinite(team.transfersRemaining) &&
          team.transfersStatus !== 'unlimited') ||
        !Number.isFinite(team.budget) ||
        team.transfersStatus === 'unknown' ||
        team.budgetStatus === 'unknown' ||
        team.drivers?.length !== 5 ||
        team.constructors?.length !== 2 ||
        [...team.drivers, ...team.constructors].some(
          (player) => !Number.isFinite(player.price),
        ),
    ).length;
    const heading = incomplete
      ? '⚠️ *Weekly data partially available*'
      : '✅ *League data fetched successfully*';
    const stateLine = incomplete
      ? `\nRecommendation data unavailable/incomplete: ${incomplete}/${teams.length} snapshots`
      : '';
    const calculated = teams.filter(
      (team) => team.transfersStatus === 'calculated-race-start',
    ).length;
    const transfersLine = calculated
      ? `\nCalculated race-start transfers: ${calculated} snapshots (current usage unknown)`
      : '';
    const reconstructed = teams.filter(
      (team) => team.teamStateStatus === 'reconstructed-race-start',
    ).length;
    const baselineLine = reconstructed
      ? `\nStarting rosters/budgets reconstructed: ${reconstructed} snapshots (before this week's changes)`
      : '';

    const message = `${heading}
Leagues: ${leagues.length}
${leagueLines}${pricesLine}${stateLine}${baselineLine}${transfersLine}
Fetched at: ${new Date().toISOString()}`;

    await this.sendMessage(message, LOG_CHANNEL_ID);
  }

  async notifySuccessLocked(allLeagues) {
    const list = Array.isArray(allLeagues) ? allLeagues : [allLeagues];
    const leagueLines = list
      .map(({ league, blobs }) => {
        const matchdays = (blobs || [])
          .map((b) => b.payload?.matchdayId)
          .filter((m) => m !== undefined && m !== null);
        const mdSummary = matchdays.length
          ? `md ${matchdays.join(', ')}`
          : 'no md';

        return `• ${league.leagueName} (${mdSummary}, ${(blobs || []).length} blob)`;
      })
      .join('\n');
    const totalBlobs = list.reduce((acc, r) => acc + (r.blobs || []).length, 0);

    const message = `🔒 *Locked-snapshot data fetched successfully*
Leagues: ${list.length}
Locked-matchday blobs: ${totalBlobs}
${leagueLines}
Fetched at: ${new Date().toISOString()}`;

    await this.sendMessage(message, LOG_CHANNEL_ID);
  }

  async notifyError(error) {
    const message = `❌ *Error fetching league data*
${error.message}`;

    await this.sendMessage(message, LOG_CHANNEL_ID);
    await this.sendMessage(message, ERRORS_CHANNEL_ID);
  }
}

module.exports = new TelegramService();
