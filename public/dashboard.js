'use strict';

// Student exams tab: create exams from questions set up in Step 1, see uploads from students'
// phones arrive and get marked, review them in the Evaluate tab, then publish results.
// Uses the helpers and state from app.js, which loads first.

const dash = { exams: [], selectedExamId: null, submissions: [], timer: null, reviewing: null };

const STATUS_LABELS = {
  queued: ['Waiting', ''],
  evaluating: ['Marking…', 'warn'],
  evaluated: ['Evaluated', 'good'],
  failed: ['Failed', 'bad'],
  'waiting-for-key': ['Needs API key', 'bad']
};

// Refreshes every few seconds while the tab is open, so new uploads appear on their own
function setDashboardActive(active) {
  clearInterval(dash.timer);
  dash.timer = null;
  if (!active) return;
  loadDashboard();
  dash.timer = setInterval(() => refreshDashboard(), 4000);
}

async function loadDashboard() {
  renderExamSources();
  try {
    const info = await api('/api/students/connect');
    $('qr').innerHTML = info.qrSvg || '';
    $('student-urls').innerHTML = info.urls.length
      ? info.urls.map((u) => `<div><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></div>`).join('')
      : '<p class="status error">This computer is not connected to a network. Connect to Wi-Fi, then reload this page.</p>';
    renderKeyStatus(info);
  } catch (err) {
    toast(err.message, true);
  }
  await refreshDashboard();
}

function renderKeyStatus(info) {
  $('server-key-status').innerHTML = info.hasServerKey
    ? `<span class="tag good">Key saved</span>${info.keyFromEnv ? ' <span class="muted small">(from the .env file)</span>' : ''}`
    : '<span class="tag bad">No key saved: uploads will wait until you save one</span>';
}

async function refreshDashboard() {
  try {
    dash.exams = await api('/api/exams');
    if (dash.selectedExamId) dash.submissions = await api(`/api/exams/${encodeURIComponent(dash.selectedExamId)}/submissions`);
  } catch (err) {
    return;
  }
  renderExams();
  renderSubmissions();
}

// ---------- exams ----------

function renderExamSources() {
  const current = state.paper.filter((q) => q.include !== false && setupIsUsable({ questionText: '', scheme: '', steps: [], ...q }));
  const papers = [...new Set(state.questions.map((q) => q.paperTitle).filter(Boolean))];
  $('new-exam-source').innerHTML = [
    `<option value="current">Questions now in Step 1 (${current.length})</option>`,
    ...papers.map((p) => `<option value="paper:${esc(p)}">Saved paper: ${esc(p)}</option>`),
    ...state.questions.map((q) => `<option value="q:${esc(q.id)}">Saved question: ${esc(q.code || q.questionText.slice(0, 40))}</option>`)
  ].join('');
}

function questionsFromSource(source) {
  if (source === 'current') {
    commitActive();
    return state.paper.filter((q) => q.include !== false && setupIsUsable({ questionText: '', scheme: '', steps: [], ...q }));
  }
  if (source.startsWith('paper:')) return state.questions.filter((q) => q.paperTitle === source.slice(6)).reverse();
  return state.questions.filter((q) => q.id === source.slice(2));
}

$('btn-create-exam').addEventListener('click', async () => {
  const questions = questionsFromSource($('new-exam-source').value);
  if (!questions.length) {
    toast('There are no questions to use. Set them up in Evaluate → Evaluation materials first.', true);
    return;
  }
  const title = $('new-exam-title').value.trim() || questions[0].paperTitle || questions[0].code;
  try {
    const exam = await api('/api/exams', { method: 'POST', json: { title, questions } });
    $('new-exam-title').value = '';
    dash.selectedExamId = exam.id;
    toast(`Exam created with ${questions.length} question(s). Students can upload now.`);
    await refreshDashboard();
  } catch (err) {
    toast(err.message, true);
  }
});

