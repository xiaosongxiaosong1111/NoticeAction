import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export const XPARSE_ENDPOINT = 'https://api.textin.com/api/v1/xparse/parse/sync';

let lastParsedAtMilliseconds = 0;

const XPARSE_LIMITS = Object.freeze({
  elements: 5_000,
  markdownCharacters: 2_000_000,
  textCharacters: 100_000,
  totalTextCharacters: 5_000_000,
  tableRows: 500,
  tableColumns: 100,
  tableCells: 20_000,
  tableGridCells: 20_000,
  cellSpan: 100,
  coordinateValues: 16,
  identifierCharacters: 1_024,
});

export class XParseError extends Error {
  constructor(
    message = 'xParse 解析失败，请检查服务配置或稍后重试',
    { statusCode = 502, code = 'TEXTIN_PARSE_FAILED' } = {},
  ) {
    super(message);
    this.name = 'XParseError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function providerFailure(payload) {
  const code = Number(payload?.code);
  if (code === 40101 || code === 40102) {
    return new XParseError(
      'TextIn 拒绝了当前 AppID / Secret Code。请在“解析设置”中重新保存工作台里的最新凭据。',
      { statusCode: 401, code: 'TEXTIN_CREDENTIALS_INVALID' },
    );
  }
  return new XParseError();
}

function limitError() {
  return new XParseError('xParse 返回内容超过安全限制');
}

function assertInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw limitError();
  return number;
}

function checkedText(value, maximum) {
  const text = String(value ?? '');
  if (text.length > maximum) throw limitError();
  return text;
}

function checkedIdentifier(value) {
  return checkedText(value, XPARSE_LIMITS.identifierCharacters);
}

function assertCoordinates(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > XPARSE_LIMITS.coordinateValues) throw limitError();
  for (const coordinate of value) {
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) throw limitError();
  }
  return value;
}

function assertPayloadBounds(data) {
  const markdown = checkedText(data.markdown, XPARSE_LIMITS.markdownCharacters);
  const elements = Array.isArray(data.elements) ? data.elements : [];
  if (elements.length > XPARSE_LIMITS.elements) throw limitError();
  let totalTextCharacters = markdown.length;

  for (const element of elements) {
    if (!element || typeof element !== 'object') throw limitError();
    checkedIdentifier(element.element_id);
    assertCoordinates(element.coordinates);
    totalTextCharacters += checkedText(element.text, XPARSE_LIMITS.textCharacters).length;
    if (totalTextCharacters > XPARSE_LIMITS.totalTextCharacters) throw limitError();
    const table = element.table_structure;
    if (!Array.isArray(table?.cells)) continue;
    const rows = assertInteger(table.rows ?? 0, 0, XPARSE_LIMITS.tableRows);
    const columns = assertInteger(table.cols ?? 0, 0, XPARSE_LIMITS.tableColumns);
    if (rows * columns > XPARSE_LIMITS.tableGridCells || table.cells.length > XPARSE_LIMITS.tableCells) throw limitError();
    if (table.cells.length > 0 && (rows === 0 || columns === 0)) throw limitError();
    for (const cell of table.cells) {
      if (!cell || typeof cell !== 'object') throw limitError();
      checkedIdentifier(cell.cell_id);
      assertCoordinates(cell.coordinates);
      const row = assertInteger(cell.row, 1, rows);
      const column = assertInteger(cell.col, 1, columns);
      const rowSpan = assertInteger(cell.row_span ?? 1, 1, XPARSE_LIMITS.cellSpan);
      const columnSpan = assertInteger(cell.col_span ?? 1, 1, XPARSE_LIMITS.cellSpan);
      if (row + rowSpan - 1 > rows || column + columnSpan - 1 > columns) throw limitError();
      totalTextCharacters += checkedText(cell.text, XPARSE_LIMITS.textCharacters).length;
      if (totalTextCharacters > XPARSE_LIMITS.totalTextCharacters) throw limitError();
    }
  }
  return { elements, markdown };
}

