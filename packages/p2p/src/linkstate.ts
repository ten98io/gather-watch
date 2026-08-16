/**
 * Link path classification from raw WebRTC stats: is the selected candidate
 * pair direct or TURN-relayed? Pure — stats shapes vary across platforms and
 * injected fakes, so everything here is structural probing over `unknown`.
 *
 * Anything unparseable is 'unknown', never a guessed 'direct' or 'relayed':
 * callers make cost decisions on this answer, so false certainty in either
 * direction is worse than admitting ignorance.
 */

/** Path classification for one peer link. */
export type MeshLinkState = 'direct' | 'relayed' | 'unknown';

interface StatsEntryLike {
  id?: unknown;
  type?: unknown;
  selectedCandidatePairId?: unknown;
  selected?: unknown;
  localCandidateId?: unknown;
  remoteCandidateId?: unknown;
  candidateType?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Flatten any supported stats container into its entry objects.
 *  Supported: RTCStatsReport / Map (forEach), arrays, and plain objects keyed
 *  by stat id. Anything else yields no entries. */
function statsEntries(stats: unknown): StatsEntryLike[] {
  if (!isObject(stats)) return [];
  const forEach = (stats as { forEach?: unknown }).forEach;
  if (typeof forEach === 'function') {
    const out: StatsEntryLike[] = [];
    (stats as { forEach: (fn: (value: unknown) => void) => void }).forEach((value) => {
      if (isObject(value)) out.push(value as StatsEntryLike);
    });
    return out;
  }
  if (Array.isArray(stats)) {
    return stats.filter(isObject) as StatsEntryLike[];
  }
  return Object.values(stats).filter(isObject) as StatsEntryLike[];
}

/** The candidateType behind a candidate stat id, or null when unresolvable. */
function candidateType(entries: StatsEntryLike[], id: unknown): string | null {
  if (typeof id !== 'string') return null;
  for (const entry of entries) {
    if (entry.id !== id) continue;
    if (typeof entry.candidateType === 'string') return entry.candidateType;
  }
  return null;
}

/** Classify one selected candidate pair. Relay on EITHER side means the path
 *  crosses a TURN server; both sides must resolve non-relay to call it direct. */
function classifyPair(entries: StatsEntryLike[], pair: StatsEntryLike): MeshLinkState {
  const local = candidateType(entries, pair.localCandidateId);
  const remote = candidateType(entries, pair.remoteCandidateId);
  if (local === 'relay' || remote === 'relay') return 'relayed';
  if (local !== null && remote !== null) return 'direct';
  return 'unknown';
}

/** Selected pairs via the standard route (transport.selectedCandidatePairId)
 *  plus the older shortcut some builds report (candidate-pair.selected). */
function selectedPairs(entries: StatsEntryLike[]): StatsEntryLike[] {
  const out = new Set<StatsEntryLike>();
  for (const entry of entries) {
    if (entry.type !== 'transport') continue;
    const pairId = entry.selectedCandidatePairId;
    if (typeof pairId !== 'string') continue;
    for (const pair of entries) {
      if (pair.type === 'candidate-pair' && pair.id === pairId) out.add(pair);
    }
  }
  for (const entry of entries) {
    if (entry.type === 'candidate-pair' && entry.selected === true) out.add(entry);
  }
  return [...out];
}

/**
 * Classify a raw stats poll result: 'relayed' when any selected candidate
 * pair runs through a TURN relay on either side, 'direct' when every selected
 * pair resolves to non-relay candidates on both sides, and 'unknown' when no
 * selected pair (or its candidates) can be found — absent stats, injected
 * fakes, older webviews.
 */
export function classifyLinkStats(stats: unknown): MeshLinkState {
  const entries = statsEntries(stats);
  const pairs = selectedPairs(entries);
  if (pairs.length === 0) return 'unknown';
  let sawUnknown = false;
  for (const pair of pairs) {
    const state = classifyPair(entries, pair);
    if (state === 'relayed') return 'relayed';
    if (state === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'direct';
}