function renderExams() {
  $('exam-body').innerHTML = dash.exams.length
    ? dash.exams
        .map(
          (e) => `<tr class="${e.id === dash.selectedExamId ? 'active' : ''}">
            <td><b>${esc(e.title)}</b><div class="muted small">${esc(e.questions.map((q) => q.code).join(', '))}</div></td>
            <td class="num">${e.questions.length}</td>
            <td class="num">${fmt(e.totalMarks)}</td>
            <td class="num">${e.counts.submissions}</td>
            <td class="num">${e.counts.evaluated}${e.counts.pending ? ` <span class="muted small">(+${e.counts.pending} in progress)</span>` : ''}${e.counts.failed ? ` <span class="tag bad">${e.counts.failed} failed</span>` : ''}</td>
            <td><button class="small-btn ${e.open ? 'secondary' : 'ghost'}" data-toggle-open="${esc(e.id)}" type="button">${e.open ? 'Open · close' : 'Closed · reopen'}</button></td>
            <td><button class="small-btn ${e.published ? 'secondary' : 'ghost'}" data-toggle-publish="${esc(e.id)}" type="button">${e.published ? 'Published · hide' : 'Publish'}</button></td>
            <td class="row gap"><button class="secondary small-btn" data-view-exam="${esc(e.id)}" type="button">Submissions</button><button class="ghost danger small-btn" data-delete-exam="${esc(e.id)}" type="button">Delete</button></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="8" class="muted">No exams yet. Create one above.</td></tr>';
}

$('exam-body').addEventListener('click', async (e) => {
  const { toggleOpen, togglePublish, viewExam, deleteExam } = e.target.dataset;
  const exam = dash.exams.find((x) => x.id === (toggleOpen || togglePublish || viewExam || deleteExam));
  if (!exam) return;
  try {
    if (toggleOpen) await api(`/api/exams/${encodeURIComponent(exam.id)}`, { method: 'PATCH', json: { open: !exam.open } });
    if (togglePublish) {
      const waiting = exam.counts.flaggedNotReviewed;
      if (!exam.published && waiting && !confirm(`${waiting} flagged script(s) are not marked as reviewed yet. Publish anyway?`)) return;
      if (!exam.published && exam.counts.pending && !confirm(`${exam.counts.pending} script(s) are still being marked. Their results will appear once marking finishes. Publish now?`)) return;
      await api(`/api/exams/${encodeURIComponent(exam.id)}`, { method: 'PATCH', json: { published: !exam.published } });
      toast(exam.published ? 'Results hidden from students.' : 'Results published. Students can see them with their receipt code.');
    }
    if (viewExam) dash.selectedExamId = exam.id;
    if (deleteExam) {
      if (!confirm(`Delete "${exam.title}" and all ${exam.counts.submissions} uploaded script(s)? Marks stay in History.`)) return;
      await api(`/api/exams/${encodeURIComponent(exam.id)}`, { method: 'DELETE' });
      if (dash.selectedExamId === exam.id) dash.selectedExamId = null;
    }
    await refreshDashboard();
    if (viewExam) $('subs-card').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- submissions ----------

function renderSubmissions() {
  const exam = dash.exams.find((e) => e.id === dash.selectedExamId);
  $('subs-card').hidden = !exam;
  if (!exam) return;
  $('subs-title').textContent = `${exam.title}: submissions`;
  $('subs-note').textContent = exam.published ? 'Results are published to students.' : 'Students see results only after you publish.';
  $('subs-body').innerHTML = dash.submissions.length
    ? dash.submissions
        .map((s) => {
          const [label, tone] = STATUS_LABELS[s.status] || [s.status, ''];
          const partial = s.errors?.length ? ` <span class="tag warn" title="${esc(s.errors.map((x) => `${x.code}: ${x.error}`).join('\n'))}">${s.errors.length} question(s) not marked</span>` : '';
          return `<tr>
            <td>${esc(s.studentName)}</td>
            <td>${esc(s.rollNo)}</td>
            <td class="small">${esc(new Date(s.createdAt).toLocaleString())}<div class="muted">${s.files.length} file(s)</div></td>
            <td><span class="tag ${tone}" title="${esc(s.error || '')}">${esc(label)}</span>${partial}${s.error ? `<div class="small diff-neg">${esc(s.error)}</div>` : ''}</td>
            <td class="num">${s.aiTotal === null ? '–' : `${fmt(s.aiTotal)}/${fmt(s.maxMarks)}`}</td>
            <td class="num">${s.finalTotal === null ? '–' : `<b>${fmt(s.finalTotal)}</b>/${fmt(s.maxMarks)}`}${s.facultyEdited ? '<div class="muted small">faculty edited</div>' : ''}</td>
            <td>${
              s.status === 'evaluated'
                ? `${s.flagCount ? `<span class="tag warn">${s.flagCount} flag(s)</span>` : '<span class="tag good">No flags</span>'}
                   <label class="check small"><input type="checkbox" data-reviewed="${esc(s.id)}" ${s.reviewed ? 'checked' : ''}> Reviewed</label>`
                : ''
            }</td>
            <td class="row gap">
              ${s.status === 'evaluated' ? `<button class="secondary small-btn" data-review="${esc(s.id)}" type="button">Review</button>` : ''}
              ${['failed', 'evaluated', 'waiting-for-key'].includes(s.status) ? `<button class="ghost small-btn" data-retry="${esc(s.id)}" type="button">${s.status === 'evaluated' ? 'Mark again' : 'Retry'}</button>` : ''}
              <button class="ghost danger small-btn" data-delete-sub="${esc(s.id)}" type="button">Delete</button>
            </td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="8" class="muted">No uploads yet. ${exam.open ? 'Share the student link above.' : 'This exam is closed for uploads.'}</td></tr>`;
}

$('subs-body').addEventListener('change', async (e) => {
  const id = e.target.dataset.reviewed;
  if (!id) return;
  await api(`/api/submissions/${encodeURIComponent(id)}`, { method: 'PATCH', json: { reviewed: e.target.checked } }).catch((err) => toast(err.message, true));
  refreshDashboard();
});

$('subs-body').addEventListener('click', async (e) => {
  const { review, retry, deleteSub } = e.target.dataset;
  const submission = dash.submissions.find((s) => s.id === (review || retry || deleteSub));
  if (!submission) return;
  try {
    if (review) await openReview(submission);
    if (retry) {
      if (submission.status === 'evaluated' && !confirm('Read and mark this script again from scratch? The current marks and any faculty marks for it will be replaced.')) return;
      await api(`/api/submissions/${encodeURIComponent(submission.id)}/retry`, { method: 'POST' });
      toast('Queued for marking.');
    }
    if (deleteSub) {
      if (!confirm(`Delete ${submission.studentName}'s upload? Their marks stay in History.`)) return;
      await api(`/api/submissions/${encodeURIComponent(submission.id)}`, { method: 'DELETE' });
    }
    await refreshDashboard();
  } catch (err) {
    toast(err.message, true);
  }
});

