// F1 returns transfer counts as numbers or numeric strings. The team_info
// value is the planning allowance; the root field can still be 0 for an
// upcoming matchday. Keep negative counts for locked transfer penalties.
function parseTransferCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const count = Number(value);

  return Number.isSafeInteger(count) ? count : null;
}

function extractTransfersRemaining(teamData) {
  const entry = Array.isArray(teamData?.userTeam) ? teamData.userTeam[0] : null;

  return parseTransferCount(entry?.team_info?.userSubsleft)
    ?? parseTransferCount(entry?.usersubsleft);
}

module.exports = { extractTransfersRemaining };
