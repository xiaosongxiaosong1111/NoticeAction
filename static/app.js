import {
  HISTORY_KEY,
  loadHistory,
  persistHistory,
  removeRecord,
  setTaskCompleted,
  upsertPlan,
} from '/history.js';

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  analysis: null,
  plan: null,
  files: [],
  decisions: {},
  requiredSubmissions: [],
  history: loadHistory(localStorage),
  currentRecordId: null,
  activeView: 'dashboard',
  evidenceTrigger: null,
  demoMode: false,
  liveParseConfigured: null,
  workflowRevision: 0,
  workflowController: new AbortController(),
  operationActive: false,
};

const uploadForm = $('#upload-form');
const fileInput = $('#notice-files');
const fileList = $('#file-list');
const analyzeButton = $('#analyze-button');
const demoButton = $('#demo-button');
const finalizeButton = $('#finalize-button');
const message = $('#global-message');
const dialog = $('#evidence-dialog');
const helpDialog = $('#help-dialog');
const helpButton = $('#help-button');
const quickDemoButton = $('#quick-demo-button');
const helpDemoButton = $('#help-demo-button');
const demoButtons = [demoButton, quickDemoButton, helpDemoButton];
let helpTrigger = helpButton;
let restoreHelpFocus = true;
let helpAfterClose = null;

