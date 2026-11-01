// Run with: npm test
// Runs the real server and the real Gemini SDK against a local stand-in for Google's API, so the
// whole flow is covered without an API key: Word upload → question detection → script → results.
// `node test/e2e.test.js --keep` leaves both running on port 5052 to try the UI by hand.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 5052;
const FAKE_PORT = 5053;
const APP = `http://127.0.0.1:${APP_PORT}`;
const KEEP = process.argv.includes('--keep');

const DETECTED = {
  paperTitle: 'Accounts Test 1',
  questions: [
    {
      code: 'Q1',
      topic: 'Depreciation',
      questionType: 'numerical',
      questionText: 'A machine cost 5,00,000 with scrap value 50,000 and a life of 5 years. Compute annual depreciation.',
      maxMarks: 4,
      scheme: '| Working | Amount | Marks |\n| Cost less scrap | 4,50,000 | 2 |\n| Annual depreciation | 90,000 | 2 |',
      steps: [
        { title: 'Cost less scrap', marks: 2, expected: '5,00,000 - 50,000 = 4,50,000', keywords: '', dependsOnEarlierFigure: false },
        { title: 'Annual depreciation', marks: 2, expected: '4,50,000 / 5 = 90,000', keywords: '', dependsOnEarlierFigure: true }
      ],
      keywords: ['depreciation'],
      layout: 'Working note, then final answer',
      instructions: ''
    },
    {
      code: 'Q2',
      topic: 'Companies Act',
      questionType: 'theory',
      questionText: 'Explain Section 185 of the Companies Act, 2013.',
      maxMarks: 2,
      scheme: 'Prohibits loans to directors.',
      steps: [{ title: 'Provision', marks: 2, expected: 'Section 185 prohibits loans to directors.', keywords: 'Section 185', dependsOnEarlierFigure: false }],
      keywords: ['Section 185'],
      layout: '',
      instructions: ''
    },
    {
      code: 'Q3',
      topic: 'Companies Act',
      questionType: 'theory',
      questionText: 'Explain Section 186.',
      maxMarks: 2,
      scheme: 'Limits on investments.',
      steps: [{ title: 'Provision', marks: 2, expected: 'Section 186 limits investments.', keywords: '', dependsOnEarlierFigure: false }],
      keywords: [],
      layout: '',
      instructions: ''
    }
  ]
};

// The student got the first figure wrong and carried it forward correctly: own-figure territory.
const TRANSCRIPT = ['--- Page 1 ---', 'Q2. Section 185 prohibits loans to directors.', '--- Page 2 ---', 'Q1. 5,00,000 - 60,000 = 4,40,000', '4,40,000 / 5 = 88,000'].join('\n');

const step = (no, awardedMarks, evidenceQuote, ownFigureApplied = false) => ({
  stepNo: no,
  title: 'x',
  maxMarks: 2,
  awardedMarks,
  evidenceQuote,
  reasoning: ownFigureApplied ? 'Expected 90,000; student 88,000 from own figure.' : 'Marked against the scheme.',
  confidence: 0.9,
  ownFigureApplied
});
const graded = (steps, keywords) => ({
  steps,
  keywords,
  presentation: { followsLayout: true, comments: 'Clear.' },
  overallFeedback: 'Good effort.',
  strengths: [],
  improvements: [],
  needsHumanReview: false,
  reviewReason: ''
});

const seen = [];
const respond = (prompt) => {
  if (prompt.includes('Find EVERY separate question')) return { kind: 'detect', body: DETECTED };
  if (prompt.includes('NUMBERED TRANSCRIPT')) {
    return {
      kind: 'split',
      body: {
        answers: [
          { code: 'Q1', attempted: true, ranges: [{ startLine: 4, endLine: 5 }] },
          { code: 'Q2', attempted: true, ranges: [{ startLine: 2, endLine: 2 }] },
          { code: 'Q3', attempted: false, ranges: [] }
        ]
      }
    };
  }
  if (prompt.includes('You are transcribing')) return { kind: 'ocr', text: TRANSCRIPT };
  if (prompt.includes('COMPUTATION')) {
    return {
      kind: 'mark-numerical',
      body: graded([step(1, 1, '5,00,000 - 60,000 = 4,40,000'), step(2, 2, '4,40,000 / 5 = 88,000', true)], [{ keyword: 'depreciation', present: false, matchedText: '' }])
    };
  }
  return { kind: 'mark-theory', body: graded([step(1, 2, 'Section 185 prohibits loans to directors.')], [{ keyword: 'Section 185', present: true, matchedText: 'Section 185' }]) };
};

