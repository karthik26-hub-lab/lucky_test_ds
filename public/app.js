'use strict';

const $ = (id) => document.getElementById(id);

const SETTING_FIELDS = [
  'ocrModel',
  'gradingModel',
  'organizeModel',
  'fallbackModels',
  'temperature',
  'requestsPerMinute',
  'maxRetries',
  'maxWaitSeconds',
  'imageMaxSide',
  'reuseTranscripts',
  'combineOcrAndMarking',
  'lowConfidence',
  'ocrPrompt',
  'markingInstructions',
  'organizePrompt'
];

const state = {
  apiKey: '',
  settings: null,
  defaults: null,
  steps: [],
  questions: [],
  currentQuestionId: null,
  run: null,
  busy: false,
  stopRequested: false,
  scriptFiles: [],
  queue: []
};

// ---------- helpers ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmt(n) {
  if (n === null || n === undefined || n === '') return '–';
  return String(Math.round(Number(n) * 100) / 100);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function storageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage blocked; the key just won't be remembered
  }
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3000);
}

function setStatus(message, isError = false) {
  const el = $('status');
  el.hidden = !message;
  el.textContent = message || '';
  el.className = isError ? 'status error' : 'status';
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.apiKey) headers['x-api-key'] = state.apiKey;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function diffClass(diff) {
  if (diff === null) return '';
  if (Math.abs(diff) < 0.001) return 'diff-zero';
  return diff > 0 ? 'diff-pos' : 'diff-neg';
}

function signed(diff) {
  if (diff === null) return '–';
  return (diff > 0 ? '+' : '') + fmt(diff);
}

function setupDrop(dropId, onFiles) {
  const drop = $(dropId);
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    onFiles(Array.from(e.dataTransfer.files || []));
  });
}

// Re-encodes large photos so they cost fewer tokens. PDFs and formats the browser
// cannot decode (e.g. HEIC) are sent unchanged.
async function shrinkImage(file, maxSide) {
  if (!maxSide || !/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = maxSide / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

// ---------- tabs ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === 'history') loadHistory();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------- settings ----------

function refreshKeyStatus() {
  const pill = $('key-status');
  pill.textContent = state.apiKey ? 'API key set' : 'No API key';
  pill.classList.toggle('ok', Boolean(state.apiKey));
}

function fillSettings(settings) {
  SETTING_FIELDS.forEach((field) => {
    const input = $(`s-${field}`);
    if (input.type === 'checkbox') input.checked = Boolean(settings[field]);
    else input.value = settings[field] ?? '';
  });
}

function readSettings() {
  const out = {};
  SETTING_FIELDS.forEach((field) => {
    const input = $(`s-${field}`);
    out[field] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  });
  return out;
}

async function loadSettings() {
  const { settings, defaults } = await api('/api/settings');
  state.settings = settings;
  state.defaults = defaults;
  fillSettings(settings);
  updatePaceNote();
}

async function loadModels() {
  if (!state.apiKey) return;
  $('key-message').textContent = 'Checking key…';
  try {
    const { models } = await api('/api/models');
    $('model-list').innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    $('key-message').textContent = `Key works. ${models.length} models available.`;
  } catch (err) {
    $('key-message').textContent = err.message;
  }
}

$('btn-save-key').addEventListener('click', () => {
  state.apiKey = $('api-key').value.trim();
  storageSet('apiKey', $('remember-key').checked ? state.apiKey : '');
  refreshKeyStatus();
  if (!state.apiKey) {
    $('key-message').textContent = 'Enter a key first.';
    return;
  }
  loadModels();
});

$('btn-save-settings').addEventListener('click', async () => {
  try {
    const { settings } = await api('/api/settings', { method: 'PUT', json: readSettings() });
    state.settings = settings;
    fillSettings(settings);
    updatePaceNote();
    $('settings-message').textContent = 'Saved.';
    toast('Settings saved.');
  } catch (err) {
    toast(err.message, true);
  }
});

$('btn-reset-settings').addEventListener('click', () => {
  if (!confirm('Reset every setting and prompt to the default? (Click Save settings to keep it.)')) return;
  fillSettings(state.defaults);
  $('settings-message').textContent = 'Defaults loaded. Click Save settings to keep them.';
});

document.querySelectorAll('[data-reset]').forEach((btn) =>
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const field = btn.dataset.reset;
    $(`s-${field}`).value = state.defaults[field];
    $('settings-message').textContent = 'Default prompt loaded. Click Save settings to keep it.';
  })
);

