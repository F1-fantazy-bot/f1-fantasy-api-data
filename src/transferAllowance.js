const f1Api = require('./f1FantasyApiService');
const { isValidTeamMetadata } = require('./weeklyState');

// Rules are loaded once per run. Neither saved standings nor locked blobs
// supply transfer/chip metadata: those snapshots may have been scraped wrong.
async function loadTransferRules(matchdayId, diagnostics = null) {
  try {
    const [schedule, config] = await Promise.all([
      f1Api.getRaceSchedule(),
      f1Api.getWebConfig(),
    ]);
    const fixtures = (schedule?.Data || schedule)?.fixtures;
    const races = Array.isArray(fixtures)
      ? fixtures.filter((f) => Number(f.GamedayId) === matchdayId)
      : [];
    const base = races[0]?.SubstitutionsAllowed;
    const maxCarry = races[0]?.MaxSubstitutionsCF;
    if (
      !Number.isInteger(base) ||
      base < 0 ||
      !Number.isInteger(maxCarry) ||
      maxCarry < 0 ||
      races.some(
        (f) =>
          f.SubstitutionsAllowed !== base || f.MaxSubstitutionsCF !== maxCarry,
      )
    )
      throw new Error('Current race transfer rules missing or inconsistent');

    const boosters = (config?.Data || config)?.boosters;
    const chips = new Map();
    if (Array.isArray(boosters)) {
      for (const booster of boosters) {
        const id = Number(booster.BoosterId);
        const name = String(booster.BoosterName || '')
          .trim()
          .toUpperCase();
        if (
          Number.isInteger(id) &&
          id > 0 &&
          [
            'LIMITLESS',
            'WILDCARD',
            'FINAL FIX',
            'AUTO PILOT',
            'NO NEGATIVE',
            'EXTRA DRS',
          ].includes(name)
        )
          chips.set(id, name);
      }
    }
    const resetChips = new Set(
      [...chips]
        .filter(([, name]) => ['LIMITLESS', 'WILDCARD'].includes(name))
        .map(([id]) => id),
    );
    if (resetChips.size !== 2) throw new Error('Unlimited chip rules missing');
    return { matchdayId, base, maxCarry, chips, resetChips };
  } catch (err) {
    diagnostics?.record(
      'Transfer rules unavailable',
      { matchday: matchdayId },
      err,
    );
    return null;
  }
}

function chipKind(team, rules) {
  // A null/zero boosterid explicitly means no active chip. Season-level
  // is...taken/iswildcard flags can be stale and must never reset carry-over.
  if (team.boosterid === null || team.boosterid === 0) return 'ordinary';
  if (!Number.isInteger(team.boosterid) || !rules?.chips.has(team.boosterid))
    return 'unknown';
  return rules.resetChips.has(team.boosterid) ? 'unlimited' : 'ordinary';
}

function unknownTransfers() {
  return {
    transfersRemaining: null,
    transfersStatus: 'unknown',
    transfersSourceMatchdayId: null,
  };
}

function resolveTransferAllowance(
  current,
  previous,
  matchdayId,
  teamNo,
  rules,
) {
  if (isValidTeamMetadata(current, matchdayId, teamNo)) {
    const team = current.userTeam[0];
    const chip = chipKind(team, rules);
    const firstWeek =
      matchdayId === 1 || Number(team.fttourgdid) === matchdayId;
    if (firstWeek || chip === 'unlimited') {
      return {
        transfersRemaining: null,
        transfersStatus: 'unlimited',
        transfersSourceMatchdayId: matchdayId,
      };
    }
    const left = team.team_info?.userSubsleft ?? team.usersubsleft;
    if (chip === 'ordinary' && Number.isInteger(left)) {
      return {
        transfersRemaining: Math.max(0, left),
        transfersStatus: 'live',
        transfersSourceMatchdayId: matchdayId,
      };
    }
    // A known unlimited current week must never be replaced with a quota.
    if (chip === 'unknown') return unknownTransfers();
  }

  const previousMatchdayId = matchdayId - 1;
  if (
    rules?.matchdayId !== matchdayId ||
    !isValidTeamMetadata(previous, previousMatchdayId, teamNo)
  )
    return unknownTransfers();
  const team = previous.userTeam[0];
  const chip = chipKind(team, rules);
  const left = team.team_info?.userSubsleft ?? team.usersubsleft;
  if (chip === 'unknown' || (chip !== 'unlimited' && !Number.isInteger(left)))
    return unknownTransfers();
  // A first-team-week counter represents unlimited changes, not unused
  // ordinary free transfers. Do not infer carry-over from it.
  if (
    chip !== 'unlimited' &&
    (previousMatchdayId === 1 || Number(team.fttourgdid) === previousMatchdayId)
  )
    return unknownTransfers();
  const carry =
    chip === 'unlimited' ? 0 : Math.min(Math.max(left, 0), rules.maxCarry);
  return {
    transfersRemaining: rules.base + carry,
    transfersStatus: 'calculated-race-start',
    transfersSourceMatchdayId: previousMatchdayId,
  };
}

module.exports = { loadTransferRules, resolveTransferAllowance };
