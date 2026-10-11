const { randomUUID } = require('node:crypto');

function safeText(value) {
  let text = String(value ?? 'unknown');

  for (const key of [
    'F1_FANTASY_EMAIL',
    'F1_FANTASY_PASSWORD',
    'TELEGRAM_BOT_TOKEN',
    'AZURE_STORAGE_CONNECTION_STRING',
  ]) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join('[redacted]');
  }

  return text
    .replace(/\/services\/user\/[^\s]+/g, '/services/user/[redacted]')
    .replace(
      /[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:-\d+-\d+)?/gi,
      '[redacted]',
    )
    .replace(/https?:\/\/[^\s]+/g, '[URL redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

class WeeklyDiagnostics {
  constructor() {
    this.runId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.currentMatchdayId = null;
    this.issues = new Map();
  }

  record(reason, context = {}, error = null) {
    const issue = this.issues.get(reason) || { count: 0, samples: [] };
    issue.count += 1;
    const details = Object.entries(context)
      .map(([key, value]) => `${key}=${safeText(value)}`)
      .join(', ');
    const sample = `${details}${error ? `; error=${safeText(error.message)}` : ''}`;
    if (issue.samples.length < 3 && !issue.samples.includes(sample)) {
      issue.samples.push(sample);
    }
    this.issues.set(reason, issue);
  }

  format({ preview = false } = {}) {
    const actionable = [...this.issues].filter(
      ([reason]) =>
        reason !== 'Transfer fields disagree — nested field selected',
    );
    if (!actionable.length) return null;

    const lines = [
      preview ? '🧪 PREVIEW — weekly data issue' : '⚠️ Weekly data issue',
    ];
    if (this.currentMatchdayId)
      lines.push(`Current race: ${this.currentMatchdayId}`);
    const fallback = this.issues.get(
      'Historical team fallback — transfers may be stale',
    );
    const unavailable = this.issues.get('Current team state unavailable');
    const rejected = this.issues.get('Upcoming team response rejected');
    const prices = this.issues.get(
      'Price feed matchday differs from current F1 matchday',
    );
    if (unavailable || fallback || rejected) {
      lines.push(
        `F1 did not provide current team data for ${(unavailable || fallback || rejected).count} team snapshots.`,
      );
      lines.push(
        unavailable
          ? 'Current budgets are unknown; older rosters are labeled historical.'
          : 'Historical transfer counts may be wrong for the current race.',
      );
    }
    const calculated = this.issues.get('Calculated race-start transfers');
    if (calculated)
      lines.push(
        `Transfers calculated for ${calculated.count} snapshots at race start; current usage is unknown.`,
      );
    if (prices) {
      const selected = prices.samples[0]?.match(/selected=(\d+)/)?.[1];
      lines.push(
        `Prices are from race ${selected || 'unknown'}, instead of the current race.`,
      );
    }
    const explained = new Set([
      'Upcoming team response rejected',
      'Historical team fallback — transfers may be stale',
      'Current team state unavailable',
      'Team snapshot matchday differs from current F1 matchday',
      'Price feed matchday differs from current F1 matchday',
      'Calculated race-start transfers',
    ]);
    const other = actionable.filter(([reason]) => !explained.has(reason));
    for (const [reason, issue] of other.slice(0, 3))
      lines.push(`${reason}: ${issue.count}`);
    if (other.length > 3)
      lines.push(
        `${other.length - 3} additional issue types; details in service logs.`,
      );
    lines.push(`Run: ${this.runId.slice(0, 8)}`);
    return lines.join('\n');
  }

  formatDetails({ preview = false } = {}) {
    if (!this.issues.size) return null;

    const lines = [
      preview
        ? '🧪 PREVIEW — weekly diagnostics (local run; no blobs uploaded)'
        : '⚠️ Weekly data diagnostics',
      `Run: ${this.runId}`,
      `Started: ${this.startedAt}`,
      `Current F1 matchday: ${this.currentMatchdayId ?? 'unknown'}`,
      'Counts are occurrences across leagues; examples are limited to 3 per issue.',
    ];
    for (const [reason, issue] of this.issues) {
      lines.push(
        '',
        `${reason}: ${issue.count}`,
        ...issue.samples.map((s) => `• ${s}`),
      );
    }
    lines.push(
      '',
      'Review before relying on this weekly snapshot; historical transfers are not verified current.',
    );

    return lines.join('\n');
  }
}

module.exports = { WeeklyDiagnostics };
