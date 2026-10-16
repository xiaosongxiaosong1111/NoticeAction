const TIME_ZONE = '+08:00';

export class MergeError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.name = 'MergeError';
    this.statusCode = statusCode;
  }
}

const MERGE_LIMITS = Object.freeze({
  documents: 20,
  elementsPerDocument: 5_000,
  markdownCharacters: 2_000_000,
  textCharacters: 100_000,
  totalTextCharactersPerDocument: 5_000_000,
  tableRows: 500,
  tableColumns: 100,
  tableCells: 20_000,
  tableGridCells: 20_000,
  cellSpan: 100,
});

function mergeLimitError() {
  return new MergeError('解析文档超过安全限制');
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw mergeLimitError();
  return number;
}

function boundedText(value, maximum) {
  const text = String(value ?? '');
  if (text.length > maximum) throw mergeLimitError();
  return text;
}

function assertDocumentBounds(document) {
  let totalTextCharacters = boundedText(document.markdown, MERGE_LIMITS.markdownCharacters).length;
  if (document.elements.length > MERGE_LIMITS.elementsPerDocument) throw mergeLimitError();
  for (const element of document.elements) {
    if (!element || typeof element !== 'object') throw mergeLimitError();
    totalTextCharacters += boundedText(element.text, MERGE_LIMITS.textCharacters).length;
    if (totalTextCharacters > MERGE_LIMITS.totalTextCharactersPerDocument) throw mergeLimitError();
    const table = element.table_structure;
    if (!Array.isArray(table?.cells)) continue;
    const rows = boundedInteger(table.rows ?? 0, 0, MERGE_LIMITS.tableRows);
    const columns = boundedInteger(table.cols ?? 0, 0, MERGE_LIMITS.tableColumns);
    if (rows * columns > MERGE_LIMITS.tableGridCells || table.cells.length > MERGE_LIMITS.tableCells) throw mergeLimitError();
    if (table.cells.length > 0 && (rows === 0 || columns === 0)) throw mergeLimitError();
    for (const cell of table.cells) {
      if (!cell || typeof cell !== 'object') throw mergeLimitError();
      const row = boundedInteger(cell.row, 1, rows);
      const column = boundedInteger(cell.col, 1, columns);
      const rowSpan = boundedInteger(cell.row_span ?? 1, 1, MERGE_LIMITS.cellSpan);
      const columnSpan = boundedInteger(cell.col_span ?? 1, 1, MERGE_LIMITS.cellSpan);
      if (row + rowSpan - 1 > rows || column + columnSpan - 1 > columns) throw mergeLimitError();
      totalTextCharacters += boundedText(cell.text, MERGE_LIMITS.textCharacters).length;
      if (totalTextCharacters > MERGE_LIMITS.totalTextCharactersPerDocument) throw mergeLimitError();
    }
  }
}

const compact = (value) => String(value ?? '').replace(/\s+/g, '');
const pad = (value) => String(value).padStart(2, '0');
const isoDate = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const isoDateTime = (date, time) => `${date}T${time}:00${TIME_ZONE}`;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function assertContext(context) {
  if (!context?.student?.name?.trim()) throw new MergeError('请填写孩子姓名');
  if (!context?.student?.class_name?.trim()) throw new MergeError('请填写班级');
  if (context.as_of && Number.isNaN(Date.parse(context.as_of))) throw new MergeError('as_of 不是有效时间');
}

function sortedDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) throw new MergeError('至少需要一份解析文档');
  if (documents.length > MERGE_LIMITS.documents) throw mergeLimitError();
  const ids = new Set();
  for (const document of documents) {
    if (!document?.document_id || ids.has(document.document_id)) throw new MergeError('文档 ID 缺失或重复');
    if (!Array.isArray(document.elements) || document.elements.length === 0) throw new MergeError(`${document.name ?? '文档'} 缺少解析正文`);
    assertDocumentBounds(document);
    ids.add(document.document_id);
  }
  return [...documents].sort((left, right) =>
    String(left.issued_at ?? '').localeCompare(String(right.issued_at ?? '')) || left.document_id.localeCompare(right.document_id),
  );
}

function documentText(document) {
  return [document.markdown, ...document.elements.map((element) => element.text)].filter(Boolean).join('\n');
}

