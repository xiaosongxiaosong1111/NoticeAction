export const HISTORY_KEY = 'notice-action.history.v1';

const HISTORY_VERSION = 1;
const MAX_RECORDS = 12;
const TASK_GROUPS = ['active_todos', 'conditional_todos', 'resolved_actions', 'cancelled_actions'];

function pick(source, keys) {
  return Object.fromEntries(keys
    .filter((key) => ['string', 'number', 'boolean'].includes(typeof source?.[key]) || source?.[key] === null)
    .map((key) => [key, source[key]]));
}

function compactEvidence(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => pick(item, ['document_id', 'document_name', 'element_id', 'page_number', 'quote']));
}

function compactEvidenceMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, items]) => Array.isArray(items))
    .map(([key, items]) => [key, compactEvidence(items)]));
}

function compactEvent(event) {
  return {
    ...pick(event, ['title', 'status', 'date', 'meet_time', 'meet_location', 'destination', 'return_time']),
    evidence: compactEvidenceMap(event?.evidence),
  };
}

function compactStudent(student) {
  return pick(student, ['name', 'class_name', 'group', 'participating']);
}

function compactDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  return documents
    .filter((document) => document && typeof document === 'object')
    .map((document) => pick(document, ['document_id', 'name', 'issued_at']));
}

function compactChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((change) => change && typeof change === 'object')
    .map((change) => ({
      ...pick(change, ['id', 'kind', 'field', 'label', 'title', 'before', 'after', 'decision']),
      evidence: compactEvidence(change.evidence),
    }));
}

function compactTodos(todos) {
  if (!Array.isArray(todos)) return [];
  return todos
    .filter((todo) => todo && typeof todo === 'object')
    .map((todo) => ({
      ...pick(todo, [
        'id', 'title', 'label', 'text', 'name', 'action', 'due_at', 'deadline', 'status', 'condition',
        'quantity', 'description', 'amount_cny', 'completed', 'completed_at', 'completed_by', 'repeat_required',
      ]),
      ...(Array.isArray(todo.items)
        ? { items: todo.items.filter((item) => ['string', 'number', 'boolean'].includes(typeof item)) }
        : {}),
      evidence: compactEvidence(todo.evidence),
    }));
}

function compactSummary(summary) {
  return pick(summary, [
    'document_count', 'change_count', 'evidence_count', 'active_count', 'conditional_count',
    'resolved_count', 'cancelled_count',
  ]);
}

function savedAtIso(savedAt) {
  const date = savedAt === undefined ? new Date() : new Date(savedAt);
  if (Number.isNaN(date.getTime())) throw new TypeError('savedAt must be a valid date');
  return date.toISOString();
}

function recordId(plan) {
  const anchor = plan.documents?.[0]?.document_id || `${plan.event?.title || ''}:${plan.event?.date || ''}`;
  return ['notice', plan.student?.name || '', plan.student?.class_name || '', anchor]
    .map((part) => encodeURIComponent(String(part)))
    .join(':');
}

function compactRecord(plan, savedAt) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.active_todos)) {
    throw new TypeError('Only finalized plans can be saved');
  }
  return {
    history_version: HISTORY_VERSION,
    id: recordId(plan),
    saved_at: savedAtIso(savedAt),
    event: compactEvent(plan.event),
    student: compactStudent(plan.student),
    documents: compactDocuments(plan.documents),
    changes: compactChanges(plan.changes),
    active_todos: compactTodos(plan.active_todos),
    conditional_todos: compactTodos(plan.conditional_todos),
    resolved_actions: compactTodos(plan.resolved_actions),
    cancelled_actions: compactTodos(plan.cancelled_actions),
    summary: compactSummary(plan.summary),
  };
}

function newestFirst(records) {
  return [...records]
    .sort((left, right) => right.saved_at.localeCompare(left.saved_at))
    .slice(0, MAX_RECORDS);
}

export function loadHistory(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(HISTORY_KEY));
    if (!Array.isArray(parsed)) return [];
    return newestFirst(parsed
      .filter((record) => record?.history_version === HISTORY_VERSION)
      .map((record) => {
        try { return compactRecord(record, record.saved_at); } catch { return null; }
      })
      .filter(Boolean));
  } catch {
    return [];
  }
}

export function persistHistory(storage, records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const compact = newestFirst(records
    .filter((record) => record?.history_version === HISTORY_VERSION)
    .map((record) => compactRecord(record, record.saved_at)));
  storage.setItem(HISTORY_KEY, JSON.stringify(compact));
  return compact;
}

export function upsertPlan(records, plan, savedAt) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const record = compactRecord(plan, savedAt);
  return newestFirst([record, ...records.filter((item) => item.id !== record.id)]);
}

export function setTaskCompleted(records, recordIdValue, taskId, completed) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  return records.map((record) => {
    if (record.id !== recordIdValue) return record;
    let changed = false;
    const groups = Object.fromEntries(TASK_GROUPS.map((group) => [group, (record[group] || []).map((task) => {
      if (task.id !== taskId || task.completed === Boolean(completed)) return task;
      changed = true;
      return { ...task, completed: Boolean(completed) };
    })]));
    return changed ? { ...record, ...groups } : record;
  });
}

export function removeRecord(records, recordIdValue) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  return records.filter((record) => record.id !== recordIdValue);
}
