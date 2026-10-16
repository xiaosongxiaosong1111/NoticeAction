import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFile, sanitizeXParsePayload, XParseError } from '../src/xparse-client.mjs';

test('sanitizes vendor URLs and request identifiers', () => {
  const document = sanitizeXParsePayload('通知.pdf', new Uint8Array([1, 2, 3]), {
    code: 200,
    data: {
      file_id: 'vendor-file',
      job_id: 'vendor-job',
      x_request_id: 'vendor-request',
      page_image_url: 'https://public.example/page.png',
      markdown: '# 通知',
      pages: [{ page_image_url: 'https://public.example/page-1.png' }],
      elements: [{
        element_id: 'element-1',
        page_number: 1,
        coordinates: [0, 0, 1, 1],
        type: 'NarrativeText',
        text: '通知正文',
        secret_field: 'remove-me',
      }],
    },
  });
  const serialized = JSON.stringify(document);
  assert.equal(document.markdown, '# 通知');
  assert.equal(document.elements[0].element_id, 'element-1');
  assert.ok(!serialized.includes('page_image_url'));
  assert.ok(!serialized.includes('vendor-'));
  assert.ok(!serialized.includes('remove-me'));
});

test('accepts only bounded finite coordinate arrays and copies them', () => {
  const elementCoordinates = Array.from({ length: 16 }, (_, index) => index / 2);
  const cellCoordinates = [0, 0, 10, 0, 10, 10, 0, 10];
  const payload = (elementValue, cellValue = cellCoordinates) => ({
    code: 200,
    data: {
      markdown: '# 通知',
      elements: [{
        element_id: 'e1',
        text: '正文',
        coordinates: elementValue,
        table_structure: {
          rows: 1,
          cols: 1,
          cells: [{ row: 1, col: 1, text: '单元格', coordinates: cellValue }],
        },
      }],
    },
  });

  const document = sanitizeXParsePayload('通知.pdf', new Uint8Array([1]), payload(elementCoordinates));
  assert.deepEqual(document.elements[0].coordinates, elementCoordinates);
  assert.deepEqual(document.elements[0].table_structure.cells[0].coordinates, cellCoordinates);
  assert.notStrictEqual(document.elements[0].coordinates, elementCoordinates);
  assert.notStrictEqual(document.elements[0].table_structure.cells[0].coordinates, cellCoordinates);

  const invalidCoordinates = [null, '0,0', [0, '1'], [0, Number.NaN], [0, Number.POSITIVE_INFINITY], Array(17).fill(0)];
  for (const coordinates of invalidCoordinates) {
    assert.throws(
      () => sanitizeXParsePayload('通知.pdf', new Uint8Array([1]), payload(coordinates)),
      (error) => error instanceof XParseError && /安全限制/.test(error.message),
    );
    assert.throws(
      () => sanitizeXParsePayload('通知.pdf', new Uint8Array([1]), payload(elementCoordinates, coordinates)),
      (error) => error instanceof XParseError && /安全限制/.test(error.message),
    );
  }
});

test('bounds element and cell identifiers before string sanitization', () => {
  const maximumIdentifier = 'x'.repeat(1_024);
  const payload = (elementId, cellId) => ({
    code: 200,
    data: {
      markdown: '# 通知',
      elements: [{
        element_id: elementId,
        text: '正文',
        table_structure: {
          rows: 1,
          cols: 1,
          cells: [{ cell_id: cellId, row: 1, col: 1, text: '单元格' }],
        },
      }],
    },
  });

  const bounded = sanitizeXParsePayload('通知.pdf', new Uint8Array([1]), payload(maximumIdentifier, 42));
  assert.equal(bounded.elements[0].element_id, maximumIdentifier);
  assert.equal(bounded.elements[0].table_structure.cells[0].cell_id, '42');

  const missing = sanitizeXParsePayload('通知.pdf', new Uint8Array([1]), payload(undefined, undefined));
  assert.equal(missing.elements[0].element_id, '');
  assert.equal(missing.elements[0].table_structure.cells[0].cell_id, '');

  for (const oversized of [payload('x'.repeat(1_025), 'cell'), payload('element', 'x'.repeat(1_025))]) {
    assert.throws(
      () => sanitizeXParsePayload('通知.pdf', new Uint8Array([1]), oversized),
      (error) => error instanceof XParseError && /安全限制/.test(error.message),
    );
  }
});

test('sends credentials only in request headers and returns sanitized data', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      code: 200,
      data: { markdown: '2026年10月18日 通知', elements: [{ element_id: 'e1', page_number: 1, text: '通知' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const document = await parseFile(
    { name: '通知.png', bytes: new Uint8Array([9, 8, 7]) },
    { appId: 'app-secret-value', secretCode: 'code-secret-value', fetchImpl },
  );
  assert.equal(captured.options.headers['x-ti-app-id'], 'app-secret-value');
  assert.equal(captured.options.headers['x-ti-secret-code'], 'code-secret-value');
  assert.equal(captured.options.redirect, 'error');
  assert.ok(captured.options.body instanceof FormData);
  assert.ok(!JSON.stringify(document).includes('secret-value'));
});

test('maps provider failures to a safe error', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 401, message: 'bad secret: do-not-leak' }), { status: 401 });
  await assert.rejects(
    parseFile(
      { name: '通知.pdf', bytes: new Uint8Array([1]) },
      { appId: 'app', secretCode: 'secret', fetchImpl },
    ),
    (error) => error instanceof XParseError && error.message === 'xParse 解析失败，请检查服务配置或稍后重试',
  );
});

test('rejects oversized xParse structures before sanitizing them', () => {
  const payload = (data) => ({ code: 200, data: { markdown: '# 通知', elements: [], ...data } });
  const element = { element_id: 'e1', page_number: 1, text: '正文' };
  const rejectsSafely = (data) => assert.throws(
    () => sanitizeXParsePayload('通知.pdf', new Uint8Array([1]), payload(data)),
    (error) => error instanceof XParseError && !error.message.includes('正文'),
  );

  rejectsSafely({ markdown: 'x'.repeat(2_000_001) });
  rejectsSafely({ elements: Array(5_001).fill(element) });
  rejectsSafely({ elements: [{ ...element, text: 'x'.repeat(100_001) }] });
  rejectsSafely({
    elements: [{
      ...element,
      table_structure: { rows: 501, cols: 1, cells: [] },
    }],
  });
  rejectsSafely({
    elements: [{
      ...element,
      table_structure: { rows: 1, cols: 101, cells: [] },
    }],
  });
  rejectsSafely({
    elements: [{
      ...element,
      table_structure: { rows: 201, cols: 100, cells: [] },
    }],
  });
  rejectsSafely({
    elements: [{
      ...element,
      table_structure: { rows: 200, cols: 100, cells: Array(20_001).fill({ row: 1, col: 1, text: '' }) },
    }],
  });
  rejectsSafely({
    elements: [{
      ...element,
      table_structure: {
        rows: 101,
        cols: 1,
        cells: [{ row: 1, col: 1, row_span: 101, col_span: 1, text: '' }],
      },
    }],
  });
  rejectsSafely({
    elements: [{
      ...element,
      table_structure: {
        rows: 1,
        cols: 100,
        cells: [{ row: 1, col: 1, row_span: 1, col_span: 101, text: '' }],
      },
    }],
  });
  rejectsSafely({
    elements: Array(51).fill({ ...element, text: 'x'.repeat(100_000) }),
  });
});