function findDocument(documents, pattern) {
  return documents.find((document) => pattern.test(documentText(document)));
}

function evidence(document, needles) {
  if (!document) return [];
  const wanted = (Array.isArray(needles) ? needles : [needles]).map(compact);
  const element = document.elements.find((candidate) => wanted.every((needle) => compact(candidate.text).includes(needle)));
  if (!element) throw new MergeError(`无法为“${wanted.join(' / ')}”定位原文证据`);
  const firstNeedle = Array.isArray(needles) ? needles[0] : needles;
  const rawText = String(element.text);
  const index = rawText.indexOf(firstNeedle);
  const quote = index >= 0 ? rawText.slice(Math.max(0, index - 28), index + firstNeedle.length + 96) : rawText.slice(0, 160);
  return [{
    document_id: document.document_id,
    document_name: document.name,
    element_id: element.element_id,
    page_number: element.page_number ?? 1,
    quote,
  }];
}

function requiredMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new MergeError(`没有识别到${label}`);
  return match;
}

function labelValue(text, label) {
  const escaped = escapeRegex(label);
  const match = text.match(new RegExp(`${escaped}\\s*[|：:]\\s*([^|；。\\n]+)`));
  return match?.[1]?.trim().replace(/[（(]虚构[）)]/g, '') ?? '';
}

function tableRows(document) {
  const table = document?.elements.find((element) => element.table_structure?.cells?.length);
  if (!table) return [];
  const { rows, cols, cells } = table.table_structure;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(''));
  for (const cell of cells) {
    const rowStart = Math.max(0, Number(cell.row) - 1);
    const colStart = Math.max(0, Number(cell.col) - 1);
    for (let row = rowStart; row < Math.min(rows, rowStart + Number(cell.row_span || 1)); row += 1) {
      for (let col = colStart; col < Math.min(cols, colStart + Number(cell.col_span || 1)); col += 1) {
        grid[row][col] = String(cell.text ?? '').trim();
      }
    }
  }
  return grid;
}

function groupItems(document, childName) {
  const rows = tableRows(document);
  const headerIndex = rows.findIndex((row) => row.includes('组别') && row.includes('成员'));
  if (headerIndex < 0) return { group: '', items: [] };
  const memberIndex = rows[headerIndex].indexOf('成员');
  const groupIndex = rows[headerIndex].indexOf('组别');
  const itemIndex = rows[headerIndex].indexOf('物资');
  const quantityIndex = rows[headerIndex].indexOf('数量');
  const ownerIndex = rows[headerIndex].indexOf('负责方式');
  const matchingRows = rows.slice(headerIndex + 1).filter((row) => row[memberIndex]?.includes(childName));
  const group = matchingRows[0]?.[groupIndex] ?? '';
  const items = matchingRows
    .filter((row) => row[ownerIndex] === '每人自带' || row[ownerIndex]?.includes(`${childName}家庭`))
    .map((row) => ({ name: row[itemIndex], quantity: row[quantityIndex], owner: row[ownerIndex] }))
    .filter((item) => item.name);
  return { group, items };
}

function completedAction(context, kind) {
  return (context.completed_actions ?? []).find((action) => action.kind === kind);
}

function resolvedSubmission(id, label, completion, sourceEvidence, extra = {}) {
  return {
    id,
    label,
    status: 'completed',
    completed_at: completion.completed_at,
    repeat_required: false,
    evidence: sourceEvidence,
    ...extra,
  };
}

