import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { finalizePlan, MergeError, mergeDocuments } from '../src/merge.mjs';

const fixtureUrl = new URL('./fixtures/parsed-documents.json', import.meta.url);
const contextUrl = new URL('./fixtures/context.json', import.meta.url);
const documents = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const contextFixture = JSON.parse(await readFile(contextUrl, 'utf8'));
const context = {
  ...contextFixture,
  completed_actions: contextFixture.completed_actions.map((action) =>
    action.kind === 'payment'
      ? { ...action, amount_cny: 128 }
      : { ...action, due_at: '2026-10-19T18:00:00+08:00' },
  ),
};

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

test('uses the latest reschedule notice when multiple updates exist', () => {
  const previousWeather = documents.find((document) => document.document_id === 'weather_reschedule');
  const replaceNoticeText = (text) => String(text)
    .replaceAll('2026年10月22日', '2026年10月24日')
    .replaceAll('原定10月23日（周五）的研学活动改为10月26日（周一）', '原定10月26日（周一）的研学活动改为10月28日（周三）')
    .replaceAll('集合时间由7:30改为8:00', '集合时间由8:00改为8:30')
    .replaceAll('10月25日12:00前', '10月27日12:00前');
  const latestWeather = {
    ...structuredClone(previousWeather),
    document_id: 'weather_reschedule_latest',
    name: '05_二次天气变更通知.png',
    issued_at: '2026-10-24T16:05:00+08:00',
    markdown: replaceNoticeText(previousWeather.markdown),
    elements: previousWeather.elements.map((element) => ({
      ...element,
      text: replaceNoticeText(element.text),
    })),
  };

  const result = mergeDocuments([...documents, latestWeather], {
    ...context,
    current_event: {
      date: '2026-10-26',
      meet_time: '08:00',
      meet_location: '体育馆北门',
    },
  });

  assert.equal(result.event.date, '2026-10-28');
  assert.equal(result.event.meet_time, '08:30');
  assert.equal(result.conditional.due_at, '2026-10-27T12:00:00+08:00');
  assert.equal(result.changes.find((change) => change.id === 'event_date').before, '2026-10-26');
  assert.equal(result.changes.find((change) => change.id === 'meet_time').before, '08:00');
  assert.equal(result.changes.find((change) => change.id === 'event_date').evidence.at(-1).document_id, latestWeather.document_id);
});

test('an unrelated undated sheet cannot make dated notices follow parse order', () => {
  const receivedAt = Date.now();
  const oldWeather = documents.find((document) => document.document_id === 'weather_reschedule');
  const replaceNoticeText = (text) => String(text)
    .replaceAll('2026年10月22日', '2026年10月24日')
    .replaceAll('原定10月23日（周五）的研学活动改为10月26日（周一）', '原定10月26日（周一）的研学活动改为10月30日（周五）');
  const latestWeather = {
    ...structuredClone(oldWeather),
    document_id: 'weather_reschedule_by_publication_date',
    issued_at: '2026-10-24T16:05:00+08:00',
    parsed_at: new Date(receivedAt - 1_000).toISOString(),
    markdown: replaceNoticeText(oldWeather.markdown),
    elements: oldWeather.elements.map((element) => ({
      ...element,
      text: replaceNoticeText(element.text),
    })),
  };
  const sourceDocuments = documents.map((document, index) => ({
    ...structuredClone(document),
    issued_at: document.document_id === 'group_table' ? null : document.issued_at,
    parsed_at: document.document_id === oldWeather.document_id
      ? new Date(receivedAt).toISOString()
      : new Date(receivedAt - 5_000 + index).toISOString(),
  }));

  const result = mergeDocuments([...sourceDocuments, latestWeather], {
    ...context,
    current_event: { date: '2026-10-26', meet_time: '08:00', meet_location: '体育馆北门' },
  });

  assert.equal(result.event.date, '2026-10-30');
  assert.equal(result.changes.find((change) => change.id === 'event_date').evidence.at(-1).document_id, latestWeather.document_id);
});

