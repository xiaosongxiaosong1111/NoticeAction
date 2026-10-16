import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { finalizePlan, MergeError, mergeDocuments } from '../src/merge.mjs';

const fixtureUrl = new URL('./fixtures/parsed-documents.json', import.meta.url);
const contextUrl = new URL('./fixtures/context.json', import.meta.url);
const documents = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const context = JSON.parse(await readFile(contextUrl, 'utf8'));

function assertEvidenceIsTraceable(result, sourceDocuments = documents) {
  const byId = new Map(sourceDocuments.map((document) => [document.document_id, document]));
  const evidenceGroups = [
    ...Object.values(result.event.evidence),
    ...result.changes.map((change) => change.evidence),
    ...result.items.map((item) => item.evidence),
    ...result.constraints.map((item) => item.evidence),
    ...result.resolved_actions.map((item) => item.evidence),
    ...result.needs_confirmation.map((item) => item.evidence),
  ];
  for (const group of evidenceGroups) {
    assert.ok(group.length > 0, 'every fact must have evidence');
    for (const evidence of group) {
      const document = byId.get(evidence.document_id);
      assert.ok(document, `unknown document ${evidence.document_id}`);
      const element = document.elements.find((candidate) => candidate.element_id === evidence.element_id);
      assert.ok(element, `unknown element ${evidence.element_id}`);
      assert.ok(element.text.includes(evidence.quote), 'quote must be verbatim element text');
    }
  }
}

test('merges four documents into the one correct proposed state', () => {
  const result = mergeDocuments(documents, context);

  assert.deepEqual(
    {
      title: result.event.title,
      status: result.event.status,
      date: result.event.date,
      meet_time: result.event.meet_time,
      meet_location: result.event.meet_location,
      destination: result.event.destination,
      return_time: result.event.return_time,
    },
    {
      title: '三年级秋季自然观察研学活动',
      status: 'rescheduled',
      date: '2026-10-26',
      meet_time: '08:00',
      meet_location: '体育馆北门',
      destination: '青禾自然教育基地',
      return_time: '16:40',
    },
  );
  assert.equal(result.student.group, '第3组');
  assert.deepEqual(result.items.map(({ name, quantity, status }) => ({ name, quantity, status })), [
    { name: '秋季校服', quantity: '', status: 'required' },
    { name: '运动鞋', quantity: '', status: 'required' },
    { name: '500mL水杯', quantity: '', status: 'required' },
    { name: '轻便雨衣', quantity: '', status: 'required' },
    { name: '蓝色帽子', quantity: '1顶/人', status: 'required' },
    { name: '加厚垃圾袋', quantity: '2只/组', status: 'cancelled' },
  ]);
  assert.deepEqual(result.constraints.map((item) => item.text), ['不得携带现金', '不得携带电子游戏设备']);
  assert.deepEqual(result.changes.map((change) => change.id), [
    'event_date',
    'meet_time',
    'meet_location',
    'trash_bags',
    'unable_to_attend',
  ]);
  assert.deepEqual(result.resolved_actions.map((action) => action.id), [
    'acknowledge_adjustment',
    'submit_receipt',
    'pay_fee',
  ]);
  assert.deepEqual(result.needs_confirmation, []);
  assertEvidenceIsTraceable(result);
});

test('document order cannot change the result', () => {
  assert.deepEqual(mergeDocuments([...documents].reverse(), context), mergeDocuments(documents, context));
});

test('does not infer receipt or payment completion from no-repeat wording', () => {
  const result = mergeDocuments(documents, { ...context, completed_actions: [] });
  assert.deepEqual(result.needs_confirmation.map((item) => item.kind), ['receipt', 'payment']);
  assert.ok(!result.resolved_actions.some((item) => ['submit_receipt', 'pay_fee'].includes(item.id)));
});

