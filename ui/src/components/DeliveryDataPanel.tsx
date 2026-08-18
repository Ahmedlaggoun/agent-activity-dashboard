import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ago, duration } from '../format';
import { apiFetch } from '../api/ws';

export const DORA_REFRESH_EVENT = 'aad:dora-refresh';

interface DeliveryDataPanelProps {
  open: boolean;
  onClose: () => void;
}

interface FormState {
  githubOrg: string;
  githubToken: string;
  jiraUrl: string;
  jiraEmail: string;
  jiraToken: string;
  jiraProjectKeys: string;
  repositories: string;
  startDate: string;
  anonymize: boolean;
}

interface NoticeState {
  tone: 'info' | 'success' | 'error';
  message: string;
}

interface SavedState {
  githubTokenSaved: boolean;
  jiraTokenSaved: boolean;
  hasSettings: boolean;
  updatedAt?: string;
}

interface DeliverySettingsSummary {
  github?: {
    org?: string;
    repos?: string[];
    hasToken?: boolean;
  };
  jira?: {
    baseUrl?: string;
    projectKeys?: string[];
    hasCredentials?: boolean;
  };
  import?: {
    startDate?: string;
    anonymize?: boolean;
  };
  updatedAt?: string;
}

interface DeliveryJob {
  id?: string;
  status?: string;
  phase?: string;
  message?: string;
  createdAt?: string | number;
  startedAt?: string | number;
  finishedAt?: string | number;
  durationMs?: number | null;
  current?: number;
  total?: number;
  counts?: Record<string, number>;
  error?: { message?: string } | string | null;
  progress?: {
    phase?: string;
    message?: string;
    current?: number;
    total?: number;
    counts?: Record<string, number>;
  } | null;
}

const EMPTY_FORM: FormState = {
  githubOrg: '',
  githubToken: '',
  jiraUrl: '',
  jiraEmail: '',
  jiraToken: '',
  jiraProjectKeys: '',
  repositories: '',
  startDate: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10),
  anonymize: true,
};

function toCsv(value: string[] | string | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

function settingsPayload(form: FormState): Record<string, unknown> {
  const jiraProjectKeys = form.jiraProjectKeys
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const repositories = form.repositories
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const payload: Record<string, Record<string, unknown>> = {
    github: {
      org: form.githubOrg.trim(),
      repos: repositories,
    },
    jira: {
      baseUrl: form.jiraUrl.trim(),
      email: form.jiraEmail.trim() || undefined,
      projectKeys: jiraProjectKeys,
    },
    import: {
      startDate: form.startDate,
      anonymize: form.anonymize,
    },
  };

  if (form.githubToken.trim()) payload.github.token = form.githubToken.trim();
  if (form.jiraToken.trim()) payload.jira.token = form.jiraToken.trim();
  return payload;
}

function normalizeDate(value: string | number | undefined): string {
  if (typeof value === 'string') return value.slice(0, 10);
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 10);
  return '';
}

function asTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

function formatDateTime(value: string | number | undefined): string {
  const ts = asTimestamp(value);
  if (!ts) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(ts);
}

function summarizeCountKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function countEntries(value: Record<string, number> | undefined): Array<[string, number]> {
  if (!value) return [];
  return Object.entries(value).filter((entry) => typeof entry[1] === 'number' && Number.isFinite(entry[1]));
}

function importError(job: DeliveryJob): string | null {
  if (typeof job.error === 'string') return job.error;
  return job.error?.message ?? null;
}

function jobLabel(job: DeliveryJob): string {
  const status = (job.status ?? job.phase ?? job.progress?.phase ?? '').toLowerCase();
  if (status.includes('success') || status.includes('complete')) return 'Completed';
  if (status.includes('fail') || status.includes('error')) return 'Failed';
  if (status.includes('queue')) return 'Queued';
  if (status.includes('run') || status.includes('progress') || status.includes('import')) return 'Running';
  return job.status ?? job.phase ?? 'Pending';
}

function jobTone(job: DeliveryJob): 'success' | 'error' | 'info' {
  const status = (job.status ?? job.phase ?? job.progress?.phase ?? '').toLowerCase();
  if (status.includes('success') || status.includes('complete')) return 'success';
  if (status.includes('fail') || status.includes('error')) return 'error';
  return 'info';
}

