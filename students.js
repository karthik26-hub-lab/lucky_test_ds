// Student uploads from phones on the same Wi-Fi, the queue that marks them with the admin's saved
// Gemini key, and the admin's exam dashboard. Students reach only /student.html and /api/student/*;
// everything else answers only the computer running the app.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import QRCode from 'qrcode';
import { sanitizeSetup } from './lib.js';
import { HttpError, createClient, friendlyError } from './gemini.js';

const ALLOWED_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, which are easy to misread

export function isLocalRequest(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// Private home/office network addresses first, so the link shown to students is the reachable one
export function lanAddresses() {
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
    .sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

// Keeps students out of the admin pages and API, which can see every result and spend the API key
export function restrictToThisComputer(req, res, next) {
  if (isLocalRequest(req)) return next();
  if (req.path.startsWith('/api/student/')) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'This part of the app only works on the computer that runs it.' });
  }
  if (req.path === '/' || req.path === '/index.html') return res.redirect('/student.html');
  next();
}

const clean = (value, max = 100) => String(value ?? '').trim().slice(0, max);
const receiptCode = () => Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const sum = (values) => Math.round(values.reduce((a, b) => a + (Number(b) || 0), 0) * 100) / 100;

// Faculty marks, where entered, replace the AI's for that step or question
export function finalMarks(run) {
  const stepMarks = run.steps.map((s, i) => run.facultySteps?.[i] ?? s.awardedMarks);
  return { stepMarks, total: run.facultyTotal ?? sum(stepMarks) };
}

