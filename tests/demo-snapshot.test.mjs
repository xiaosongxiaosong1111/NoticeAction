import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mergeDocuments } from '../src/merge.mjs';

const documents = JSON.parse(await readFile(new URL('../samples/demo-documents.json', import.meta.url), 'utf8'));
const context = {
  as_of: '2026-10-22T17:00:00+08:00',
  student: { name: '林小满', class_name: '三（2）班', participating: true },
  completed_actions: [],
};

test('real sanitized xParse snapshot reaches the same critical state', () => {
  const result = mergeDocuments(documents, context);
  assert.equal(result.event.date, '2026-10-26');
  assert.equal(result.event.meet_time, '08:00');
  assert.equal(result.event.meet_location, '体育馆北门');
  assert.equal(result.student.group, '第3组');
  assert.equal(result.items.find((item) => item.name === '蓝色帽子').status, 'required');
  assert.equal(result.items.find((item) => item.name === '加厚垃圾袋').status, 'cancelled');
  assert.deepEqual(result.needs_confirmation.map((item) => item.kind), ['receipt', 'payment']);
  assert.ok(!JSON.stringify(result).includes('page_image_url'));
});
