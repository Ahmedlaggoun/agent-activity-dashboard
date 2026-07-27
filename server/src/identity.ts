// Pseudonymization. When anonymize is on (default), a real identity (user.email,
// or the session id as fallback) is mapped to a STABLE friendly label like
// "swift-otter" — same person → same label across sessions, but no identity is
// stored or sent. Deterministic from a salt so restarts keep the same labels.
import { createHash } from 'node:crypto';
import { config } from './config.js';

const ADJ = [
  'swift', 'calm', 'bright', 'bold', 'keen', 'brave', 'lucid', 'quiet',
  'nimble', 'wry', 'sage', 'crisp', 'deft', 'vivid', 'stark', 'lithe',
];
const NOUN = [
  'otter', 'falcon', 'lynx', 'heron', 'ibex', 'marten', 'raven', 'wren',
  'tern', 'shrike', 'vole', 'gecko', 'orca', 'puma', 'seal', 'finch',
];

const cache = new Map<string, string>();

export function pseudonym(realKey: string): string {
  const cached = cache.get(realKey);
  if (cached) return cached;
  const h = createHash('sha256').update((config.anonymizeSalt || 'aad') + '|' + realKey).digest();
  const label = `${ADJ[h[0] % ADJ.length]}-${NOUN[h[1] % NOUN.length]}-${(h[2] % 100).toString().padStart(2, '0')}`;
  cache.set(realKey, label);
  return label;
}

/** Resolve the agent label for an event's identity. */
export function agentLabel(userEmail?: string, sessionId?: string): string {
  const key = userEmail || (sessionId ? `sess:${sessionId}` : 'unknown');
  return pseudonym(key);
}
