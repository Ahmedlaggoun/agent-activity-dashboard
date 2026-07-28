import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, copyFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';

interface DeliverySecrets {
  githubToken: string;
  jiraEmail: string;
  jiraToken: string;
}

interface StoredDeliverySettings {
  github: {
    org: string;
    apiBaseUrl: string;
    repos: string[];
  };
  jira: {
    baseUrl: string;
    projectKeys: string[];
    devStatuses: string[];
    reviewStatuses: string[];
    validationStatuses: string[];
    doneStatuses: string[];
  };
  import: {
    startDate: string;
    anonymize: boolean;
    anonymizeSalt: string;
  };
  updatedAt: string;
}

interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: string;
}

export interface DeliverySettingsInput {
  github: {
    org: string;
    apiBaseUrl?: string;
    repos?: string[];
    token?: string;
  };
  jira: {
    baseUrl: string;
    email?: string;
    token?: string;
    projectKeys?: string[];
    devStatuses?: string[];
    reviewStatuses?: string[];
    validationStatuses?: string[];
    doneStatuses?: string[];
  };
  import: {
    startDate: string;
    anonymize?: boolean;
    anonymizeSalt?: string;
  };
}

export interface DeliverySettingsSummary {
  github: {
    org: string;
    apiBaseUrl: string;
    repos: string[];
    hasToken: boolean;
  };
  jira: {
    baseUrl: string;
    projectKeys: string[];
    devStatuses: string[];
    reviewStatuses: string[];
    validationStatuses: string[];
    doneStatuses: string[];
    hasCredentials: boolean;
  };
  import: {
    startDate: string;
    anonymize: boolean;
  };
  updatedAt: string;
  encryptionReady: boolean;
}

export interface DeliveryConnectionStatus {
  ok: boolean;
  message: string;
}

export interface DeliveryConnectionTestResult {
  github: DeliveryConnectionStatus;
  jira: DeliveryConnectionStatus;
}

export type DeliveryImportStatus = 'running' | 'succeeded' | 'failed';

export interface DeliveryImportRun {
  id: string;
  status: DeliveryImportStatus;
  startDate: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  message: string;
  progress: string[];
  artifactsPath: string;
  counts?: {
    pullRequests?: number;
    deploymentsToDefault?: number;
    tickets?: number;
    failures?: number;
  };
  latestSuccess: boolean;
  error?: string;
}

export interface DeliveryState {
  settings: DeliverySettingsSummary | null;
  activeRun: DeliveryImportRun | null;
  runs: DeliveryImportRun[];
}

interface DeliveryRuntimeConfig {
  now?: () => Date;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  runExtractor?: (request: DeliveryImportExecutionRequest) => Promise<void>;
  testGithub?: (settings: StoredDeliverySettings, secrets: DeliverySecrets) => Promise<DeliveryConnectionStatus>;
  testJira?: (settings: StoredDeliverySettings, secrets: DeliverySecrets) => Promise<DeliveryConnectionStatus>;
}

interface DeliveryImportExecutionRequest {
  configPath: string;
  outputDir: string;
  startDate: string;
  secrets: DeliverySecrets;
  onProgress: (message: string) => void;
}

interface PersistedRuns {
  runs: DeliveryImportRun[];
}