test('final plan contains no stale or unrelated obligations', () => {
  const analysis = mergeDocuments(documents, context);
  const plan = finalizePlan(analysis, {
    change_decisions: Object.fromEntries(analysis.changes.map((change) => [change.id, true])),
  });
  const serialized = JSON.stringify({
    event: {
      date: plan.event.date,
      meet_time: plan.event.meet_time,
      meet_location: plan.event.meet_location,
    },
    active_todos: plan.active_todos.map(({ evidence: _evidence, ...todo }) => todo),
  });

  assert.deepEqual(plan.active_todos.map((todo) => todo.id), ['prepare_personal_items', 'attend_activity']);
  assert.deepEqual(plan.conditional_todos.map((todo) => todo.id), ['unable_to_attend']);
  assert.deepEqual(plan.resolved_actions.map((action) => action.id), [
    'acknowledge_adjustment',
    'submit_receipt',
    'pay_fee',
    'bring_trash_bags',
  ]);
  assert.ok(!serialized.includes('2026-10-23'));
  assert.ok(!serialized.includes('07:30'));
  assert.ok(!serialized.includes('学校东门'));
  assert.ok(!serialized.includes('加厚垃圾袋'));
  assert.ok(!serialized.includes('放大镜'));
  assert.ok(!serialized.includes('A4记录夹'));
  assert.ok(!serialized.includes('野餐垫'));
});

test('keeps receipt and payment actionable when the user says they are not submitted', () => {
  const analysis = mergeDocuments(documents, { ...context, completed_actions: [] });
  const plan = finalizePlan(analysis, {
    change_decisions: Object.fromEntries(analysis.changes.map((change) => [change.id, true])),
    submission_states: { receipt: 'not_submitted', payment: 'not_submitted' },
  });
  assert.deepEqual(plan.active_todos.slice(0, 2).map((todo) => todo.id), ['submit_receipt', 'pay_fee']);
  assert.ok(plan.active_todos.slice(0, 2).every((todo) => todo.status === 'overdue'));
});

test('receipt and payment can be confirmed independently', () => {
  const analysis = mergeDocuments(documents, { ...context, completed_actions: [] });
  const decisions = {
    change_decisions: Object.fromEntries(analysis.changes.map((change) => [change.id, true])),
  };

  const receiptOnly = finalizePlan(analysis, {
    ...decisions,
    submission_states: { receipt: 'submitted', payment: 'not_submitted' },
  });
  assert.ok(receiptOnly.resolved_actions.some((todo) => todo.id === 'submit_receipt' && todo.status === 'completed'));
  assert.ok(receiptOnly.active_todos.some((todo) => todo.id === 'pay_fee'));
  assert.ok(!receiptOnly.active_todos.some((todo) => todo.id === 'submit_receipt'));

  const paymentOnly = finalizePlan(analysis, {
    ...decisions,
    submission_states: { receipt: 'not_submitted', payment: 'submitted' },
  });
  assert.ok(paymentOnly.resolved_actions.some((todo) => todo.id === 'pay_fee' && todo.status === 'completed'));
  assert.ok(paymentOnly.active_todos.some((todo) => todo.id === 'submit_receipt'));
  assert.ok(!paymentOnly.active_todos.some((todo) => todo.id === 'pay_fee'));
});

test('a non-participant gets the required teacher-contact task, not attendance preparation', () => {
  const analysis = mergeDocuments(documents, {
    ...context,
    student: { ...context.student, participating: false },
    completed_actions: [],
  });
  const plan = finalizePlan(analysis, {
    change_decisions: Object.fromEntries(analysis.changes.map((change) => [change.id, true])),
    submission_states: { receipt: 'submitted' },
  });

  assert.deepEqual(plan.active_todos.map((todo) => todo.id), ['unable_to_attend']);
  assert.match(plan.active_todos[0].title, /联系(班主任|.*老师)/);
  assert.equal(plan.active_todos[0].due_at, analysis.conditional.due_at);
  assert.deepEqual(plan.conditional_todos, []);
  assert.ok(!plan.active_todos.some((todo) => ['prepare_personal_items', 'attend_activity', 'pay_fee'].includes(todo.id)));
});

