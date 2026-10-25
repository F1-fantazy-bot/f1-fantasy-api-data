const { randomUUID } = require('node:crypto');
const { sanitize, safeText, safeStack } = require('./reportSanitizer');

class ExecutionDiagnostics {
  constructor(mode = 'weekly') {
    this.mode = mode;
    this.stage = 'fetch';
    this.context = {};
    this.sensitiveValues = new Set();
    this.runId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.currentMatchdayId = null;
    this.issues = new Map();
    this.information = new Map();
  }

  setStage(stage, context = {}) {
    this.stage = stage;
    this.context = context;
  }

  protect(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && String(value).length)
        this.sensitiveValues.add(String(value));
    }
  }

  hasFailures() {
    return [...this.issues.keys()].some(
      (reason) => reason !== 'Transfer fields disagree — nested field selected',
    );
  }

  record(reason, context = {}, error = null) {
    this._record(this.issues, reason, context, error);
  }

  recordInfo(reason, context = {}) {
    this._record(this.information, reason, context);
  }

  _record(collection, reason, context, error = null) {
    reason = safeText(reason, this.sensitiveValues);
    const issue = collection.get(reason) || {
      count: 0,
      samples: [],
      examples: [],
    };
    issue.count += 1;
    const details = Object.entries({
      stage: this.stage,
      ...this.context,
      ...context,
    })
      .map(
        ([key, value]) =>
          `${safeText(key)}=${/account|guid|social|userName/i.test(key) ? '[redacted]' : safeText(value, this.sensitiveValues)}`,
      )
      .join(', ');
    const sample = `${details}${error ? `; error=${safeText(error.message ?? error, this.sensitiveValues)}` : ''}`;
    if (issue.samples.length < 3 && !issue.samples.includes(sample)) {
      issue.samples.push(sample);
      issue.examples.push({
        summary: sample,
        stack: safeStack(error, this.sensitiveValues),
      });
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
    if (this.mode !== 'weekly') {
      if (!this.hasFailures()) return null;
      return `${preview ? '🧪 PREVIEW — ' : '⚠️ '}Locked data partially available\n${[...this.issues].map(([reason, issue]) => `${reason}: ${issue.count}`).join('\n')}`;
    }
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
        ? `🧪 PREVIEW — ${this.mode} diagnostics (local run; no blobs uploaded)`
        : `🔎 ${this.mode === 'weekly' ? 'Weekly' : 'Locked'} debug diagnostics`,
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

  formatFailureReport() {
    if (!this.hasFailures()) return null;
    const fatal =
      this.issues.has('Fatal execution failure') ||
      this.issues.has('Browser cleanup failed');
    const lines = [
      `${fatal ? '❌' : '⚠️'} ${this.mode} execution ${fatal ? 'failed' : 'completed with partial failures'}`,
      fatal
        ? this.currentMatchdayId
          ? `Current race: ${this.currentMatchdayId}`
          : null
        : this.format({ includeInfo: false }),
      'Counts are occurrences; at most 3 examples per failure category.',
    ];
    for (const [reason, issue] of this.issues) {
      if (reason === 'Transfer fields disagree — nested field selected')
        continue;
      lines.push('', `${reason}: ${issue.count}`);
      for (const example of issue.examples) {
        lines.push(`• ${example.summary}`);
        if (example.stack) lines.push(example.stack);
      }
    }
    // Apply again to catch identifiers learned later in this execution.
    return sanitize(lines.filter(Boolean).join('\n'), this.sensitiveValues);
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

class WeeklyDiagnostics extends ExecutionDiagnostics {}

module.exports = { WeeklyDiagnostics, ExecutionDiagnostics };
