'use strict';

// The page students open on their phones: choose a paper, photograph the answer, submit, and
// later see the published result with the roll number and receipt code.
const $ = (id) => document.getElementById(id);
const state = { exams: [], exam: null, pages: [] };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const fmt = (n) => (n === null || n === undefined ? '–' : String(Math.round(Number(n) * 100) / 100));

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3000);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Remembers this phone's receipts, so a student doesn't have to keep the code safe themselves
const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage blocked: the student keeps the code themselves
    }
  }
};

// Question text uses Markdown tables; everything else stays as written
function renderText(text) {
  const out = [];
  let table = [];
  const flush = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\|[\s|:-]+\|$/.test(r)).map((r) => r.split('|').slice(1, -1).map((c) => esc(c.trim())));
    out.push(
      `<div class="table-wrap"><table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`).join('')}</table></div>`
    );
    table = [];
  };
  String(text || '')
    .split('\n')
    .forEach((line) => {
      if (line.trim().startsWith('|')) table.push(line.trim());
      else {
        flush();
        out.push(esc(line));
      }
    });
  flush();
  return out.join('\n');
}

function show(view) {
  ['exams', 'answer', 'receipt', 'results'].forEach((v) => ($(`v-${v}`).hidden = v !== view));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === (view === 'results' ? 'results' : 'submit')));
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    if (t.dataset.view === 'results') {
      renderMySubmissions();
      show('results');
    } else show(state.exam ? 'answer' : 'exams');
  })
);

// ---------- choose and answer ----------

async function loadExams() {
  try {
    state.exams = await api('/api/student/exams');
  } catch (err) {
    $('exam-list').innerHTML = `<p class="status error">${esc(err.message)}</p>`;
    return;
  }
  $('exam-list').innerHTML = state.exams.length
    ? state.exams
        .map(
          (e) => `<button class="exam-card" type="button" data-exam="${esc(e.id)}"><b>${esc(e.title)}</b><span class="muted">${e.questions.length} question(s) · ${fmt(e.totalMarks)} marks</span></button>`
        )
        .join('')
    : '<p class="muted">No paper is open for answers right now. Ask your faculty.</p>';
}

$('exam-list').addEventListener('click', (e) => {
  const id = e.target.closest('[data-exam]')?.dataset.exam;
  if (!id) return;
  state.exam = state.exams.find((x) => x.id === id);
  $('exam-title').textContent = state.exam.title;
  $('exam-questions').innerHTML = state.exam.questions
    .map(
      (q) => `<div class="question"><b>${esc(q.code)}</b> <span class="muted">(${fmt(q.maxMarks)} marks${q.topic ? ` · ${esc(q.topic)}` : ''})</span>
        <div class="question-text">${renderText(q.questionText)}</div></div>`
    )
    .join('');
  const me = store.get('student', {});
  $('student-name').value ||= me.name || '';
  $('roll-no').value ||= me.rollNo || '';
  show('answer');
});

$('btn-change').addEventListener('click', () => {
  state.exam = null;
  show('exams');
});

// Phone photos are often 4000px+; 2000px keeps handwriting readable and uploads much faster
async function shrink(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = 2000 / Math.max(bitmap.width, bitmap.height);
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

function renderPages() {
  $('pages').innerHTML = state.pages
    .map(
      (p, i) => `<div class="page"><span class="n">${i + 1}</span>${
        p.url ? `<img src="${p.url}" alt="Page ${i + 1}">` : `<span>📄 ${esc(p.file.name)}</span>`
      }<button class="x" type="button" data-remove="${i}" aria-label="Remove page ${i + 1}">×</button></div>`
    )
    .join('');
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const small = await shrink(file);
    state.pages.push({ file: small, url: small.type.startsWith('image/') ? URL.createObjectURL(small) : '' });
  }
  renderPages();
}

['camera', 'files'].forEach((id) =>
  $(id).addEventListener('change', async (e) => {
    await addFiles(e.target.files);
    e.target.value = '';
  })
);

$('pages').addEventListener('click', (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  const [removed] = state.pages.splice(Number(i), 1);
  if (removed.url) URL.revokeObjectURL(removed.url);
  renderPages();
});

$('btn-submit').addEventListener('click', async () => {
  const name = $('student-name').value.trim();
  const rollNo = $('roll-no').value.trim();
  if (!name || !rollNo) return toast('Enter your name and roll number.', true);
  if (!state.pages.length) return toast('Add photos or a PDF of your answer.', true);

  const btn = $('btn-submit');
  btn.disabled = true;
  $('submit-status').textContent = 'Uploading… keep this page open.';
  const form = new FormData();
  form.append('examId', state.exam.id);
  form.append('studentName', name);
  form.append('rollNo', rollNo);
  state.pages.forEach((p) => form.append('files', p.file));
  try {
    const { code, examTitle } = await api('/api/student/submissions', { method: 'POST', body: form });
    store.set('student', { name, rollNo });
    store.set('receipts', [{ code, rollNo, examTitle, at: new Date().toISOString() }, ...store.get('receipts', [])].slice(0, 20));
    state.pages.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    state.pages = [];
    renderPages();
    $('receipt-code').textContent = code;
    $('btn-see-result').onclick = () => lookup(rollNo, code);
    $('submit-status').textContent = '';
    show('receipt');
  } catch (err) {
    $('submit-status').textContent = '';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- results ----------

function renderMySubmissions() {
  const receipts = store.get('receipts', []);
  $('my-subs').innerHTML = receipts.length
    ? `<p class="muted small">Answers submitted from this phone:</p>${receipts
        .map((r) => `<button class="ghost small-btn" type="button" data-roll="${esc(r.rollNo)}" data-code="${esc(r.code)}">${esc(r.examTitle)} · ${esc(r.code)}</button>`)
        .join('')}`
    : '';
}

$('my-subs').addEventListener('click', (e) => {
  const { roll, code } = e.target.dataset;
  if (code) lookup(roll, code);
});

$('btn-lookup').addEventListener('click', () => lookup($('r-roll').value, $('r-code').value));

async function lookup(rollNo, code) {
  renderMySubmissions();
  show('results');
  $('r-roll').value = rollNo;
  $('r-code').value = code;
  if (!String(rollNo).trim() || !String(code).trim()) return toast('Enter your roll number and receipt code.', true);
  $('result-out').innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const r = await api(`/api/student/results?rollNo=${encodeURIComponent(rollNo.trim())}&code=${encodeURIComponent(code.trim())}`);
    $('result-out').innerHTML = r.published ? renderResult(r) : `<div class="card"><h2>${esc(r.examTitle)}</h2><p>${esc(r.message)}</p></div>`;
  } catch (err) {
    $('result-out').innerHTML = `<div class="card"><p class="status error">${esc(err.message)}</p></div>`;
  }
}

function renderResult(r) {
  const cls = (m, max) => (m >= max ? 'full' : m > 0 ? 'part' : 'zero');
  return `
    <div class="card">
      <h2>${esc(r.examTitle)}</h2>
      <div class="score-big">${fmt(r.total)} <span class="muted" style="font-size:18px">/ ${fmt(r.maxMarks)}</span></div>
      <p class="muted small">${esc(r.studentName)}</p>
    </div>
    ${r.questions
      .map(
        (q) => `<div class="card">
          <div class="card-head"><h2>${esc(q.code)}</h2><b>${fmt(q.marks)} / ${fmt(q.maxMarks)}</b></div>
          ${q.notAttempted ? '<p class="status error">No answer to this question was found in your script.</p>' : ''}
          ${q.steps
            .map(
              (s) => `<div class="step-row ${cls(s.marks, s.maxMarks)}">
                <div class="top"><span>${esc(s.title)}</span><span>${fmt(s.marks)} / ${fmt(s.maxMarks)}</span></div>
                ${s.comment ? `<div>${esc(s.comment)}</div>` : ''}
                ${s.marks < s.maxMarks && s.needed ? `<div class="needed"><b>What was needed:</b>\n${esc(s.needed)}</div>` : ''}
              </div>`
            )
            .join('')}
          ${q.feedback ? `<div class="section"><b>Feedback</b><div>${esc(q.feedback)}</div></div>` : ''}
          ${q.improvements?.length ? `<div class="section"><b>To improve</b><ul class="plain">${q.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        </div>`
      )
      .join('')}`;
}

loadExams();