function text(value, fallback = '—') {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function showMessage(value = '') {
  message.textContent = value;
  message.hidden = !value;
  if (value) message.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setBusy(button, busy, busyText) {
  if (busy) button.dataset.label = button.textContent;
  button.disabled = busy || (button === analyzeButton && state.liveParseConfigured !== true);
  if (busy) button.textContent = busyText;
  else if (button.dataset.label) button.textContent = button.dataset.label;
  document.body.classList.toggle('is-loading', busy);
}

function renewWorkflow() {
  state.workflowController.abort();
  state.workflowRevision += 1;
  state.workflowController = new AbortController();
  state.operationActive = false;
  for (const button of [analyzeButton, finalizeButton, ...demoButtons]) {
    if (button.dataset.label) button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  analyzeButton.disabled = state.liveParseConfigured !== true;
  finalizeButton.disabled = true;
  for (const button of demoButtons) button.disabled = false;
  document.body.classList.remove('is-loading');
}

function beginOperation() {
  renewWorkflow();
  state.operationActive = true;
  return { revision: state.workflowRevision, signal: state.workflowController.signal };
}

function workflowCancelled(error, revision, signal) {
  return signal.aborted || revision !== state.workflowRevision || error?.name === 'AbortError';
}

async function request(url, options) {
  const response = await fetch(url, options);
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok || !body.ok) throw new Error(body.error?.message || body.error || '请求失败（' + response.status + '）');
  return body;
}

function currentRecord() {
  return state.history.find((record) => record.id === state.currentRecordId) || null;
}

function currentSource() {
  return state.plan || state.analysis || currentRecord() || state.history[0];
}

function viewElement(view) {
  return $('#' + (view === 'dashboard' ? 'view-dashboard' : view === 'evidence' ? 'view-evidence' : 'step-' + view));
}

function updateNavAvailability() {
  const enabled = {
    confirm: Boolean(state.analysis),
    plan: Boolean(state.plan || state.history.length),
    evidence: Boolean(currentSource()),
  };
  for (const view of Object.keys(enabled)) {
    document.querySelectorAll('button[data-view="' + view + '"]').forEach((button) => {
      button.disabled = !enabled[view];
    });
  }
  const count = state.analysis?.changes?.length || 0;
  $('#nav-change-count').textContent = String(count);
  $('#nav-change-count').hidden = count === 0;
}

function updateCurrentNav(view) {
  for (const item of document.querySelectorAll('.nav-item[data-view], .mobile-nav [data-view]')) {
    const active = item.dataset.view === view;
    item.classList.toggle('is-current', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

function goToView(view, focus = true) {
  if (view === 'confirm' && !state.analysis) return;
  if (view === 'plan' && !state.plan) {
    if (state.history.length) return openRecord(state.history[0].id);
    return;
  }
  if (view === 'evidence' && !currentSource()) return;
  const next = viewElement(view);
  if (!next) return;
  document.querySelectorAll('.app-view').forEach((section) => { section.hidden = section !== next; });
  state.activeView = view;
  updateCurrentNav(view);
  if (view === 'dashboard') {
    updateFamily(state.history[0]?.student);
    renderDashboard();
  }
  if (view === 'plan' && state.plan) updateFamily(state.plan.student);
  if (view === 'evidence') renderEvidenceCenter();
  showMessage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const heading = $('h1', next);
  if (focus && heading) heading.focus({ preventScroll: true });
}

function goToStep(step) {
  const view = ['upload', 'confirm', 'plan'][step - 1];
  for (const indicator of document.querySelectorAll('[data-step-indicator]')) {
    const index = Number(indicator.dataset.stepIndicator);
    indicator.classList.toggle('is-current', index === step);
    indicator.classList.toggle('is-done', index < step);
    if (index === step) indicator.setAttribute('aria-current', 'step');
    else indicator.removeAttribute('aria-current');
    $('span', indicator).textContent = index < step ? '✓' : String(index);
  }
  updateNavAvailability();
  goToView(view);
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function setFiles(files) {
  state.files = [...files].map((file) => ({ file, status: 'pending', label: '等待解析' }));
  renderFiles();
}

function renderFiles() {
  $('#selected-file-count').textContent = state.files.length + ' 份材料';
  fileList.replaceChildren(...state.files.map(({ file, status, label }) =>
    element('li', {}, [
      element('span', { className: 'file-name' }, [
        element('b', { textContent: file.name }),
        element('small', { textContent: formatSize(file.size) }),
      ]),
      element('span', { className: 'file-state ' + status, textContent: label }),
    ]),
  ));
}

function validateFiles() {
  if (!state.files.length) throw new Error('请至少选择一份通知材料。');
  if (state.files.length > 20) throw new Error('一次最多选择 20 份材料，避免超额解析。');
  const tooLarge = state.files.find(({ file }) => file.size > 10 * 1024 * 1024);
  if (tooLarge) throw new Error('“' + tooLarge.file.name + '”超过 10 MB，请压缩后重试。');
}

function eventFacts(event) {
  return [
    ['日期', event.date],
    ['集合', [event.meet_time, event.meet_location].filter(Boolean).join(' · ')],
    ['地点', event.destination],
    ['返校', event.return_time],
  ];
}

function renderEvent(root, event, final = false, student = null) {
  const person = student || state.plan?.student || state.analysis?.student || {};
  const date = final ? element('span', { className: 'event-date', textContent: text(event.date) }) : null;
  const studentLine = [person.name, person.class_name, person.group].filter(Boolean).join(' · ');
  root.replaceChildren(...[
    date,
    element('h3', { textContent: text(event.title, '本次活动') }),
    studentLine ? element('p', { className: 'student-line', textContent: studentLine }) : null,
    element('div', { className: 'event-meta' }, eventFacts(event).map(([label, value]) =>
      element('div', {}, [
        element('small', { textContent: label }),
        element('strong', { textContent: text(value) }),
      ]),
    )),
  ].filter(Boolean));
}

const changeLabels = {
  event_date: ['活动日期', '日'],
  meet_time: ['集合时间', '时'],
  meet_location: ['集合地点', '地'],
  trash_bags: ['分组物资', '物'],
  unable_to_attend: ['无法参加时', '报'],
};

function evidenceFor(value) {
  return Array.isArray(value?.evidence) ? value.evidence : [];
}

function documentName(documentId, source = currentSource()) {
  return source?.documents?.find((item) => item.document_id === documentId)?.name || documentId;
}

function describeChange(change) {
  const before = change.before ?? change.old_value ?? change.from;
  const after = change.after ?? change.new_value ?? change.to ?? change.value;
  if (before !== undefined && after !== undefined) return { before: text(before), after: text(after) };
  return { description: text(change.description ?? change.text ?? change.summary, '请按最新通知更新') };
}

function changeCard(change) {
  const [fallbackTitle, icon] = changeLabels[change.id] || ['通知变化', '变'];
  const detail = describeChange(change);
  const copy = element('div', { className: 'change-copy' }, [
    element('h3', { textContent: text(change.title ?? change.label, fallbackTitle) }),
  ]);
  const paragraph = element('p');
  if (detail.description) paragraph.textContent = detail.description;
  else paragraph.append(
    element('del', { textContent: detail.before }),
    document.createTextNode(' → '),
    element('ins', { textContent: detail.after }),
  );
  copy.append(paragraph);

  const evidenceButton = element('button', {
    className: 'evidence-button',
    type: 'button',
    'data-evidence-index': change.id,
    textContent: '查看原文片段 ↗',
  });
  const accept = element('button', { type: 'button', 'data-decision': 'true', 'aria-pressed': 'false', textContent: '按新通知执行' });
  const reject = element('button', { type: 'button', 'data-decision': 'false', 'aria-pressed': 'false', textContent: '仍按旧通知执行' });
  for (const button of [accept, reject]) {
    button.addEventListener('click', () => {
      state.decisions[change.id] = button.dataset.decision === 'true';
      accept.setAttribute('aria-pressed', String(state.decisions[change.id]));
      reject.setAttribute('aria-pressed', String(!state.decisions[change.id]));
      updateFinalizeState();
    });
  }
  evidenceButton.addEventListener('click', () => showEvidence(change));

  return element('article', { className: 'change-card' }, [
    element('span', { className: 'change-icon', 'aria-hidden': 'true', textContent: icon }),
    copy,
    evidenceButton,
    element('div', { className: 'decision-row', 'aria-label': fallbackTitle + '处理方式' }, [accept, reject]),
  ]);
}

function showEvidence(subject) {
  state.evidenceTrigger = document.activeElement;
  const evidence = evidenceFor(subject);
  $('#evidence-content').replaceChildren(...(evidence.length ? evidence.map((item) =>
    element('article', { className: 'evidence' }, [
      element('blockquote', { textContent: '“' + text(item.quote, '原文片段') + '”' }),
      element('p', {
        textContent: [
          text(item.document_name ?? item.filename ?? documentName(item.document_id), '通知材料'),
          item.page_number ? '第 ' + item.page_number + ' 页' : '原文片段',
        ].join(' · '),
      }),
    ]),
  ) : [element('p', { className: 'empty-state', textContent: '该结论的原文定位暂不可用。' })]));
  dialog.showModal();
}

function renderAnalysis(analysis, demoMode = false) {
  state.analysis = analysis;
  state.plan = null;
  state.currentRecordId = null;
  state.decisions = {};
  state.demoMode = demoMode;
  renderEvent($('#event-preview'), analysis.event || {}, false, analysis.student);
  const changes = analysis.changes || [];
  $('#change-summary-pill').textContent = changes.length + ' 项变化';
  $('#change-list').replaceChildren(...(changes.length ? changes.map(changeCard) : [
    element('p', { className: 'empty-state surface', textContent: '没有发现需要确认的变更。' }),
  ]));
  document.querySelectorAll('[name^="submission-"]').forEach((radio) => { radio.checked = false; });
  const confirmationKinds = new Set((analysis.needs_confirmation || []).map(({ kind }) => kind));
  state.requiredSubmissions = [
    ...(confirmationKinds.has('receipt') ? ['receipt'] : []),
    ...(analysis.student?.participating !== false && confirmationKinds.has('payment') ? ['payment'] : []),
  ];
  $('#receipt-confirmation').hidden = !state.requiredSubmissions.includes('receipt');
  $('#payment-confirmation').hidden = !state.requiredSubmissions.includes('payment');
  $('#payment-title').textContent = analysis.payment?.amount_cny ? analysis.payment.amount_cny + ' 元活动费' : '活动费';
  updateFamily(analysis.student);
  updateFinalizeState();
  renderEvidenceCenter();
  goToStep(2);
}

async function parseSelectedFiles(revision, signal) {
  validateFiles();
  if (state.liveParseConfigured !== true) {
    throw new Error('当前仅支持示例体验；请用 .\\start.ps1 -Live 重新启动后再上传。');
  }
  const documents = [];
  for (const entry of state.files) {
    if (workflowCancelled(null, revision, signal)) return null;
    entry.status = 'working';
    entry.label = 'xParse 解析中…';
    renderFiles();
    try {
      const result = await request('/api/parse?filename=' + encodeURIComponent(entry.file.name), {
        method: 'POST',
        headers: { 'Content-Type': entry.file.type || 'application/octet-stream' },
        body: entry.file,
        signal,
      });
      if (workflowCancelled(null, revision, signal)) return null;
      documents.push(result.document);
      entry.status = 'done';
      entry.label = '已提取';
      renderFiles();
    } catch (error) {
      if (workflowCancelled(error, revision, signal)) return null;
      entry.status = 'error';
      entry.label = '解析失败';
      renderFiles();
      throw new Error(entry.file.name + '：' + error.message);
    }
  }
  return documents;
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!uploadForm.reportValidity()) return;
  const { revision, signal } = beginOperation();
  showMessage();
  setBusy(analyzeButton, true, '正在读懂通知…');
  try {
    const documents = await parseSelectedFiles(revision, signal);
    if (!documents || workflowCancelled(null, revision, signal)) return;
    const context = {
      student: {
        name: $('#child-name').value.trim(),
        class_name: $('#class-name').value.trim(),
        participating: $('#participating').checked,
      },
      completed_actions: [],
    };
    const result = await request('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents, context }),
      signal,
    });
    if (workflowCancelled(null, revision, signal)) return;
    renderAnalysis(result.analysis);
  } catch (error) {
    if (!workflowCancelled(error, revision, signal)) showMessage(error.message);
  } finally {
    if (revision === state.workflowRevision) {
      state.operationActive = false;
      setBusy(analyzeButton, false);
    }
  }
});

async function loadDemo(trigger) {
  const profile = trigger === demoButton
    ? {
        name: $('#child-name').value.trim() || '林小满',
        className: $('#class-name').value.trim() || '三（2）班',
        participating: $('#participating').checked,
      }
    : { name: '林小满', className: '三（2）班', participating: true };
  const hasDraft = state.files.length > 0 || (state.analysis && !state.plan);
  if (hasDraft && !window.confirm('体验示例会放弃当前未完成的材料和确认进度，是否继续？')) return;
  if (helpDialog.open) {
    restoreHelpFocus = false;
    await new Promise((resolve) => {
      helpAfterClose = resolve;
      helpDialog.close();
    });
  }
  newWorkflow();
  const { revision, signal } = beginOperation();
  $('#child-name').value = profile.name;
  $('#class-name').value = profile.className;
  $('#participating').checked = profile.participating;
  showMessage();
  setBusy(trigger, true, '正在载入示例…');
  try {
    const url = '/api/demo?child_name=' + encodeURIComponent(profile.name) + '&participating=' + profile.participating;
    const result = await request(url, { signal });
    if (workflowCancelled(null, revision, signal)) return;
    renderAnalysis(result.analysis, true);
  } catch (error) {
    if (!workflowCancelled(error, revision, signal)) showMessage(error.message);
  } finally {
    if (revision === state.workflowRevision) {
      state.operationActive = false;
      setBusy(trigger, false);
    }
  }
}

for (const trigger of demoButtons) {
  trigger.addEventListener('click', () => loadDemo(trigger));
}

fileInput.addEventListener('change', () => setFiles(fileInput.files));
const dropZone = $('#drop-zone');
for (const type of ['dragenter', 'dragover']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
}
dropZone.addEventListener('drop', (event) => setFiles(event.dataTransfer.files));

function updateFinalizeState() {
  const changes = state.analysis?.changes || [];
  const undecided = changes.filter(({ id }) => typeof state.decisions[id] !== 'boolean');
  const missingSubmissions = state.requiredSubmissions.filter((kind) => !$('[name="submission-' + kind + '"]:checked'));
  const total = changes.length + state.requiredSubmissions.length;
  const completed = total - undecided.length - missingSubmissions.length;
  const ready = completed === total;

  finalizeButton.disabled = !ready;
  $('#review-progress-text').textContent = completed + ' / ' + total;
  $('#review-progress-title').textContent = ready ? '审核完成' : '还差 ' + (total - completed) + ' 项';
  const progress = total ? completed / total * 100 : 100;
  $('#review-progress-bar').value = progress;
  $('#review-progress-bar').textContent = Math.round(progress) + '%';

  const reasons = [];
  if (undecided.length) reasons.push('还有 ' + undecided.length + ' 项变化未确认');
  if (missingSubmissions.includes('receipt')) reasons.push('请选择回执状态');
  if (missingSubmissions.includes('payment')) reasons.push('请选择缴费状态');
  $('#finalize-reason').textContent = reasons.length ? reasons.join('；') : '全部确认完成，可以生成行动清单。';
}

document.querySelectorAll('[name^="submission-"]').forEach((radio) => {
  radio.addEventListener('change', updateFinalizeState);
});

finalizeButton.addEventListener('click', async () => {
  if (finalizeButton.disabled) return;
  const { revision, signal } = beginOperation();
  const demoMode = state.demoMode;
  const submissionStates = Object.fromEntries(state.requiredSubmissions.map((kind) => [
    kind,
    $('[name="submission-' + kind + '"]:checked').value,
  ]));
  showMessage();
  setBusy(finalizeButton, true, '正在生成清单…');
  try {
    const result = await request('/api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysis: state.analysis,
        decisions: { change_decisions: state.decisions, submission_states: submissionStates },
      }),
      signal,
    });
    if (workflowCancelled(null, revision, signal)) return;
    if (demoMode) {
      state.currentRecordId = null;
      state.plan = upsertPlan([], result.plan)[0];
    } else {
      state.history = persistHistory(localStorage, upsertPlan(state.history, result.plan));
      state.currentRecordId = state.history[0].id;
      state.plan = state.history[0];
    }
    renderPlan(state.plan);
    renderDashboard();
    renderEvidenceCenter();
    updateNavAvailability();
    goToStep(3);
  } catch (error) {
    if (!workflowCancelled(error, revision, signal)) showMessage(error.message);
  } finally {
    if (revision === state.workflowRevision) {
      state.operationActive = false;
      setBusy(finalizeButton, false);
    }
  }
});

