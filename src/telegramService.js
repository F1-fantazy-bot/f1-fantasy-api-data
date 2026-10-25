const TelegramBot = require('node-telegram-bot-api');
const { sanitize } = require('./reportSanitizer');
const { ExecutionDiagnostics } = require('./weeklyDiagnostics');

const LOG_CHANNEL_ID = '-1002298860617';
const ERRORS_CHANNEL_ID = '-5167373779';

// Leave room for the channel prefix and multipart heading. Count UTF-16 units,
// which conservatively bounds Telegram's character limit even for emoji.
function splitReport(message) {
  const limit = 3800;
  const chunks = [];
  let chunk = '';
  for (let line of message.split('\n')) {
    if (chunk && chunk.length + line.length + 1 > limit) {
      chunks.push(chunk);
      chunk = '';
    }
    while (line.length > limit) {
      let end = limit;
      if (/[\uD800-\uDBFF]/.test(line[end - 1])) end--;
      chunks.push(line.slice(0, end));
      line = line.slice(end);
    }
    chunk += `${chunk ? '\n' : ''}${line}`;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

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

  async sendMessage(
    message,
    chatId = LOG_CHANNEL_ID,
    options = {},
    sensitiveValues = [],
  ) {
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
      console.error(
        'Failed to send Telegram notification:',
        sanitize(error.message || error, sensitiveValues),
      );
    }
  }

  async notifyWeeklyDiagnostics(diagnostics, { preview = false } = {}) {
    const message = diagnostics.format({ preview });
    if (!message) return [];

    return this._sendPlainReport(
      message,
      [ERRORS_CHANNEL_ID],
      preview ? 'PREVIEW — Weekly diagnostics' : 'Weekly diagnostics',
      diagnostics.sensitiveValues,
    );
  }

  async notifyFailureReport(diagnostics) {
    const message = diagnostics.formatFailureReport();
    if (!message) return [];
    return this._sendPlainReport(
      message,
      [LOG_CHANNEL_ID, ERRORS_CHANNEL_ID],
      'Failure report',
      diagnostics.sensitiveValues,
    );
  }

  async _sendPlainReport(message, destinations, label, sensitiveValues = []) {
    const chunks = splitReport(sanitize(message, sensitiveValues));
    const sent = [];
    for (const destination of destinations) {
      for (const [index, part] of chunks.entries()) {
        const heading =
          chunks.length > 1 ? `${label} ${index + 1}/${chunks.length}\n` : '';
        try {
          sent.push(
            await this.sendMessage(
              `${heading}${part}`,
              destination,
              {
                parse_mode: undefined,
              },
              sensitiveValues,
            ),
          );
        } catch (error) {
          // Also isolate failures if sendMessage is replaced by another transport.
          console.error(
            'Failed to send failure report:',
            sanitize(error.message || error, sensitiveValues),
          );
        }
      }
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

  async notifySkippedLocked(reason) {
    await this.sendMessage(
      `ℹ️ Locked scrape skipped\n${reason}\nNo further snapshots were uploaded.`,
      LOG_CHANNEL_ID,
      { parse_mode: undefined },
    );
  }

  async notifySuccessLocked(allLeagues, { degraded = false } = {}) {
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
    const incomplete = list.some(
      ({ blobs }) =>
        !blobs?.length ||
        blobs.some(
          ({ payload }) =>
            !payload?.teams?.length ||
            payload.teams.some(
              (team) =>
                team.drivers?.length !== 5 ||
                team.constructors?.length !== 2 ||
                [...team.drivers, ...team.constructors].some(
                  (player) => !player.name || !Number.isFinite(player.price),
                ),
            ),
        ),
    );
    const heading =
      degraded || incomplete || totalBlobs === 0
        ? '⚠️ *Locked-snapshot data partially available*'
        : '🔒 *Locked-snapshot data fetched successfully*';

    const message = `${heading}
Leagues: ${list.length}
Locked-matchday blobs: ${totalBlobs}
${leagueLines}
Fetched at: ${new Date().toISOString()}`;

    await this.sendMessage(message, LOG_CHANNEL_ID);
  }

  async notifyError(error) {
    const diagnostics = new ExecutionDiagnostics();
    diagnostics.record('Fatal execution failure', {}, error);
    return this.notifyFailureReport(diagnostics);
  }
}

module.exports = new TelegramService();
