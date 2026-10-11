const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconstructRaceStartBaseline } = require('./raceStartBaseline');

const chips = new Map([
  [1, 'LIMITLESS'],
  [2, 'WILDCARD'],
  [3, 'FINAL FIX'],
  [4, 'AUTO PILOT'],
  [5, 'NO NEGATIVE'],
  [6, 'EXTRA DRS'],
]);
function state(md = 17, chip = null) {
  return {
    mdid: md,
    userTeam: [
      {
        teamno: 2,
        boosterid: chip,
        capplayerid: '1',
        team_info: { maxTeambal: 100, teamVal: 90, teamBal: 10 },
        playerid: Array.from({ length: 7 }, (_, i) => ({
          id: String(i + 1),
          playerpostion: i + 1,
          iscaptain: i === 0 ? 1 : 0,
          ismgcaptain: i === 0 ? 1 : 0,
          isfinal: 0,
        })),
      },
    ],
  };
}
function roster(md) {
  return new Map(
    Array.from({ length: 7 }, (_, i) => [
      String(i + 1),
      {
        name: `Player ${i + 1}`,
        kind: i < 5 ? 'driver' : 'constructor',
        price: (i < 5 ? 10 : 20) + (md === 18 ? 1 : 0),
      },
    ]),
  );
}
function reconstruct(previous, overrides = {}) {
  return reconstructRaceStartBaseline({
    previous,
    matchdayId: 18,
    teamNo: 2,
    chips,
    getRoster: async (md) => roster(md),
    fetchArchivedTeam: async () => {
      throw new Error('Unexpected original-roster request');
    },
    ...overrides,
  });
}

test('ordinary and Wildcard rosters produce a labeled starting cap from new prices plus carried cash', async () => {
  for (const chip of [null, 0, 2, 4, 5, 6]) {
    const original = state(17, chip);
    const before = JSON.stringify(original);
    const result = await reconstruct(original);
    assert.equal(result.budget, 107);
    assert.equal(result.budgetStatus, 'calculated-race-start');
    assert.equal(result.budgetSourceMatchdayId, 17);
    assert.equal(result.teamStateStatus, 'reconstructed-race-start');
    assert.equal(result.teamStateMatchdayId, 17);
    assert(
      result.teamData.userTeam[0].playerid.every(
        (p) => p.ismgcaptain === 0 && p.isfinal === 0,
      ),
    );
    assert.equal(JSON.stringify(original), before);
  }
});

test('zero carried cash is valid and monetary arithmetic is rounded to cents', async () => {
  const original = state();
  original.userTeam[0].team_info.maxTeambal = 90;
  assert.equal((await reconstruct(original)).budget, 97);
  original.userTeam[0].team_info.maxTeambal = 100.1;
  assert.equal((await reconstruct(original)).budget, 107.1);
});

function finalFix(md = 17) {
  const data = state(md, 3);
  const team = data.userTeam[0];
  team.finalfxoldplayerid = '1';
  team.finalfxnewplayerid = '8';
  team.playerid[0].isfinal = 2;
  team.playerid.push({ id: '8', isfinal: 1, iscaptain: 1, playerpostion: 8 });
  team.team_info.teamBal = 5; // Temporary swap cash, not restored cash.
  return data;
}

test('Final Fix removes the incoming row, restores the original captain, and restores cash from the regular cap', async () => {
  const data = finalFix();
  data.userTeam[0].capplayerid = '8';
  data.userTeam[0].playerid[0].iscaptain = 0;
  const result = await reconstruct(data);
  const players = result.teamData.userTeam[0].playerid;
  assert.equal(players.length, 7);
  assert(players.some((p) => p.id === '1' && p.iscaptain === 1));
  assert.equal(
    players.some((p) => p.id === '8'),
    false,
  );
  assert.equal(result.budget, 107); // 97 roster + 10 restored cash, not 5.
});

test('Limitless uses the original pre-chip roster and the chip race regular cap, including a preceding Final Fix', async () => {
  for (const original of [state(16), finalFix(16)]) {
    const temporary = state(17, 1);
    temporary.userTeam[0].playerid = temporary.userTeam[0].playerid.map(
      (p) => ({ ...p, id: String(Number(p.id) + 20) }),
    );
    const requests = [];
    const result = await reconstruct(temporary, {
      fetchArchivedTeam: async (md) => {
        requests.push(md);
        return original;
      },
    });
    assert.deepEqual(requests, [16]);
    assert.equal(result.teamStateMatchdayId, 16);
    assert.equal(result.budgetSourceMatchdayId, 17);
    assert.equal(result.budget, 107);
    assert.deepEqual(
      result.teamData.userTeam[0].playerid.map((p) => p.id),
      ['1', '2', '3', '4', '5', '6', '7'],
    );
  }
});

test('unknown chips, wrong race/team, rejected archives, or missing original rosters are never guessed', async () => {
  const wrongTeam = state();
  wrongTeam.userTeam[0].teamno = 1;
  const rejected = state();
  rejected.Meta = { Success: false };
  const ambiguous = state();
  delete ambiguous.userTeam[0].boosterid;
  for (const data of [
    null,
    state(16),
    wrongTeam,
    rejected,
    ambiguous,
    state(17, 999),
  ]) {
    await assert.rejects(reconstruct(data));
  }
  await assert.rejects(
    reconstruct(state(17, 1), { fetchArchivedTeam: async () => null }),
    /identity/,
  );
});

test('malformed Final Fix markers, duplicate players, invalid captain, and impossible cash fail safely', async () => {
  const missingSwap = finalFix();
  delete missingSwap.userTeam[0].finalfxoldplayerid;
  const wrongMarker = finalFix();
  wrongMarker.userTeam[0].playerid[0].isfinal = 0;
  const staleMarker = state();
  staleMarker.userTeam[0].playerid[0].isfinal = 2;
  const duplicate = state();
  duplicate.userTeam[0].playerid[1].id = '1';
  const badCaptain = state();
  badCaptain.userTeam[0].capplayerid = '99';
  const negativeCash = state();
  negativeCash.userTeam[0].team_info.maxTeambal = 80;
  for (const data of [
    missingSwap,
    wrongMarker,
    staleMarker,
    duplicate,
    badCaptain,
    negativeCash,
  ])
    await assert.rejects(reconstruct(data));
});

test('missing prices and invalid player categories never turn into a zero-price baseline', async () => {
  for (const value of [null, undefined, 0, NaN]) {
    await assert.rejects(
      reconstruct(state(), {
        getRoster: async (md) => {
          const prices = roster(md);
          prices.get('1').price = value;
          return prices;
        },
      }),
      /valid price/,
    );
  }
  await assert.rejects(
    reconstruct(state(), {
      getRoster: async (md) => {
        const prices = roster(md);
        prices.get('6').kind = 'driver';
        return prices;
      },
    }),
    /five drivers/,
  );
});
