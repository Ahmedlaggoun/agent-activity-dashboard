import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { beforeEach } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(resolve(tmpdir(), 'aad-delivery-service-'));

process.env.DATA_DIR = tempRoot;
process.env.DB_PATH = resolve(tempRoot, 'history.db');
process.env.DELIVERY_SETTINGS_PATH = resolve(tempRoot, 'delivery/settings.json');
process.env.DELIVERY_SECRETS_PATH = resolve(tempRoot, 'delivery/secrets.json');
process.env.DELIVERY_RUNS_PATH = resolve(tempRoot, 'delivery/runs.json');
process.env.DELIVERY_ARTIFACTS_DIR = resolve(tempRoot, 'delivery/artifacts');
process.env.DELIVERY_LATEST_DORA_PATH = resolve(tempRoot, 'delivery/latest-success/latest-dora.json');
process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-delivery-key';

const { DeliveryService } = (await import(pathToFileURL(resolve(here, 'delivery.js')).href)) as typeof import('./delivery.js');

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function settingsInput() {
  return {
    github: {
      org: 'openai',
      apiBaseUrl: 'https://api.github.com',
      repos: ['agent-activity-dashboard'],
      token: 'ghs_test_secret',
    },
    jira: {
      baseUrl: 'https://example.atlassian.net',
      email: 'lead@example.com',
      token: 'jira_secret',
      projectKeys: ['AAD'],
      devStatuses: ['In Progress'],
      reviewStatuses: ['In Review'],
      validationStatuses: ['QA'],
      doneStatuses: ['Done'],
    },
    import: {
      startDate: '2026-01-01',
      anonymize: true,
      anonymizeSalt: 'local-salt',
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error('timed out waiting for condition');
}

test('saveSettings stores encrypted credentials and returns a redacted summary', async () => {
  const service = new DeliveryService();
  const summary = await service.saveSettings(settingsInput());

  assert.equal(summary.github.org, 'openai');
  assert.equal(summary.github.hasToken, true);
  assert.equal(summary.jira.hasCredentials, true);
  assert.equal(summary.import.startDate, '2026-01-01');
  assert.equal('token' in summary.github, false);
  assert.equal('anonymizeSalt' in summary.import, false);

  const encrypted = await readFile(process.env.DELIVERY_SECRETS_PATH as string, 'utf8');
  assert.match(encrypted, /ciphertext/);
  assert.doesNotMatch(encrypted, /ghs_test_secret|jira_secret|lead@example.com/);
});

test('rejects service URLs that could exfiltrate saved credentials', async () => {
  const service = new DeliveryService();
  const input = settingsInput();
  input.jira.baseUrl = 'https://attacker.example';
  await assert.rejects(() => service.saveSettings(input), /Atlassian Cloud/i);
});

test('only one delivery import can run at a time', async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const service = new DeliveryService({
    runExtractor: async ({ outputDir }) => {
      await writeFile(
        resolve(outputDir, 'latest-dora.json'),
        JSON.stringify({ manifest: { counts: { pullRequests: 1 } }, metrics: { dora: {} } }),
      );
      await blocker;
    },
  });

  await service.saveSettings(settingsInput());
  const first = await service.startImport();
  assert.equal(first.status, 'running');

  await assert.rejects(() => service.startImport(), /already running/i);
  release();
  await waitFor(async () => (await service.getState()).activeRun === null);
});

test('failed imports do not replace the latest successful baseline', async () => {
  let attempts = 0;
  const service = new DeliveryService({
    runExtractor: async ({ outputDir, onProgress }) => {
      attempts += 1;
      onProgress(`attempt ${attempts}`);
      if (attempts === 2) {
        throw new Error('401 bad credentials');
      }
      await writeFile(
        resolve(outputDir, 'latest-dora.json'),
        JSON.stringify({
          manifest: { counts: { pullRequests: 5, tickets: 3 } },
          metrics: { dora: { deploymentFrequency: { perWeek: 2 } } },
        }),
      );
    },
  });

  await service.saveSettings(settingsInput());
  const successRun = await service.startImport('2026-02-01');
  await waitFor(async () => (await service.getState()).runs.find((run) => run.id === successRun.id)?.status === 'succeeded');

  const latestAfterSuccess = JSON.parse(await readFile(process.env.DELIVERY_LATEST_DORA_PATH as string, 'utf8')) as {
    metrics: { dora: { deploymentFrequency: { perWeek: number } } };
  };
  assert.equal(latestAfterSuccess.metrics.dora.deploymentFrequency.perWeek, 2);

  const failedRun = await service.startImport('2026-03-01');
  await waitFor(async () => (await service.getState()).runs.find((run) => run.id === failedRun.id)?.status === 'failed');

  const state = await service.getState();
  const succeeded = state.runs.find((run) => run.id === successRun.id);
  const failed = state.runs.find((run) => run.id === failedRun.id);
  assert.equal(succeeded?.latestSuccess, true);
  assert.equal(failed?.latestSuccess, false);
  assert.match(failed?.error ?? '', /failed/i);

  const latestAfterFailure = JSON.parse(await readFile(process.env.DELIVERY_LATEST_DORA_PATH as string, 'utf8')) as {
    metrics: { dora: { deploymentFrequency: { perWeek: number } } };
  };
  assert.equal(latestAfterFailure.metrics.dora.deploymentFrequency.perWeek, 2);
});