// ---------- step navigation ----------

function goStep(n) {
  $('step-1').hidden = n !== 1;
  $('step-2').hidden = n !== 2;
  document.querySelectorAll('.stepper li').forEach((li) => {
    const step = Number(li.dataset.step);
    li.classList.toggle('current', step === n);
    li.classList.toggle('done', step < n);
  });
  window.scrollTo({ top: 0 });
}

function setupIsUsable(setup) {
  return Boolean(setup.questionText.trim() || setup.scheme.trim() || setup.steps.some((s) => String(s.title).trim()));
}

function toStep2() {
  const setup = readSetup();
  if (!setupIsUsable(setup)) return toast('Add the question, a marking scheme or at least one step first.', true);
  renderSetupSummary(setup);
  goStep(2);
}

document.querySelectorAll('.stepper li').forEach((li) => li.addEventListener('click', () => (li.dataset.step === '2' ? toStep2() : goStep(1))));
$('btn-next').addEventListener('click', toStep2);
$('btn-back').addEventListener('click', () => goStep(1));

function renderSetupSummary(setup) {
  const stepTotal = setup.steps.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);
  const keywordCount = setup.keywords.split('\n').filter((k) => k.trim()).length;
  $('setup-summary').innerHTML = `
    <div class="summary-grid">
      <div><span class="muted small">Question</span><b>${esc(setup.code || '–')}</b></div>
      <div><span class="muted small">Max marks</span><b>${fmt(setup.maxMarks)}</b></div>
      <div><span class="muted small">Steps</span><b>${setup.steps.length || 'from scheme'}</b></div>
      <div><span class="muted small">Keywords</span><b>${keywordCount}</b></div>
    </div>
    <div class="muted small">${esc(setup.questionText.slice(0, 220))}${setup.questionText.length > 220 ? '…' : ''}</div>
    ${setup.steps.length && Math.abs(stepTotal - setup.maxMarks) > 0.001 ? `<div class="warnings" style="margin-top:8px">Steps add up to ${fmt(stepTotal)}, not ${fmt(setup.maxMarks)}.</div>` : ''}`;
}

// ---------- step 1: materials ----------

function renderSteps() {
  $('steps-body').innerHTML = state.steps
    .map(
      (s, i) => `<tr>
        <td>${i + 1}</td>
        <td><input data-i="${i}" data-f="title" value="${esc(s.title)}" placeholder="e.g. Relevant provision"></td>
        <td><input data-i="${i}" data-f="marks" type="number" min="0" step="0.25" value="${esc(s.marks)}"></td>
        <td><textarea data-i="${i}" data-f="expected" rows="2" placeholder="What the student must write">${esc(s.expected)}</textarea></td>
        <td><input data-i="${i}" data-f="keywords" value="${esc(s.keywords)}" placeholder="optional"></td>
        <td><button class="icon-btn" data-remove="${i}" title="Remove step" type="button">×</button></td>
      </tr>`
    )
    .join('');
  updateStepTotal();
}

function updateStepTotal() {
  const total = state.steps.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);
  const max = Number($('q-max').value) || 0;
  const el = $('step-total');
  if (!state.steps.length) {
    el.textContent = 'Optional. Without steps, the model derives them from the marking scheme.';
    el.style.color = '';
    return;
  }
  el.textContent = `Steps add up to ${fmt(total)} of ${fmt(max)} marks`;
  el.style.color = Math.abs(total - max) > 0.001 ? 'var(--bad)' : 'var(--good)';
}

$('steps-body').addEventListener('input', (e) => {
  const { i, f } = e.target.dataset;
  if (i === undefined) return;
  state.steps[Number(i)][f] = e.target.value;
  if (f === 'marks') updateStepTotal();
});

$('steps-body').addEventListener('click', (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  state.steps.splice(Number(i), 1);
  renderSteps();
});

$('btn-add-step').addEventListener('click', () => {
  state.steps.push({ title: '', marks: 1, expected: '', keywords: '' });
  renderSteps();
});

$('q-max').addEventListener('input', updateStepTotal);

function readSetup() {
  return {
    id: state.currentQuestionId,
    code: $('q-code').value,
    questionText: $('q-text').value,
    maxMarks: Number($('q-max').value),
    granularity: Number($('q-granularity').value),
    steps: state.steps.map((s) => ({ ...s, marks: Number(s.marks) || 0 })),
    keywords: $('q-keywords').value,
    layout: $('q-layout').value,
    scheme: $('q-scheme').value,
    instructions: $('q-instructions').value
  };
}