function todoTitle(todo) {
  return text(todo.title ?? todo.text ?? todo.name ?? todo.label ?? todo.action, todo.id);
}

function todoDetail(todo) {
  const due = todo.due_at ? '截止 ' + formatDateTime(todo.due_at) : todo.deadline;
  const items = Array.isArray(todo.items) ? todo.items.join('、') : '';
  return [due, todo.quantity, todo.condition, items, todo.description].filter(Boolean).join(' · ');
}

function formatDateTime(value) {
  const match = String(value).match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return match ? Number(match[1]) + '月' + Number(match[2]) + '日 ' + match[3] + ':' + match[4] : value;
}

function toggleTask(taskId, completed) {
  if (state.demoMode && state.plan) {
    state.plan = setTaskCompleted([state.plan], state.plan.id, taskId, completed)[0];
    renderPlan(state.plan);
    renderEvidenceCenter();
    return;
  }
  if (!state.currentRecordId) return;
  state.history = persistHistory(
    localStorage,
    setTaskCompleted(state.history, state.currentRecordId, taskId, completed),
  );
  state.plan = currentRecord();
  renderPlan(state.plan);
  renderDashboard();
  renderEvidenceCenter();
}

function planGroup(title, className, items, emptyText, toggleable = false) {
  const list = element('ul', { className: 'todo-list' }, items.map((item) => {
    const task = element('li', { className: 'todo' + (item.completed ? ' is-completed' : '') }, [
      element('b', { textContent: todoTitle(item) }),
      todoDetail(item) ? element('small', { textContent: todoDetail(item) }) : null,
      evidenceFor(item).length ? (() => {
        const button = element('button', {
          className: 'todo-evidence',
          type: 'button',
          textContent: '查看 ' + evidenceFor(item).length + ' 条依据',
        });
        button.addEventListener('click', () => showEvidence(item));
        return button;
      })() : null,
    ]);
    const canToggle = typeof toggleable === 'function' ? toggleable(item) : toggleable;
    if (canToggle) {
      const toggle = element('button', {
        className: 'task-toggle',
        type: 'button',
        'aria-label': (item.completed ? '标记为未完成：' : '标记为已完成：') + todoTitle(item),
        'aria-pressed': String(Boolean(item.completed)),
        textContent: '✓',
      });
      toggle.addEventListener('click', () => toggleTask(item.id, !item.completed));
      task.prepend(toggle);
    }
    return task;
  }));
  return element('section', { className: 'plan-group ' + className }, [
    element('h3', {}, [
      document.createTextNode(title),
      element('span', { className: 'count', textContent: String(items.length) }),
    ]),
    items.length ? list : element('p', { className: 'empty-state', textContent: emptyText }),
  ]);
}