// Opens the marks in the Evaluate tab, where faculty can adjust them; students see those changes
async function openReview(submission) {
  const exam = dash.exams.find((e) => e.id === submission.examId);
  const runs = await api(`/api/submissions/${encodeURIComponent(submission.id)}/runs`);
  if (!runs.length) return toast('No marks were saved for this script.', true);
  dash.reviewing = { submission, exam };
  loadPaper(exam.questions);
  state.evalSetups = exam.questions;
  renderSetupSummary(exam.questions);
  showTab('evaluate');
  goStep(2);
  showRuns(runs);
}

// Shown above a result that came from a student's upload
function studentBanner(run) {
  const review = dash.reviewing;
  if (!run.submissionId || !review || review.submission.id !== run.submissionId) return '';
  const files = review.submission.files
    .map((f, i) => `<a href="/api/submissions/${encodeURIComponent(review.submission.id)}/files/${encodeURIComponent(f.stored)}" target="_blank" rel="noopener">Page ${i + 1}</a>`)
    .join(' · ');
  return `<div class="student-banner">
    <div><b>${esc(review.submission.studentName)}</b> · Roll ${esc(review.submission.rollNo)} · ${esc(review.exam.title)}</div>
    <div class="small">Student's pages: ${files}</div>
    <div class="small muted">Marks you enter here are what the student sees after you publish.</div>
    <button class="ghost small-btn" type="button" data-back-dashboard>← Back to student exams</button>
  </div>`;
}

$('result').addEventListener('click', (e) => {
  if (e.target.matches('[data-back-dashboard]')) {
    dash.reviewing = null;
    showTab('dashboard');
  }
});

// ---------- server key ----------

async function saveServerKey(apiKey) {
  if (!apiKey) return toast('Enter a key first.', true);
  try {
    await api('/api/students/server-key', { method: 'PUT', json: { apiKey } });
    $('server-key').value = '';
    renderKeyStatus(await api('/api/students/connect'));
    toast('Key saved. Waiting uploads will now be marked.');
    refreshDashboard();
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-server-key').addEventListener('click', () => saveServerKey($('server-key').value.trim()));
$('btn-copy-key').addEventListener('click', () => {
  if (!state.apiKey) return toast('No key in Settings yet. Paste one here instead.', true);
  saveServerKey(state.apiKey);
});

setDashboardActive(true);