function fillSetup(s = {}) {
  state.currentQuestionId = s.id || null;
  $('q-code').value = s.code || '';
  $('q-text').value = s.questionText || '';
  $('q-max').value = s.maxMarks || '';
  $('q-granularity').value = String(s.granularity || 0.5);
  state.steps = (s.steps || []).map((st) => ({ ...st }));
  $('q-keywords').value = s.keywords || '';
  $('q-layout').value = s.layout || '';
  $('q-scheme').value = s.scheme || '';
  $('q-instructions').value = s.instructions || '';
  $('btn-delete-question').hidden = !state.currentQuestionId;
  $('saved-questions').value = state.currentQuestionId || '';
  renderSteps();
}

async function loadQuestions() {
  try {
    state.questions = await api('/api/questions');
  } catch {
    state.questions = [];
  }
  $('saved-questions').innerHTML =
    '<option value="">Or use a saved question…</option>' +
    state.questions.map((q) => `<option value="${esc(q.id)}">${esc(q.code || q.questionText.slice(0, 50))}</option>`).join('');
  $('saved-questions').value = state.currentQuestionId || '';
}

$('saved-questions').addEventListener('change', (e) => {
  const q = state.questions.find((item) => item.id === e.target.value);
  if (q) {
    fillSetup(q);
    $('import-notes').hidden = true;
  }
});

$('btn-new-question').addEventListener('click', () => {
  fillSetup({});
  $('import-notes').hidden = true;
  $('materials-text').textContent = 'Drop the materials here, or click to choose';
});

$('btn-save-question').addEventListener('click', async () => {
  try {
    const saved = await api('/api/questions', { method: 'POST', json: readSetup() });
    state.currentQuestionId = saved.id;
    await loadQuestions();
    $('btn-delete-question').hidden = false;
    toast('Question saved.');
  } catch (err) {
    toast(err.message, true);
  }
});

$('btn-delete-question').addEventListener('click', async () => {
  if (!state.currentQuestionId || !confirm('Delete this saved question? Past evaluations are kept.')) return;
  await api(`/api/questions/${encodeURIComponent(state.currentQuestionId)}`, { method: 'DELETE' });
  fillSetup({});
  await loadQuestions();
  toast('Saved question deleted.');
});

async function importMaterials(files) {
  if (!files.length) return;
  const useAi = $('use-ai-import').checked;
  const needsAi = files.some((f) => !/\.(xlsx|csv|txt|md)$/i.test(f.name));
  if (useAi && needsAi && !state.apiKey) {
    toast('Some files need AI to read them. Add your API key in Settings first, or turn off the AI option.', true);
    return;
  }
  $('materials-text').innerHTML = `<b>Reading ${files.length} file(s)…</b>`;
  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  form.append('useAi', String(useAi));
  try {
    const { setup, notes } = await api('/api/import', { method: 'POST', body: form });
    fillSetup({ ...setup, id: null });
    $('import-notes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    $('import-notes').hidden = false;
    $('materials-text').innerHTML = `<b>${files.length} file(s) imported</b><br><span class="muted">${files.map((f) => esc(f.name)).join(', ')}. Drop more to add.</span>`;
    toast('Materials imported. Check the fields below.');
  } catch (err) {
    $('materials-text').textContent = 'Drop the materials here, or click to choose';
    toast(err.message, true);
  }
}

$('materials-files').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  importMaterials(files);
});
setupDrop('materials-drop', importMaterials);

// ---------- step 2: scripts ----------

const scriptMode = () => document.querySelector('input[name="script-mode"]:checked').value;

function updatePaceNote() {
  const s = state.settings;
  if (!s) return;
  const calls = s.combineOcrAndMarking ? 1 : 2;
  const perScript = s.requestsPerMinute ? Math.ceil((calls * 60) / s.requestsPerMinute) : null;
  $('pace-note').textContent = perScript
    ? `${calls} request(s) per script. At ${s.requestsPerMinute} requests/minute, each script takes at least ~${perScript}s, plus model time. Change this in Settings.`
    : `${calls} request(s) per script, no rate limit set.`;
}

