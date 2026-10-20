import {
  HISTORY_KEY,
  loadHistory,
  persistHistory,
  removeRecord,
  setTaskCompleted,
  upsertPlan,
} from '/history.js';
import {
  baselineIsCurrent,
  mergeTransitionHistory,
  missingBaselineDocuments,
  restoreHistoricalDocumentMetadata,
  reviewIncrementalChanges,
  sameStudentIdentity,
  withExclusiveHistoryLock,
} from '/incremental.js';

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  analysis: null,
  plan: null,
  files: [],
  sourceDocuments: [],
  baselinePlan: null,
  baselinePersisted: false,
  appendMode: false,
  contextChanged: false,
  decisions: {},
  reviewChanges: [],
  requiredSubmissions: [],
  history: loadHistory(localStorage),
  currentRecordId: null,
  activeView: 'dashboard',
  evidenceTrigger: null,
  demoMode: false,
  liveParseConfigured: null,
  credentialsSaved: false,
  credentialServiceCompatible: false,
  credentialStorageAvailable: false,
  credentialStorageError: false,
  serviceReachable: false,
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
const appendMaterialButton = $('#append-material-button');
const message = $('#global-message');
const dialog = $('#evidence-dialog');
const helpDialog = $('#help-dialog');
const helpButton = $('#help-button');
const credentialsDialog = $('#credentials-dialog');
const credentialsButton = $('#credentials-button');
const credentialsForm = $('#credentials-form');
const credentialsAppId = $('#credentials-app-id');
const credentialsSecretCode = $('#credentials-secret-code');
const credentialsSave = $('#credentials-save');
const credentialsClear = $('#credentials-clear');
const credentialsClose = $('#credentials-close');
const quickDemoButton = $('#quick-demo-button');
const helpDemoButton = $('#help-demo-button');
const demoButtons = [demoButton, quickDemoButton, helpDemoButton];
const identityInputs = [$('#child-name'), $('#class-name'), $('#participating')];
const toast = $('#toast');
const toastText = $('#toast-text');
const discardDialog = $('#discard-dialog');
let helpTrigger = helpButton;
let restoreHelpFocus = true;
let helpAfterClose = null;
let credentialsTrigger = credentialsButton;
let credentialOperationActive = false;
let credentialDialogRevision = 0;
let pendingHistoryWrite = Promise.resolve();
let toastTimer = null;
let discardTrigger = null;
let discardAfterStart = null;

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

function showToast(value) {
  clearTimeout(toastTimer);
  toastText.textContent = value;
  toast.classList.remove('is-visible');
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3600);
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
  fileInput.disabled = false;
  for (const input of identityInputs) input.disabled = false;
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
  if (!response.ok || !body.ok) {
    const error = new Error(body.error?.message || body.error || '请求失败（' + response.status + '）');
    if (typeof body.error?.code === 'string') error.code = body.error.code;
    throw error;
  }
  return body;
}

function pendingFileLabel() {
  return state.liveParseConfigured === true ? '等待解析' : '先配置实时解析';
}

function setCredentialStatus(value, isError = false) {
  const status = $('#credentials-status');
  status.textContent = value;
  status.classList.toggle('is-error', isError);
}

function updateCredentialStatus() {
  let value = '尚未配置。填写一次后，即可在下次启动时继续使用。';
  if (!state.serviceReachable) value = '本地服务暂不可用，请确认程序已经启动。';
  else if (!state.credentialServiceCompatible) value = '后台服务版本过旧，请关闭旧服务后重新双击启动器。';
  else if (state.credentialStorageError) value = '读取加密凭据失败，请重新保存。';
  else if (!state.credentialStorageAvailable) value = '当前环境不支持本机加密保存。';
  else if (state.liveParseConfigured && state.credentialsSaved) value = '已启用，并由 Windows 为当前用户加密保存。';
  else if (state.liveParseConfigured) value = '当前服务已启用；此凭据尚未保存到本机。';
  setCredentialStatus(value);
  credentialsSave.disabled = credentialOperationActive || !state.serviceReachable || !state.credentialStorageAvailable;
  credentialsClear.disabled = credentialOperationActive || !state.serviceReachable || !state.credentialStorageAvailable || (!state.liveParseConfigured && !state.credentialsSaved);
}

