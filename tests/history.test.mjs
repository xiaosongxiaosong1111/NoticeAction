import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HISTORY_KEY,
  loadHistory,
  persistHistory,
  removeRecord,
  setTaskCompleted,
  upsertPlan,
} from '../static/history.js';

function storageWith(initialValue = null) {
  let value = initialValue;
  return {
    getItem(key) {
      assert.equal(key, HISTORY_KEY);
      return value;
    },
    setItem(key, nextValue) {
      assert.equal(key, HISTORY_KEY);
      value = nextValue;
    },
  };
}

function plan(overrides = {}) {
  return {
    schema_version: 1,
    event: {
      title: '三年级秋季研学活动',
      status: 'rescheduled',
      date: '2026-10-26',
      meet_time: '08:00',
      meet_location: '体育馆北门',
      destination: '青禾自然教育基地',
      return_time: '16:40',
      evidence: {
        date: [{ document_id: 'notice', document_name: '通知.pdf', element_id: 'date', page_number: 1, quote: '改为10月26日' }],
      },
    },
    student: { name: '林小满', class_name: '三（2）班', group: '第3组', participating: true },
    documents: [{ document_id: 'notice', name: '通知.pdf', issued_at: '2026-10-16T00:00:00+08:00', parsed_at: '2026-10-16T01:00:00.000Z', markdown: '不能入库' }],
    changes: [{
      id: 'event_date', kind: 'modified', field: 'event.date', label: '活动日期', before: '2026-10-23', after: '2026-10-26', decision: 'accepted',
      evidence: [{ document_id: 'notice', document_name: '通知.pdf', element_id: 'date', page_number: 1, quote: '改为10月26日' }],
    }],
    active_todos: [{ id: 'prepare', title: '准备物品', due_at: '2026-10-26T08:00:00+08:00', status: 'pending', items: ['水杯'], evidence: [] }],
    conditional_todos: [{ id: 'unable', title: '无法参加时联系老师', condition: '无法参加', evidence: [] }],
    resolved_actions: [{ id: 'receipt', label: '提交回执', status: 'completed', completed_at: '2026-10-18T10:00:00+08:00', evidence: [] }],
    cancelled_actions: [{ id: 'bags', label: '准备垃圾袋', status: 'cancelled', evidence: [] }],
    summary: { document_count: 1, change_count: 1, active_count: 1, resolved_count: 1 },
    markdown: '原始 Markdown 绝不能保存',
    elements: [{ text: '原始解析元素' }],
    file: { name: '本地文件.pdf' },
    url: 'https://vendor.example/result',
    app_id: 'secret-app-id',
    secret_code: 'secret-code',
    ...overrides,
  };
}

test('upsertPlan creates only a compact, versioned finalized-plan record', () => {
  const source = plan();
  const records = upsertPlan([], source, '2026-10-16T12:00:00.000Z');

  assert.equal(records.length, 1);
  assert.equal(records[0].history_version, 1);
  assert.equal(records[0].saved_at, '2026-10-16T12:00:00.000Z');
  assert.deepEqual(records[0].student, source.student);
  assert.deepEqual(records[0].documents, [{ document_id: 'notice', name: '通知.pdf', issued_at: '2026-10-16T00:00:00+08:00', parsed_at: '2026-10-16T01:00:00.000Z' }]);
  assert.deepEqual(records[0].active_todos[0].items, ['水杯']);
  assert.equal(records[0].event.evidence.date[0].quote, '改为10月26日');

  const serialized = JSON.stringify(records);
  for (const forbidden of ['原始 Markdown', '原始解析元素', '本地文件.pdf', 'vendor.example', 'secret-app-id', 'secret-code']) {
    assert.ok(!serialized.includes(forbidden), `history leaked ${forbidden}`);
  }
  assert.equal(source.documents[0].markdown, '不能入库', 'source plan remains unchanged');
});

test('upsertPlan replaces the same student event immutably and keeps newest 12 first', () => {
  const original = upsertPlan([], plan(), '2026-10-01T00:00:00.000Z');
  const originalSnapshot = structuredClone(original);
  const updated = upsertPlan(original, plan({ event: { ...plan().event, date: '2026-10-27' } }), '2026-10-02T00:00:00.000Z');

  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, original[0].id);
  assert.equal(updated[0].event.date, '2026-10-27');
  assert.deepEqual(original, originalSnapshot);

  const thirteen = Array.from({ length: 13 }, (_, index) => plan({
    student: { ...plan().student, name: `学生${index}` },
  })).reduce(
    (records, item, index) => upsertPlan(records, item, `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
    [],
  );
  assert.equal(thirteen.length, 12);
  assert.equal(thirteen[0].student.name, '学生12');
  assert.equal(thirteen.at(-1).student.name, '学生1');
});

test('loadHistory safely rejects invalid and old storage and persistHistory sanitizes again', () => {
  assert.deepEqual(loadHistory(storageWith('{broken')), []);
  assert.deepEqual(loadHistory(storageWith(JSON.stringify([{ id: 'old-record' }]))), []);
  assert.deepEqual(loadHistory(storageWith(JSON.stringify({ history_version: 1 }))), []);

  const storage = storageWith();
  const records = upsertPlan([], plan(), '2026-10-16T12:00:00.000Z');
  records[0].secret_code = 'must-not-persist';
  records[0].documents[0].elements = [{ text: 'must-not-persist' }];
  const persisted = persistHistory(storage, records);

  assert.deepEqual(loadHistory(storage), persisted);
  assert.ok(!JSON.stringify(persisted).includes('must-not-persist'));
});

test('setTaskCompleted updates one task without mutating records', () => {
  const records = upsertPlan([], plan(), '2026-10-16T12:00:00.000Z');
  const snapshot = structuredClone(records);
  const updated = setTaskCompleted(
    records,
    records[0].id,
    'prepare',
    true,
    '2026-10-19T09:30:00.000Z',
  );

  assert.equal(updated[0].active_todos[0].completed, true);
  assert.equal(updated[0].saved_at, '2026-10-19T09:30:00.000Z');
  assert.deepEqual(records, snapshot);
  assert.notEqual(updated, records);
  assert.notEqual(updated[0], records[0]);
  assert.notEqual(updated[0].active_todos, records[0].active_todos);

  const unchanged = setTaskCompleted(
    updated,
    updated[0].id,
    'prepare',
    true,
    '2026-10-20T09:30:00.000Z',
  );
  assert.equal(unchanged[0].saved_at, '2026-10-19T09:30:00.000Z');
  assert.deepEqual(setTaskCompleted(updated, 'missing', 'prepare', false, '2026-10-20T09:30:00.000Z'), updated);
});

test('removeRecord removes one record immutably and persistHistory can clear all', () => {
  const first = upsertPlan([], plan(), '2026-10-16T12:00:00.000Z');
  const records = upsertPlan(first, plan({ student: { ...plan().student, name: '吴初夏' } }), '2026-10-17T12:00:00.000Z');
  const remaining = removeRecord(records, records[0].id);

  assert.equal(remaining.length, 1);
  assert.equal(records.length, 2);
  assert.notEqual(remaining, records);

  const storage = storageWith('anything');
  assert.deepEqual(persistHistory(storage, []), []);
  assert.deepEqual(loadHistory(storage), []);
});
