const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LATEST_IMAGE,
  decideContainerAction,
  inspectReleaseContainer,
} = require('../scripts/stop-crash-loop');

function snapshot(
  state = 'Waiting',
  detailStatus = 'CrashLoopBackOff: Back-off restarting failed',
) {
  return {
    provisioningState: 'Succeeded',
    groupState: 'Running',
    containers: [{ image: LATEST_IMAGE, state, detailStatus }],
  };
}

function mockAzure(snapshots, { showError = null, stopError = null } = {}) {
  const commands = [];
  const runAzure = async (args) => {
    commands.push(args);
    if (args[1] === 'show') {
      if (showError) throw showError;
      return JSON.stringify(snapshots.shift());
    }
    assert.equal(args[0], 'container');
    assert.equal(args[1], 'stop', 'The only mutation allowed is stop');
    if (stopError) throw stopError;
    return '';
  };
  return { commands, runAzure };
}

for (const name of [
  'f1-fantasy-api-data-aci',
  'f1-fantasy-api-data-aci-locked',
]) {
  test(`${name}: two current crash-loop observations allow stop, never start/redeploy`, async () => {
    const mock = mockAzure([snapshot(), snapshot()]);
    const result = await inspectReleaseContainer({
      name,
      runAzure: mock.runAzure,
    });
    assert.equal(result.action, 'stopped');
    assert.equal(result.configurationProblem, null);
    assert.deepEqual(
      mock.commands.map((args) => args.slice(0, 2)),
      [
        ['container', 'show'],
        ['container', 'show'],
        ['container', 'stop'],
      ],
    );
    for (const args of mock.commands) {
      assert.equal(args[args.indexOf('--name') + 1], name);
      assert.equal(
        args[args.indexOf('--resource-group') + 1],
        'f1-fantazy-bot',
      );
    }
  });
}

for (const [label, data] of [
  ['healthy running scrape', snapshot('Running', '')],
  ['running retry with stale failure text', snapshot('Running')],
  ['terminated failed attempt', snapshot('Terminated', 'Error')],
  ['stopped container', snapshot('Stopped')],
  [
    'stopped group with stale crash-loop state',
    { ...snapshot(), groupState: 'Stopped' },
  ],
  ['succeeded group', { ...snapshot(), groupState: 'Succeeded' }],
  ['failed group', { ...snapshot(), groupState: 'Failed' }],
  ['terminated group', { ...snapshot(), groupState: 'Terminated' }],
  ['image pull failure', snapshot('Waiting', 'ImagePullBackOff')],
  ['ordinary startup', snapshot('Waiting', 'ContainerCreating')],
  ['generic backoff', snapshot('Waiting', 'Back-off restarting failed')],
  [
    'past crash loop only',
    {
      ...snapshot('Waiting', ''),
      previousState: { detailStatus: 'CrashLoopBackOff', exitCode: 1 },
      restartCount: 1000,
    },
  ],
  [
    'missing runtime state',
    { ...snapshot(), groupState: null, containers: [{ image: LATEST_IMAGE }] },
  ],
  ['unknown group state', { ...snapshot(), groupState: 'Pending' }],
  ['deployment in progress', { ...snapshot(), provisioningState: 'Updating' }],
  [
    'multiple containers',
    {
      ...snapshot(),
      containers: [
        ...snapshot().containers,
        ...snapshot('Running', '').containers,
      ],
    },
  ],
  ['missing details', snapshot('Waiting', null)],
]) {
  test(`${label}: leave the workload alone`, async () => {
    const mock = mockAzure([data]);
    const result = await inspectReleaseContainer({
      name: 'f1-fantasy-api-data-aci',
      runAzure: mock.runAzure,
    });
    assert.equal(result.action, 'leave');
    assert.equal(mock.commands.length, 1);
  });
}

test('absent or malformed container state never authorizes a stop', () => {
  for (const data of [null, {}, { containers: [] }, { containers: [null] }])
    assert.equal(decideContainerAction(data).action, 'leave');
});