function renderChangeTimeline(changes) {
  const items = changes || [];
  $('#timeline-count').textContent = items.length + ' 项变化';
  $('#change-timeline').replaceChildren(...(items.length ? items.map((change) => {
    const detail = describeChange(change);
    const adopted = change.decision !== 'deferred';
    const evidenceButton = element('button', {
      className: 'timeline-evidence',
      type: 'button',
      textContent: '查看依据',
    });
    evidenceButton.addEventListener('click', () => showEvidence(change));
    const value = element('p');
    if (detail.description) value.textContent = detail.description;
    else value.append(
      element('del', { textContent: detail.before }),
      document.createTextNode(' → '),
      element('ins', { textContent: detail.after }),
    );
    return element('article', { className: 'timeline-item' }, [
      element('span', { className: 'timeline-dot', 'aria-hidden': 'true' }),
      element('div', { className: 'timeline-copy' }, [
        element('div', { className: 'timeline-title' }, [
          element('strong', { textContent: text(change.title ?? change.label, '通知变化') }),
          element('span', { className: 'decision-badge ' + (adopted ? 'accepted' : 'deferred'), textContent: adopted ? '已采用' : '保留原值' }),
        ]),
        value,
      ]),
      evidenceFor(change).length ? evidenceButton : null,
    ]);
  }) : [element('p', { className: 'empty-state', textContent: '这份清单没有版本变化。' })]));
}