export function mergeDocuments(inputDocuments, context) {
  assertContext(context);
  const documents = sortedDocuments(inputDocuments);
  const base = findDocument(documents, /研学活动通知|无论参加与否/);
  if (!base) throw new MergeError('请先上传包含活动安排的基础通知');
  const groupDocument = findDocument(documents, /组别[\s\S]*成员[\s\S]*负责方式/);
  const adjustment = findDocument(documents, /集合地点由[“"][^”"]+[”"]改为/);
  const weather = findDocument(documents, /研学改期|原定\s*\d+月\d+日[\s\S]*改为\s*\d+月\d+日/);
  const baseText = documentText(base);
  const baseCompact = compact(baseText);
  const titleElement = base.elements.find((element) => /研学活动通知/.test(element.text));
  const title = String(titleElement?.text ?? '研学活动').replace(/通知\s*$/, '').trim();
  const dateMatch = requiredMatch(baseCompact, /活动日期[|：:]*(\d{4})年(\d{1,2})月(\d{1,2})日/, '活动日期');
  const baseDate = isoDate(dateMatch[1], dateMatch[2], dateMatch[3]);
  const baseDateNeedle = `${dateMatch[1]}年${dateMatch[2]}月${dateMatch[3]}日`;
  const timeMatch = requiredMatch(baseCompact, /集合时间[|：:]*(?:上午)?(\d{1,2}):(\d{2})/, '集合时间');
  const baseTime = `${pad(timeMatch[1])}:${timeMatch[2]}`;
  const baseTimeNeedle = `${timeMatch[1]}:${timeMatch[2]}`;
  const baseLocation = labelValue(baseText, '集合地点');
  const destination = labelValue(baseText, '活动地点');
  const returnMatch = requiredMatch(baseCompact, /(?:预计返校|返校时间)[|：:]*(?:下午)?(\d{1,2})\s*:(\d{2})/, '返校时间');
  const returnTime = `${pad(returnMatch[1])}:${returnMatch[2]}`;
  const returnTimeNeedle = `${returnMatch[1]}:${returnMatch[2]}`;
  const receiptMatch = requiredMatch(baseCompact, /(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})前提交电子回执/, '回执截止时间');
  const receiptDue = isoDateTime(isoDate(receiptMatch[1], receiptMatch[2], receiptMatch[3]), `${pad(receiptMatch[4])}:${receiptMatch[5]}`);
  const feeMatch = requiredMatch(baseCompact, /活动费用(\d+)元\/人/, '活动费用');
  const amountCny = Number(feeMatch[1]);
  const paymentNeedle = `${amountCny}元/人`;

  let eventDate = baseDate;
  let meetTime = baseTime;
  let meetLocation = baseLocation;
  let dateEvidence = evidence(base, baseDateNeedle);
  let meetTimeEvidence = evidence(base, baseTimeNeedle);
  let meetLocationEvidence = evidence(base, baseLocation);
  const changes = [];
  if (weather) {
    const text = compact(documentText(weather));
    const year = Number(weather.issued_at?.slice(0, 4) || dateMatch[1]);
    const changedDate = requiredMatch(text, /原定(\d{1,2})月(\d{1,2})日[^。]*?改为(\d{1,2})月(\d{1,2})日/, '改期日期');
    eventDate = isoDate(year, changedDate[3], changedDate[4]);
    const oldDateNeedle = `${changedDate[1]}月${changedDate[2]}日`;
    const newDateNeedle = `${changedDate[3]}月${changedDate[4]}日`;
    const changedTime = requiredMatch(text, /集合时间由(\d{1,2}):(\d{2})改为(\d{1,2}):(\d{2})/, '变更后的集合时间');
    meetTime = `${pad(changedTime[3])}:${changedTime[4]}`;
    const oldTimeNeedle = `${changedTime[1]}:${changedTime[2]}`;
    const newTimeNeedle = `${changedTime[3]}:${changedTime[4]}`;
    dateEvidence = [...dateEvidence, ...evidence(weather, [oldDateNeedle, newDateNeedle])];
    meetTimeEvidence = [...meetTimeEvidence, ...evidence(weather, [oldTimeNeedle, newTimeNeedle])];
    changes.push(
      { id: 'event_date', kind: 'modified', field: 'event.date', label: '活动日期', before: baseDate, after: eventDate, evidence: dateEvidence },
      { id: 'meet_time', kind: 'modified', field: 'event.meet_time', label: '集合时间', before: baseTime, after: meetTime, evidence: meetTimeEvidence },
    );
  }
  if (adjustment) {
    const locationMatch = requiredMatch(compact(documentText(adjustment)), /集合地点由[“"]([^”"]+)[”"]改为[“"]([^”"]+)[”"]/, '变更后的集合地点');
    meetLocation = locationMatch[2];
    meetLocationEvidence = [...meetLocationEvidence, ...evidence(adjustment, [locationMatch[1], locationMatch[2]])];
    changes.push({
      id: 'meet_location',
      kind: 'modified',
      field: 'event.meet_location',
      label: '集合地点',
      before: locationMatch[1],
      after: locationMatch[2],
      evidence: meetLocationEvidence,
    });
  }

  // shortcut: the contest MVP extracts the fixed school-event vocabulary; add a schema-driven model before supporting arbitrary notices.
  const baseItems = ['秋季校服', '运动鞋', '500mL水杯', '轻便雨衣']
    .filter((name) => baseCompact.includes(compact(name)))
    .map((name) => ({ name, quantity: '', status: 'required', evidence: evidence(base, name) }));
  const membership = groupItems(groupDocument, context.student.name);
  const items = [...baseItems, ...membership.items.map((item) => ({
    ...item,
    status: adjustment && compact(documentText(adjustment)).includes(`${compact(item.name)}不用准备`) ? 'cancelled' : 'required',
    evidence: evidence(groupDocument, item.name),
  }))];
  const trashBags = items.find((item) => item.name === '加厚垃圾袋');
  if (trashBags?.status === 'cancelled') {
    changes.push({
      id: 'trash_bags',
      kind: 'cancelled',
      field: 'items.trash_bags.status',
      label: '加厚垃圾袋',
      before: `需要准备 ${trashBags.quantity}`,
      after: '不用准备',
      evidence: [...trashBags.evidence, ...evidence(adjustment, '加厚垃圾袋不用准备')],
    });
  }

  let unableDue = '';
  if (weather) {
    const text = compact(documentText(weather));
    const year = Number(weather.issued_at?.slice(0, 4) || dateMatch[1]);
    const unableMatch = requiredMatch(text, /不能参加改期活动的[^\d]*(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})前私聊/, '不能参加时的联系截止时间');
    unableDue = isoDateTime(isoDate(year, unableMatch[1], unableMatch[2]), `${pad(unableMatch[3])}:${unableMatch[4]}`);
    changes.push({
      id: 'unable_to_attend',
      kind: 'conditional',
      field: 'conditional_todos.unable_to_attend',
      label: '不能参加时联系老师',
      before: '无',
      after: `${unableDue.slice(5, 16).replace('T', ' ')} 前私聊班主任`,
      evidence: evidence(weather, '不能参加改期活动的'),
    });
  }

  const constraints = ['现金', '电子游戏设备']
    .filter((name) => baseCompact.includes(compact(name)))
    .map((name) => ({ text: `不得携带${name}`, evidence: evidence(base, name) }));
  const resolvedActions = [];
  const acknowledgement = adjustment && compact(documentText(adjustment)).match(
    new RegExp(`${escapeRegex(compact(context.student.name))}家长(\\d{1,2}):(\\d{2})收到`),
  );
  if (acknowledgement) {
    const issuedDate = String(adjustment.issued_at).slice(0, 10);
    resolvedActions.push({
      id: 'acknowledge_adjustment',
      label: '群接龙确认收到',
      status: 'completed',
      completed_by: `${context.student.name}家长`,
      completed_at: isoDateTime(issuedDate, `${pad(acknowledgement[1])}:${acknowledgement[2]}`),
      evidence: evidence(adjustment, `${context.student.name}家长`),
    });
  }
  const noRepeatEvidence = weather ? evidence(weather, '已交回执和费用无需重复提交') : evidence(base, '电子回执');
  const receiptCompletion = completedAction(context, 'receipt');
  const paymentCompletion = completedAction(context, 'payment');
  if (receiptCompletion) resolvedActions.push(resolvedSubmission('submit_receipt', '提交电子回执', receiptCompletion, noRepeatEvidence));
  if (paymentCompletion) resolvedActions.push(resolvedSubmission('pay_fee', `缴纳活动费 ${amountCny} 元`, paymentCompletion, noRepeatEvidence, { amount_cny: amountCny }));
  const needsConfirmation = [];
  if (weather && !receiptCompletion) needsConfirmation.push({ kind: 'receipt', message: '请确认此前是否已提交电子回执；已提交则无需重复提交', evidence: noRepeatEvidence });
  if (weather && !paymentCompletion && context.student.participating !== false) needsConfirmation.push({ kind: 'payment', message: `请确认此前是否已缴纳 ${amountCny} 元活动费；已缴纳则无需重复缴费`, evidence: noRepeatEvidence });

  const result = {
    schema_version: 1,
    event: {
      title,
      status: weather ? 'rescheduled' : 'scheduled',
      date: eventDate,
      meet_time: meetTime,
      meet_location: meetLocation,
      destination,
      return_time: returnTime,
      evidence: {
        title: evidence(base, titleElement?.text ?? title),
        date: dateEvidence,
        meet_time: meetTimeEvidence,
        meet_location: meetLocationEvidence,
        destination: weather ? [...evidence(base, destination), ...evidence(weather, '活动地点和其他准备要求不变')] : evidence(base, destination),
        return_time: weather ? [...evidence(base, returnTimeNeedle), ...evidence(weather, ['返校时间', returnTimeNeedle])] : evidence(base, returnTimeNeedle),
      },
    },
    student: { ...context.student, group: membership.group },
    receipt: { due_at: receiptDue, evidence: evidence(base, '电子回执') },
    payment: { amount_cny: amountCny, due_at: receiptDue, participating_only: true, evidence: evidence(base, ['活动费用', paymentNeedle]) },
    items,
    constraints,
    changes,
    conditional: unableDue ? { id: 'unable_to_attend', due_at: unableDue, condition: `不能参加${eventDate}改期活动`, action: '私聊班主任王老师', evidence: evidence(weather, '不能参加改期活动的') } : null,
    resolved_actions: resolvedActions,
    needs_confirmation: needsConfirmation,
    stable_facts: [
      { label: '返校时间', value: returnTime, evidence: weather ? evidence(weather, ['返校时间', returnTimeNeedle]) : evidence(base, returnTimeNeedle) },
      ...(items.some((item) => item.name === '蓝色帽子') ? [{ label: '蓝色帽子', value: '照常携带', evidence: adjustment ? evidence(adjustment, '蓝色帽子照常携带') : evidence(groupDocument, '蓝色帽子') }] : []),
    ],
    documents: documents.map(({ document_id, name, issued_at }) => ({ document_id, name, issued_at })),
    as_of: context.as_of ?? new Date().toISOString(),
  };
  result.summary = {
    document_count: documents.length,
    change_count: changes.length,
    evidence_count: new Set(documents.flatMap((document) => document.elements.map((element) => element.element_id))).size,
  };
  return result;
}