test('evidence follows parsed values instead of the example date, time, place, and fee', () => {
  const replacements = [
    ['10月23日', '11月02日'],
    ['10月26日', '11月05日'],
    ['上午7:30', '上午09:10'],
    ['集合时间由7:30改为8:00', '集合时间由09:10改为09:40'],
    ['学校东门', '图书馆门口'],
    ['体育馆北门', '科技馆门口'],
    ['青禾自然教育基地', '市植物园'],
    ['16:40', '17:20'],
    ['128元', '156元'],
  ];
  const changedDocuments = JSON.parse(replacements.reduce(
    (serialized, [before, after]) => serialized.replaceAll(before, after),
    JSON.stringify(documents),
  ));
  const result = mergeDocuments(changedDocuments, context);

  assert.deepEqual(
    {
      date: result.event.date,
      meet_time: result.event.meet_time,
      meet_location: result.event.meet_location,
      destination: result.event.destination,
      return_time: result.event.return_time,
      amount_cny: result.payment.amount_cny,
    },
    {
      date: '2026-11-05',
      meet_time: '09:40',
      meet_location: '科技馆门口',
      destination: '市植物园',
      return_time: '17:20',
      amount_cny: 156,
    },
  );
  assert.equal(result.changes.find((change) => change.id === 'event_date').before, '2026-11-02');
  assertEvidenceIsTraceable(result, changedDocuments);
});

test('rejects oversized merge inputs before text joins or table allocation', () => {
  const rejectsSafely = (sourceDocuments) => assert.throws(
    () => mergeDocuments(sourceDocuments, context),
    (error) => error instanceof MergeError && /限制|过大|过多/.test(error.message),
  );
  const base = documents[0];
  const tableDocumentIndex = documents.findIndex((document) =>
    document.elements.some((element) => element.table_structure),
  );
  const withTable = (tableStructure) => {
    const changed = structuredClone(documents);
    const tableElement = changed[tableDocumentIndex].elements.find((element) => element.table_structure);
    tableElement.table_structure = tableStructure;
    return changed;
  };

  rejectsSafely(Array.from({ length: 21 }, (_, index) => ({ ...base, document_id: `doc_${index}` })));
  rejectsSafely([{ ...base, elements: Array(5_001).fill(base.elements[0]) }]);
  rejectsSafely([{ ...base, markdown: 'x'.repeat(2_000_001) }]);
  rejectsSafely([{ ...base, elements: [{ ...base.elements[0], text: 'x'.repeat(100_001) }] }]);
  rejectsSafely(withTable({ rows: 501, cols: 1, cells: [] }));
  rejectsSafely(withTable({ rows: 1, cols: 101, cells: [] }));
  rejectsSafely(withTable({ rows: 201, cols: 100, cells: [] }));
  rejectsSafely(withTable({ rows: 200, cols: 100, cells: Array(20_001).fill({ row: 1, col: 1, text: '' }) }));
  rejectsSafely(withTable({
    rows: 101,
    cols: 1,
    cells: [{ row: 1, col: 1, row_span: 101, col_span: 1, text: '' }],
  }));
  rejectsSafely(withTable({
    rows: 1,
    cols: 100,
    cells: [{ row: 1, col: 1, row_span: 1, col_span: 101, text: '' }],
  }));
  rejectsSafely([{
    ...base,
    elements: Array(51).fill({ ...base.elements[0], text: 'x'.repeat(100_000) }),
  }]);
});

test('rejects accepting the changed-event absence task after rejecting the date change', () => {
  const analysis = mergeDocuments(documents, {
    ...context,
    student: { ...context.student, participating: false },
    completed_actions: [],
  });
  assert.throws(
    () => finalizePlan(analysis, {
      change_decisions: Object.fromEntries(analysis.changes.map((change) => [
        change.id,
        change.id !== 'event_date',
      ])),
      submission_states: { receipt: 'submitted' },
    }),
    (error) => error instanceof MergeError && /拒绝活动日期变更.*不能参加改期活动/.test(error.message),
  );
});

test('keeps compatible date and absence-task decisions unchanged', () => {
  const analysis = mergeDocuments(documents, context);
  const decisions = (eventDate, unableToAttend) => ({
    change_decisions: Object.fromEntries(analysis.changes.map((change) => [
      change.id,
      change.id === 'event_date' ? eventDate : change.id === 'unable_to_attend' ? unableToAttend : true,
    ])),
  });

  const accepted = finalizePlan(analysis, decisions(true, true));
  assert.equal(accepted.event.date, '2026-10-26');
  assert.match(accepted.conditional_todos[0].condition, /2026-10-26/);
  assert.deepEqual(accepted.conditional_todos[0].evidence, analysis.conditional.evidence);

  const rejected = finalizePlan(analysis, decisions(false, false));
  assert.equal(rejected.event.date, '2026-10-23');
  assert.deepEqual(rejected.conditional_todos, []);
});