function renderPlan(plan) {
  if (!plan) return;
  renderEvent($('#final-event'), plan.event || {}, true, plan.student);
  const active = plan.active_todos || [];
  const conditional = plan.conditional_todos || [];
  const activeRemaining = active.filter((item) => !item.completed);
  const conditionalRemaining = conditional.filter((item) => !item.completed);
  const manuallyDone = [...active, ...conditional].filter((item) => item.completed);
  const done = [
    ...(plan.resolved_actions || []).filter((item) => item.status !== 'cancelled'),
    ...manuallyDone,
  ];
  const cancelled = plan.cancelled_actions?.length
    ? plan.cancelled_actions
    : (plan.resolved_actions || []).filter((item) => item.status === 'cancelled');
  $('#plan-groups').replaceChildren(
    planGroup('现在要做', 'active', activeRemaining, '没有待办，安心等待出发。', true),
    planGroup('符合条件才做', 'conditional', conditionalRemaining, '没有条件待办。', true),
    planGroup('已经完成', 'done', done, '暂无已完成事项。', (item) => item.completed === true),
    planGroup('已经取消', 'cancelled', cancelled, '没有取消事项。'),
  );

  $('#metric-active').textContent = String(activeRemaining.length);
  $('#metric-conditional').textContent = String(conditionalRemaining.length);
  $('#metric-done').textContent = String(done.length);
  $('#metric-cancelled').textContent = String(cancelled.length);
  renderChangeTimeline(plan.changes);
  updateFamily(plan.student);
}