const fakeGoogle = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const text = JSON.stringify(JSON.parse(body || '{}').contents || '');
    const answer = respond(text.replace(/\\n/g, '\n'));
    seen.push({ kind: answer.kind, text, schema: body.includes('responseSchema') });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: answer.text ?? JSON.stringify(answer.body) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }
      })
    );
  });
});
await new Promise((resolve) => fakeGoogle.listen(FAKE_PORT, '127.0.0.1', resolve));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-e2e-'));
const app = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir, GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`, GEMINI_API_KEY: '' },
  stdio: 'inherit'
});
const finish = () => {
  app.kill();
  fakeGoogle.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
};

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const tc = (t) => `<w:tc>${p(t)}</w:tc>`;
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('Q1 A machine cost 5,00,000 with scrap value 50,000 and a life of 5 years. Compute annual depreciation.')}<w:tbl><w:tr>${tc('Cost less scrap')}${tc('4,50,000')}${tc('2')}</w:tr><w:tr>${tc('Annual depreciation')}${tc('90,000')}${tc('2')}</w:tr></w:tbl>${p('5,00,000 - 50,000 = 4,50,000 and 4,50,000 / 5 = 90,000')}${p('Q2 Explain Section 185 of the Companies Act, 2013.')}${p('Q3 Explain Section 186.')}</w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function post(route, form) {
  const res = await fetch(APP + route, { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: form });
  return { status: res.status, data: await res.json() };
}

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${APP}/api/settings`);
      break;
    } catch (err) {
      if (i > 50) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await fetch(`${APP}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestsPerMinute: 0 }) });

  // Step 1: one Word file becomes a paper of checked questions
  const importForm = new FormData();
  importForm.append('files', new File([await makeDocx()], 'paper.docx'));
  const imported = await post('/api/import', importForm);
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const { setups, paperTitle, notes } = imported.data;
  assert.equal(setups.length, 3);
  assert.equal(paperTitle, 'Accounts Test 1');
  assert.equal(setups[0].steps[1].dependsOnEarlierFigure, true);
  assert.ok(notes.some((n) => /Detected 3 questions/.test(n)));
  const detect = seen.find((s) => s.kind === 'detect');
  assert.ok(detect.schema, 'detection uses the JSON schema');
  assert.match(detect.text, /Annual depreciation \| 90,000 \| 2/, 'the table reached the model intact');

  // Step 2: one script is read once, split, and marked per question
  seen.length = 0;
  const evaluate = async () => {
    const form = new FormData();
    form.append('files', new File([Buffer.from('%PDF-1.4 script')], 'roll-101.pdf', { type: 'application/pdf' }));
    form.append('setups', JSON.stringify(setups));
    form.append('scriptName', 'Roll 101');
    form.append('facultyTotal', '');
    return post('/api/evaluate', form);
  };
  const first = await evaluate();
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(seen.map((s) => s.kind), ['ocr', 'split', 'mark-numerical', 'mark-theory'], 'no marking request for the unanswered Q3');
  const { runs, errors } = first.data;
  assert.deepEqual(errors, []);
  assert.equal(runs.length, 3);

  const [q1, q2, q3] = runs;
  assert.equal(q1.totalAwarded, 3, 'wrong first figure loses a mark; carried figure keeps full marks');
  assert.equal(q1.steps[1].ownFigureApplied, true);
  assert.equal(q1.transcript, 'Q1. 5,00,000 - 60,000 = 4,40,000\n4,40,000 / 5 = 88,000', 'Q1 sees only its own answer');
  assert.ok(!q1.flags.some((f) => /full marks, but none/.test(f)), 'own-figure credit is not flagged as a wrong figure');
  assert.equal(q1.fullTranscript, TRANSCRIPT);
  assert.equal(q2.totalAwarded, 2);
  assert.equal(q2.keywords[0].exactMatch, true);
  assert.deepEqual(q2.flags, []);
  assert.equal(q3.totalAwarded, 0);
  assert.match(q3.flags[0], /No answer to this question/);
  assert.equal(q3.usage.grading, undefined);

  // The same script again reuses the transcript instead of paying for OCR
  seen.length = 0;
  const second = await evaluate();
  assert.equal(second.status, 200);
  assert.ok(!seen.some((s) => s.kind === 'ocr'), 'OCR is not repeated');
  assert.equal(second.data.runs[0].transcriptSource, 'saved transcript (no OCR call)');

  // History and the report still work with per-question results
  const all = await (await fetch(`${APP}/api/runs`)).json();
  assert.equal(all.length, 6);
  const csv = await (await fetch(`${APP}/api/runs.csv`)).text();
  assert.match(csv, /Roll 101,Q1/);

  console.log('All end-to-end tests passed.');
  if (KEEP) {
    console.log(`Stand-in running. Open http://localhost:${APP_PORT} (any API key works). Press Ctrl+C to stop.`);
    await new Promise(() => {});
  }
  finish();
} catch (err) {
  finish();
  throw err;
}
