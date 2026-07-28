import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after, beforeEach } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(resolve(tmpdir(), 'aad-delivery-routes-'));

process.env.DATA_DIR = tempRoot;
process.env.DB_PATH = resolve(tempRoot, 'history.db');
process.env.DELIVERY_SETTINGS_PATH = resolve(tempRoot, 'delivery/settings.json');
process.env.DELIVERY_SECRETS_PATH = resolve(tempRoot, 'delivery/secrets.json');
process.env.DELIVERY_RUNS_PATH = resolve(tempRoot, 'delivery/runs.json');
process.env.DELIVERY_ARTIFACTS_DIR = resolve(tempRoot, 'delivery/artifacts');
process.env.DELIVERY_LATEST_DORA_PATH = resolve(tempRoot, 'delivery/latest-success/latest-dora.json');
process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-delivery-key';
process.env.COST_LEDGER = '0';

const { buildApp } = (await import(pathToFileURL(resolve(here, 'index.js')).href)) as typeof import('./index.js');
const { DeliveryService } = (await import(pathToFileURL(resolve(here, 'delivery.js')).href)) as typeof import('./delivery.js');

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error('timed out waiting for route condition');
}

test('delivery routes redact credentials and expose import history', async () => {
  const delivery = new DeliveryService({
    testGithub: async () => ({ ok: true, message: 'GitHub connected.' }),
    testJira: async () => ({ ok: true, message: 'Jira connected.' }),
    runExtractor: async ({ outputDir }) => {
      await writeFile(
        resolve(outputDir, 'latest-dora.json'),
        JSON.stringify({
          manifest: { counts: { pullRequests: 2, deploymentsToDefault: 1, tickets: 2 } },
          metrics: { dora: { deploymentFrequency: { perWeek: 1.5 } }, cost: { perMergedPrUsd: 3.25 } },
        }),
      );
    },
  });
  const app = await buildApp({ deliveryService: delivery });

  try {
    const save = await app.inject({
      method: 'PUT',
      url: '/api/delivery/settings',
      payload: {
        github: {
          org: 'openai',
          token: 'ghs_secret_value',
        },
        jira: {
          baseUrl: 'https://example.atlassian.net',
          email: 'lead@example.com',
          token: 'jira_secret_value',
          projectKeys: ['AAD'],
        },
        import: {
          startDate: '2026-01-01',
        },
      },
    });
    assert.equal(save.statusCode, 200, save.body);
    const saveBody = save.json() as {
      settings: {
        github: { hasToken: boolean; org: string };
        jira: { hasCredentials: boolean };
      };
    };
    assert.equal(saveBody.settings.github.hasToken, true);
    assert.equal(saveBody.settings.jira.hasCredentials, true);
    assert.equal(JSON.stringify(saveBody).includes('secret_value'), false);

    const testResponse = await app.inject({
      method: 'POST',
      url: '/api/delivery/test',
    });
    assert.equal(testResponse.statusCode, 200, testResponse.body);

    const start = await app.inject({
      method: 'POST',
      url: '/api/delivery/imports',
      payload: {},
    });
    assert.equal(start.statusCode, 202, start.body);
    const started = start.json() as { id: string };

    await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: '/api/delivery/imports' });
      const body = response.json() as { runs: Array<{ id: string; status: string }> };
      return body.runs.some((run) => run.id === started.id && run.status === 'succeeded');
    });

    const state = await app.inject({ method: 'GET', url: '/api/delivery' });
    assert.equal(state.statusCode, 200, state.body);
    const stateBody = state.json() as {
      activeRun: null;
      runs: Array<{ latestSuccess: boolean; counts?: { pullRequests?: number } }>;
    };
    assert.equal(stateBody.activeRun, null);
    assert.equal(stateBody.runs[0]?.latestSuccess, true);
    assert.equal(stateBody.runs[0]?.counts?.pullRequests, 2);

    const dora = await app.inject({ method: 'GET', url: '/api/dora' });
    assert.equal(dora.statusCode, 200, dora.body);
    const doraBody = dora.json() as { metrics: { cost: { perMergedPrUsd: number } } };
    assert.equal(doraBody.metrics.cost.perMergedPrUsd, 3.25);
  } finally {
    await app.close();
  }
});

test('delivery mutations reject untrusted browser origins', async () => {
  const app = await buildApp({ deliveryService: new DeliveryService() });
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/delivery/settings',
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});