function updateFamily(student = {}) {
  const family = [student.name, student.class_name].filter(Boolean).join(' · ');
  $('#current-family').textContent = family || '尚未选择家庭';
}

function compactDate(value) {
  const match = String(value || '').match(/\d{4}-(\d{2})-(\d{2})/);
  return match ? Number(match[1]) + '月\n' + Number(match[2]) + '日' : '日期\n待定';
}

function renderDashboard() {
  const activeCount = state.history.reduce((sum, record) =>
    sum + (record.active_todos || []).filter((todo) => !todo.completed).length, 0);
  const changeCount = state.history.reduce((sum, record) => sum + (record.changes || []).length, 0);
  const documentCount = state.history.reduce((sum, record) => sum + (record.documents || []).length, 0);
  $('#dashboard-active-count').textContent = String(activeCount);
  $('#dashboard-change-count').textContent = String(changeCount);
  $('#dashboard-document-count').textContent = String(documentCount);
  $('#dashboard-history-count').textContent = String(state.history.length);
  $('#history-summary').textContent = state.history.length
    ? '共 ' + state.history.length + ' 个活动，' + activeCount + ' 项待办未完成'
    : '还没有保存过行动清单';
  $('#dashboard-empty').hidden = state.history.length > 0;
  $('#dashboard-content').hidden = state.history.length === 0;
  $('#clear-history-button').hidden = state.history.length === 0;

  $('#history-list').replaceChildren(...state.history.map((record) => {
    const open = element('button', { className: 'text-button', type: 'button', textContent: '打开清单' });
    open.addEventListener('click', () => openRecord(record.id));
    const remove = element('button', {
      className: 'delete-button',
      type: 'button',
      'aria-label': '删除本地记录：' + text(record.event?.title, '活动'),
      textContent: '×',
    });
    remove.addEventListener('click', () => deleteHistoryRecord(record));
    const pending = (record.active_todos || []).filter((todo) => !todo.completed).length;
    return element('article', { className: 'history-card', 'data-history-id': record.id }, [
      element('span', { className: 'history-date', textContent: compactDate(record.event?.date) }),
      element('div', { className: 'history-copy' }, [
        element('strong', { textContent: text(record.event?.title, '未命名活动') }),
        element('small', {
          textContent: [
            [record.student?.name, record.student?.class_name].filter(Boolean).join(' · '),
            pending + ' 项待办',
            (record.documents || []).length + ' 份材料',
          ].filter(Boolean).join('　'),
        }),
      ]),
      element('div', { className: 'history-actions' }, [open, remove]),
    ]);
  }));
}