function applyServiceStatus(health = null) {
  state.serviceReachable = Boolean(health);
  state.liveParseConfigured = Boolean(health?.live_parse_configured);
  state.credentialsSaved = Boolean(health?.credentials_saved);
  state.credentialServiceCompatible = health?.credential_management_version === 1;
  state.credentialStorageAvailable = state.credentialServiceCompatible && health?.credential_storage_available === true;
  state.credentialStorageError = Boolean(health?.credential_storage_error);
  analyzeButton.disabled = state.operationActive || !state.liveParseConfigured;
  $('#live-mode-note').hidden = state.liveParseConfigured;

  for (const entry of state.files) {
    if (entry.status === 'pending') entry.label = pendingFileLabel();
  }
  renderFiles();

  const status = $('#service-status');
  if (!health) {
    status.className = 'service-status is-warning';
    status.textContent = '服务暂不可用';
  } else {
    status.className = 'service-status ' + (state.liveParseConfigured ? 'is-ready' : 'is-warning');
    status.replaceChildren(
      element('span', { 'aria-hidden': 'true', textContent: '●' }),
      document.createTextNode(state.liveParseConfigured ? ' 在线解析已就绪' : ' 示例模式可用'),
    );
  }
  credentialsButton.classList.toggle('is-ready', state.liveParseConfigured);
  updateCredentialStatus();
}