const DEFAULT_DEV_STATUSES = ['In Progress', 'En cours'];
const DEFAULT_REVIEW_STATUSES = ['In Review', 'Code Review', 'Revue'];
const DEFAULT_VALIDATION_STATUSES = ['In Validation', 'QA', 'Recette', 'To Verify'];
const DEFAULT_DONE_STATUSES = ['Done', 'Deployed', 'Closed', 'Termine', 'Terminee'];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanList(value: string[] | undefined, fallback: string[] = []): string[] {
  const seen = new Set<string>();
  const list = value ?? fallback;
  const out: string[] = [];
  for (const item of list) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function requireDateOnly(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format.`);
  }
  return value;
}

function requireTrustedServiceUrl(value: string, service: 'GitHub' | 'Jira'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${service} URL is invalid.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error(`${service} URL must use standard HTTPS without embedded credentials.`);
  }
  const hostname = url.hostname.toLowerCase();
  const trusted =
    service === 'GitHub'
      ? hostname === 'api.github.com'
      : hostname.endsWith('.atlassian.net');
  if (!trusted) {
    throw new Error(
      service === 'GitHub'
        ? 'This POC supports GitHub.com only.'
        : 'This POC supports Atlassian Cloud Jira URLs only.',
    );
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

function graphqlUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.includes('api.github.com')) return 'https://api.github.com/graphql';
  return apiBaseUrl.replace(/\/api\/v3\/?$/, '') + '/api/graphql';
}

function sanitizeExternalError(source: 'GitHub' | 'Jira' | 'import', error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthorized|forbidden|bad credentials|authentication/i.test(message)) {
    return `${source} authentication failed. Check the saved credentials.`;
  }
  if (/404|not found/i.test(message)) {
    return `${source} configuration is invalid. Check the organization, URL, or project keys.`;
  }
  if (/timeout|aborted|econn|network|fetch failed|getaddrinfo|enotfound/i.test(message)) {
    return `${source} is unreachable from the dashboard container.`;
  }
  if (source === 'import') {
    return 'The delivery import failed before producing a baseline.';
  }
  return `${source} validation failed. Review the saved configuration and try again.`;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function defaultGithubTest(settings: StoredDeliverySettings, secrets: DeliverySecrets): Promise<DeliveryConnectionStatus> {
  const res = await fetchJson(graphqlUrl(settings.github.apiBaseUrl), {
    method: 'POST',
    headers: {
      authorization: `bearer ${secrets.githubToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      query: 'query($org:String!){ organization(login:$org){ login repositories(first:1){ totalCount } } viewer { login } }',
      variables: { org: settings.github.org },
    }),
  });
  if (!res.ok) {
    throw new Error(`github ${res.status}`);
  }
  const data = (await res.json()) as {
    data?: { organization?: { login?: string; repositories?: { totalCount?: number } } };
    errors?: Array<{ message?: string }>;
  };
  if (data.errors?.length) {
    throw new Error(data.errors[0]?.message ?? 'github graphql error');
  }
  const org = data.data?.organization;
  if (!org?.login) {
    throw new Error('github organization not found');
  }
  const repoScope = settings.github.repos.length ? `${settings.github.repos.length} selected repos` : `${org.repositories?.totalCount ?? 0} visible repos`;
  return { ok: true, message: `GitHub connected to ${org.login} with ${repoScope}.` };
}

async function defaultJiraTest(settings: StoredDeliverySettings, secrets: DeliverySecrets): Promise<DeliveryConnectionStatus> {
  const baseUrl = settings.jira.baseUrl.replace(/\/$/, '');
  const auth = Buffer.from(`${secrets.jiraEmail}:${secrets.jiraToken}`).toString('base64');
  const projects = settings.jira.projectKeys;
  if (!projects.length) {
    const res = await fetchJson(`${baseUrl}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`jira ${res.status}`);
    return { ok: true, message: 'Jira connected.' };
  }
  for (const projectKey of projects) {
    const res = await fetchJson(`${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`jira ${res.status} ${projectKey}`);
  }
  return { ok: true, message: `Jira connected to ${projects.length} project key${projects.length === 1 ? '' : 's'}.` };
}

async function defaultRunExtractor(request: DeliveryImportExecutionRequest): Promise<void> {
  const args = [
    config.delivery.extractorPath,
    '--config',
    request.configPath,
    '--since',
    request.startDate,
    '--out',
    request.outputDir,
  ];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: dirname(config.delivery.extractorPath),
      env: {
        ...process.env,
        GITHUB_TOKEN: request.secrets.githubToken,
        JIRA_EMAIL: request.secrets.jiraEmail,
        JIRA_API_TOKEN: request.secrets.jiraToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    const flush = (chunk: string) => {
      const parts = chunk.split(/\r?\n/);
      const tail = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed) request.onProgress(trimmed);
      }
      return tail;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      stderr = flush(stderr);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (stderr.trim()) {
        flush(`${stderr}\n`);
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      const output = `${stdout}\n${stderr}`.trim();
      reject(new Error(output || `extractor exited with code ${code ?? 'unknown'}`));
    });
  });
}