test('uses the latest complete base notice without treating a change notice as the base', () => {
  const originalBase = documents.find((document) => document.document_id === 'base_notice');
  const replaceFee = (text) => String(text).replaceAll('128元', '156元');
  const revisedBase = {
    ...structuredClone(originalBase),
    document_id: 'revised_complete_base_notice',
    name: '05_研学活动完整修订通知.pdf',
    issued_at: '2026-10-20T09:00:00+08:00',
    markdown: replaceFee(originalBase.markdown),
    elements: originalBase.elements.map((element) => ({ ...element, text: replaceFee(element.text) })),
  };
  const reminderText = '无论参加与否，请留意班级群里的后续提醒。';
  const laterReminder = {
    document_id: 'later_partial_reminder',
    name: '06_群内提醒.png',
    issued_at: '2026-10-25T09:00:00+08:00',
    markdown: reminderText,
    elements: [{ element_id: 'later_reminder_text', page_number: 1, text: reminderText }],
  };

  const result = mergeDocuments([...documents, revisedBase, laterReminder], context);

  assert.equal(result.payment.amount_cny, 156);
  assert.ok(!result.resolved_actions.some((action) => action.id === 'pay_fee'));
  assert.ok(result.needs_confirmation.some((confirmation) => confirmation.kind === 'payment'));
});

test('a newer complete base notice supersedes older event adjustments', () => {
  const originalBase = documents.find((document) => document.document_id === 'base_notice');
  const reviseBase = (text) => String(text)
    .replaceAll('2026年10月23日', '2026年10月30日')
    .replaceAll('上午7:30', '上午9:00')
    .replaceAll('学校东门', '图书馆门口')
    .replaceAll('2026年10月19日18:00', '2026年10月29日18:00')
    .replaceAll('128元', '156元');
  const revisedBase = {
    ...structuredClone(originalBase),
    document_id: 'latest_complete_base_notice',
    name: '05_研学活动完整修订通知.pdf',
    issued_at: '2026-10-25T09:00:00+08:00',
    markdown: reviseBase(originalBase.markdown),
    elements: originalBase.elements.map((element) => ({ ...element, text: reviseBase(element.text) })),
  };

  const result = mergeDocuments([...documents, revisedBase], {
    ...context,
    current_event: { date: '2026-10-26', meet_time: '08:00', meet_location: '体育馆北门' },
  });

  assert.equal(result.event.date, '2026-10-30');
  assert.equal(result.event.meet_time, '09:00');
  assert.equal(result.event.meet_location, '图书馆门口');
  assert.equal(result.payment.amount_cny, 156);
  assert.equal(result.conditional, null);
  assert.ok(!result.resolved_actions.some((action) => action.id === 'submit_receipt'));
  assert.ok(result.needs_confirmation.some((confirmation) => confirmation.kind === 'receipt'));
  assert.ok(!result.needs_confirmation.some((confirmation) => confirmation.kind === 'payment'));
  assert.ok(!result.changes.some((change) => ['event_date', 'meet_time', 'meet_location', 'unable_to_attend'].includes(change.id)));
});

test('keeps explicit confirmation even when a client baseline already matches the latest values', () => {
  const result = mergeDocuments(documents, {
    ...context,
    current_event: {
      date: '2026-10-26',
      meet_time: '08:00',
      meet_location: '体育馆北门',
    },
  });

  assert.deepEqual(result.changes.map((change) => change.id), [
    'event_date',
    'meet_time',
    'meet_location',
    'trash_bags',
    'unable_to_attend',
  ]);
  assert.equal(result.changes.find((change) => change.id === 'event_date').before, '2026-10-26');
  assert.equal(result.changes.find((change) => change.id === 'event_date').after, '2026-10-26');
  assert.equal(result.event.date, '2026-10-26');
  assert.equal(result.event.meet_time, '08:00');
  assert.equal(result.event.meet_location, '体育馆北门');
});

test('a later location-only notice preserves earlier independent material adjustments', () => {
  const locationText = '2026年10月24日 集合地点由“体育馆北门”改为“图书馆门口”。其他安排不变。';
  const locationOnly = {
    document_id: 'location_only_update',
    name: '05_集合地点补充通知.png',
    issued_at: '2026-10-24T18:00:00+08:00',
    markdown: locationText,
    elements: [{ element_id: 'location_only_text', page_number: 1, text: locationText }],
  };

  const result = mergeDocuments([...documents, locationOnly], {
    ...context,
    current_event: {
      date: '2026-10-26',
      meet_time: '08:00',
      meet_location: '体育馆北门',
    },
  });

  assert.equal(result.event.meet_location, '图书馆门口');
  assert.equal(result.items.find((item) => item.name === '加厚垃圾袋').status, 'cancelled');
  assert.ok(result.stable_facts.some((fact) => fact.label === '蓝色帽子' && fact.value === '照常携带'));
  assert.ok(result.resolved_actions.some((action) => action.id === 'acknowledge_adjustment'));
});

