const { execFile } = require('node:child_process');
const { appendFile } = require('node:fs/promises');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const LATEST_IMAGE = 'f1fantasyacr.azurecr.io/f1-fantasy-api-data:latest';
const CONTAINER_GROUPS = [
  'f1-fantasy-api-data-aci',
  'f1-fantasy-api-data-aci-locked',
];
const QUERY =
  '{name:name,provisioningState:provisioningState,groupState:instanceView.state,containers:containers[].{image:image,state:instanceView.currentState.state,detailStatus:instanceView.currentState.detailStatus}}';

function decideContainerAction(snapshot) {
  if (
    ['Stopped', 'Terminated', 'Succeeded', 'Failed'].includes(
      snapshot?.groupState,
    )
  )
    return { action: 'leave', reason: 'Container group is inactive' };
  const containers = snapshot?.containers;
  if (!Array.isArray(containers) || !containers.length)
    return { action: 'leave', reason: 'Container state is unavailable' };
  if (containers.some((container) => container?.state === 'Running'))
    return { action: 'leave', reason: 'Running scrape left to finish' };
  if (
    containers.some((container) =>
      ['Stopped', 'Terminated'].includes(container?.state),
    )
  )
    return { action: 'leave', reason: 'Container is stopped or terminated' };
  if (
    snapshot.provisioningState === 'Succeeded' &&
    snapshot.groupState === 'Running' &&
    containers.length === 1 &&
    containers[0]?.state === 'Waiting' &&
    /^CrashLoopBackOff(?::|$)/.test(containers[0]?.detailStatus || '')
  )
    return { action: 'stop', reason: 'Confirmed CrashLoopBackOff' };
  return {
    action: 'leave',
    reason: 'No confirmed crash loop; state left unchanged',
  };
}

function configurationProblem(snapshot) {
  if (
    Array.isArray(snapshot?.containers) &&
    snapshot.containers.length &&
    snapshot.containers.every((container) => container?.image === LATEST_IMAGE)
  )
    return null;
  return (
    'Expected :latest configuration is missing or pinned to another image. ' +
    'Plan a separate manual ACI deployment with :latest during an approved capture/maintenance window; ' +
    'that migration restarts the workload and may run a scrape. No image configuration was changed.'
  );
}

async function azure(args) {
  const { stdout } = await execute('az', args, { maxBuffer: 1024 * 1024 });
  return stdout;
}

async function inspectReleaseContainer({
  name,
  resourceGroup = 'f1-fantazy-bot',
  runAzure = azure,
}) {
  if (!CONTAINER_GROUPS.includes(name))
    throw new Error('Unexpected container group');
  const inspect = async () =>
    JSON.parse(
      await runAzure([
        'container',
        'show',
        '--resource-group',
        resourceGroup,
        '--name',
        name,
        '--query',
        QUERY,
        '--output',
        'json',
        '--only-show-errors',
      ]),
    );
  let snapshot = await inspect();
  let decision = decideContainerAction(snapshot);
  if (decision.action === 'stop') {
    // A retry may have become a healthy run since the initial inspection.
    snapshot = await inspect();
    decision = decideContainerAction(snapshot);
  }
  if (decision.action === 'stop') {
    await runAzure([
      'container',
      'stop',
      '--resource-group',
      resourceGroup,
      '--name',
      name,
      '--output',
      'none',
      '--only-show-errors',
    ]);
    decision = {
      action: 'stopped',
      reason:
        'Confirmed crash loop stopped; next start remains scheduled/manual',
    };
  }
  return {
    name,
    ...decision,
    images: snapshot?.containers?.map((container) => container?.image) || [],
    configurationProblem: configurationProblem(snapshot),
  };
}

async function main() {
  const result = await inspectReleaseContainer({
    name: process.argv[2],
    resourceGroup: process.env.RESOURCE_GROUP,
  });
  console.log(`${result.name}: ${result.reason}`);
  console.log(`Configured image: ${result.images.join(', ') || 'unknown'}`);
  console.log(
    'Image published does not mean new version executed. No fetcher was started or redeployed.',
  );
  if (result.configurationProblem) {
    console.error(result.configurationProblem);
    process.exitCode = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## ${result.name}\n\n${result.reason}\n\n` +
        `Configured image: ${result.images.join(', ') || 'unknown'}\n\n` +
        `${result.configurationProblem || 'Configuration remains on :latest.'}\n\n` +
        'No fetcher was started or redeployed. New-version execution is not verified by this release.\n',
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      'Post-publication container inspection failed:',
      error.message,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  LATEST_IMAGE,
  decideContainerAction,
  inspectReleaseContainer,
};