export class DeliveryService {
  private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  private readonly now: () => Date;
  private readonly runExtractor: (request: DeliveryImportExecutionRequest) => Promise<void>;
  private readonly testGithub: (settings: StoredDeliverySettings, secrets: DeliverySecrets) => Promise<DeliveryConnectionStatus>;
  private readonly testJira: (settings: StoredDeliverySettings, secrets: DeliverySecrets) => Promise<DeliveryConnectionStatus>;
  private settings: StoredDeliverySettings | null = null;
  private secrets: DeliverySecrets | null = null;
  private runs: DeliveryImportRun[] = [];
  private activeRunId: string | null = null;
  private initialized = false;

  constructor(runtime: DeliveryRuntimeConfig = {}) {
    this.logger = runtime.logger ?? console;
    this.now = runtime.now ?? (() => new Date());
    this.runExtractor = runtime.runExtractor ?? defaultRunExtractor;
    this.testGithub = runtime.testGithub ?? defaultGithubTest;
    this.testJira = runtime.testJira ?? defaultJiraTest;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(config.delivery.settingsPath), { recursive: true });
    await mkdir(dirname(config.delivery.secretsPath), { recursive: true });
    await mkdir(dirname(config.delivery.runsPath), { recursive: true });
    await mkdir(config.delivery.artifactsDir, { recursive: true });
    this.settings = await this.readSettings();
    this.secrets = await this.readSecrets();
    this.runs = await this.readRuns();
    const recoveredAt = this.now().toISOString();
    let changed = false;
    this.runs = this.runs.map((run) => {
      if (run.status !== 'running') return run;
      changed = true;
      return {
        ...run,
        status: 'failed',
        latestSuccess: false,
        finishedAt: recoveredAt,
        durationMs: run.durationMs ?? Math.max(0, Date.parse(recoveredAt) - Date.parse(run.startedAt)),
        message: 'Import interrupted when the server stopped.',
        error: 'The previous import did not finish because the server restarted.',
      };
    });
    if (changed) {
      await this.writeRuns();
    }
    this.initialized = true;
  }

  async getState(): Promise<DeliveryState> {
    await this.init();
    return {
      settings: this.settings ? this.toSummary(this.settings, this.secrets) : null,
      activeRun: this.activeRunId ? this.runs.find((run) => run.id === this.activeRunId) ?? null : null,
      runs: [...this.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    };
  }

  async saveSettings(input: DeliverySettingsInput): Promise<DeliverySettingsSummary> {
    await this.init();
    this.requireEncryptionKey();
    const normalized = this.normalizeSettings(input, this.settings ?? undefined);
    const secrets = this.mergeSecrets(input, this.secrets ?? undefined);
    await this.writeSettings(normalized);
    await this.writeSecrets(secrets);
    this.settings = normalized;
    this.secrets = secrets;
    return this.toSummary(normalized, secrets);
  }

  async deleteSettings(): Promise<void> {
    await this.init();
    this.settings = null;
    this.secrets = null;
    await rm(config.delivery.settingsPath, { force: true });
    await rm(config.delivery.secretsPath, { force: true });
  }

  async testConnections(input?: DeliverySettingsInput): Promise<DeliveryConnectionTestResult> {
    await this.init();
    const settings = input ? this.normalizeSettings(input, this.settings ?? undefined) : this.settings;
    const secrets = input ? this.mergeSecrets(input, this.secrets ?? undefined) : this.secrets;
    if (!settings || !secrets) {
      throw new Error('Save or provide GitHub and Jira credentials before testing the connection.');
    }
    const [github, jira] = await Promise.all([
      this.testGithub(settings, secrets).catch((error: unknown) => ({
        ok: false,
        message: sanitizeExternalError('GitHub', error),
      })),
      this.testJira(settings, secrets).catch((error: unknown) => ({
        ok: false,
        message: sanitizeExternalError('Jira', error),
      })),
    ]);
    return { github, jira };
  }

  async startImport(startDate?: string): Promise<DeliveryImportRun> {
    await this.init();
    if (this.activeRunId) {
      throw new Error('A delivery import is already running.');
    }
    if (!this.settings || !this.secrets) {
      throw new Error('Save GitHub and Jira settings before starting an import.');
    }
    this.requireEncryptionKey();
    const effectiveStartDate = requireDateOnly(startDate ?? this.settings.import.startDate, 'Import start date');
    const id = `${this.now().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
    const runDir = resolve(config.delivery.artifactsDir, id);
    const outputDir = resolve(runDir, 'output');
    const configPath = resolve(runDir, 'config.json');
    const run: DeliveryImportRun = {
      id,
      status: 'running',
      startDate: effectiveStartDate,
      startedAt: this.now().toISOString(),
      message: 'Starting delivery import…',
      progress: [],
      artifactsPath: relative(config.dataDir, runDir) || '.',
      latestSuccess: false,
    };
    this.activeRunId = id;
    this.runs.unshift(run);
    await mkdir(outputDir, { recursive: true });
    await this.writeRuns();
    await this.writeRuntimeConfig(configPath, this.settings, effectiveStartDate);
    void this.executeImport(run, configPath, outputDir, runDir);
    return run;
  }

  private async executeImport(run: DeliveryImportRun, configPath: string, outputDir: string, runDir: string): Promise<void> {
    try {
      const secrets = this.secrets;
      if (!secrets) throw new Error('Missing delivery credentials.');
      await this.runExtractor({
        configPath,
        outputDir,
        startDate: run.startDate,
        secrets,
        onProgress: (message) => {
          const clean = this.sanitizeProgress(message);
          if (!clean) return;
          run.message = clean;
          run.progress = [clean, ...run.progress].slice(0, 20);
          void this.writeRuns();
        },
      });
      const latestPath = resolve(outputDir, 'latest-dora.json');
      const raw = await readFile(latestPath, 'utf8');
      const parsed = JSON.parse(raw) as { manifest?: { counts?: DeliveryImportRun['counts'] } };
      await mkdir(dirname(config.delivery.latestDoraPath), { recursive: true });
      await copyFile(latestPath, config.delivery.latestDoraPath);
      for (const existing of this.runs) {
        existing.latestSuccess = existing.id === run.id;
      }
      run.status = 'succeeded';
      run.finishedAt = this.now().toISOString();
      run.durationMs = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
      run.counts = parsed.manifest?.counts;
      run.message = 'Delivery baseline imported successfully.';
      run.progress = run.progress.length ? run.progress : ['Delivery baseline imported successfully.'];
      await this.writeRuns();
      this.logger.info({ runId: run.id, artifactsPath: relative(config.dataDir, runDir) }, 'delivery import finished');
    } catch (error) {
      run.status = 'failed';
      run.finishedAt = this.now().toISOString();
      run.durationMs = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
      run.error = sanitizeExternalError('import', error);
      run.message = run.error;
      run.latestSuccess = false;
      await this.writeRuns();
      this.logger.warn({ runId: run.id, err: error instanceof Error ? error.message : String(error) }, 'delivery import failed');
    } finally {
      this.activeRunId = null;
    }
  }

  private sanitizeProgress(message: string): string | null {
    const trimmed = message.trim();
    if (!trimmed) return null;
    const noControl = trimmed.replace(/\u001b\[[0-9;]*m/g, '');
    return noControl.replace(/https?:\/\/[^\s)]+/g, (value) => {
      try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return value;
      }
    });
  }

  private async writeRuntimeConfig(path: string, settings: StoredDeliverySettings, startDate: string): Promise<void> {
    const payload = {
      github: {
        apiBaseUrl: settings.github.apiBaseUrl,
        org: settings.github.org,
        repos: settings.github.repos,
        defaultBranchOverride: null,
      },
      jira: {
        baseUrl: settings.jira.baseUrl,
        projectKeys: settings.jira.projectKeys,
        devStatuses: settings.jira.devStatuses,
        reviewStatuses: settings.jira.reviewStatuses,
        validationStatuses: settings.jira.validationStatuses,
        doneStatuses: settings.jira.doneStatuses,
      },
      window: {
        monthsBack: 24,
      },
      failure: {
        hotfixBranchPattern: '^(hotfix|incident)/',
        hotfixLabels: ['hotfix', 'incident', 'hotfixes'],
      },
      anonymize: settings.import.anonymize,
      anonymizeSalt: settings.import.anonymizeSalt,
      _dashboardManagedStartDate: startDate,
      costLedgerPath: resolve(config.dataDir, 'cost-ledger.jsonl'),
    };
    await writeFile(path, JSON.stringify(payload, null, 2));
  }

  private normalizeSettings(input: DeliverySettingsInput, existing?: StoredDeliverySettings): StoredDeliverySettings {
    if (!isObject(input.github) || !isObject(input.jira) || !isObject(input.import)) {
      throw new Error('GitHub, Jira, and import settings are required.');
    }
    const githubOrg = input.github.org.trim();
    const jiraBaseUrl = requireTrustedServiceUrl(input.jira.baseUrl.trim(), 'Jira');
    if (!githubOrg) throw new Error('GitHub organization is required.');
    if (!jiraBaseUrl) throw new Error('Jira base URL is required.');
    const startDate = requireDateOnly(input.import.startDate, 'Import start date');
    const apiBaseUrl = requireTrustedServiceUrl(
      input.github.apiBaseUrl?.trim() ||
        existing?.github.apiBaseUrl ||
        config.delivery.defaultGithubApiBaseUrl,
      'GitHub',
    );
    const jiraProjectKeys = cleanList(input.jira.projectKeys as string[] | undefined, existing?.jira.projectKeys ?? []);
    if (!jiraProjectKeys.length) {
      throw new Error('At least one Jira project key is required.');
    }
    return {
      github: {
        org: githubOrg,
        apiBaseUrl,
        repos: cleanList(input.github.repos as string[] | undefined, existing?.github.repos ?? []),
      },
      jira: {
        baseUrl: jiraBaseUrl,
        projectKeys: jiraProjectKeys,
        devStatuses: cleanList(input.jira.devStatuses as string[] | undefined, existing?.jira.devStatuses ?? DEFAULT_DEV_STATUSES),
        reviewStatuses: cleanList(input.jira.reviewStatuses as string[] | undefined, existing?.jira.reviewStatuses ?? DEFAULT_REVIEW_STATUSES),
        validationStatuses: cleanList(input.jira.validationStatuses as string[] | undefined, existing?.jira.validationStatuses ?? DEFAULT_VALIDATION_STATUSES),
        doneStatuses: cleanList(input.jira.doneStatuses as string[] | undefined, existing?.jira.doneStatuses ?? DEFAULT_DONE_STATUSES),
      },
      import: {
        startDate,
        anonymize: input.import.anonymize ?? existing?.import.anonymize ?? true,
        anonymizeSalt:
          input.import.anonymizeSalt?.trim() ||
          existing?.import.anonymizeSalt ||
          randomBytes(16).toString('hex'),
      },
      updatedAt: this.now().toISOString(),
    };
  }

  private mergeSecrets(input: DeliverySettingsInput, existing?: DeliverySecrets): DeliverySecrets {
    const githubToken = input.github.token?.trim() || existing?.githubToken;
    const jiraEmail = input.jira.email?.trim() || existing?.jiraEmail;
    const jiraToken = input.jira.token?.trim() || existing?.jiraToken;
    if (!githubToken) throw new Error('GitHub token is required.');
    if (!jiraEmail || !jiraToken) throw new Error('Jira email and API token are required.');
    return { githubToken, jiraEmail, jiraToken };
  }

  private toSummary(settings: StoredDeliverySettings, secrets: DeliverySecrets | null): DeliverySettingsSummary {
    return {
      github: {
        org: settings.github.org,
        apiBaseUrl: settings.github.apiBaseUrl,
        repos: settings.github.repos,
        hasToken: !!secrets?.githubToken,
      },
      jira: {
        baseUrl: settings.jira.baseUrl,
        projectKeys: settings.jira.projectKeys,
        devStatuses: settings.jira.devStatuses,
        reviewStatuses: settings.jira.reviewStatuses,
        validationStatuses: settings.jira.validationStatuses,
        doneStatuses: settings.jira.doneStatuses,
        hasCredentials: !!(secrets?.jiraEmail && secrets.jiraToken),
      },
      import: {
        startDate: settings.import.startDate,
        anonymize: settings.import.anonymize,
      },
      updatedAt: settings.updatedAt,
      encryptionReady: !!config.credentialEncryptionKey,
    };
  }

  private requireEncryptionKey(): void {
    if (!config.credentialEncryptionKey) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY is required to store delivery credentials.');
    }
  }

  private keyBytes(): Buffer {
    this.requireEncryptionKey();
    return createHash('sha256').update(config.credentialEncryptionKey as string).digest();
  }

  private encrypt(payload: DeliverySecrets): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keyBytes(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      updatedAt: this.now().toISOString(),
    };
  }

  private decrypt(payload: EncryptedPayload): DeliverySecrets {
    const decipher = createDecipheriv('aes-256-gcm', this.keyBytes(), Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as DeliverySecrets;
  }

  private async readSettings(): Promise<StoredDeliverySettings | null> {
    try {
      const raw = await readFile(config.delivery.settingsPath, 'utf8');
      return JSON.parse(raw) as StoredDeliverySettings;
    } catch {
      return null;
    }
  }

  private async writeSettings(settings: StoredDeliverySettings): Promise<void> {
    await writeFile(config.delivery.settingsPath, JSON.stringify(settings, null, 2));
  }

  private async readSecrets(): Promise<DeliverySecrets | null> {
    try {
      const raw = await readFile(config.delivery.secretsPath, 'utf8');
      return this.decrypt(JSON.parse(raw) as EncryptedPayload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'delivery secrets unavailable');
      return null;
    }
  }

  private async writeSecrets(secrets: DeliverySecrets): Promise<void> {
    await writeFile(config.delivery.secretsPath, JSON.stringify(this.encrypt(secrets), null, 2));
  }

  private async readRuns(): Promise<DeliveryImportRun[]> {
    try {
      const raw = await readFile(config.delivery.runsPath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedRuns | DeliveryImportRun[];
      if (Array.isArray(parsed)) return parsed;
      return Array.isArray(parsed.runs) ? parsed.runs : [];
    } catch {
      return [];
    }
  }

  private async writeRuns(): Promise<void> {
    await writeFile(config.delivery.runsPath, JSON.stringify({ runs: this.runs }, null, 2));
  }

  async latestArtifactDirectories(): Promise<string[]> {
    await this.init();
    try {
      return (await readdir(config.delivery.artifactsDir)).sort();
    } catch {
      return [];
    }
  }
}