function isJobActive(job: DeliveryJob | null): boolean {
  if (!job) return false;
  const status = (job.status ?? job.phase ?? job.progress?.phase ?? '').toLowerCase();
  if (!status) return true;
  return !(
    status.includes('success') ||
    status.includes('complete') ||
    status.includes('fail') ||
    status.includes('error') ||
    status.includes('cancel')
  );
}

function isSuccessful(job: DeliveryJob | null | undefined): boolean {
  if (!job) return false;
  const status = (job.status ?? job.phase ?? job.progress?.phase ?? '').toLowerCase();
  return status.includes('success') || status.includes('complete');
}

async function readJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text) as T;
}

async function fetchStatus() {
  const response = await apiFetch('/api/delivery');
  const payload = (await readJson<Record<string, unknown>>(response)) ?? {};
  if (!response.ok) throw new Error(extractMessage(payload, 'Unable to load delivery status.'));
  const settings = (payload.settings ?? {}) as DeliverySettingsSummary;
  const activeImport = (payload.activeRun as DeliveryJob | null | undefined) ?? null;
  const hasSettings = Boolean(settings.github?.org && settings.jira?.baseUrl);
  return {
    settings,
    activeImport,
    hasSettings,
  };
}

async function fetchImports() {
  const response = await apiFetch('/api/delivery/imports');
  const payload = await readJson<Record<string, unknown> | DeliveryJob[]>(response);
  if (!response.ok) throw new Error(extractMessage(payload, 'Unable to load delivery history.'));
  if (Array.isArray(payload)) return payload as DeliveryJob[];
  return ((payload?.runs ?? []) as DeliveryJob[]).slice();
}

function extractMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    if (record.error && typeof record.error === 'object' && typeof (record.error as Record<string, unknown>).message === 'string') {
      return String((record.error as Record<string, unknown>).message);
    }
  }
  return fallback;
}

function statusSummary(settings: DeliverySettingsSummary, hasSettings: boolean) {
  return {
    githubTokenSaved: Boolean(settings.github?.hasToken),
    jiraTokenSaved: Boolean(settings.jira?.hasCredentials),
    hasSettings,
    updatedAt: settings.updatedAt,
  };
}

