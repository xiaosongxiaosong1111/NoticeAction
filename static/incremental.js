function transitionValue(change, keys) {
  for (const key of keys) {
    if (change?.[key] !== undefined) return change[key];
  }
  return undefined;
}

function transitionKey(change) {
  return JSON.stringify([
    change?.id,
    change?.kind,
    change?.field,
    transitionValue(change, ['before', 'old_value', 'from']),
    transitionValue(change, ['after', 'new_value', 'to', 'value']),
  ]);
}

function isNoOp(change) {
  const before = transitionValue(change, ['before', 'old_value', 'from']);
  const after = transitionValue(change, ['after', 'new_value', 'to', 'value']);
  return before !== undefined && after !== undefined && String(before) === String(after);
}

export function missingBaselineDocuments(baseline, availableDocuments = []) {
  const availableIds = new Set(availableDocuments.map(({ document_id }) => document_id).filter(Boolean));
  return (baseline?.documents || []).filter(({ document_id }) => document_id && !availableIds.has(document_id));
}

export function restoreHistoricalDocumentMetadata(documents = [], baselineDocuments = []) {
  const needsLegacyOrder = baselineDocuments.some((document) => !document.parsed_at);
  const legacyStart = Date.UTC(2000, 0, 1);
  const previous = new Map(baselineDocuments.map((document, index) => [document.document_id, {
    ...document,
    ...(needsLegacyOrder ? { parsed_at: new Date(legacyStart + index).toISOString() } : {}),
  }]));
  return documents.map((document) => {
    const baseline = previous.get(document.document_id);
    if (!baseline) return document;
    return {
      ...document,
      issued_at: baseline.issued_at ?? document.issued_at ?? null,
      ...(baseline.parsed_at ? { parsed_at: baseline.parsed_at } : {}),
    };
  });
}

export function reviewIncrementalChanges(changes = [], baselineChanges = []) {
  const latestByField = new Map();
  for (const change of baselineChanges) latestByField.set(change.field ?? change.id, change);
  const accepted = new Set([...latestByField.values()]
    .filter(({ decision }) => decision === 'accepted')
    .map(transitionKey));
  const visibleChanges = [];
  const inheritedDecisions = {};

  for (const change of changes) {
    if (isNoOp(change) || accepted.has(transitionKey(change))) {
      inheritedDecisions[change.id] = true;
    } else {
      visibleChanges.push(change);
    }
  }
  return { visibleChanges, inheritedDecisions };
}

export function mergeTransitionHistory(baselineChanges = [], latestChanges = []) {
  const transitions = new Map();
  for (const change of [...baselineChanges, ...latestChanges]) {
    if (isNoOp(change)) continue;
    const key = transitionKey(change);
    transitions.delete(key);
    transitions.set(key, change);
  }
  return [...transitions.values()];
}

export function baselineIsCurrent(records, baseline) {
  if (!baseline?.id || !baseline.saved_at) return false;
  const current = records.find(({ id }) => id === baseline.id);
  return current?.saved_at === baseline.saved_at;
}

export function sameStudentIdentity(baseline, current) {
  const normalize = (value) => String(value ?? '').trim();
  return normalize(baseline?.name) === normalize(current?.name)
    && normalize(baseline?.class_name) === normalize(current?.class_name);
}

export function withExclusiveHistoryLock(lockManager, operation) {
  if (!lockManager?.request) return Promise.resolve().then(operation);
  return lockManager.request('notice-action-history-v1', { mode: 'exclusive' }, operation);
}
