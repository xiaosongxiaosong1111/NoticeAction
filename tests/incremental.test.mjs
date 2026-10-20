import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baselineIsCurrent,
  mergeTransitionHistory,
  missingBaselineDocuments,
  restoreHistoricalDocumentMetadata,
  reviewIncrementalChanges,
  sameStudentIdentity,
  withExclusiveHistoryLock,
} from '../static/incremental.js';

test('lists every baseline document missing from the currently available parsed sources', () => {
  const baseline = {
    documents: [
      { document_id: 'doc-base', name: '基础通知.pdf' },
      { document_id: 'doc-group', name: '分组表.xlsx' },
    ],
  };

  assert.deepEqual(missingBaselineDocuments(baseline, [
    { document_id: 'doc-base', name: '基础通知.pdf', markdown: '正文' },
  ]), [
    { document_id: 'doc-group', name: '分组表.xlsx' },
  ]);
  assert.deepEqual(missingBaselineDocuments(baseline, [
    { document_id: 'doc-base' },
    { document_id: 'doc-group' },
    { document_id: 'doc-update' },
  ]), []);
});

test('hides accepted repeated transitions and no-ops while keeping deferred and new changes reviewable', () => {
  const baselineChanges = [
    { id: 'meet_location', field: 'event.meet_location', before: '学校东门', after: '体育馆北门', decision: 'accepted' },
    { id: 'trash_bags', field: 'supplies.trash_bags', before: '每组2个', after: '取消携带', decision: 'deferred' },
  ];
  const changes = [
    { id: 'meet_location', field: 'event.meet_location', before: '学校东门', after: '体育馆北门' },
    { id: 'event_date', field: 'event.date', before: '2026-10-28', after: '2026-10-28' },
    { id: 'trash_bags', field: 'supplies.trash_bags', before: '每组2个', after: '取消携带' },
    { id: 'meet_time', field: 'event.meet_time', before: '08:00', after: '08:30' },
  ];

  assert.deepEqual(reviewIncrementalChanges(changes, baselineChanges), {
    visibleChanges: [changes[2], changes[3]],
    inheritedDecisions: { meet_location: true, event_date: true },
  });
});

test('only inherits the latest decision for a field when the same transition returns later', () => {
  const returnedChange = { id: 'meet_location', field: 'event.meet_location', before: '学校东门', after: '体育馆北门' };
  const baselineChanges = [
    { ...returnedChange, decision: 'accepted' },
    { id: 'meet_location', field: 'event.meet_location', before: '体育馆北门', after: '学校东门', decision: 'accepted' },
  ];

  assert.deepEqual(reviewIncrementalChanges([returnedChange], baselineChanges), {
    visibleChanges: [returnedChange],
    inheritedDecisions: {},
  });
});

test('moves a repeated transition to the end of the accumulated timeline', () => {
  const first = { id: 'meet_location', field: 'event.meet_location', before: 'A', after: 'B', decision: 'accepted' };
  const second = { id: 'meet_location', field: 'event.meet_location', before: 'B', after: 'A', decision: 'accepted' };
  const repeated = { ...first, evidence: [{ document_id: 'latest' }] };

  assert.deepEqual(mergeTransitionHistory([first, second], [repeated, {
    id: 'event_date', field: 'event.date', before: '2026-10-28', after: '2026-10-28',
  }]), [second, repeated]);
});

test('matches a persisted baseline only against the newest history snapshot', () => {
  const baseline = { id: 'notice-1', saved_at: '2026-10-19T08:00:00.000Z' };

  assert.equal(baselineIsCurrent([
    baseline,
    { id: 'notice-2', saved_at: '2026-10-19T09:00:00.000Z' },
  ], baseline), true);
  assert.equal(baselineIsCurrent([
    { ...baseline, saved_at: '2026-10-19T10:00:00.000Z' },
  ], baseline), false);
  assert.equal(baselineIsCurrent([], baseline), false);
});

test('append identity must remain the same student and class', () => {
  const baseline = { name: '林小满', class_name: '三（2）班' };

  assert.equal(sameStudentIdentity(baseline, { name: ' 林小满 ', class_name: '三（2）班 ' }), true);
  assert.equal(sameStudentIdentity(baseline, { name: '张小雨', class_name: '三（2）班' }), false);
  assert.equal(sameStudentIdentity(baseline, { name: '林小满', class_name: '三（3）班' }), false);
});

test('restores the original ordering metadata when historical files are reselected', () => {
  const baselineDocuments = [
    { document_id: 'old', name: '旧分组表.xlsx', issued_at: null, parsed_at: '2026-10-18T01:00:00.000Z' },
    { document_id: 'new', name: '新分组表.xlsx', issued_at: null, parsed_at: '2026-10-19T01:00:00.000Z' },
  ];
  const reselected = [
    { document_id: 'new', name: '新分组表.xlsx', issued_at: null, parsed_at: '2026-10-20T01:00:00.000Z' },
    { document_id: 'old', name: '旧分组表.xlsx', issued_at: null, parsed_at: '2026-10-20T01:00:01.000Z' },
    { document_id: 'added', name: '新增通知.png', issued_at: null, parsed_at: '2026-10-20T01:00:02.000Z' },
  ];

  assert.deepEqual(
    restoreHistoricalDocumentMetadata(reselected, baselineDocuments).map(({ document_id, parsed_at }) => ({ document_id, parsed_at })),
    [
      { document_id: 'new', parsed_at: '2026-10-19T01:00:00.000Z' },
      { document_id: 'old', parsed_at: '2026-10-18T01:00:00.000Z' },
      { document_id: 'added', parsed_at: '2026-10-20T01:00:02.000Z' },
    ],
  );
});

test('preserves legacy history order when parsed timestamps were not stored yet', () => {
  const baselineDocuments = [
    { document_id: 'old', name: '旧分组表.xlsx', issued_at: null },
    { document_id: 'new', name: '新分组表.xlsx', issued_at: null },
  ];
  const reselected = [
    { document_id: 'new', parsed_at: '2026-10-20T01:00:00.000Z' },
    { document_id: 'old', parsed_at: '2026-10-20T01:00:01.000Z' },
    { document_id: 'added', parsed_at: '2026-10-20T01:00:02.000Z' },
  ];
  const restored = restoreHistoricalDocumentMetadata(reselected, baselineDocuments);

  assert.ok(Date.parse(restored[0].parsed_at) > Date.parse(restored[1].parsed_at));
  assert.equal(restored[2].parsed_at, reselected[2].parsed_at);
});

test('runs the final history check and write under one exclusive browser lock', async () => {
  const calls = [];
  const lockManager = {
    request(name, options, operation) {
      calls.push({ name, options });
      return operation();
    },
  };

  assert.equal(await withExclusiveHistoryLock(lockManager, () => 'saved'), 'saved');
  assert.deepEqual(calls, [{
    name: 'notice-action-history-v1',
    options: { mode: 'exclusive' },
  }]);
  assert.equal(await withExclusiveHistoryLock(null, () => 'fallback'), 'fallback');
});
