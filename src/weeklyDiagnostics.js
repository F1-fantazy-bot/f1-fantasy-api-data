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
    this.information = new Map();
  }

  record(reason, context = {}, error = null) {
    this._record(this.issues, reason, context, error);
  }

  recordInfo(reason, context = {}) {
    this._record(this.information, reason, context);
  }

  _record(collection, reason, context, error = null) {
    const issue = collection.get(reason) || { count: 0, samples: [] };
    issue.count += 1;
    const details = Object.entries(context)
      .map(([key, value]) => `${key}=${safeText(value)}`)
      .join(', ');
    const sample = `${details}${error ? `; error=${safeText(error.message)}` : ''}`;
    if (issue.samples.length < 3 && !issue.samples.includes(sample)) {
      issue.samples.push(sample);
    }
    collection.set(reason, issue);
  }

  formatInfo() {
    const baseline = this.information.get('Reconstructed race-start baselines');
    const calculated = this.information.get('Calculated race-start transfers');
    const lines = [];
    if (baseline)
      lines.push(
        `ℹ️ Race-start rosters and budgets reconstructed for ${baseline.count} team snapshots.`,
      );
    if (calculated)
      lines.push(
        `ℹ️ Race-start transfer allowances calculated for ${calculated.count} team snapshots; current usage is unknown.`,
      );
    return lines.length ? lines.join('\n') : null;
  }

  format({ preview = false, includeInfo = true } = {}) {
    const actionable = [...this.issues].filter(
      ([reason]) =>
        reason !== 'Transfer fields disagree — nested field selected',
    );
    if (!actionable.length) return null;

    const lines = [
      preview
        ? '🧪 PREVIEW — weekly data warning'
        : '⚠️ Weekly data partially available',
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
    if (unavailable || fallback) {
      lines.push(
        `Recommendation baselines unavailable for ${(unavailable || fallback).count} team snapshots.`,
      );
      lines.push(
        unavailable
          ? 'Current budgets are unknown; older rosters are labeled historical.'
          : 'Historical transfer counts may be wrong for the current race.',
      );
    }
    if (rejected)
      lines.push(`Unexpected current-team responses: ${rejected.count}`);
    const information = this.formatInfo();
    if (includeInfo && information) lines.push(information);
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
    if (!this.issues.size && !this.information.size) return null;

    const lines = [
      preview
        ? '🧪 PREVIEW — weekly diagnostics (local run; no blobs uploaded)'
        : '🔎 Weekly debug diagnostics',
      `Run: ${this.runId}`,
      `Started: ${this.startedAt}`,
      `Current F1 matchday: ${this.currentMatchdayId ?? 'unknown'}`,
      'Counts are occurrences across leagues; examples are limited to 3 per issue.',
    ];
    for (const [label, collection] of [
      ['Warning', this.issues],
      ['Info', this.information],
    ]) {
      for (const [reason, issue] of collection) {
        lines.push(
          '',
          `${label} — ${reason}: ${issue.count}`,
          ...issue.samples.map((s) => `• ${s}`),
        );
      }
    }

    return lines.join('\n');
  }

  logToConsole({ debug = process.env.F1_WEEKLY_DEBUG === 'true' } = {}) {
    const warning = this.format({ includeInfo: false });
    if (warning) console.warn(warning);
    const information = this.formatInfo();
    if (information) console.log(information);
    if (debug) {
      const details = this.formatDetails();
      if (details) console.debug(details);
    }
  }
}

module.exports = { WeeklyDiagnostics };