for (const state of ['Running', 'Terminated', 'Stopped']) {
  test(`recheck transitions to ${state}: do not interrupt the scrape`, async () => {
    const mock = mockAzure([snapshot(), snapshot(state, '')]);
    const result = await inspectReleaseContainer({
      name: 'f1-fantasy-api-data-aci',
      runAzure: mock.runAzure,
    });
    assert.equal(result.action, 'leave');
    assert.equal(mock.commands.length, 2);
  });
}

test('a recheck that loses crash-loop confirmation leaves the group alone', async () => {
  const mock = mockAzure([
    snapshot(),
    snapshot('Waiting', 'ContainerCreating'),
  ]);
  const result = await inspectReleaseContainer({
    name: 'f1-fantasy-api-data-aci',
    runAzure: mock.runAzure,
  });
  assert.equal(result.action, 'leave');
  assert.equal(mock.commands.length, 2);
});

for (const image of [
  'f1fantasyacr.azurecr.io/f1-fantasy-api-data@sha256:' + 'a'.repeat(64),
  'f1fantasyacr.azurecr.io/f1-fantasy-api-data:old-commit',
]) {
  test(`non-latest image reports a separate migration without redeploying: ${image}`, async () => {
    const data = snapshot('Terminated', 'Completed');
    data.containers[0].image = image;
    const mock = mockAzure([data]);
    const result = await inspectReleaseContainer({
      name: 'f1-fantasy-api-data-aci',
      runAzure: mock.runAzure,
    });
    assert.match(result.configurationProblem, /separate manual ACI deployment/);
    assert.match(result.configurationProblem, /may run a scrape/);
    assert.equal(mock.commands.length, 1);
    assert.equal(data.containers[0].image, image);
  });
}

test('a pinned crash loop may be stopped but its image is never silently migrated', async () => {
  const data = snapshot();
  data.containers[0].image = 'pinned-image@sha256:old';
  const mock = mockAzure([data, structuredClone(data)]);
  const result = await inspectReleaseContainer({
    name: 'f1-fantasy-api-data-aci',
    runAzure: mock.runAzure,
  });
  assert.equal(result.action, 'stopped');
  assert(result.configurationProblem);
  assert(mock.commands.every((args) => ['show', 'stop'].includes(args[1])));
});

test('an Azure inspection failure never causes a mutation', async () => {
  const failure = new Error('Azure read failed');
  const mock = mockAzure([], { showError: failure });
  await assert.rejects(
    inspectReleaseContainer({
      name: 'f1-fantasy-api-data-aci',
      runAzure: mock.runAzure,
    }),
    failure,
  );
  assert.equal(mock.commands.length, 1);
});

test('a failed recheck never authorizes stopping a previously observed crash loop', async () => {
  const commands = [];
  const result = inspectReleaseContainer({
    name: 'f1-fantasy-api-data-aci',
    runAzure: async (args) => {
      commands.push(args);
      if (commands.length === 1) return JSON.stringify(snapshot());
      throw new Error('Recheck unavailable');
    },
  });
  await assert.rejects(result, /Recheck unavailable/);
  assert.equal(commands.length, 2);
  assert(commands.every((args) => args[1] === 'show'));
});

test('a stop failure is reported without starting, restarting or redeploying', async () => {
  const failure = new Error('Azure stop failed');
  const mock = mockAzure([snapshot(), snapshot()], { stopError: failure });
  await assert.rejects(
    inspectReleaseContainer({
      name: 'f1-fantasy-api-data-aci',
      runAzure: mock.runAzure,
    }),
    failure,
  );
  assert.equal(mock.commands.length, 3);
});

test('unexpected resource names cannot be inspected or stopped', async () => {
  const mock = mockAzure([]);
  await assert.rejects(
    inspectReleaseContainer({
      name: 'unrelated-container',
      runAzure: mock.runAzure,
    }),
    /Unexpected container group/,
  );
  assert.equal(mock.commands.length, 0);
});