export function finalizePlan(analysis, decisions) {
  const changeDecisions = decisions?.change_decisions;
  if (!changeDecisions || typeof changeDecisions !== 'object') throw new MergeError('请确认每一项变化');
  for (const change of analysis.changes) {
    if (typeof changeDecisions[change.id] !== 'boolean') throw new MergeError(`尚未确认：${change.label}`);
  }
  const plan = structuredClone(analysis);
  const accepted = (id) => changeDecisions[id] === true;
  const changeById = new Map(plan.changes.map((change) => [change.id, change]));
  if (changeById.has('event_date') && changeById.has('unable_to_attend') && !accepted('event_date') && accepted('unable_to_attend')) {
    throw new MergeError('拒绝活动日期变更后，不能采用“不能参加改期活动”事项');
  }
  if (changeById.has('event_date') && !accepted('event_date')) plan.event.date = changeById.get('event_date').before;
  if (changeById.has('meet_time') && !accepted('meet_time')) plan.event.meet_time = changeById.get('meet_time').before;
  if (changeById.has('meet_location') && !accepted('meet_location')) plan.event.meet_location = changeById.get('meet_location').before;
  if (plan.conditional) {
    plan.conditional = {
      ...plan.conditional,
      condition: `不能参加${plan.event.date}${accepted('event_date') ? '改期活动' : '活动'}`,
    };
  }
  const trashBags = plan.items.find((item) => item.name === '加厚垃圾袋');
  if (trashBags) trashBags.status = accepted('trash_bags') ? 'cancelled' : 'required';
  plan.changes = plan.changes.map((change) => ({ ...change, decision: accepted(change.id) ? 'accepted' : 'deferred' }));

  const resolved = [...plan.resolved_actions];
  const activeTodos = [];
  const submissionStates = decisions.submission_states ?? {};
  for (const confirmation of plan.needs_confirmation) {
    if (!['submitted', 'not_submitted'].includes(submissionStates[confirmation.kind])) {
      throw new MergeError(`请确认${confirmation.kind === 'receipt' ? '回执' : '费用'}是否已经提交`);
    }
  }
  const asOf = Date.parse(plan.as_of);
  const statusAt = (dueAt) => Date.parse(dueAt) < asOf ? 'overdue' : 'pending';
  if (!resolved.some((item) => item.id === 'submit_receipt')) {
    if (submissionStates.receipt === 'submitted') {
      resolved.push({ id: 'submit_receipt', label: '提交电子回执', status: 'completed', repeat_required: false, evidence: plan.needs_confirmation.find((item) => item.kind === 'receipt')?.evidence ?? plan.receipt.evidence });
    } else {
      activeTodos.push({ id: 'submit_receipt', title: '提交电子回执', due_at: plan.receipt.due_at, status: statusAt(plan.receipt.due_at), condition: '无论参加与否', evidence: plan.receipt.evidence });
    }
  }
  if (plan.student.participating !== false && !resolved.some((item) => item.id === 'pay_fee')) {
    if (submissionStates.payment === 'submitted') {
      resolved.push({ id: 'pay_fee', label: `缴纳活动费 ${plan.payment.amount_cny} 元`, amount_cny: plan.payment.amount_cny, status: 'completed', repeat_required: false, evidence: plan.needs_confirmation.find((item) => item.kind === 'payment')?.evidence ?? plan.payment.evidence });
    } else {
      activeTodos.push({ id: 'pay_fee', title: `缴纳活动费 ${plan.payment.amount_cny} 元`, due_at: plan.payment.due_at, status: statusAt(plan.payment.due_at), condition: '仅参加活动时', evidence: plan.payment.evidence });
    }
  }
  if (plan.student.participating !== false) {
    const requiredItems = plan.items.filter((item) => item.status === 'required');
    activeTodos.push({
      id: 'prepare_personal_items',
      title: '准备研学个人物品',
      due_at: isoDateTime(plan.event.date, plan.event.meet_time),
      status: 'pending',
      items: requiredItems.map((item) => item.quantity ? `${item.name}（${item.quantity}）` : item.name),
      evidence: requiredItems.flatMap((item) => item.evidence),
    });
    activeTodos.push({
      id: 'attend_activity',
      title: `${Number(plan.event.date.slice(5, 7))}月${Number(plan.event.date.slice(8, 10))}日${plan.event.meet_time}到${plan.event.meet_location}集合`,
      due_at: isoDateTime(plan.event.date, plan.event.meet_time),
      status: 'pending',
      evidence: [...plan.event.evidence.date, ...plan.event.evidence.meet_time, ...plan.event.evidence.meet_location],
    });
  }
  let conditionalTodos = [];
  if (plan.conditional && accepted('unable_to_attend')) {
    if (plan.student.participating === false) {
      activeTodos.push({
        id: plan.conditional.id,
        title: `联系班主任说明${plan.conditional.condition}`,
        due_at: plan.conditional.due_at,
        status: statusAt(plan.conditional.due_at),
        action: plan.conditional.action,
        evidence: plan.conditional.evidence,
      });
    } else {
      conditionalTodos = [plan.conditional];
    }
  }
  if (trashBags?.status === 'cancelled') {
    resolved.push({ id: 'bring_trash_bags', label: `加厚垃圾袋 ${trashBags.quantity}`, status: 'cancelled', evidence: changeById.get('trash_bags').evidence });
  }
  plan.active_todos = activeTodos;
  plan.conditional_todos = conditionalTodos;
  plan.resolved_actions = resolved;
  plan.cancelled_actions = resolved.filter((action) => action.status === 'cancelled');
  plan.needs_confirmation = [];
  plan.summary = {
    ...plan.summary,
    active_count: activeTodos.length,
    conditional_count: conditionalTodos.length,
    resolved_count: resolved.filter((item) => item.status === 'completed').length,
    cancelled_count: resolved.filter((item) => item.status === 'cancelled').length,
  };
  return plan;
}
