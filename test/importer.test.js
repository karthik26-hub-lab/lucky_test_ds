// Run with: npm test
import assert from 'node:assert/strict';
import { importMaterials, buildExcelTemplate, buildTextTemplate, parseTextTemplate, parseCsv, EXAMPLE_SETUP } from '../importer.js';
import { sanitizeSettings, modelChain, DEFAULT_SETTINGS, buildCombinedPrompt, buildGradingPrompt, sanitizeSetup } from '../lib.js';
import { generate } from '../gemini.js';

const file = (name, content, mimetype = 'application/octet-stream') => {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  return { originalname: name, buffer, size: buffer.length, mimetype };
};
const noAi = { useAi: false, organize: () => assert.fail('AI should not be called') };

// --- text template round trip ---
const fromText = parseTextTemplate(buildTextTemplate());
assert.equal(fromText.code, EXAMPLE_SETUP.code);
assert.equal(fromText.maxMarks, 4);
assert.equal(fromText.steps.length, 4);
assert.equal(fromText.steps[1].marks, 1);
assert.deepEqual(fromText.keywords, EXAMPLE_SETUP.keywords);
assert.equal(fromText.layout, EXAMPLE_SETUP.layout);
assert.equal(parseTextTemplate('Just some free text about Section 185.'), null, 'free text is not a template');

// --- Excel template round trip ---
const xlsx = await buildExcelTemplate();
const fromExcel = await importMaterials([file('template.xlsx', xlsx)], noAi);
assert.equal(fromExcel.setups[0].code, EXAMPLE_SETUP.code);
assert.equal(fromExcel.setups[0].questionText, EXAMPLE_SETUP.questionText);
assert.equal(fromExcel.setups[0].steps.length, 4);
assert.equal(fromExcel.setups[0].steps[0].keywords, 'Section 185, loan to director');
assert.equal(fromExcel.setups[0].keywords.split('\n').length, EXAMPLE_SETUP.keywords.length);
assert.equal(fromExcel.setups[0].granularity, 0.5);
assert.match(fromExcel.notes[0], /read 3 table/);

// --- CSV files, with a title row above the header ---
assert.deepEqual(parseCsv('a,"b, c"\r\n"x ""y""",z\n'), [['a', 'b, c'], ['x "y"', 'z']]);
const csv = await importMaterials(
  [
    file('steps.csv', 'Q1 marking\nStep,Marks,What earns the marks\nProvision,2,Cites Sec 185\nConclusion,2,States result\n'),
    file('kw.csv', 'Keyword\nSection 185\nloan | advance\n')
  ],
  noAi
);
assert.equal(csv.setups[0].steps.length, 2);
assert.equal(csv.setups[0].maxMarks, 4, 'max marks falls back to the step total');
assert.equal(csv.setups[0].keywords, 'Section 185\nloan | advance');

// --- free text without AI goes into the scheme box; with AI it is organized ---
const plain = await importMaterials([file('notes.txt', 'Suggested answer: the loan is void.')], noAi);
assert.match(plain.setups[0].scheme, /the loan is void/);
const organized = await importMaterials([file('notes.txt', 'Suggested answer: the loan is void.'), file('kw.csv', 'Keyword\nvoid\n')], {
  useAi: true,
  organize: async (texts, binaries) => {
    assert.equal(texts.length, 1);
    assert.equal(binaries.length, 0);
    return { document: { questions: [{ code: 'AI-Q', questionText: 'Q?', maxMarks: 5, steps: [], keywords: ['void', 'Section 185'], layout: '', scheme: 'void loan', instructions: '' }] } };
  }
});
assert.equal(organized.setups[0].code, 'AI-Q');
assert.equal(organized.setups[0].keywords, 'void\nSection 185', 'keywords are merged without duplicates');
const unsupported = await importMaterials([file('old.xls', 'x')], noAi);
assert.match(unsupported.notes[0], /save as \.xlsx/);

// --- settings ---
const s = sanitizeSettings({ requestsPerMinute: '12', lowConfidence: 5, ocrPrompt: '  ', combineOcrAndMarking: true });
assert.equal(s.requestsPerMinute, 12);
assert.equal(s.lowConfidence, DEFAULT_SETTINGS.lowConfidence, 'out-of-range values fall back to the default');
assert.equal(s.ocrPrompt, DEFAULT_SETTINGS.ocrPrompt, 'empty prompt falls back to the default');
assert.equal(s.combineOcrAndMarking, true);
assert.deepEqual(modelChain('a', 'b, a,\nc'), ['a', 'b', 'c']);
const custom = { ...DEFAULT_SETTINGS, markingInstructions: 'CUSTOM RULES' };
const setup = sanitizeSetup(EXAMPLE_SETUP);
assert.match(buildGradingPrompt(setup, 'answer', custom), /^CUSTOM RULES/);
assert.match(buildCombinedPrompt(setup, custom), /CUSTOM RULES[\s\S]*Step 4: Conclusion/);

// --- retries and model fallback ---
const fast = { ...DEFAULT_SETTINGS, requestsPerMinute: 0, maxRetries: 2, maxWaitSeconds: 5 };
const err = (status, message) => Object.assign(new Error(message), { status });
const fakeAi = (script) => {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async ({ model }) => {
        calls.push(model);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return { text: 'ok', model };
      }
    }
  };
};

let ai = fakeAi([err(429, '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"0.01s"}]}}'), 'ok']);
let out = await generate(ai, ['m1', 'm2'], {}, fast);
assert.deepEqual(ai.calls, ['m1', 'm1'], 'per-minute limit: waits and retries the same model');
assert.equal(out.model, 'm1');

ai = fakeAi([err(429, 'RESOURCE_EXHAUSTED quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier'), 'ok']);
out = await generate(ai, ['m1', 'm2'], {}, fast);
assert.deepEqual(ai.calls, ['m1', 'm2'], 'daily quota: moves to the fallback model');
assert.match(out.notes[0], /daily quota/);

ai = fakeAi([err(404, 'models/nope is not found for API version v1beta'), 'ok']);
out = await generate(ai, ['nope', 'm2'], {}, fast);
assert.equal(out.model, 'm2', 'missing model: moves to the fallback model');

ai = fakeAi([err(429, 'RESOURCE_EXHAUSTED "retryDelay": "40s"')]);
await assert.rejects(generate(ai, ['m1'], {}, fast), /No model could complete/, 'a wait longer than the maximum gives up with advice');

ai = fakeAi([err(400, 'Invalid argument')]);
await assert.rejects(generate(ai, ['m1', 'm2'], {}, fast), /Invalid argument/, 'other errors are not retried');
assert.deepEqual(ai.calls, ['m1']);

console.log('All importer, settings and retry tests passed.');