function sanitizeCell(cell) {
  return {
    cell_id: checkedIdentifier(cell.cell_id),
    row: Number(cell.row ?? 0),
    col: Number(cell.col ?? 0),
    row_span: Number(cell.row_span ?? 1),
    col_span: Number(cell.col_span ?? 1),
    text: String(cell.text ?? ''),
    coordinates: [...assertCoordinates(cell.coordinates)],
  };
}

function sanitizeElement(element) {
  const sanitized = {
    element_id: checkedIdentifier(element.element_id),
    type: String(element.type ?? ''),
    page_number: Number(element.page_number ?? 1),
    coordinates: [...assertCoordinates(element.coordinates)],
    text: String(element.text ?? ''),
  };
  if (Array.isArray(element.table_structure?.cells)) {
    sanitized.table_structure = {
      rows: Number(element.table_structure.rows ?? 0),
      cols: Number(element.table_structure.cols ?? 0),
      cells: element.table_structure.cells.map(sanitizeCell),
    };
  }
  return sanitized;
}

function inferIssuedAt(data) {
  const lines = [data.markdown, ...(data.elements ?? []).map((element) => element.text)]
    .flatMap((text) => String(text ?? '').split(/\r?\n/));
  const lineIndex = lines.findIndex((line) => /^\s*(?:[#>*-]\s*)?(?:20\d{2}年)?\d{1,2}月\d{1,2}日(?=\s|$)/.test(line));
  if (lineIndex < 0) return null;
  const date = lines[lineIndex].match(/^\s*(?:[#>*-]\s*)?(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日(?=\s|$)/);
  const [year, month, day] = [date[1] ?? new Date().getFullYear(), date[2], date[3]];
  const time = lines[lineIndex].slice(date[0].length).match(/^\s+(\d{1,2}):(\d{2})(?=\s|$)/);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(time?.[1] ?? '00').padStart(2, '0')}:${time?.[2] ?? '00'}:00+08:00`;
}

function nextParsedAt() {
  lastParsedAtMilliseconds = Math.max(Date.now(), lastParsedAtMilliseconds + 1);
  return new Date(lastParsedAtMilliseconds).toISOString();
}

export function sanitizeXParsePayload(name, bytes, payload) {
  if (payload?.code !== 200 || !payload.data || typeof payload.data !== 'object') throw new XParseError();
  const data = payload.data;
  const bounded = assertPayloadBounds(data);
  const elements = bounded.elements.map(sanitizeElement).filter((element) => element.text || element.table_structure);
  if (!bounded.markdown.trim() && elements.length === 0) throw new XParseError('xParse 未返回可用正文');
  const digest = createHash('sha256').update(name).update(bytes).digest('hex').slice(0, 16);
  return {
    document_id: `doc_${digest}`,
    name,
    format: extname(name).slice(1).toLowerCase(),
    issued_at: inferIssuedAt({ markdown: bounded.markdown, elements }),
    parsed_at: nextParsedAt(),
    page_count: Math.max(1, ...elements.map((element) => element.page_number || 1)),
    markdown: bounded.markdown,
    elements,
  };
}

export async function parseFile(
  { name, bytes },
  { appId, secretCode, fetchImpl = fetch, timeoutMs = 240_000 } = {},
) {
  if (!appId || !secretCode) throw new XParseError('服务端尚未配置 xParse 凭据');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
  form.append('config', JSON.stringify({
    capabilities: {
      include_hierarchy: true,
      include_table_structure: true,
      pages: true,
      title_tree: true,
      table_view: 'markdown',
    },
    config: { force_engine: 'textin', engine_params: { parse_mode: 'auto' } },
  }));
  try {
    const response = await fetchImpl(XPARSE_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: { 'x-ti-app-id': appId, 'x-ti-secret-code': secretCode, accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    if (!response.ok || payload?.code !== 200) throw providerFailure(payload);
    return sanitizeXParsePayload(name, bytes, payload);
  } catch (error) {
    if (error instanceof XParseError) throw error;
    throw new XParseError();
  }
}