function openRecord(recordId) {
  const record = state.history.find((item) => item.id === recordId);
  if (!record) return;
  renewWorkflow();
  state.analysis = null;
  state.decisions = {};
  state.requiredSubmissions = [];
  uploadForm.reset();
  setFiles([]);
  state.demoMode = false;
  state.currentRecordId = record.id;
  state.plan = record;
  renderPlan(record);
  renderEvidenceCenter();
  updateNavAvailability();
  goToView('plan');
}

function deleteHistoryRecord(record) {
  if (!window.confirm('只删除当前浏览器里的“' + text(record.event?.title, '活动') + '”记录？')) return;
  state.history = persistHistory(localStorage, removeRecord(state.history, record.id));
  if (state.currentRecordId === record.id) {
    state.currentRecordId = null;
    state.plan = null;
  }
  updateFamily(state.history[0]?.student);
  renderDashboard();
  renderEvidenceCenter();
  updateNavAvailability();
  if (state.activeView === 'plan' && !state.plan) goToView('dashboard');
}

function clearHistory() {
  if (!state.history.length || !window.confirm('清空当前浏览器保存的全部通知历史？此操作不能撤销。')) return;
  renewWorkflow();
  state.history = persistHistory(localStorage, []);
  state.currentRecordId = null;
  state.plan = null;
  state.analysis = null;
  state.demoMode = false;
  updateFamily();
  renderDashboard();
  renderEvidenceCenter();
  updateNavAvailability();
  goToView('dashboard');
}

