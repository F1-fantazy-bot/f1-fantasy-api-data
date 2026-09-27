const { deriveAccountId } = require('./accountId');

function identityKey(accountId, teamNo) {
  return accountId && teamNo != null ? `${accountId}:${teamNo}` : null;
}

function legacyKey(userName, teamName, teamNo) {
  return JSON.stringify([userName || '', teamName || '', Number(teamNo) || 1]);
}

// Historical blobs may have duplicate display identities. Retain only
// unambiguous legacy entries; an account-aware record must never fall back
// to another account merely because its display name matches.
function indexPriorRaceBudgets(priorTeams, currentEntries) {
  const exact = new Map();
  const legacy = new Map();
  const currentCounts = new Map();
  for (const entry of currentEntries || []) {
    const key = legacyKey(entry.user_name, decodeURIComponent(entry.team_name || ''), entry.team_no);
    currentCounts.set(key, (currentCounts.get(key) || 0) + 1);
  }
  for (const team of priorTeams || []) {
    if (!team?.raceBudgets || typeof team.raceBudgets !== 'object') continue;
    const key = identityKey(team.accountId, team.teamNo);
    if (key) {
      if (exact.has(key)) exact.set(key, null);
      else exact.set(key, team.raceBudgets);
    } else {
      const oldKey = legacyKey(team.userName, team.teamName, team.teamNo);
      if (legacy.has(oldKey)) legacy.set(oldKey, null);
      else legacy.set(oldKey, team.raceBudgets);
    }
  }
  return (entry) => {
    const exactKey = identityKey(deriveAccountId(entry.user_guid), entry.team_no || 1);
    if (exact.has(exactKey)) return exact.get(exactKey) || {};
    const oldKey = legacyKey(entry.user_name, decodeURIComponent(entry.team_name || ''), entry.team_no);
    return currentCounts.get(oldKey) === 1 ? legacy.get(oldKey) || {} : {};
  };
}

module.exports = { indexPriorRaceBudgets };