test('a location supplement titled as reschedule does not become a date adjustment', () => {
  const locationText = '【研学改期补充通知】集合地点由“体育馆北门”改为“图书馆门口”，日期和时间不变。';
  const locationOnly = {
    document_id: 'location_only_reschedule_title',
    name: '05_研学改期补充通知.png',
    issued_at: '2026-10-24T18:00:00+08:00',
    markdown: locationText,
    elements: [{ element_id: 'location_only_text', page_number: 1, text: locationText }],
  };

  const result = mergeDocuments([...documents, locationOnly], {
    ...context,
    current_event: {
      date: '2026-10-26',
      meet_time: '08:00',
      meet_location: '体育馆北门',
    },
  });

  assert.equal(result.event.date, '2026-10-26');
  assert.equal(result.event.meet_location, '图书馆门口');
  assert.equal(result.changes.filter((change) => change.id === 'event_date').length, 1);
  assert.equal(result.changes.find((change) => change.id === 'event_date').evidence.at(-1).document_id, 'weather_reschedule');
});

test('later parsed undated group sheet overrides the older sheet regardless of document id', () => {
  const original = documents.find((document) => document.document_id === 'group_table');
  const receivedAt = Date.now();
  const replaceQuantity = (document, quantity) => JSON.parse(
    JSON.stringify(document).replaceAll('1顶/人', quantity),
  );
  const older = {
    ...replaceQuantity(original, '1顶/人'),
    document_id: 'zz_older_undated_sheet',
    name: '旧分组表.xlsx',
    issued_at: null,
    parsed_at: new Date(receivedAt - 1_000).toISOString(),
  };
  const newer = {
    ...replaceQuantity(original, '2顶/人'),
    document_id: 'aa_newer_undated_sheet',
    name: '新分组表.xlsx',
    issued_at: null,
    parsed_at: new Date(receivedAt).toISOString(),
  };
  const withoutOriginal = documents.filter((document) => document.document_id !== original.document_id);

  const forward = mergeDocuments([...withoutOriginal, older, newer], context);
  const reversed = mergeDocuments([newer, older, ...withoutOriginal].reverse(), context);

  assert.equal(forward.items.find((item) => item.name === '蓝色帽子').quantity, '2顶/人');
  assert.deepEqual(reversed, forward);
});

test('parse order breaks ties between documents with the same publication timestamp', () => {
  const original = documents.find((document) => document.document_id === 'group_table');
  const receivedAt = Date.now();
  const replaceQuantity = (document, quantity) => JSON.parse(
    JSON.stringify(document).replaceAll('1顶/人', quantity),
  );
  const older = {
    ...replaceQuantity(original, '1顶/人'),
    document_id: 'zz_older_same_time',
    issued_at: '2026-10-16T00:01:00+08:00',
    parsed_at: new Date(receivedAt - 1_000).toISOString(),
  };
  const newer = {
    ...replaceQuantity(original, '2顶/人'),
    document_id: 'aa_newer_same_time',
    issued_at: '2026-10-16T00:01:00+08:00',
    parsed_at: new Date(receivedAt).toISOString(),
  };
  const withoutOriginal = documents.filter((document) => document.document_id !== original.document_id);

  const result = mergeDocuments([...withoutOriginal, older, newer], context);

  assert.equal(result.items.find((item) => item.name === '蓝色帽子').quantity, '2顶/人');
});

test('parse order wins when only one document has a publication timestamp', () => {
  const original = documents.find((document) => document.document_id === 'group_table');
  const receivedAt = Date.now();
  const replaceQuantity = (document, quantity) => JSON.parse(
    JSON.stringify(document).replaceAll('1顶/人', quantity),
  );
  const older = {
    ...replaceQuantity(original, '1顶/人'),
    document_id: 'zz_older_without_publication_date',
    issued_at: null,
    parsed_at: new Date(receivedAt - 1_000).toISOString(),
  };
  const newer = {
    ...replaceQuantity(original, '2顶/人'),
    document_id: 'aa_newer_with_publication_date',
    issued_at: '2026-10-18T00:00:00+08:00',
    parsed_at: new Date(receivedAt).toISOString(),
  };
  const withoutOriginal = documents.filter((document) => document.document_id !== original.document_id);

  const result = mergeDocuments([...withoutOriginal, older, newer], context);

  assert.equal(result.items.find((item) => item.name === '蓝色帽子').quantity, '2顶/人');
});