function collectEvidence(source) {
  if (!source) return [];
  const entries = [];
  const add = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item && (item.quote || item.document_id || item.document_name)) entries.push(item);
    }
  };
  for (const items of Object.values(source.event?.evidence || {})) add(items);
  for (const change of source.changes || []) add(change.evidence);
  for (const group of ['active_todos', 'conditional_todos', 'resolved_actions', 'cancelled_actions']) {
    for (const task of source[group] || []) add(task.evidence);
  }
  const seen = new Set();
  return entries.filter((item) => {
    const key = [item.document_id, item.document_name, item.page_number, item.element_id, item.quote].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderEvidenceCenter() {
  const source = currentSource();
  const evidence = collectEvidence(source);
  $('#evidence-empty').hidden = evidence.length > 0;
  if (!evidence.length) {
    $('#evidence-list').replaceChildren();
    return;
  }
  const groups = new Map();
  for (const item of evidence) {
    const id = item.document_id || item.document_name || 'unknown';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  $('#evidence-list').replaceChildren(...[...groups.entries()].map(([documentId, items]) =>
    element('article', { className: 'source-card' }, [
      element('header', { className: 'source-heading' }, [
        element('div', {}, [
          element('strong', { textContent: text(items[0].document_name || documentName(documentId, source), '通知材料') }),
          element('small', { textContent: 'xParse 结构化定位 · 原文可追溯' }),
        ]),
        element('span', { className: 'source-count', textContent: items.length + ' 条依据' }),
      ]),
      element('div', { className: 'source-quotes' }, items.map((item) =>
        element('div', { className: 'source-quote' }, [
          element('blockquote', { textContent: '“' + text(item.quote, '原文片段') + '”' }),
          element('p', { textContent: item.page_number ? '第 ' + item.page_number + ' 页' : '原文片段' }),
        ]),
      )),
    ]),
  ));
}

function escapeIcs(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function calendarStamp(date, time) {
  return String(date).replaceAll('-', '') + 'T' + String(time || '0900').replace(':', '').padEnd(6, '0');
}

$('#ics-button').addEventListener('click', () => {
  const source = state.plan || currentRecord();
  const event = source?.event;
  if (!event?.date) return showMessage('活动日期不完整，暂时无法加入日历。');
  const details = (source.active_todos || []).filter((todo) => !todo.completed).map(todoTitle).join('；');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Notice Action//CN', 'BEGIN:VEVENT',
    'UID:' + Date.now() + '@notice-action.local',
    'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'),
    'DTSTART:' + calendarStamp(event.date, event.meet_time),
    'DTEND:' + calendarStamp(event.date, event.return_time || event.meet_time),
    'SUMMARY:' + escapeIcs(event.title),
    'LOCATION:' + escapeIcs(event.meet_location),
    'DESCRIPTION:' + escapeIcs(details),
    'END:VEVENT', 'END:VCALENDAR', '',
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  const link = element('a', { href: url, download: '家校通知行动清单.ics' });
  link.click();
  URL.revokeObjectURL(url);
  showMessage('日历文件已下载，请打开文件完成导入。');
});

function newWorkflow() {
  renewWorkflow();
  state.analysis = null;
  state.plan = null;
  state.currentRecordId = null;
  state.decisions = {};
  state.requiredSubmissions = [];
  state.demoMode = false;
  uploadForm.reset();
  $('#child-name').value = '';
  $('#class-name').value = '';
  $('#participating').checked = true;
  updateFamily();
  setFiles([]);
  updateNavAvailability();
  goToStep(1);
}

for (const control of document.querySelectorAll('[data-view]')) {
  control.addEventListener('click', (event) => {
    event.preventDefault();
    if (state.operationActive) renewWorkflow();
    goToView(control.dataset.view);
  });
}
$('#dashboard-start-button').addEventListener('click', newWorkflow);
$('#new-notice-button').addEventListener('click', newWorkflow);
$('#clear-history-button').addEventListener('click', clearHistory);
$('#back-button').addEventListener('click', () => {
  renewWorkflow();
  updateFinalizeState();
  goToStep(1);
});
$('#restart-button').addEventListener('click', newWorkflow);
helpButton.addEventListener('click', () => {
  helpTrigger = helpButton;
  restoreHelpFocus = true;
  helpDialog.showModal();
});
$('#help-close').addEventListener('click', () => helpDialog.close());
$('#help-start-button').addEventListener('click', () => {
  restoreHelpFocus = false;
  helpAfterClose = () => {
    newWorkflow();
    requestAnimationFrame(() => $('#upload-title').focus({ preventScroll: true }));
  };
  helpDialog.close();
});
helpDialog.addEventListener('click', (event) => {
  const bounds = helpDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    helpDialog.close();
  }
});
helpDialog.addEventListener('close', () => {
  const shouldRestore = restoreHelpFocus;
  const afterClose = helpAfterClose;
  restoreHelpFocus = true;
  helpAfterClose = null;
  requestAnimationFrame(() => {
    if (afterClose) afterClose();
    else if (shouldRestore) helpTrigger?.focus();
  });
});

function closeEvidence() {
  dialog.close();
}

$('#dialog-close').addEventListener('click', closeEvidence);
$('#dialog-done').addEventListener('click', closeEvidence);
dialog.addEventListener('close', () => {
  if (state.evidenceTrigger?.isConnected) state.evidenceTrigger.focus();
  state.evidenceTrigger = null;
});
dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    closeEvidence();
  }
});

window.addEventListener('storage', (event) => {
  if (event.key !== HISTORY_KEY) return;
  state.history = loadHistory(localStorage);
  if (state.currentRecordId) {
    state.plan = currentRecord();
    if (!state.plan) state.currentRecordId = null;
  }
  updateFamily((state.plan || state.history[0])?.student);
  renderDashboard();
  if (state.plan) renderPlan(state.plan);
  renderEvidenceCenter();
  updateNavAvailability();
  if (!state.plan && state.activeView === 'plan') goToView('dashboard');
});

if (state.history[0]) updateFamily(state.history[0].student);
renderDashboard();
renderEvidenceCenter();
updateNavAvailability();
renderFiles();

request('/api/health').then(({ live_parse_configured: live }) => {
  state.liveParseConfigured = live;
  analyzeButton.disabled = !live;
  $('#live-mode-note').hidden = live;
  const status = $('#service-status');
  status.className = 'service-status ' + (live ? 'is-ready' : 'is-warning');
  status.replaceChildren(
    element('span', { 'aria-hidden': 'true', textContent: '●' }),
    document.createTextNode(live ? ' 在线解析已就绪' : ' 示例模式可用'),
  );
}).catch(() => {
  state.liveParseConfigured = false;
  analyzeButton.disabled = true;
  $('#live-mode-note').hidden = false;
  const status = $('#service-status');
  status.className = 'service-status is-warning';
  status.textContent = '服务暂不可用';
});
