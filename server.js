import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  DEFAULT_SETTINGS,
  GRADE_SCHEMA,
  COMBINED_SCHEMA,
  SETUP_SCHEMA,
  sanitizeSettings,
  sanitizeSetup,
  modelChain,
  buildGradingPrompt,
  buildCombinedPrompt,
  finalizeResult,
  findUnclear,
  csvCell
} from './lib.js';
import { HttpError, createClient, friendlyError, generate, usageOf, filesToParts, parseJson } from './gemini.js';
import { importMaterials, buildExcelTemplate, buildTextTemplate } from './importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // .env is optional; the key can also be entered in the UI
}

const PORT = Number(process.env.PORT) || 5050;
const DATA_DIR = path.join(__dirname, 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const OCR_CACHE_FILE = path.join(DATA_DIR, 'ocr-cache.json');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 60 } });

function readJson(file, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

const loadSettings = () => sanitizeSettings(readJson(SETTINGS_FILE, {}));

function clientFor(req) {
  return createClient((req.get('x-api-key') || process.env.GEMINI_API_KEY || '').trim());
}

const route = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: friendlyError(err) });
  }
};

function parseSetupField(value) {
  try {
    return sanitizeSetup(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    throw new HttpError(400, 'The question setup could not be read.');
  }
}

function requireUsableSetup(setup) {
  if (!setup.questionText && !setup.scheme && !setup.steps.length) {
    throw new HttpError(400, 'Add the question, a marking scheme or at least one step first (Step 1).');
  }
}

const toMark = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

async function runGrading(ai, setup, transcript, settings) {
  const { resp, model, notes } = await generate(
    ai,
    modelChain(settings.gradingModel, settings.fallbackModels),
    {
      contents: buildGradingPrompt(setup, transcript, settings),
      config: { temperature: settings.temperature, responseMimeType: 'application/json', responseSchema: GRADE_SCHEMA }
    },
    settings
  );
  return { raw: parseJson(resp), usage: usageOf(resp, model), notes };
}

function saveRun({ setup, transcript, raw, settings, scriptName, facultyTotal, usage, notes, mode, transcriptSource }) {
  const run = {
    id: `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    createdAt: new Date().toISOString(),
    scriptName: String(scriptName || '').trim() || 'Untitled script',
    setup,
    transcript,
    mode,
    transcriptSource,
    usage,
    callNotes: notes,
    facultyTotal: toMark(facultyTotal),
    facultySteps: [],
    ...finalizeResult(setup, transcript, raw, settings)
  };
  const runs = readJson(RUNS_FILE);
  runs.unshift(run);
  writeJson(RUNS_FILE, runs);
  return run;
}

// ---------- settings ----------

app.get('/api/settings', (req, res) => res.json({ settings: loadSettings(), defaults: DEFAULT_SETTINGS }));

app.put('/api/settings', (req, res) => {
  const settings = sanitizeSettings(req.body);
  writeJson(SETTINGS_FILE, settings);
  res.json({ settings });
});

app.get(
  '/api/models',
  route(async (req, res) => {
    const ai = clientFor(req);
    const models = [];
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    for await (const m of pager) {
      const actions = m.supportedActions || [];
      const id = String(m.name || '').replace(/^models\//, '');
      if (actions.length && !actions.includes('generateContent')) continue;
      if (!/gemini/i.test(id) || /embedding|tts|image|live|audio/i.test(id)) continue;
      models.push({ id, label: m.displayName || id });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ models });
  })
);

// ---------- step 1: evaluation materials ----------

app.get(
  '/api/templates/evaluation-template.xlsx',
  route(async (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="evaluation-template.xlsx"');
    res.send(await buildExcelTemplate());
  })
);

app.get('/api/templates/evaluation-template.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="evaluation-template.txt"');
  res.send('﻿' + buildTextTemplate());
});

app.post(
  '/api/import',
  upload.array('files'),
  route(async (req, res) => {
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'Choose at least one file.');
    const settings = loadSettings();
    const result = await importMaterials(files, {
      useAi: req.body.useAi !== 'false',
      organize: async (rawTexts, binaries) => {
        const ai = clientFor(req);
        const parts = binaries.length ? await filesToParts(ai, binaries) : [];
        const text = rawTexts.length ? `\n\nTEXT MATERIALS:\n\n${rawTexts.join('\n\n---\n\n')}` : '';
        const { resp, model, notes } = await generate(
          ai,
          modelChain(settings.organizeModel, settings.fallbackModels),
          {
            contents: [{ role: 'user', parts: [...parts, { text: settings.organizePrompt + text }] }],
            config: { temperature: settings.temperature, responseMimeType: 'application/json', responseSchema: SETUP_SCHEMA }
          },
          settings
        );
        if (notes.length) console.log('Import:', notes.join('; '));
        return { setup: parseJson(resp), usage: usageOf(resp, model) };
      }
    });
    res.json(result);
  })
);

// ---------- step 2: student scripts ----------

function transcriptCacheKey(files, settings) {
  const hash = crypto.createHash('sha256');
  files.forEach((f) => hash.update(f.buffer));
  hash.update(`\0${settings.ocrModel}\0${settings.ocrPrompt}`);
  return hash.digest('hex');
}

app.post(
  '/api/evaluate',
  upload.array('files'),
  route(async (req, res) => {
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'Attach the answer script (PDF or images).');
    const settings = loadSettings();
    const setup = parseSetupField(req.body.setup);
    requireUsableSetup(setup);
    const ai = clientFor(req);

    const cache = readJson(OCR_CACHE_FILE, {});
    const cacheKey = transcriptCacheKey(files, settings);
    const cached = settings.reuseTranscripts ? cache[cacheKey] : null;
    const ocrChain = modelChain(settings.ocrModel, settings.fallbackModels);
    const notes = [];
    let transcript;
    let raw;
    let ocrUsage = null;
    let gradingUsage;
    let mode = 'separate';

    if (cached) {
      transcript = cached.transcript;
    } else if (settings.combineOcrAndMarking) {
      mode = 'combined';
      const parts = await filesToParts(ai, files);
      const call = await generate(
        ai,
        ocrChain,
        {
          contents: [{ role: 'user', parts: [...parts, { text: buildCombinedPrompt(setup, settings) }] }],
          config: { temperature: settings.temperature, responseMimeType: 'application/json', responseSchema: COMBINED_SCHEMA }
        },
        settings
      );
      notes.push(...call.notes);
      raw = parseJson(call.resp);
      transcript = String(raw.transcript || '').trim();
      gradingUsage = usageOf(call.resp, call.model);
    } else {
      const parts = await filesToParts(ai, files);
      const call = await generate(
        ai,
        ocrChain,
        { contents: [{ role: 'user', parts: [...parts, { text: settings.ocrPrompt }] }], config: { temperature: settings.temperature } },
        settings
      );
      notes.push(...call.notes);
      transcript = (call.resp.text || '').trim();
      ocrUsage = usageOf(call.resp, call.model);
    }

    if (!transcript) throw new HttpError(422, 'The model returned no transcript. Try a clearer scan or another model.');
    if (!cached) {
      cache[cacheKey] = { transcript, createdAt: new Date().toISOString() };
      writeJson(OCR_CACHE_FILE, cache);
    }

    if (!raw) {
      const graded = await runGrading(ai, setup, transcript, settings);
      raw = graded.raw;
      gradingUsage = graded.usage;
      notes.push(...graded.notes);
    }

    res.json(
      saveRun({
        setup,
        transcript,
        raw,
        settings,
        scriptName: req.body.scriptName,
        facultyTotal: req.body.facultyTotal,
        usage: { ocr: ocrUsage, grading: gradingUsage },
        notes,
        mode,
        transcriptSource: cached ? 'saved transcript (no OCR call)' : mode === 'combined' ? 'OCR + marking in one call' : 'OCR'
      })
    );
  })
);

// Re-mark an edited transcript without running OCR again
app.post(
  '/api/grade',
  route(async (req, res) => {
    const { setup: rawSetup, transcript, scriptName, facultyTotal } = req.body || {};
    if (!String(transcript || '').trim()) throw new HttpError(400, 'There is no transcript to mark.');
    const settings = loadSettings();
    const setup = parseSetupField(rawSetup);
    requireUsableSetup(setup);
    const { raw, usage, notes } = await runGrading(clientFor(req), setup, transcript, settings);
    res.json(
      saveRun({
        setup,
        transcript,
        raw,
        settings,
        scriptName,
        facultyTotal,
        usage: { ocr: null, grading: usage },
        notes,
        mode: 'remark',
        transcriptSource: 'edited transcript'
      })
    );
  })
);

// ---------- saved questions ----------

app.get('/api/questions', (req, res) => res.json(readJson(QUESTIONS_FILE)));

app.post('/api/questions', (req, res) => {
  const setup = sanitizeSetup(req.body);
  if (!setup.code && !setup.questionText) {
    return res.status(400).json({ error: 'Give the question a code or text before saving.' });
  }
  const questions = readJson(QUESTIONS_FILE);
  setup.id = setup.id || `q-${Date.now()}`;
  const index = questions.findIndex((q) => q.id === setup.id);
  if (index === -1) questions.unshift(setup);
  else questions[index] = setup;
  writeJson(QUESTIONS_FILE, questions);
  res.json(setup);
});

app.delete('/api/questions/:id', (req, res) => {
  writeJson(
    QUESTIONS_FILE,
    readJson(QUESTIONS_FILE).filter((q) => q.id !== req.params.id)
  );
  res.json({ ok: true });
});

// ---------- run history ----------

app.get('/api/runs', (req, res) => res.json(readJson(RUNS_FILE)));

app.patch('/api/runs/:id', (req, res) => {
  const runs = readJson(RUNS_FILE);
  const run = runs.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  if ('facultyTotal' in req.body) run.facultyTotal = toMark(req.body.facultyTotal);
  if (Array.isArray(req.body.facultySteps)) run.facultySteps = req.body.facultySteps.map(toMark);
  if ('notes' in req.body) run.notes = String(req.body.notes || '');
  writeJson(RUNS_FILE, runs);
  res.json(run);
});

app.delete('/api/runs/:id', (req, res) => {
  writeJson(
    RUNS_FILE,
    readJson(RUNS_FILE).filter((r) => r.id !== req.params.id)
  );
  res.json({ ok: true });
});

app.get('/api/runs.csv', (req, res) => {
  const header = [
    'Date',
    'Script',
    'Question',
    'OCR model',
    'Marking model',
    'Transcript source',
    'AI marks',
    'Max marks',
    'Faculty marks',
    'Difference (AI - faculty)',
    'Step marks AI',
    'Step marks faculty',
    'Unclear words',
    'Flags',
    'OCR input tokens',
    'OCR output tokens',
    'Marking input tokens',
    'Marking output tokens',
    'Thinking tokens',
    'Rate-limit notes',
    'Notes'
  ];
  const rows = readJson(RUNS_FILE).map((r) => {
    const ocr = r.usage?.ocr || {};
    const grading = r.usage?.grading || {};
    const diff = r.facultyTotal === null ? '' : Math.round((r.totalAwarded - r.facultyTotal) * 100) / 100;
    return [
      r.createdAt,
      r.scriptName,
      r.setup?.code || r.setup?.questionText?.slice(0, 60),
      ocr.model || (r.mode === 'combined' ? grading.model : ''),
      grading.model || '',
      r.transcriptSource || '',
      r.totalAwarded,
      r.maxMarks,
      r.facultyTotal ?? '',
      diff,
      r.steps.map((s) => s.awardedMarks).join(' | '),
      (r.facultySteps || []).map((v) => v ?? '').join(' | '),
      findUnclear(r.transcript).length,
      r.flags.join(' ; '),
      ocr.inputTokens ?? '',
      ocr.outputTokens ?? '',
      grading.inputTokens ?? '',
      grading.outputTokens ?? '',
      (ocr.thinkingTokens || 0) + (grading.thinkingTokens || 0),
      (r.callNotes || []).join(' ; '),
      r.notes || ''
    ];
  });
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="evaluation-runs.csv"');
  res.send('﻿' + csv);
});

const server = app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`CA Evaluation Tester running at ${url}`);
  console.log(`Data is saved in ${DATA_DIR}`);
  if (process.argv.includes('--open')) {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  }
});
// Free-tier retries can make a single evaluation take several minutes
server.requestTimeout = 0;
