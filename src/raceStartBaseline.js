const { isValidTeamMetadata } = require('./weeklyState');
const { extractBudget } = require('./budget');

function activeChip(team, chips) {
  if (team.boosterid === null || team.boosterid === 0) return null;
  const name = chips?.get(team.boosterid);
  if (!name) throw new Error('Archived active chip is missing or unknown');
  return name;
}

async function carriedRoster(
  data,
  matchdayId,
  teamNo,
  chips,
  fetchArchivedTeam,
) {
  if (!isValidTeamMetadata(data, matchdayId, teamNo)) {
    throw new Error(
      'Archived race/team identity does not match the required baseline',
    );
  }
  const team = data.userTeam[0];
  const chip = activeChip(team, chips);
  if (chip === 'LIMITLESS') {
    if (matchdayId <= 1)
      throw new Error('Original pre-Limitless roster is unavailable');
    return carriedRoster(
      await fetchArchivedTeam(matchdayId - 1),
      matchdayId - 1,
      teamNo,
      chips,
      fetchArchivedTeam,
    );
  }

  let players = team.playerid;
  let captainId = team.capplayerid;
  if (!Array.isArray(players)) throw new Error('Archived roster is missing');
  if (chip === 'FINAL FIX') {
    const incoming = team.finalfxnewplayerid;
    const outgoing = team.finalfxoldplayerid;
    if (
      incoming === null ||
      incoming === undefined ||
      outgoing === null ||
      outgoing === undefined ||
      String(incoming) === '' ||
      String(outgoing) === '' ||
      String(incoming) === String(outgoing) ||
      players.length !== 8 ||
      players.filter(
        (p) => String(p?.id) === String(incoming) && Number(p.isfinal) === 1,
      ).length !== 1 ||
      players.filter(
        (p) => String(p?.id) === String(outgoing) && Number(p.isfinal) === 2,
      ).length !== 1
    )
      throw new Error('Final Fix restoration metadata is missing or ambiguous');
    // Final Fix transfers the boost to the temporary incoming driver. Its
    // captain ID must return to the outgoing driver along with the roster.
    const incomingPlayer = players.find(
      (p) => String(p.id) === String(incoming),
    );
    if (
      Number(incomingPlayer.iscaptain) === 1 &&
      captainId !== null &&
      captainId !== undefined &&
      ![String(incoming), String(outgoing)].includes(String(captainId))
    ) {
      throw new Error('Final Fix captain restoration metadata is inconsistent');
    }
    if (
      String(captainId) === String(incoming) ||
      Number(incomingPlayer.iscaptain) === 1
    )
      captainId = outgoing;
    players = players.filter((p) => String(p?.id) !== String(incoming));
  } else if (players.some((p) => Number(p?.isfinal) > 0)) {
    throw new Error('Final Fix player markers disagree with the active chip');
  }
  if (
    players.length !== 7 ||
    players.some(
      (p) => p?.id === undefined || p.id === null || String(p.id) === '',
    ) ||
    new Set(players.map((p) => String(p.id))).size !== 7
  )
    throw new Error('Carried roster must contain seven distinct players');

  // Temporary Final Fix/Extra DRS flags expire. Use the saved captain ID
  // where available rather than the scoring boost chosen by Autopilot.
  const hasSavedCaptain = captainId !== null && captainId !== undefined;
  if (
    hasSavedCaptain &&
    !players.some((p) => String(p.id) === String(captainId))
  ) {
    throw new Error('Archived captain is not in the restored roster');
  }
  const restored = players.map((p) => ({
    ...p,
    isfinal: 0,
    ismgcaptain: 0,
    ...(hasSavedCaptain
      ? { iscaptain: String(p.id) === String(captainId) ? 1 : 0 }
      : {}),
  }));
  return {
    data: {
      ...data,
      userTeam: [{ ...team, capplayerid: captainId, playerid: restored }],
    },
    sourceMatchdayId: matchdayId,
  };
}

function rosterValue(players, roster) {
  let value = 0;
  let drivers = 0;
  let constructors = 0;
  for (const player of players) {
    const info = roster?.get(String(player.id));
    if (!info?.name || !Number.isFinite(info.price) || info.price <= 0) {
      throw new Error('A baseline player has no valid price or identity');
    }
    if (info.kind === 'driver') drivers++;
    else if (info.kind === 'constructor') constructors++;
    else throw new Error('A baseline player has an unknown position');
    value += Math.round(info.price * 100);
  }
  if (drivers !== 5 || constructors !== 2)
    throw new Error('Baseline requires five drivers and two constructors');
  const captains = players.filter((p) => Number(p.iscaptain) === 1);
  if (
    captains.length > 1 ||
    captains.some((p) => roster.get(String(p.id)).kind !== 'driver')
  ) {
    throw new Error('Baseline captain selection is invalid');
  }
  return value;
}

async function reconstructRaceStartBaseline({
  previous,
  matchdayId,
  teamNo,
  chips,
  fetchArchivedTeam,
  getRoster,
}) {
  const previousMatchdayId = matchdayId - 1;
  const carried = await carriedRoster(
    previous,
    previousMatchdayId,
    teamNo,
    chips,
    fetchArchivedTeam,
  );
  const oldBudget = extractBudget(previous);
  if (!Number.isFinite(oldBudget) || oldBudget <= 0)
    throw new Error('Previous race cost cap is missing');
  const oldRoster = await getRoster(previousMatchdayId);
  const newRoster = await getRoster(matchdayId);
  const players = carried.data.userTeam[0].playerid;
  const oldValue = rosterValue(players, oldRoster);
  const newValue = rosterValue(players, newRoster);
  // Cash is restored alongside temporary chip changes. Nested cash can refer
  // to Final Fix's temporary driver and must not be copied to the baseline.
  const cash = Math.round(oldBudget * 100) - oldValue;
  if (cash < 0)
    throw new Error('Restored roster exceeds the archived regular cost cap');
  return {
    teamData: carried.data,
    teamStateStatus: 'reconstructed-race-start',
    teamStateMatchdayId: carried.sourceMatchdayId,
    budget: (newValue + cash) / 100,
    budgetStatus: 'calculated-race-start',
    budgetSourceMatchdayId: previousMatchdayId,
  };
}

module.exports = { reconstructRaceStartBaseline };