export function DeliveryDataPanel({ open, onClose }: DeliveryDataPanelProps) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const refreshGateRef = useRef<{ startedAt: number; id?: string } | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeImport, setActiveImport] = useState<DeliveryJob | null>(null);
  const [imports, setImports] = useState<DeliveryJob[]>([]);
  const [savedState, setSavedState] = useState<SavedState>({
    githubTokenSaved: false,
    jiraTokenSaved: false,
    hasSettings: false,
    updatedAt: undefined,
  });

  const latestImport = imports[0] ?? null;
  const historyStats = useMemo(() => {
    const completed = imports.filter((item) => isSuccessful(item)).length;
    const failed = imports.filter((item) => jobTone(item) === 'error').length;
    return {
      total: imports.length,
      completed,
      failed,
    };
  }, [imports]);

  const applySettings = (settings: DeliverySettingsSummary, hasSettings: boolean, hydrateForm: boolean) => {
    setSavedState(statusSummary(settings, hasSettings));
    if (!hydrateForm) return;
    setForm((current: FormState) => ({
      githubOrg: settings.github?.org ?? current.githubOrg,
      githubToken: '',
      jiraUrl: settings.jira?.baseUrl ?? current.jiraUrl,
      // Jira email is encrypted with the token and intentionally not returned.
      jiraEmail: '',
      jiraToken: '',
      jiraProjectKeys: settings.jira?.projectKeys != null ? toCsv(settings.jira.projectKeys) : current.jiraProjectKeys,
      repositories: settings.github?.repos != null ? toCsv(settings.github.repos) : current.repositories,
      startDate: settings.import?.startDate != null ? normalizeDate(settings.import.startDate) : current.startDate,
      anonymize: settings.import?.anonymize ?? current.anonymize,
    }));
  };

  const maybeDispatchDoraRefresh = (nextActiveImport: DeliveryJob | null, nextImports: DeliveryJob[]) => {
    const pending = refreshGateRef.current;
    if (!pending) return;
    if (nextActiveImport?.id && !pending.id) {
      refreshGateRef.current = { ...pending, id: nextActiveImport.id };
    }
    if (isJobActive(nextActiveImport)) return;

    const candidate = nextImports[0];
    if (!candidate) return;
    const candidateTs =
      asTimestamp(candidate.startedAt) ??
      asTimestamp(candidate.createdAt) ??
      asTimestamp(candidate.finishedAt) ??
      0;
    const sameImport = pending.id ? candidate.id === pending.id : candidateTs >= pending.startedAt - 5_000;
    if (!sameImport) return;

    if (isSuccessful(candidate)) {
      window.dispatchEvent(new Event(DORA_REFRESH_EVENT));
      setNotice({
        tone: 'success',
        message: 'Delivery baseline imported. DORA metrics are refreshing now.',
      });
    } else if (jobTone(candidate) === 'error') {
      setNotice({
        tone: 'error',
        message: importError(candidate) ?? 'The delivery import failed. Review the history details below.',
      });
    }

    refreshGateRef.current = null;
  };

  const refreshPanel = async (hydrateForm = false) => {
    const [status, history] = await Promise.all([fetchStatus(), fetchImports()]);
    applySettings(status.settings, status.hasSettings, hydrateForm);
    setActiveImport(status.activeImport);
    setImports(history);
    maybeDispatchDoraRefresh(status.activeImport, history);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    refreshPanel(true)
      .catch((error: unknown) => {
        if (!cancelled) {
          setNotice({
            tone: 'error',
            message: error instanceof Error ? error.message : 'Unable to load delivery data.',
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          firstInputRef.current?.focus();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !isJobActive(activeImport)) return;
    const timer = window.setInterval(() => {
      refreshPanel(false).catch((error: unknown) => {
        setNotice({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Unable to refresh import progress.',
        });
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [activeImport, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  const onField =
    <K extends keyof FormState>(key: K) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      if (key === 'anonymize') {
        setForm((current: FormState) => ({ ...current, anonymize: event.target.checked }));
        return;
      }
      setForm((current: FormState) => ({
        ...current,
        [key]: event.target.value,
      }));
    };

  const handleTest = async () => {
    setTesting(true);
    setNotice({ tone: 'info', message: 'Testing GitHub and Jira connections…' });
    try {
      const response = await apiFetch('/api/delivery/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPayload(form)),
      });
      const payload = (await readJson<Record<string, unknown>>(response)) ?? {};
      if (!response.ok) throw new Error(extractMessage(payload, 'Connection test failed.'));
      const github = payload.github && typeof payload.github === 'object' ? payload.github : null;
      const jira = payload.jira && typeof payload.jira === 'object' ? payload.jira : null;
      const githubMessage =
        github && typeof (github as Record<string, unknown>).message === 'string'
          ? String((github as Record<string, unknown>).message)
          : 'GitHub OK';
      const jiraMessage =
        jira && typeof (jira as Record<string, unknown>).message === 'string'
          ? String((jira as Record<string, unknown>).message)
          : 'Jira OK';
      const githubOk = github && (github as Record<string, unknown>).ok === true;
      const jiraOk = jira && (jira as Record<string, unknown>).ok === true;
      if (!githubOk || !jiraOk) {
        throw new Error(`${githubMessage} · ${jiraMessage}`);
      }
      setNotice({
        tone: 'success',
        message: `${githubMessage} · ${jiraMessage}`,
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setNotice({ tone: 'info', message: 'Saving encrypted delivery settings…' });
    try {
      const response = await apiFetch('/api/delivery/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPayload(form)),
      });
      const payload = (await readJson<Record<string, unknown>>(response)) ?? {};
      if (!response.ok) throw new Error(extractMessage(payload, 'Unable to save delivery settings.'));
      const settings = (payload.settings ?? {}) as DeliverySettingsSummary;
      applySettings(settings, true, true);
      setForm((current: FormState) => ({
        ...current,
        githubToken: '',
        jiraToken: '',
      }));
      setNotice({
        tone: 'success',
        message: 'Credentials saved securely. Tokens are now hidden from the dashboard.',
      });
      await refreshPanel(false);
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to save delivery settings.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete the saved GitHub and Jira credentials from this dashboard?')) return;
    setDeleting(true);
    setNotice({ tone: 'info', message: 'Removing saved delivery settings…' });
    try {
      const response = await apiFetch('/api/delivery/settings', { method: 'DELETE' });
      const payload = (await readJson<Record<string, unknown>>(response)) ?? {};
      if (!response.ok) throw new Error(extractMessage(payload, 'Unable to delete saved settings.'));
      setForm(EMPTY_FORM);
      setSavedState({
        githubTokenSaved: false,
        jiraTokenSaved: false,
        hasSettings: false,
        updatedAt: undefined,
      });
      setActiveImport(null);
      refreshGateRef.current = null;
      setNotice({
        tone: 'success',
        message: 'Saved delivery credentials removed from local storage.',
      });
      await refreshPanel(false).catch(() => {
        /* keep local reset state if the history endpoint is temporarily unavailable */
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to delete saved settings.',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleStartImport = async () => {
    if (!savedState.hasSettings) {
      setNotice({
        tone: 'error',
        message: 'Save the encrypted delivery settings before starting an import.',
      });
      return;
    }
    if (!form.startDate) {
      setNotice({
        tone: 'error',
        message: 'Select a baseline start date before starting an import.',
      });
      return;
    }

    setStarting(true);
    setNotice({ tone: 'info', message: 'Starting delivery import…' });
    try {
      const response = await apiFetch('/api/delivery/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: form.startDate }),
      });
      const payload = (await readJson<Record<string, unknown>>(response)) ?? {};
      if (!response.ok) throw new Error(extractMessage(payload, 'Unable to start the delivery import.'));
      const importJob = payload as DeliveryJob;
      refreshGateRef.current = {
        startedAt: Date.now(),
        id: importJob?.id,
      };
      setNotice({
        tone: 'info',
        message: 'Import started. Progress and counts will update automatically.',
      });
      await refreshPanel(false);
    } catch (error) {
      refreshGateRef.current = null;
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to start the delivery import.',
      });
    } finally {
      setStarting(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        className="drawer delivery-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-panel-title"
      >
        <header className="drawer-head delivery-panel-head">
          <div>
            <div className="drawer-title" id="delivery-panel-title">
              Delivery data
            </div>
            <div className="drawer-sub">
              Connect GitHub and Jira, save the credentials locally, and import a dated DORA baseline.
            </div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close delivery data panel">
            ✕
          </button>
        </header>

        <div className="delivery-panel-body">
          <section className="delivery-card delivery-card-tight">
            <div className="delivery-card-head">
              <div>
                <h3>Connection status</h3>
                <p>Saved tokens are never shown again after storage.</p>
              </div>
              {savedState.hasSettings && (
                <button
                  type="button"
                  className="delivery-button delivery-button-ghost"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Delete saved credentials'}
                </button>
              )}
            </div>
            <div className="delivery-status-grid">
              <div className={`delivery-status-chip ${savedState.githubTokenSaved ? 'is-on' : ''}`}>
                GitHub token {savedState.githubTokenSaved ? 'saved' : 'not saved'}
              </div>
              <div className={`delivery-status-chip ${savedState.jiraTokenSaved ? 'is-on' : ''}`}>
                Jira token {savedState.jiraTokenSaved ? 'saved' : 'not saved'}
              </div>
              <div className={`delivery-status-chip ${savedState.hasSettings ? 'is-on' : ''}`}>
                Settings {savedState.hasSettings ? 'ready' : 'missing'}
              </div>
            </div>
            {savedState.updatedAt && (
              <div className="delivery-status-meta">Last updated {formatDateTime(savedState.updatedAt)}</div>
            )}
          </section>

          <section className="delivery-card">
            <div className="delivery-card-head">
              <div>
                <h3>Connections</h3>
                <p>Read-only GitHub and Jira access for the delivery baseline importer.</p>
              </div>
            </div>
            <div className="delivery-form-grid">
              <label className="delivery-field">
                <span>GitHub organization</span>
                <input
                  ref={firstInputRef}
                  value={form.githubOrg}
                  onChange={onField('githubOrg')}
                  placeholder="acme-inc"
                  autoComplete="organization"
                />
              </label>
              <label className="delivery-field">
                <span>GitHub token</span>
                <input
                  type="password"
                  value={form.githubToken}
                  onChange={onField('githubToken')}
                  placeholder={savedState.githubTokenSaved ? 'Saved token hidden' : 'ghp_…'}
                  autoComplete="new-password"
                />
              </label>
              <label className="delivery-field">
                <span>Jira URL</span>
                <input
                  value={form.jiraUrl}
                  onChange={onField('jiraUrl')}
                  placeholder="https://company.atlassian.net"
                  inputMode="url"
                />
              </label>
              <label className="delivery-field">
                <span>Jira email</span>
                <input
                  type="email"
                  value={form.jiraEmail}
                  onChange={onField('jiraEmail')}
                  placeholder="lead@company.com"
                  autoComplete="email"
                />
              </label>
              <label className="delivery-field">
                <span>Jira token</span>
                <input
                  type="password"
                  value={form.jiraToken}
                  onChange={onField('jiraToken')}
                  placeholder={savedState.jiraTokenSaved ? 'Saved token hidden' : 'jira_pat_…'}
                  autoComplete="new-password"
                />
              </label>
              <label className="delivery-field">
                <span>Jira project keys</span>
                <input
                  value={form.jiraProjectKeys}
                  onChange={onField('jiraProjectKeys')}
                  placeholder="AAD, CORE, OPS"
                />
              </label>
              <label className="delivery-field delivery-field-wide">
                <span>Repositories</span>
                <input
                  value={form.repositories}
                  onChange={onField('repositories')}
                  placeholder="frontend, backend, analytics"
                />
              </label>
            </div>
            <div className="delivery-actions">
              <button
                type="button"
                className="delivery-button delivery-button-ghost"
                onClick={handleTest}
                disabled={testing || saving || starting}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button
                type="button"
                className="delivery-button"
                onClick={handleSave}
                disabled={saving || starting}
              >
                {saving ? 'Saving…' : 'Save securely'}
              </button>
            </div>
          </section>

          <section className="delivery-card">
            <div className="delivery-card-head">
              <div>
                <h3>Import baseline</h3>
                <p>Scope the imported history window and start a background run.</p>
              </div>
            </div>
            <div className="delivery-form-grid delivery-form-grid-compact">
              <label className="delivery-field">
                <span>Start date</span>
                <input type="date" value={form.startDate} onChange={onField('startDate')} />
              </label>
              <label className="delivery-toggle">
                <input
                  type="checkbox"
                  checked={form.anonymize}
                  onChange={onField('anonymize')}
                />
                <span>
                  <strong>Anonymize imported identities</strong>
                  <small>Store pseudonyms instead of raw email identifiers in the local baseline.</small>
                </span>
              </label>
            </div>
            <div className="delivery-actions">
              <button
                type="button"
                className="delivery-button"
                onClick={handleStartImport}
                disabled={starting || saving || deleting || isJobActive(activeImport)}
              >
                {starting ? 'Starting…' : isJobActive(activeImport) ? 'Import running…' : 'Start import'}
              </button>
            </div>
          </section>

          <section className="delivery-card">
            <div className="delivery-card-head">
              <div>
                <h3>Active import</h3>
                <p>Progress updates poll automatically while a run is active.</p>
              </div>
            </div>
            {activeImport ? (
              <div className={`delivery-active delivery-tone-${jobTone(activeImport)}`} aria-live="polite">
                <div className="delivery-active-head">
                  <strong>{jobLabel(activeImport)}</strong>
                  <span>{formatDateTime(activeImport.startedAt ?? activeImport.createdAt)}</span>
                </div>
                {(activeImport.progress?.current != null || activeImport.current != null) &&
                  (activeImport.progress?.total != null || activeImport.total != null) && (
                    <div className="delivery-progress">
                      <div
                        className="delivery-progress-bar"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round(
                              (((activeImport.progress?.current ?? activeImport.current ?? 0) /
                                Math.max(1, activeImport.progress?.total ?? activeImport.total ?? 1)) *
                                100),
                            ),
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                <div className="delivery-active-copy">
                  {activeImport.progress?.message ?? activeImport.message ?? 'Waiting for importer updates…'}
                </div>
                <div className="delivery-meta-row">
                  <span>
                    Started {ago(asTimestamp(activeImport.startedAt ?? activeImport.createdAt) ?? Date.now())}
                  </span>
                  <span>
                    Duration{' '}
                    {duration(
                      activeImport.durationMs ??
                        Math.max(
                          0,
                          Date.now() - (asTimestamp(activeImport.startedAt ?? activeImport.createdAt) ?? Date.now()),
                        ),
                    )}
                  </span>
                </div>
                {countEntries(activeImport.progress?.counts ?? activeImport.counts).length > 0 && (
                  <div className="delivery-count-grid">
                    {countEntries(activeImport.progress?.counts ?? activeImport.counts).map(([key, value]) => (
                      <div key={key} className="delivery-count-tile">
                        <strong>{value}</strong>
                        <span>{summarizeCountKey(key)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {importError(activeImport) && <div className="delivery-error">{importError(activeImport)}</div>}
              </div>
            ) : (
              <div className="delivery-empty-copy">No import is running right now.</div>
            )}
          </section>

          <section className="delivery-card">
            <div className="delivery-card-head">
              <div>
                <h3>History</h3>
                <p>Review previous baseline runs, their dates, durations, counts, and failures.</p>
              </div>
            </div>
            <div className="delivery-history-stats">
              <div className="delivery-count-tile">
                <strong>{historyStats.total}</strong>
                <span>Total runs</span>
              </div>
              <div className="delivery-count-tile">
                <strong>{historyStats.completed}</strong>
                <span>Completed</span>
              </div>
              <div className="delivery-count-tile">
                <strong>{historyStats.failed}</strong>
                <span>Failed</span>
              </div>
              <div className="delivery-count-tile">
                <strong>{latestImport ? formatDateTime(latestImport.finishedAt ?? latestImport.startedAt ?? latestImport.createdAt) : '—'}</strong>
                <span>Latest run</span>
              </div>
            </div>
            {imports.length === 0 ? (
              <div className="delivery-empty-copy">No baseline imports yet.</div>
            ) : (
              <div className="delivery-history-list">
                {imports.map((item, index) => (
                  <article key={item.id ?? `${item.startedAt ?? item.createdAt ?? index}`} className="delivery-history-item">
                    <div className="delivery-history-head">
                      <div>
                        <strong>{jobLabel(item)}</strong>
                        <span>{formatDateTime(item.finishedAt ?? item.startedAt ?? item.createdAt)}</span>
                      </div>
                      <span className={`delivery-pill delivery-pill-${jobTone(item)}`}>{jobLabel(item)}</span>
                    </div>
                    <div className="delivery-meta-row">
                      <span>Started {formatDateTime(item.startedAt ?? item.createdAt)}</span>
                      <span>
                        Duration{' '}
                        {duration(
                          item.durationMs ??
                            Math.max(
                              0,
                              (asTimestamp(item.finishedAt) ?? asTimestamp(item.startedAt) ?? Date.now()) -
                                (asTimestamp(item.startedAt ?? item.createdAt) ?? Date.now()),
                            ),
                        )}
                      </span>
                    </div>
                    {(item.message || item.progress?.message) && (
                      <div className="delivery-history-copy">{item.progress?.message ?? item.message}</div>
                    )}
                    {countEntries(item.counts ?? item.progress?.counts).length > 0 && (
                      <div className="delivery-count-grid">
                        {countEntries(item.counts ?? item.progress?.counts).map(([key, value]) => (
                          <div key={key} className="delivery-count-tile">
                            <strong>{value}</strong>
                            <span>{summarizeCountKey(key)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {importError(item) && <div className="delivery-error">{importError(item)}</div>}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="delivery-footer">
          {loading ? (
            <div className="delivery-empty-copy">Loading delivery settings…</div>
          ) : notice ? (
            <div className={`delivery-notice delivery-tone-${notice.tone}`} aria-live="polite">
              {notice.message}
            </div>
          ) : (
            <div className="delivery-empty-copy">Use the panel to manage the dated delivery baseline.</div>
          )}
        </footer>
      </aside>
    </>
  );
}