function renderQueue() {
  $('queue-body').innerHTML = state.queue
    .map(
      (item, i) => `<tr class="${state.run && item.runId === state.run.id ? 'active' : ''}">
        <td class="small">${esc(item.file.name)}</td>
        <td><input data-q="${i}" data-f="name" value="${esc(item.name)}"></td>
        <td class="num"><input data-q="${i}" data-f="faculty" type="number" step="0.25" min="0" value="${esc(item.faculty)}"></td>
        <td>${
          item.run
            ? `<button class="secondary small-btn" data-view="${i}" type="button">${fmt(item.run.totalAwarded)}/${fmt(item.run.maxMarks)} · View</button>`
            : `<span class="tag ${item.error ? 'bad' : item.status === 'Working…' ? 'warn' : ''}" title="${esc(item.error || '')}">${esc(item.error ? 'Failed' : item.status)}</span>`
        }</td>
      </tr>`
    )
    .join('');
}

$('queue-body').addEventListener('input', (e) => {
  const { q, f } = e.target.dataset;
  if (q !== undefined) state.queue[Number(q)][f] = e.target.value;
});

$('queue-body').addEventListener('click', (e) => {
  const i = e.target.dataset.view;
  if (i === undefined) return;
  renderRun(state.queue[Number(i)].run);
  renderQueue();
});

function setScriptFiles(files) {
  const mode = scriptMode();
  if (mode === 'single') {
    state.scriptFiles = files;
    $('script-text').innerHTML = files.length
      ? `<b>${files.length} file(s) selected</b><br><span class="muted">${files.map((f) => esc(f.name)).join(', ')}</span>`
      : 'Drop the answer script here, or click to choose<br><span class="muted">PDF or photos</span>';
    if (files.length && !$('script-name').value) $('script-name').value = files[0].name.replace(/\.[^.]+$/, '');
  } else {
    state.queue.push(...files.map((file) => ({ file, name: file.name.replace(/\.[^.]+$/, ''), faculty: '', status: 'Waiting' })));
    $('script-text').innerHTML = `<b>${state.queue.length} script(s) in the list</b><br><span class="muted">Drop more files to add them</span>`;
    renderQueue();
  }
}

document.querySelectorAll('input[name="script-mode"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    const batch = scriptMode() === 'batch';
    $('single-fields').hidden = batch;
    $('queue-wrap').hidden = !batch;
    state.scriptFiles = [];
    state.queue = [];
    renderQueue();
    $('script-text').innerHTML = batch
      ? 'Drop one file per student here, or click to choose<br><span class="muted">Each PDF is one student’s script</span>'
      : 'Drop the answer script here, or click to choose<br><span class="muted">PDF or photos</span>';
  })
);

$('script-files').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  setScriptFiles(files);
});
setupDrop('script-drop', setScriptFiles);

function setBusy(busy) {
  state.busy = busy;
  $('btn-evaluate').disabled = busy;
  $('btn-stop').hidden = !busy || scriptMode() !== 'batch';
  const regrade = $('btn-regrade');
  if (regrade) regrade.disabled = busy;
}

async function evaluateScript(files, scriptName, facultyTotal) {
  const maxSide = state.settings?.imageMaxSide || 0;
  const form = new FormData();
  for (const f of files) form.append('files', await shrinkImage(f, maxSide));
  form.append('setup', JSON.stringify(readSetup()));
  form.append('scriptName', scriptName);
  form.append('facultyTotal', facultyTotal);
  return api('/api/evaluate', { method: 'POST', body: form });
}

$('btn-evaluate').addEventListener('click', async () => {
  if (state.busy) return;
  if (!state.apiKey) {
    toast('Add your Gemini API key in Settings first.', true);
    return showTab('settings');
  }

  if (scriptMode() === 'single') {
    if (!state.scriptFiles.length) return toast('Choose the answer script file(s) first.', true);
    setBusy(true);
    setStatus('Reading and marking the script… on the free tier this can take a minute or more.');
    try {
      const run = await evaluateScript(state.scriptFiles, $('script-name').value, $('faculty-total').value);
      setStatus('');
      renderRun(run);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      setBusy(false);
    }
    return;
  }

  const pending = state.queue.filter((item) => !item.run);
  if (!pending.length) return toast(state.queue.length ? 'All scripts in the list are done.' : 'Add the script files first.', true);
  state.stopRequested = false;
  setBusy(true);
  let done = 0;
  for (const item of pending) {
    if (state.stopRequested) break;
    item.status = 'Working…';
    item.error = '';
    renderQueue();
    setStatus(`Script ${done + 1} of ${pending.length}: ${item.name}…`);
    try {
      item.run = await evaluateScript([item.file], item.name, item.faculty);
      item.runId = item.run.id;
      renderRun(item.run);
    } catch (err) {
      item.error = err.message;
    }
    done += 1;
    renderQueue();
  }
  const failed = pending.filter((item) => item.error).length;
  setStatus(
    state.stopRequested
      ? `Stopped after ${done} script(s).`
      : `Finished ${done} script(s)${failed ? `, ${failed} failed (hover “Failed” to see why). Click Evaluate to retry them.` : '.'}`,
    failed > 0
  );
  setBusy(false);
});