test('mixed timestamp sorting is stable across every input permutation', () => {
  const original = documents.find((document) => document.document_id === 'group_table');
  const receivedAt = Date.now();
  const replaceQuantity = (document, quantity) => JSON.parse(
    JSON.stringify(document).replaceAll('1顶/人', quantity),
  );
  const groupVersions = [
    {
      ...replaceQuantity(original, '3顶/人'),
      document_id: 'group_a',
      issued_at: '2026-10-18T00:00:00+08:00',
      parsed_at: new Date(receivedAt).toISOString(),
    },
    {
      ...replaceQuantity(original, '1顶/人'),
      document_id: 'group_b',
      issued_at: '2026-10-19T00:00:00+08:00',
      parsed_at: new Date(receivedAt - 2_000).toISOString(),
    },
    {
      ...replaceQuantity(original, '2顶/人'),
      document_id: 'group_c',
      issued_at: null,
      parsed_at: new Date(receivedAt - 1_000).toISOString(),
    },
  ];
  const otherDocuments = documents
    .filter((document) => document.document_id !== original.document_id)
    .map((document, index) => ({
      ...document,
      parsed_at: new Date(receivedAt - 10_000 + index).toISOString(),
    }));
  const [a, b, c] = groupVersions;
  const permutations = [
    [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
  ];

  const quantities = permutations.map((permutation) =>
    mergeDocuments([...otherDocuments, ...permutation], context)
      .items.find((item) => item.name === '蓝色帽子').quantity,
  );

  assert.deepEqual(quantities, Array(permutations.length).fill('3顶/人'));
});

test('receipt deadline edits do not masquerade as activity date changes', () => {
  const notices = [
    '【研学改期补充】活动日期不变，原定10月26日提交回执，现改为10月28日提交。',
    '研学活动：原定10月26日提交回执，现改为10月28日提交，活动日期不变。',
  ];
  for (const [index, text] of notices.entries()) {
    const receiptOnly = {
      document_id: `receipt_deadline_only_${index}`,
      name: `05_回执补充通知_${index}.png`,
      issued_at: `2026-10-24T18:0${index}:00+08:00`,
      markdown: text,
      elements: [{ element_id: `receipt_only_text_${index}`, page_number: 1, text }],
    };

    const result = mergeDocuments([...documents, receiptOnly], context);

    assert.equal(result.event.date, '2026-10-26');
    assert.equal(result.changes.find((change) => change.id === 'event_date').evidence.at(-1).document_id, 'weather_reschedule');
  }
});

test('recognizes an explicit full-year activity date adjustment', () => {
  const text = '活动日期调整：原定2026年10月26日的研学活动改为2026年10月30日，其他安排不变。';
  const fullYearAdjustment = {
    document_id: 'full_year_date_adjustment',
    name: '06_活动日期调整.png',
    issued_at: '2026-10-25T18:00:00+08:00',
    markdown: text,
    elements: [{ element_id: 'full_year_date_text', page_number: 1, text }],
  };

  const result = mergeDocuments([...documents, fullYearAdjustment], {
    ...context,
    current_event: { date: '2026-10-26', meet_time: '08:00', meet_location: '体育馆北门' },
  });

  assert.equal(result.event.date, '2026-10-30');
  assert.equal(result.changes.find((change) => change.id === 'event_date').evidence.at(-1).document_id, fullYearAdjustment.document_id);
});

test('does not invent an acknowledgement date when its source has no publication date', () => {
  const adjustment = documents.find((document) => document.document_id === 'teacher_adjustment');
  const undatedAdjustment = {
    ...structuredClone(adjustment),
    document_id: 'undated_teacher_adjustment',
    issued_at: null,
    parsed_at: new Date().toISOString(),
  };
  const changedDocuments = documents.map((document) =>
    document.document_id === adjustment.document_id ? undatedAdjustment : document,
  );

  const result = mergeDocuments(changedDocuments, context);
  const acknowledgement = result.resolved_actions.find((action) => action.id === 'acknowledge_adjustment');

  assert.ok(acknowledgement);
  assert.ok(!Object.hasOwn(acknowledgement, 'completed_at'));
});

test('a later date-only reschedule inherits earlier time and contact instructions', () => {
  const dateText = '2026年10月24日 二次改期：原定10月26日的研学活动改为10月28日，其他安排不变。';
  const dateOnly = {
    document_id: 'date_only_update',
    name: '06_二次改期通知.png',
    issued_at: '2026-10-24T19:00:00+08:00',
    markdown: dateText,
    elements: [{ element_id: 'date_only_text', page_number: 1, text: dateText }],
  };

  const result = mergeDocuments([...documents, dateOnly], {
    ...context,
    current_event: {
      date: '2026-10-26',
      meet_time: '08:00',
      meet_location: '体育馆北门',
    },
  });

  assert.equal(result.event.date, '2026-10-28');
  assert.equal(result.event.meet_time, '08:00');
  assert.equal(result.conditional.due_at, '2026-10-25T12:00:00+08:00');
  assert.equal(result.changes.find((change) => change.id === 'event_date').evidence.at(-1).document_id, dateOnly.document_id);
});

test('does not infer receipt or payment completion from no-repeat wording', () => {
  const result = mergeDocuments(documents, { ...context, completed_actions: [] });
  assert.deepEqual(result.needs_confirmation.map((item) => item.kind), ['receipt', 'payment']);
  assert.ok(!result.resolved_actions.some((item) => ['submit_receipt', 'pay_fee'].includes(item.id)));
});

test('inherits a completed payment only when its finite numeric amount still matches', () => {
  const changedDocuments = JSON.parse(JSON.stringify(documents).replaceAll('128元', '156元'));
  const receipt = { kind: 'receipt', completed_at: '2026-10-18T20:00:00+08:00' };
  const stalePayments = [
    { kind: 'payment', amount_cny: 128 },
    { kind: 'payment' },
    { kind: 'payment', amount_cny: '156' },
    { kind: 'payment', amount_cny: Number.POSITIVE_INFINITY },
  ];

  for (const payment of stalePayments) {
    const result = mergeDocuments(changedDocuments, {
      ...context,
      completed_actions: [receipt, payment],
    });
    assert.ok(!result.resolved_actions.some((action) => action.id === 'pay_fee'));
    assert.ok(result.needs_confirmation.some((confirmation) => confirmation.kind === 'payment'));
  }

  const matching = mergeDocuments(changedDocuments, {
    ...context,
    completed_actions: [receipt, { kind: 'payment', amount_cny: 156 }],
  });
  assert.ok(matching.resolved_actions.some((action) => action.id === 'pay_fee' && action.amount_cny === 156));
  assert.ok(!matching.needs_confirmation.some((confirmation) => confirmation.kind === 'payment'));
});

test('inherits a completed receipt only when its due date still matches', () => {
  const legacyReceipt = { kind: 'receipt', completed_at: '2026-10-18T20:00:00+08:00' };
  const staleReceipt = { ...legacyReceipt, due_at: '2026-10-18T18:00:00+08:00' };

  for (const receipt of [legacyReceipt, staleReceipt]) {
    const result = mergeDocuments(documents, { ...context, completed_actions: [receipt] });
    assert.ok(!result.resolved_actions.some((action) => action.id === 'submit_receipt'));
    assert.ok(result.needs_confirmation.some((confirmation) => confirmation.kind === 'receipt'));
  }

  const matching = mergeDocuments(documents, {
    ...context,
    completed_actions: [{ ...legacyReceipt, due_at: '2026-10-19T18:00:00+08:00' }],
  });
  const resolvedReceipt = matching.resolved_actions.find((action) => action.id === 'submit_receipt');
  assert.equal(resolvedReceipt?.due_at, '2026-10-19T18:00:00+08:00');
  assert.ok(!matching.needs_confirmation.some((confirmation) => confirmation.kind === 'receipt'));
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
  assert.equal(plan.active_todos.find((todo) => todo.id === 'submit_receipt').due_at, analysis.receipt.due_at);
  assert.equal(plan.active_todos.find((todo) => todo.id === 'pay_fee').amount_cny, 128);
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
  assert.ok(receiptOnly.resolved_actions.some((todo) =>
    todo.id === 'submit_receipt'
      && todo.status === 'completed'
      && todo.due_at === analysis.receipt.due_at,
  ));
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