async function refreshHealth() {
  try {
    const health = await request('/api/health');
    applyServiceStatus(health);
    return health;
  } catch {
    applyServiceStatus();
    return null;
  }
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
  const count = state.analysis ? state.reviewChanges.length : 0;
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

function fileKey(file) {
  return [file.name, file.size, file.lastModified, file.type].join('|');
}

function setFiles(files) {
  state.files = [...files].map((file) => ({
    key: fileKey(file),
    file,
    status: 'pending',
    label: pendingFileLabel(),
    document: null,
  }));
  renderFiles();
}

function addFiles(files) {
  const known = new Set(state.files.map(({ key }) => key));
  const added = [];
  for (const file of files) {
    const key = fileKey(file);
    if (known.has(key)) continue;
    known.add(key);
    added.push({
      key,
      file,
      status: 'pending',
      label: pendingFileLabel(),
      document: null,
    });
  }
  state.files = [...state.files, ...added];
  if (added.length) invalidateAnalysis();
  renderFiles();
}

function invalidateAnalysis() {
  if (!state.analysis) return;
  state.analysis = null;
  state.decisions = {};
  state.reviewChanges = [];
  state.requiredSubmissions = [];
  document.querySelectorAll('[name^="submission-"]').forEach((radio) => { radio.checked = false; });
  finalizeButton.disabled = true;
  updateNavAvailability();
}

function markContextChanged() {
  state.contextChanged = true;
  invalidateAnalysis();
}

function updateFileEntry(key, patch) {
  state.files = state.files.map((entry) => entry.key === key ? { ...entry, ...patch } : entry);
  renderFiles();
}

function removeFileEntry(key) {
  if (state.operationActive) return;
  state.files = state.files.filter((entry) => entry.key !== key);
  fileInput.value = '';
  invalidateAnalysis();
  renderFiles();
}

function renderUploadContext() {
  const included = state.sourceDocuments.length;
  const missing = state.appendMode ? missingBaselineDocuments(state.baselinePlan, state.sourceDocuments) : [];
  $('#upload-title').textContent = state.appendMode
    ? '追加同一活动的材料'
    : included ? '继续补充同一活动材料' : '整理一组新通知';
  const guide = $('#upload-step-goal');
  let title = '先上传一份基础通知也可以';
  let detail = '学校后来又发改期、换地点或补充说明时，可从行动清单继续追加，不用一次收齐。';
  if (missing.length) {
    title = '需重传 ' + missing.length + ' 份历史原材料';
    detail = '为保证变更比对完整，请把下方标为“必须重传”的文件与本次新通知一起选择。';
  } else if (included) {
    title = '已纳入 ' + included + ' 份材料';
    detail = '这次只选择新增或修改后的通知，系统会和已解析材料重新比对。';
  } else if (state.appendMode) {
    title = '原文件没有保存在本机';
    detail = '请重新选择全部历史原材料，再选择本次新增或修改后的通知；系统不会把历史文件名当作可解析正文。';
  }
  guide.replaceChildren(
    element('span', { className: 'step-guide-number', 'aria-hidden': 'true', textContent: '1' }),
    element('div', {}, [
      element('strong', { textContent: title }),
      element('p', { textContent: detail }),
    ]),
  );
  $('#materials-title').textContent = included ? '添加本次新增材料' : '放入相关通知';
  $('#identity-mode-note').hidden = !state.appendMode;
  if (!state.operationActive) {
    analyzeButton.textContent = state.appendMode
      ? '重新比对并找出新变化'
      : '下一步：解析并整理';
  }
}

function renderFiles() {
  const included = state.sourceDocuments.length;
  const missing = state.appendMode ? missingBaselineDocuments(state.baselinePlan, state.sourceDocuments) : [];
  $('#selected-file-count').textContent = missing.length
    ? missing.length + ' 份历史材料待重传 · ' + state.files.length + ' 份已选择'
    : included
    ? included + ' 份已纳入 · ' + state.files.length + ' 份待解析'
    : state.files.length + ' 份待解析';
  const includedItems = state.sourceDocuments.map((document) =>
    element('li', { className: 'is-included' }, [
      element('span', { className: 'file-name' }, [
        element('b', { textContent: text(document.name, '已解析通知') }),
        element('small', { textContent: document.issued_at ? '发布时间 ' + document.issued_at.slice(0, 16).replace('T', ' ') : '已解析材料' }),
      ]),
      element('span', { className: 'file-state done', textContent: '已纳入' }),
    ]));
  const requiredItems = missing.map((document) =>
    element('li', { className: 'is-required' }, [
      element('span', { className: 'file-name' }, [
        element('b', { textContent: text(document.name, '历史通知材料') }),
        element('small', { textContent: '需与原文件一致，解析后会按材料 ID 核验' }),
      ]),
      element('span', { className: 'file-state required', textContent: '必须重传' }),
    ]));
  const queuedItems = state.files.map(({ key, file, status, label }) => {
    const removeButton = element('button', {
      className: 'file-remove',
      type: 'button',
      'aria-label': '移除' + file.name,
      title: '从本次解析中移除',
      ...(state.operationActive ? { disabled: '' } : {}),
      textContent: '移除',
    });
    removeButton.addEventListener('click', () => removeFileEntry(key));
    return element('li', {}, [
      element('span', { className: 'file-name' }, [
        element('b', { textContent: file.name }),
        element('small', { textContent: formatSize(file.size) }),
      ]),
      element('span', { className: 'file-item-actions' }, [
        element('span', { className: 'file-state ' + status, textContent: label }),
        removeButton,
      ]),
    ]);
  });
  fileList.replaceChildren(...includedItems, ...requiredItems, ...queuedItems);
  renderUploadContext();
}

function validateFiles() {
  if (!state.files.length && !(state.contextChanged && state.sourceDocuments.length)) {
    throw new Error(state.sourceDocuments.length ? '请至少选择一份新增通知材料。' : '请至少选择一份通知材料。');
  }
  if (state.sourceDocuments.length + state.files.length > 20) throw new Error('同一活动最多纳入 20 份材料，避免超额解析。');
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
  state.demoMode = demoMode;
  state.contextChanged = false;
  renderEvent($('#event-preview'), analysis.event || {}, false, analysis.student);
  const changes = analysis.changes || [];
  const review = state.baselinePlan
    ? reviewIncrementalChanges(changes, state.baselinePlan.changes)
    : { visibleChanges: changes, inheritedDecisions: {} };
  state.decisions = review.inheritedDecisions;
  state.reviewChanges = review.visibleChanges;
  $('#change-summary-pill').textContent = state.reviewChanges.length + ' 项变化';
  $('#change-list').replaceChildren(...(state.reviewChanges.length ? state.reviewChanges.map(changeCard) : [
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

function combineSourceDocuments(current, additions) {
  const documents = new Map(current.map((document) => [document.document_id, document]));
  for (const document of additions) documents.set(document.document_id, document);
  return [...documents.values()];
}

function completedActionsFromPlan(plan) {
  const actions = new Map([
    ...(plan?.resolved_actions || []),
    ...(plan?.active_todos || []),
    ...(plan?.conditional_todos || []),
  ].map((action) => [action.id, action]));
  return [
    ['receipt', actions.get('submit_receipt')],
    ['payment', actions.get('pay_fee')],
  ].flatMap(([kind, action]) => action?.status === 'completed' || action?.completed === true
      ? [{
        kind,
        ...(action.completed_at ? { completed_at: action.completed_at } : {}),
        ...(kind === 'receipt' && action.due_at ? { due_at: action.due_at } : {}),
        ...(kind === 'payment' && Number.isFinite(Number(action.amount_cny ?? plan?.payment?.amount_cny))
          ? { amount_cny: Number(action.amount_cny ?? plan.payment.amount_cny) }
          : {}),
      }]
    : []);
}

async function parseSelectedFiles(revision, signal) {
  validateFiles();
  if (state.liveParseConfigured !== true) {
    throw new Error('请先打开“解析设置”，保存 TextIn AppID 和 Secret Code。');
  }
  const documents = [];
  const entries = [...state.files];
  for (const [index, entry] of entries.entries()) {
    if (workflowCancelled(null, revision, signal)) return null;
    if (entry.document) {
      documents.push(entry.document);
      continue;
    }
    updateFileEntry(entry.key, { status: 'working', label: 'xParse 解析中…' });
    analyzeButton.textContent = '正在解析 ' + (index + 1) + '/' + entries.length + '：' + entry.file.name;
    try {
      const result = await request('/api/parse?filename=' + encodeURIComponent(entry.file.name), {
        method: 'POST',
        headers: { 'Content-Type': entry.file.type || 'application/octet-stream' },
        body: entry.file,
        signal,
      });
      if (workflowCancelled(null, revision, signal)) return null;
      documents.push(result.document);
      updateFileEntry(entry.key, { status: 'done', label: '已提取', document: result.document });
    } catch (error) {
      if (workflowCancelled(error, revision, signal)) return null;
      updateFileEntry(entry.key, { status: 'error', label: '解析失败' });
      if (error.code === 'TEXTIN_CREDENTIALS_INVALID') openCredentials(analyzeButton, error.message);
      const failure = new Error(entry.file.name + '：' + error.message);
      failure.code = error.code;
      throw failure;
    }
  }
  return documents;
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!uploadForm.reportValidity()) return;
  if (state.appendMode && !sameStudentIdentity(state.baselinePlan?.student, {
    name: $('#child-name').value,
    class_name: $('#class-name').value,
  })) {
    showMessage('追加材料必须沿用原清单的孩子姓名和班级；如需整理另一位孩子，请点击“新建整理”。');
    return;
  }
  const { revision, signal } = beginOperation();
  showMessage();
  setBusy(analyzeButton, true, '正在读懂通知…');
  fileInput.disabled = true;
  for (const input of identityInputs) input.disabled = true;
  try {
    const additions = await parseSelectedFiles(revision, signal);
    if (!additions || workflowCancelled(null, revision, signal)) return;
    analyzeButton.textContent = '正在生成变更清单…';
    const restoredAdditions = state.appendMode
      ? restoreHistoricalDocumentMetadata(additions, state.baselinePlan?.documents)
      : additions;
    const documents = combineSourceDocuments(state.sourceDocuments, restoredAdditions);
    if (documents.length > 20) throw new Error('同一活动最多纳入 20 份材料，避免超额解析。');
    const missing = state.appendMode ? missingBaselineDocuments(state.baselinePlan, documents) : [];
    if (missing.length) {
      throw new Error('还缺少历史原材料：' + missing.map(({ name }) => text(name, '未命名材料')).join('、') + '。请重新选择原文件后再解析。');
    }
    const context = {
      student: {
        name: $('#child-name').value.trim(),
        class_name: $('#class-name').value.trim(),
        participating: $('#participating').checked,
      },
      completed_actions: completedActionsFromPlan(state.baselinePlan),
      ...(state.baselinePlan?.event ? {
        current_event: {
          date: state.baselinePlan.event.date,
          meet_time: state.baselinePlan.event.meet_time,
          meet_location: state.baselinePlan.event.meet_location,
        },
      } : {}),
    };
    const result = await request('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents, context }),
      signal,
    });
    if (workflowCancelled(null, revision, signal)) return;
    state.sourceDocuments = documents;
    setFiles([]);
    fileInput.value = '';
    renderAnalysis(result.analysis);
  } catch (error) {
    if (!workflowCancelled(error, revision, signal)) showMessage(error.message);
  } finally {
    if (revision === state.workflowRevision) {
      state.operationActive = false;
      fileInput.disabled = false;
      for (const input of identityInputs) input.disabled = false;
      setBusy(analyzeButton, false);
      renderFiles();
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
  newWorkflow();
  if (helpDialog.open) {
    restoreHelpFocus = false;
    await new Promise((resolve) => {
      helpAfterClose = resolve;
      helpDialog.close();
    });
  }
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

fileInput.addEventListener('change', () => {
  if (state.operationActive) return;
  addFiles(fileInput.files);
  fileInput.value = '';
});
for (const input of identityInputs.slice(0, 2)) input.addEventListener('input', markContextChanged);
$('#participating').addEventListener('change', markContextChanged);
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
dropZone.addEventListener('drop', (event) => {
  if (!state.operationActive) addFiles(event.dataTransfer.files);
});

function updateFinalizeState() {
  const changes = state.analysis ? state.reviewChanges : [];
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

function taskMeaning(task) {
  return JSON.stringify({
    id: task.id,
    title: task.title,
    label: task.label,
    action: task.action,
    due_at: task.due_at,
    deadline: task.deadline,
    condition: task.condition,
    quantity: task.quantity,
    description: task.description,
    items: task.items,
  });
}

function inheritCompletedTasks(plan, baseline) {
  if (!baseline) return plan;
  const completed = new Map(
    [...(baseline.active_todos || []), ...(baseline.conditional_todos || [])]
      .filter((task) => task.completed)
      .map((task) => [task.id, taskMeaning(task)]),
  );
  const inherit = (tasks = []) => tasks.map((task) => completed.get(task.id) === taskMeaning(task)
    ? { ...task, completed: true }
    : task);
  return {
    ...plan,
    active_todos: inherit(plan.active_todos),
    conditional_todos: inherit(plan.conditional_todos),
  };
}

function mergeChangeHistory(plan, baseline) {
  if (!baseline) return plan;
  const changes = mergeTransitionHistory(baseline.changes, plan.changes);
  return {
    ...plan,
    changes,
    summary: { ...plan.summary, change_count: changes.length },
  };
}

function loadLatestHistoryForFinalize(baselinePlan = state.baselinePlan, baselinePersisted = state.baselinePersisted) {
  const latest = loadHistory(localStorage);
  if (baselinePersisted && !baselineIsCurrent(latest, baselinePlan)) {
    state.history = latest;
    throw new Error('这份清单已在另一个窗口更新，请重新打开后再追加。');
  }
  state.history = latest;
  return latest;
}

finalizeButton.addEventListener('click', async () => {
  if (finalizeButton.disabled) return;
  const demoMode = state.demoMode;
  const baselinePlan = state.baselinePlan;
  const baselinePersisted = state.baselinePersisted;
  try {
    if (!demoMode) loadLatestHistoryForFinalize(baselinePlan, baselinePersisted);
  } catch (error) {
    showMessage(error.message);
    return;
  }
  const { revision, signal } = beginOperation();
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
    const plan = mergeChangeHistory(
      inheritCompletedTasks(result.plan, baselinePlan),
      baselinePlan,
    );
    if (demoMode) {
      state.currentRecordId = null;
      state.plan = upsertPlan([], plan)[0];
    } else {
      const saved = await withExclusiveHistoryLock(navigator.locks, () => {
        if (workflowCancelled(null, revision, signal)) return false;
        const latestHistory = loadLatestHistoryForFinalize(baselinePlan, baselinePersisted);
        const records = baselinePlan?.id
          ? latestHistory.filter((record) => record.id !== baselinePlan.id)
          : latestHistory;
        state.history = persistHistory(localStorage, upsertPlan(records, plan));
        state.currentRecordId = state.history[0].id;
        state.plan = state.history[0];
        return true;
      });
      if (!saved || workflowCancelled(null, revision, signal)) return;
    }
    state.baselinePlan = null;
    state.baselinePersisted = false;
    state.appendMode = false;
    state.contextChanged = false;
    renderPlan(state.plan);
    renderDashboard();
    renderEvidenceCenter();
    updateNavAvailability();
    goToStep(3);
    showToast(demoMode ? '示例清单已生成，不会写入历史。' : '行动清单已生成并保存。');
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

async function updateHistoryExclusively(update) {
  return withExclusiveHistoryLock(navigator.locks, () => {
    const latest = loadHistory(localStorage);
    state.history = persistHistory(localStorage, update(latest));
    return state.history;
  });
}

async function toggleTask(taskId, completed) {
  if (state.demoMode && state.plan) {
    state.plan = setTaskCompleted([state.plan], state.plan.id, taskId, completed)[0];
    renderPlan(state.plan);
    renderEvidenceCenter();
    return;
  }
  if (!state.currentRecordId) return;
  const recordId = state.currentRecordId;
  try {
    const write = updateHistoryExclusively((latest) =>
      setTaskCompleted(latest, recordId, taskId, completed));
    pendingHistoryWrite = write.catch(() => {});
    await write;
    state.plan = currentRecord();
    renderPlan(state.plan);
    renderDashboard();
    renderEvidenceCenter();
  } catch {
    showMessage('待办状态保存失败，请重试。');
  }
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
  const canReuseSources = state.currentRecordId === record.id && state.sourceDocuments.length > 0;
  renewWorkflow();
  state.analysis = null;
  state.decisions = {};
  state.reviewChanges = [];
  state.requiredSubmissions = [];
  state.baselinePlan = null;
  state.baselinePersisted = false;
  state.appendMode = false;
  state.contextChanged = false;
  if (!canReuseSources) state.sourceDocuments = [];
  uploadForm.reset();
  $('#child-name').readOnly = false;
  $('#class-name').readOnly = false;
  setFiles([]);
  state.demoMode = false;
  state.currentRecordId = record.id;
  state.plan = record;
  renderPlan(record);
  renderEvidenceCenter();
  updateNavAvailability();
  goToView('plan');
}

async function appendMaterials() {
  await pendingHistoryWrite;
  const plan = state.plan || currentRecord();
  if (!plan) return;
  renewWorkflow();
  state.baselinePlan = structuredClone(plan);
  state.baselinePersisted = state.history.some((record) => record.id === plan.id);
  state.appendMode = true;
  state.contextChanged = false;
  state.analysis = null;
  state.decisions = {};
  state.reviewChanges = [];
  state.requiredSubmissions = [];
  state.demoMode = false;
  uploadForm.reset();
  $('#child-name').value = text(plan.student?.name, '');
  $('#class-name').value = text(plan.student?.class_name, '');
  $('#child-name').readOnly = true;
  $('#class-name').readOnly = true;
  $('#participating').checked = plan.student?.participating !== false;
  setFiles([]);
  updateFamily(plan.student);
  updateNavAvailability();
  goToStep(1);
}

async function deleteHistoryRecord(record) {
  if (!window.confirm('只删除当前浏览器里的“' + text(record.event?.title, '活动') + '”记录？')) return;
  try {
    const write = updateHistoryExclusively((latest) => removeRecord(latest, record.id));
    pendingHistoryWrite = write.catch(() => {});
    await write;
  } catch {
    showMessage('历史记录删除失败，请重试。');
    return;
  }
  if (state.currentRecordId === record.id) {
    state.currentRecordId = null;
    state.plan = null;
    state.sourceDocuments = [];
    state.baselinePlan = null;
    state.baselinePersisted = false;
    state.appendMode = false;
    state.contextChanged = false;
  }
  updateFamily(state.history[0]?.student);
  renderDashboard();
  renderEvidenceCenter();
  updateNavAvailability();
  if (state.activeView === 'plan' && !state.plan) goToView('dashboard');
}

async function clearHistory() {
  if (!state.history.length || !window.confirm('清空当前浏览器保存的全部通知历史？此操作不能撤销。')) return;
  renewWorkflow();
  try {
    const write = updateHistoryExclusively(() => []);
    pendingHistoryWrite = write.catch(() => {});
    await write;
  } catch {
    showMessage('历史记录清空失败，请重试。');
    return;
  }
  state.currentRecordId = null;
  state.plan = null;
  state.analysis = null;
  state.reviewChanges = [];
  state.sourceDocuments = [];
  state.baselinePlan = null;
  state.baselinePersisted = false;
  state.appendMode = false;
  state.contextChanged = false;
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
  showToast('日历文件已下载，请打开文件完成导入。');
});

function hasUnsavedDraft() {
  const identityStarted = state.activeView === 'upload'
    && !state.plan
    && Boolean($('#child-name').value.trim() || $('#class-name').value.trim());
  return state.operationActive
    || state.files.length > 0
    || Boolean(state.analysis && !state.plan)
    || identityStarted;
}

function requestNewWorkflow(trigger, afterStart = null) {
  if (!hasUnsavedDraft()) {
    newWorkflow();
    afterStart?.();
    return;
  }
  discardTrigger = trigger;
  discardAfterStart = afterStart;
  discardDialog.returnValue = 'cancel';
  discardDialog.showModal();
  requestAnimationFrame(() => $('#discard-cancel').focus({ preventScroll: true }));
}

function newWorkflow() {
  renewWorkflow();
  state.analysis = null;
  state.plan = null;
  state.sourceDocuments = [];
  state.baselinePlan = null;
  state.baselinePersisted = false;
  state.appendMode = false;
  state.contextChanged = false;
  state.currentRecordId = null;
  state.decisions = {};
  state.reviewChanges = [];
  state.requiredSubmissions = [];
  state.demoMode = false;
  uploadForm.reset();
  $('#child-name').readOnly = false;
  $('#class-name').readOnly = false;
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
    if (state.operationActive) {
      renewWorkflow();
      if (state.analysis) updateFinalizeState();
    }
    goToView(control.dataset.view);
  });
}
$('#dashboard-start-button').addEventListener('click', (event) => requestNewWorkflow(event.currentTarget));
$('#new-notice-button').addEventListener('click', (event) => requestNewWorkflow(event.currentTarget));
$('#clear-history-button').addEventListener('click', clearHistory);
$('#back-button').addEventListener('click', () => {
  renewWorkflow();
  updateFinalizeState();
  renderFiles();
  goToStep(1);
});
appendMaterialButton.addEventListener('click', appendMaterials);
$('#restart-button').addEventListener('click', (event) => requestNewWorkflow(event.currentTarget));

discardDialog.addEventListener('click', (event) => {
  if (event.target !== discardDialog) return;
  const bounds = discardDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    discardDialog.close('cancel');
  }
});
discardDialog.addEventListener('close', () => {
  const confirmed = discardDialog.returnValue === 'confirm';
  const trigger = discardTrigger;
  const afterStart = discardAfterStart;
  discardTrigger = null;
  discardAfterStart = null;
  if (confirmed) {
    newWorkflow();
    showToast('已开始新的整理。');
    afterStart?.();
  } else {
    requestAnimationFrame(() => trigger?.focus());
  }
});

function openCredentials(trigger, errorMessage = '') {
  credentialsTrigger = trigger;
  credentialDialogRevision += 1;
  credentialsForm.reset();
  updateCredentialStatus();
  if (errorMessage) setCredentialStatus(errorMessage, true);
  credentialsDialog.showModal();
  requestAnimationFrame(() => credentialsAppId.focus({ preventScroll: true }));
}

function setCredentialBusy(busy, actionButton = credentialsSave, label = '正在保存…') {
  credentialOperationActive = busy;
  credentialsAppId.disabled = busy;
  credentialsSecretCode.disabled = busy;
  credentialsSave.disabled = busy || !state.serviceReachable || !state.credentialStorageAvailable;
  credentialsClear.disabled = busy || !state.serviceReachable || !state.credentialStorageAvailable || (!state.liveParseConfigured && !state.credentialsSaved);
  if (busy) {
    actionButton.dataset.label = actionButton.textContent;
    actionButton.textContent = label;
  } else {
    for (const button of [credentialsSave, credentialsClear]) {
      if (!button.dataset.label) continue;
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }
}

credentialsButton.addEventListener('click', () => openCredentials(credentialsButton));
$('#configure-live-button').addEventListener('click', () => openCredentials($('#configure-live-button')));
credentialsClose.addEventListener('click', () => credentialsDialog.close());
credentialsDialog.addEventListener('click', (event) => {
  const bounds = credentialsDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    credentialsDialog.close();
  }
});
credentialsDialog.addEventListener('close', () => {
  if (credentialsDialog.open) return;
  credentialDialogRevision += 1;
  credentialsForm.reset();
  requestAnimationFrame(() => credentialsTrigger?.focus());
});

credentialsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!credentialsForm.reportValidity()) return;
  setCredentialBusy(true, credentialsSave, '正在保存…');
  const revision = credentialDialogRevision;
  try {
    const status = await request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: credentialsAppId.value.trim(),
        secret_code: credentialsSecretCode.value,
      }),
    });
    applyServiceStatus(status);
    if (revision === credentialDialogRevision && credentialsDialog.open) {
      credentialsForm.reset();
      credentialsTrigger = credentialsButton;
      credentialsDialog.close();
    }
    showToast('解析凭据已安全保存，可以上传真实材料了。');
  } catch (error) {
    if (revision === credentialDialogRevision && credentialsDialog.open) setCredentialStatus(error.message, true);
    else showMessage(error.message);
  } finally {
    setCredentialBusy(false);
  }
});

credentialsClear.addEventListener('click', async () => {
  if (!window.confirm('清除当前 Windows 用户保存的 TextIn 凭据？清除后真实解析将停用。')) return;
  setCredentialBusy(true, credentialsClear, '正在清除…');
  const revision = credentialDialogRevision;
  try {
    const status = await request('/api/credentials/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    credentialsForm.reset();
    applyServiceStatus(status);
    showToast('已清除保存的解析凭据。');
  } catch (error) {
    if (revision === credentialDialogRevision && credentialsDialog.open) setCredentialStatus(error.message, true);
    else showMessage(error.message);
  } finally {
    setCredentialBusy(false);
  }
});

helpButton.addEventListener('click', () => {
  helpTrigger = helpButton;
  restoreHelpFocus = true;
  helpDialog.showModal();
});
$('#help-close').addEventListener('click', () => helpDialog.close());
$('#help-start-button').addEventListener('click', () => {
  restoreHelpFocus = false;
  helpAfterClose = () => requestNewWorkflow(helpButton, () => requestAnimationFrame(() => $('#upload-title').focus({ preventScroll: true })));
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
refreshHealth();