export function registerStudentFeatures(app, { dataDir, port, readJson, writeJson, upload, route, evaluateFiles, loadSettings, runsFile }) {
  const EXAMS_FILE = path.join(dataDir, 'exams.json');
  const SUBMISSIONS_FILE = path.join(dataDir, 'submissions.json');
  const KEY_FILE = path.join(dataDir, 'server-key.json');
  const UPLOADS_DIR = path.join(dataDir, 'submissions');

  const serverKey = () => (process.env.GEMINI_API_KEY || readJson(KEY_FILE, {}).apiKey || '').trim();
  const loadExams = () => readJson(EXAMS_FILE);
  const loadSubmissions = () => readJson(SUBMISSIONS_FILE);
  const findExam = (id) => loadExams().find((e) => e.id === id);

  // Reads and writes happen in one synchronous step, so the queue and requests can't overwrite each other
  function updateSubmission(id, changes) {
    const submissions = loadSubmissions();
    const submission = submissions.find((s) => s.id === id);
    if (!submission) return null;
    Object.assign(submission, typeof changes === 'function' ? changes(submission) : changes);
    writeJson(SUBMISSIONS_FILE, submissions);
    return submission;
  }

  function updateExam(id, changes) {
    const exams = loadExams();
    const exam = exams.find((e) => e.id === id);
    if (!exam) throw new HttpError(404, 'Exam not found.');
    Object.assign(exam, changes);
    writeJson(EXAMS_FILE, exams);
    return exam;
  }

  const runsFor = (submission) => {
    const byId = new Map(readJson(runsFile).map((r) => [r.id, r]));
    return (submission.runIds || []).map((id) => byId.get(id)).filter(Boolean);
  };

  function summarize(submission) {
    const runs = runsFor(submission);
    return {
      ...submission,
      aiTotal: runs.length ? sum(runs.map((r) => r.totalAwarded)) : null,
      finalTotal: runs.length ? sum(runs.map((r) => finalMarks(r).total)) : null,
      maxMarks: runs.length ? sum(runs.map((r) => r.maxMarks)) : null,
      flagCount: runs.reduce((n, r) => n + r.flags.length, 0),
      facultyEdited: runs.some((r) => r.facultyTotal !== null || (r.facultySteps || []).some((v) => v !== null))
    };
  }

  // ---------- evaluation queue ----------

  let running = false;
  async function processQueue() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const next = loadSubmissions().find((s) => s.status === 'queued');
        if (!next) break;
        const key = serverKey();
        if (!key) {
          // Waits for the admin to save a key; saving one restarts the queue
          loadSubmissions()
            .filter((s) => s.status === 'queued')
            .forEach((s) => updateSubmission(s.id, { status: 'waiting-for-key' }));
          break;
        }
        updateSubmission(next.id, { status: 'evaluating', error: null });
        try {
          const exam = findExam(next.examId);
          if (!exam) throw new Error('The exam for this script was deleted.');
          const files = next.files.map((f) => {
            const buffer = fs.readFileSync(path.join(UPLOADS_DIR, next.id, f.stored));
            return { originalname: f.name, mimetype: f.mimetype, buffer, size: buffer.length };
          });
          const { runs, errors } = await evaluateFiles(createClient(key), files, exam.questions, loadSettings(), {
            scriptName: `${next.studentName} (${next.rollNo})`,
            extra: { submissionId: next.id, examId: exam.id, studentName: next.studentName, rollNo: next.rollNo }
          });
          updateSubmission(next.id, { status: 'evaluated', evaluatedAt: new Date().toISOString(), runIds: runs.map((r) => r.id), errors });
        } catch (err) {
          console.error(`Evaluation failed for ${next.id}:`, err.message);
          updateSubmission(next.id, { status: 'failed', error: friendlyError(err) });
        }
      }
    } finally {
      running = false;
    }
  }

  // A script that was being marked when the app closed starts again
  loadSubmissions()
    .filter((s) => s.status === 'evaluating')
    .forEach((s) => updateSubmission(s.id, { status: 'queued' }));
  setImmediate(processQueue);

  // ---------- student pages ----------

  const publicQuestion = (q) => ({ code: q.code, topic: q.topic, questionText: q.questionText, maxMarks: q.maxMarks });

  app.get('/api/student/exams', (req, res) => {
    res.json(
      loadExams()
        .filter((e) => e.open)
        .map((e) => ({ id: e.id, title: e.title, questions: e.questions.map(publicQuestion), totalMarks: sum(e.questions.map((q) => q.maxMarks)) }))
    );
  });

  app.post(
    '/api/student/submissions',
    upload.array('files'),
    route(async (req, res) => {
      const exam = findExam(clean(req.body.examId));
      if (!exam || !exam.open) throw new HttpError(400, 'This exam is not accepting answers right now.');
      const studentName = clean(req.body.studentName);
      const rollNo = clean(req.body.rollNo, 40);
      if (!studentName || !rollNo) throw new HttpError(400, 'Enter your name and roll number.');
      const files = req.files || [];
      if (!files.length) throw new HttpError(400, 'Add photos or a PDF of your answer.');
      const bad = files.find((f) => !ALLOWED_TYPES.test(f.mimetype));
      if (bad) throw new HttpError(400, `${bad.originalname}: only photos (JPG, PNG, HEIC) or PDF can be uploaded.`);

      const id = `sub-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const folder = path.join(UPLOADS_DIR, id);
      fs.mkdirSync(folder, { recursive: true });
      const stored = files.map((f, i) => {
        const name = `${String(i + 1).padStart(2, '0')}${path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin'}`;
        fs.writeFileSync(path.join(folder, name), f.buffer);
        return { name: clean(f.originalname, 200), stored: name, mimetype: f.mimetype, size: f.size };
      });

      const submission = {
        id,
        code: receiptCode(),
        examId: exam.id,
        studentName,
        rollNo,
        files: stored,
        status: 'queued',
        createdAt: new Date().toISOString(),
        runIds: [],
        errors: [],
        reviewed: false
      };
      writeJson(SUBMISSIONS_FILE, [submission, ...loadSubmissions()]);
      setImmediate(processQueue);
      res.json({ id, code: submission.code, examTitle: exam.title });
    })
  );

  // Needs the roll number AND the receipt code, so one student can't look up another's result
  app.get('/api/student/results', (req, res) => {
    const rollNo = clean(req.query.rollNo, 40).toLowerCase();
    const code = clean(req.query.code, 10).toUpperCase();
    const submission = loadSubmissions().find((s) => s.code === code && s.rollNo.toLowerCase() === rollNo);
    if (!submission) return res.status(404).json({ error: 'No answer found for this roll number and receipt code.' });
    const exam = findExam(submission.examId);
    const base = { examTitle: exam?.title || 'Deleted exam', studentName: submission.studentName, submittedAt: submission.createdAt };
    if (!exam?.published || submission.status !== 'evaluated') {
      const message =
        submission.status === 'evaluated'
          ? 'Your answer has been evaluated. Results will appear here once the academy publishes them.'
          : 'Your answer has been received and is being evaluated.';
      return res.json({ ...base, published: false, message });
    }
    const questions = runsFor(submission).map((run) => {
      const { stepMarks, total } = finalMarks(run);
      return {
        code: run.setup.code,
        questionText: run.setup.questionText,
        marks: total,
        maxMarks: run.maxMarks,
        notAttempted: !run.transcript,
        steps: run.steps.map((s, i) => ({
          title: s.title,
          marks: stepMarks[i],
          maxMarks: s.maxMarks,
          comment: s.reasoning,
          needed: run.setup.steps[i]?.expected || ''
        })),
        feedback: run.overallFeedback,
        strengths: run.strengths,
        improvements: run.improvements
      };
    });
    res.json({
      ...base,
      published: true,
      total: sum(questions.map((q) => q.marks)),
      maxMarks: sum(questions.map((q) => q.maxMarks)),
      questions
    });
  });

  // ---------- admin dashboard ----------

  app.get(
    '/api/students/connect',
    route(async (req, res) => {
      const urls = lanAddresses().map((ip) => `http://${ip}:${port}/student.html`);
      res.json({
        urls,
        qrSvg: urls.length ? await QRCode.toString(urls[0], { type: 'svg', margin: 1 }) : '',
        hasServerKey: Boolean(serverKey()),
        keyFromEnv: Boolean(process.env.GEMINI_API_KEY)
      });
    })
  );

  app.put('/api/students/server-key', (req, res) => {
    const apiKey = clean(req.body?.apiKey, 200);
    writeJson(KEY_FILE, { apiKey });
    // Scripts that were waiting for a key can now be marked
    loadSubmissions()
      .filter((s) => s.status === 'waiting-for-key')
      .forEach((s) => updateSubmission(s.id, { status: 'queued' }));
    setImmediate(processQueue);
    res.json({ hasServerKey: Boolean(serverKey()) });
  });

  app.get('/api/exams', (req, res) => {
    const submissions = loadSubmissions().map(summarize);
    res.json(
      loadExams().map((exam) => {
        const mine = submissions.filter((s) => s.examId === exam.id);
        return {
          ...exam,
          totalMarks: sum(exam.questions.map((q) => q.maxMarks)),
          counts: {
            submissions: mine.length,
            evaluated: mine.filter((s) => s.status === 'evaluated').length,
            pending: mine.filter((s) => ['queued', 'evaluating', 'waiting-for-key'].includes(s.status)).length,
            failed: mine.filter((s) => s.status === 'failed').length,
            flaggedNotReviewed: mine.filter((s) => s.status === 'evaluated' && s.flagCount && !s.reviewed).length
          }
        };
      })
    );
  });

  app.post('/api/exams', (req, res) => {
    const title = clean(req.body?.title, 150);
    const questions = (Array.isArray(req.body?.questions) ? req.body.questions : []).map((q) => sanitizeSetup(q));
    if (!title) return res.status(400).json({ error: 'Give the exam a title.' });
    if (!questions.length) return res.status(400).json({ error: 'Add at least one question.' });
    const exam = { id: `exam-${Date.now()}`, title, questions, open: true, published: false, createdAt: new Date().toISOString(), publishedAt: null };
    writeJson(EXAMS_FILE, [exam, ...loadExams()]);
    res.json(exam);
  });

  app.patch('/api/exams/:id', (req, res) => {
    const changes = {};
    if ('title' in req.body) changes.title = clean(req.body.title, 150) || 'Untitled exam';
    if ('open' in req.body) changes.open = Boolean(req.body.open);
    if ('published' in req.body) {
      changes.published = Boolean(req.body.published);
      changes.publishedAt = changes.published ? new Date().toISOString() : null;
    }
    res.json(updateExam(req.params.id, changes));
  });

  app.delete('/api/exams/:id', (req, res) => {
    const submissions = loadSubmissions();
    submissions.filter((s) => s.examId === req.params.id).forEach((s) => fs.rmSync(path.join(UPLOADS_DIR, s.id), { recursive: true, force: true }));
    writeJson(SUBMISSIONS_FILE, submissions.filter((s) => s.examId !== req.params.id));
    writeJson(EXAMS_FILE, loadExams().filter((e) => e.id !== req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/exams/:id/submissions', (req, res) => {
    res.json(loadSubmissions().filter((s) => s.examId === req.params.id).map(summarize));
  });

  app.get('/api/submissions/:id/runs', (req, res) => {
    const submission = loadSubmissions().find((s) => s.id === req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });
    res.json(runsFor(submission));
  });

  app.get('/api/submissions/:id/files/:name', (req, res) => {
    const submission = loadSubmissions().find((s) => s.id === req.params.id);
    const file = submission?.files.find((f) => f.stored === req.params.name);
    if (!file) return res.status(404).end();
    res.type(file.mimetype).sendFile(path.join(UPLOADS_DIR, submission.id, file.stored));
  });

  app.patch('/api/submissions/:id', (req, res) => {
    const submission = updateSubmission(req.params.id, 'reviewed' in req.body ? { reviewed: Boolean(req.body.reviewed) } : {});
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });
    res.json(summarize(submission));
  });

  app.post('/api/submissions/:id/retry', (req, res) => {
    const submission = updateSubmission(req.params.id, { status: 'queued', error: null });
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });
    setImmediate(processQueue);
    res.json(summarize(submission));
  });

  app.delete('/api/submissions/:id', (req, res) => {
    fs.rmSync(path.join(UPLOADS_DIR, req.params.id), { recursive: true, force: true });
    writeJson(SUBMISSIONS_FILE, loadSubmissions().filter((s) => s.id !== req.params.id));
    res.json({ ok: true });
  });

  return {
    serverKey,
    // A re-marked answer replaces the old one in the student's result
    replaceRun(oldRunId, newRun) {
      const owner = loadSubmissions().find((s) => (s.runIds || []).includes(oldRunId));
      if (owner) updateSubmission(owner.id, (s) => ({ runIds: s.runIds.map((id) => (id === oldRunId ? newRun.id : id)) }));
    }
  };
}