$('btn-stop').addEventListener('click', () => {
  state.stopRequested = true;
  toast('Will stop after the current script.');
});

// ---------- result ----------

function stepFacultyValue(run, i) {
  const v = run.facultySteps?.[i];
  return v === null || v === undefined ? '' : v;
}

function renderRun(run) {
  state.run = run;
  $('result-empty').hidden = true;
  const el = $('result');
  el.hidden = false;

  const diff = run.facultyTotal === null || run.facultyTotal === undefined ? null : run.totalAwarded - run.facultyTotal;
  const usage = run.usage || {};
  const usageLine = ['ocr', 'grading']
    .filter((k) => usage[k])
    .map(
      (k) =>
        `${k === 'ocr' ? 'OCR' : run.mode === 'combined' ? 'OCR + marking' : 'Marking'}: ${esc(usage[k].model)} · ${usage[k].inputTokens.toLocaleString()} in / ${usage[k].outputTokens.toLocaleString()} out` +
        (usage[k].thinkingTokens ? ` / ${usage[k].thinkingTokens.toLocaleString()} thinking` : '') +
        ' tokens'
    )
    .join('<br>');

  el.innerHTML = `
    <div class="card-head">
      <h2>${esc(run.scriptName)} <span class="muted">· ${esc(run.setup.code || 'Question')}</span></h2>
      <span class="muted small">${new Date(run.createdAt).toLocaleString()}</span>
    </div>

    <div class="score-row">
      <div class="score"><div class="label">AI marks</div><div class="value">${fmt(run.totalAwarded)} <small>/ ${fmt(run.maxMarks)}</small></div></div>
      <div class="score"><div class="label">Faculty marks</div><input id="r-faculty-total" type="number" step="0.25" min="0" value="${run.facultyTotal ?? ''}" placeholder="enter"></div>
      <div class="score"><div class="label">Difference (AI − faculty)</div><div class="value ${diffClass(diff)}" id="r-diff">${signed(diff)}</div></div>
    </div>

    ${run.warnings.length ? `<div class="warnings">${run.warnings.map(esc).join('<br>')}</div>` : ''}
    ${
      run.flags.length
        ? `<div class="flags"><b>Would go to faculty review</b><ul>${run.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`
        : '<div class="flags clear"><b>No review triggers.</b> This script would be auto-marked.</div>'
    }

    <div class="section">
      <h3>Stepwise marks</h3>
      <div class="table-wrap">
        <table class="result-steps">
          <thead><tr><th>Step</th><th class="num">AI</th><th class="num">Faculty</th><th class="num">Conf.</th></tr></thead>
          <tbody>
            ${run.steps
              .map(
                (s, i) => `<tr>
                  <td><b>${s.stepNo}. ${esc(s.title)}</b>
                    <div>${esc(s.reasoning)}</div>
                    ${
                      s.evidenceQuote
                        ? `<div class="evidence ${s.evidenceFound ? '' : 'missing'}">${s.evidenceFound ? '' : '⚠ not found in transcript: '}“${esc(s.evidenceQuote)}”</div>`
                        : '<div class="evidence">No supporting text found.</div>'
                    }
                  </td>
                  <td class="num"><b>${fmt(s.awardedMarks)}</b>/${fmt(s.maxMarks)}</td>
                  <td class="num"><input class="faculty-step" data-step="${i}" type="number" step="0.25" min="0" max="${s.maxMarks}" value="${stepFacultyValue(run, i)}"></td>
                  <td class="num"><span class="tag ${s.confidence >= 0.8 ? 'good' : s.confidence >= 0.6 ? 'warn' : 'bad'}">${Math.round(s.confidence * 100)}%</span></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    ${
      run.keywords.length
        ? `<div class="section">
            <h3>ICAI keywords</h3>
            <div class="table-wrap"><table>
              <thead><tr><th>Keyword</th><th>Exact text match</th><th>AI says present</th></tr></thead>
              <tbody>${run.keywords
                .map(
                  (k) => `<tr>
                    <td>${esc(k.keyword)}</td>
                    <td><span class="tag ${k.exactMatch ? 'good' : 'bad'}">${k.exactMatch ? 'Found' : 'Not found'}</span></td>
                    <td><span class="tag ${k.aiPresent ? 'good' : 'bad'}">${k.aiPresent ? 'Yes' : 'No'}</span>
                      ${k.aiMatchedText ? `<div class="evidence">“${esc(k.aiMatchedText)}”</div>` : ''}</td>
                  </tr>`
                )
                .join('')}</tbody>
            </table></div>
          </div>`
        : ''
    }

    <div class="section">
      <h3>Presentation <span class="tag ${run.presentation.followsLayout ? 'good' : 'warn'}">${run.presentation.followsLayout ? 'Follows layout' : 'Layout issues'}</span></h3>
      <div>${esc(run.presentation.comments) || '<span class="muted">No comments.</span>'}</div>
    </div>

    <div class="section">
      <h3>Feedback for the student</h3>
      <div>${esc(run.overallFeedback)}</div>
      ${run.strengths.length ? `<div class="section"><b>Strengths</b><ul class="plain">${run.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${run.improvements.length ? `<div class="section"><b>To improve</b><ul class="plain">${run.improvements.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    </div>

    <div class="section">
      <label>Your notes on this result <span class="muted">(saved with the run)</span>
        <textarea id="r-notes" rows="2" placeholder="e.g. OCR misread 185 as 186">${esc(run.notes || '')}</textarea>
      </label>
    </div>

    <div class="section">
      <h3>Transcript <span class="muted small">(${esc(run.transcriptSource || 'OCR')})</span></h3>
      <p class="muted small">Correct any reading mistakes, then mark again. This separates OCR errors from marking errors. Each re-mark is saved as a new run.</p>
      <textarea id="r-transcript" class="transcript" rows="14">${esc(run.transcript)}</textarea>
      <div class="row gap" style="margin-top:8px">
        <button id="btn-regrade" class="secondary" type="button">Mark again with this transcript</button>
      </div>
    </div>

    <div class="section usage">${usageLine}</div>
    ${run.callNotes?.length ? `<div class="section call-notes">Rate limits during this run: ${run.callNotes.map(esc).join('; ')}</div>` : ''}
  `;

  $('r-faculty-total').addEventListener('change', (e) => saveFaculty({ facultyTotal: e.target.value }));
  el.querySelectorAll('.faculty-step').forEach((input) =>
    input.addEventListener('change', () => {
      const facultySteps = Array.from(el.querySelectorAll('.faculty-step')).map((i) => (i.value === '' ? null : Number(i.value)));
      const patch = { facultySteps };
      const filled = facultySteps.filter((v) => v !== null);
      // Keep the faculty total in step with the per-step marks once every step is filled
      if (filled.length === facultySteps.length) patch.facultyTotal = filled.reduce((a, b) => a + b, 0);
      saveFaculty(patch);
    })
  );
  $('r-notes').addEventListener('change', (e) => saveFaculty({ notes: e.target.value }));
  $('btn-regrade').addEventListener('click', regrade);
}

async function saveFaculty(patch) {
  if (!state.run) return;
  try {
    const updated = await api(`/api/runs/${encodeURIComponent(state.run.id)}`, { method: 'PATCH', json: patch });
    state.run = updated;
    const queued = state.queue.find((item) => item.runId === updated.id);
    if (queued) queued.run = updated;
    const diff = updated.facultyTotal === null ? null : updated.totalAwarded - updated.facultyTotal;
    $('r-diff').textContent = signed(diff);
    $('r-diff').className = `value ${diffClass(diff)}`;
    if ('facultyTotal' in patch) $('r-faculty-total').value = updated.facultyTotal ?? '';
  } catch (err) {
    toast(err.message, true);
  }
}

async function regrade() {
  if (state.busy || !state.run) return;
  const transcript = $('r-transcript').value;
  if (!transcript.trim()) return toast('The transcript is empty.', true);
  setBusy(true);
  setStatus('Marking the edited transcript…');
  try {
    const run = await api('/api/grade', {
      method: 'POST',
      json: { setup: state.run.setup, transcript, scriptName: state.run.scriptName, facultyTotal: state.run.facultyTotal ?? '' }
    });
    setStatus('');
    renderRun(run);
    toast('Marked again and saved as a new run.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

// ---------- history ----------

async function loadHistory() {
  let runs = [];
  try {
    runs = await api('/api/runs');
  } catch (err) {
    toast(err.message, true);
  }

  const compared = runs.filter((r) => r.facultyTotal !== null && r.facultyTotal !== undefined);
  const diffs = compared.map((r) => r.totalAwarded - r.facultyTotal);
  const absDiffs = diffs.map(Math.abs);
  const pct = (n) => (compared.length ? `${Math.round((n / compared.length) * 100)}%` : '–');
  const meanAbs = absDiffs.length ? `${fmt(absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length)} marks` : '–';

  let stepPairs = 0;
  let stepExact = 0;
  runs.forEach((r) =>
    (r.facultySteps || []).forEach((v, i) => {
      if (v === null || v === undefined || !r.steps[i]) return;
      stepPairs += 1;
      if (Math.abs(r.steps[i].awardedMarks - v) < 0.001) stepExact += 1;
    })
  );

  const stats = [
    ['Evaluations', runs.length],
    ['With faculty marks', compared.length],
    ['Average difference', meanAbs],
    ['Exact match', pct(absDiffs.filter((d) => d < 0.001).length)],
    ['Within ±0.5', pct(absDiffs.filter((d) => d <= 0.5 + 1e-9).length)],
    ['Within ±1', pct(absDiffs.filter((d) => d <= 1 + 1e-9).length)],
    ['AI higher / lower', compared.length ? `${diffs.filter((d) => d > 0.001).length} / ${diffs.filter((d) => d < -0.001).length}` : '–'],
    ['Steps matching faculty', stepPairs ? `${Math.round((stepExact / stepPairs) * 100)}% of ${stepPairs}` : '–'],
    ['Flagged for review', runs.length ? `${Math.round((runs.filter((r) => r.flags.length).length / runs.length) * 100)}%` : '–']
  ];
  $('accuracy-summary').innerHTML = stats
    .map(([label, value]) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`)
    .join('');

  $('history-body').innerHTML = runs.length
    ? runs
        .map((r) => {
          const diff = r.facultyTotal === null || r.facultyTotal === undefined ? null : r.totalAwarded - r.facultyTotal;
          const ocrModel = r.usage?.ocr?.model || (r.mode === 'combined' ? 'one call' : r.mode === 'remark' ? 're-mark' : 'saved');
          return `<tr>
            <td>${esc(new Date(r.createdAt).toLocaleString())}</td>
            <td>${esc(r.scriptName)}</td>
            <td>${esc(r.setup.code || r.setup.questionText.slice(0, 40))}</td>
            <td class="small">${esc(ocrModel)} / ${esc(r.usage?.grading?.model || '')}</td>
            <td class="num">${fmt(r.totalAwarded)}/${fmt(r.maxMarks)}</td>
            <td class="num">${fmt(r.facultyTotal)}</td>
            <td class="num ${diffClass(diff)}">${signed(diff)}</td>
            <td>${r.flags.length ? `<span class="tag warn">${r.flags.length} flag(s)</span>` : '<span class="tag good">Auto</span>'}</td>
            <td class="row gap"><button class="secondary" data-open="${esc(r.id)}" type="button">Open</button><button class="ghost danger" data-delete="${esc(r.id)}" type="button">Delete</button></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="9" class="muted">No evaluations yet.</td></tr>';

  $('history-body').onclick = async (e) => {
    const openId = e.target.dataset.open;
    const deleteId = e.target.dataset.delete;
    if (openId) {
      const run = runs.find((r) => r.id === openId);
      fillSetup(run.setup);
      renderSetupSummary(readSetup());
      renderRun(run);
      showTab('evaluate');
      goStep(2);
    } else if (deleteId && confirm('Delete this evaluation from the history?')) {
      await api(`/api/runs/${encodeURIComponent(deleteId)}`, { method: 'DELETE' });
      loadHistory();
    }
  };
}

// ---------- start ----------

state.apiKey = storageGet('apiKey');
$('api-key').value = state.apiKey;
refreshKeyStatus();
fillSetup({});
loadQuestions();
loadSettings().then(loadModels).catch((err) => toast(err.message, true));
