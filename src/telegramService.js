const TelegramBot = require('node-telegram-bot-api');

const LOG_CHANNEL_ID = '-1002298860617';
const ERRORS_CHANNEL_ID = '-5167373779';

class TelegramService {
  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      console.warn('⚠️  TELEGRAM_BOT_TOKEN not set — Telegram notifications disabled');
      this.bot = null;

      return;
    }

    this.bot = new TelegramBot(token);
  }

  async sendMessage(message, chatId = LOG_CHANNEL_ID) {
    if (!this.bot) {
      console.log('[Telegram skip] Would send:', message.substring(0, 80));

      return;
    }

    try {
      const isChannelMessage = chatId === LOG_CHANNEL_ID || chatId === ERRORS_CHANNEL_ID;
      const formattedMessage = isChannelMessage ? `F1_FANTASY_API: ${message}` : message;

      await this.bot.sendMessage(chatId, formattedMessage, {
        parse_mode: 'Markdown',
      });
      console.log('Telegram notification sent successfully');
    } catch (error) {
      console.error('Failed to send Telegram notification:', error.message);
    }
  }

  async notifySuccess(data) {
    const leagueName = data?.leagueName || 'Unknown';
    const memberCount = data?.memberCount || '?';
    const teamCount = data?.teams?.length || 0;

    const message = `✅ *League data fetched successfully*
League: ${leagueName} (${memberCount} members)
Teams fetched: ${teamCount}
Fetched at: ${data?.fetchedAt || new Date().toISOString()}`;

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
