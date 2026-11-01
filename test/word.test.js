// Run with: npm test
// Builds a real .docx in memory, with tables, an equation and a picture, and runs it through the
// importer. The AI step is replaced by a stand-in, so this checks what the AI would be sent.
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { importMaterials, readDocx, flattenEquations, htmlToMarkdown, parseLabelledDocument, parseMarks, parseTextTemplate } from '../importer.js';
import { buildGradingPrompt, buildSegmentPrompt, extractFigures, finalizeResult, normalize, sanitizeSetup, sliceAnswers, DEFAULT_SETTINGS } from '../lib.js';

const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text, extra = '') => `<w:tc><w:tcPr>${extra}</w:tcPr>${para(text)}</w:tc>`;
const row = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;

const EQUATION = `<w:p><m:oMathPara><m:oMath>
  <m:r><m:t>Depreciation=</m:t></m:r>
  <m:f><m:num><m:r><m:t>Cost-Scrap</m:t></m:r></m:num><m:den><m:r><m:t>Life</m:t></m:r></m:den></m:f>
</m:oMath></m:oMathPara></w:p>`;

const PICTURE = `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

const BODY = [
  para('Topic: Depreciation'),
  para('Q1. A machine cost 5,00,000 with scrap value of 50,000 and a life of 5 years. Compute annual depreciation. (4 marks)'),
  EQUATION,
  `<w:tbl>${row(cell('Working'), cell('Amount'), cell('Marks'))}${row(cell('Cost less scrap'), cell('4,50,000'), cell('2'))}${row(cell('Annual depreciation'), cell('90,000'), cell('2'))}</w:tbl>`,
  PICTURE,
  para('Q2. Explain Section 185 of the Companies Act, 2013. (2 marks)')
].join('');

async function buildDocx(body = BODY) {
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`);
  zip.file('word/media/image1.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const file = (name, buffer) => ({ originalname: name, buffer, size: buffer.length, mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

// --- a real Word file keeps its tables, equations and pictures ---
const docx = await buildDocx();
const doc = await readDocx(docx, 'paper.docx');
assert.match(doc.markdown, /\| Working \| Amount \| Marks \|\n\| --- \| --- \| --- \|\n\| Cost less scrap \| 4,50,000 \| 2 \|/, 'table stays a table with its figures in their columns');
assert.match(doc.markdown, /Depreciation=\(Cost-Scrap\)\/\(Life\)/, 'equation is spelled out, not dropped');
assert.match(doc.markdown, /\[Embedded image 1\]/, 'picture position is marked');
assert.equal(doc.images.length, 1);
assert.equal(doc.images[0].mimetype, 'image/png');
assert.equal(doc.equations, 1);
assert.equal(doc.unreadable, 0);

assert.match(flattenEquations('<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>').xml, /x\^\(2\)/);
assert.match(htmlToMarkdown('<table><tr><td colspan="2">Head</td></tr><tr><td rowspan="2">A</td><td>1</td></tr><tr><td>2</td></tr></table>'), /\| Head \|  \|[\s\S]*\| A \| 1 \|\n\|  \| 2 \|/, 'merged cells keep later cells in the right column');
assert.equal(htmlToMarkdown('<p>a &amp; b &lt; c</p>'), 'a & b < c');

const oldEquation = await readDocx(await buildDocx(`${para('Q1')}<w:p><w:r><w:object></w:object></w:r></w:p>`), 'old.docx');
assert.equal(oldEquation.unreadable, 1, 'old-style equations are reported, not silently lost');

// --- one Word file becomes several questions ---
let sentTexts;
let sentBinaries;
const detected = {
  paperTitle: 'Accounts Test 1',
  questions: [
    {
      code: 'Q1',
      topic: 'Depreciation',
      questionType: 'numerical',
      questionText: 'A machine cost 5,00,000 with scrap value of 50,000 and a life of 5 years.',
      maxMarks: 4,
      steps: [
        { title: 'Cost less scrap', marks: 2, expected: '4,50,000', keywords: '', dependsOnEarlierFigure: false },
        { title: 'Annual depreciation', marks: 2, expected: '90,000', keywords: '', dependsOnEarlierFigure: true }
      ],
      keywords: [],
      layout: '',
      scheme: '',
      instructions: ''
    },
    { code: 'Q2', topic: '', questionType: 'theory', questionText: 'Explain Section 185 of the Companies Act, 2013.', maxMarks: 2, steps: [], keywords: ['Section 185'], layout: '', scheme: '', instructions: '' }
  ]
};
const organize = (document) => async (texts, binaries) => {
  sentTexts = texts;
  sentBinaries = binaries;
  return { document };
};

const imported = await importMaterials([file('paper.docx', docx)], { useAi: true, organize: organize(detected) });
assert.equal(imported.setups.length, 2, 'every detected question is returned');
assert.equal(imported.paperTitle, 'Accounts Test 1');
assert.equal(imported.setups[0].topic, 'Depreciation');
assert.equal(imported.setups[0].questionType, 'numerical');
assert.equal(imported.setups[0].steps[1].dependsOnEarlierFigure, true);
assert.equal(imported.setups[1].keywords, 'Section 185');
assert.match(sentTexts[0], /\| Annual depreciation \| 90,000 \| 2 \|/, 'the AI receives the table');
assert.equal(sentBinaries.length, 1, 'the AI receives the picture');
assert.match(imported.notes[0], /Detected 2 questions/);
assert.ok(imported.notes.some((n) => /Q2: no stepwise marks found/.test(n)), 'missing steps are pointed out');

// --- plain checks catch what the AI got wrong (a document without pictures) ---
const noPicture = await buildDocx(BODY.replace(PICTURE, ''));
const wrong = await importMaterials([file('paper.docx', noPicture)], {
  useAi: true,
  organize: organize({
    questions: [{ ...detected.questions[0], maxMarks: 5, steps: [{ title: 'Annual depreciation', marks: 2, expected: '95,000', keywords: '' }] }]
  })
});
assert.ok(wrong.notes.some((n) => /figures not found in the document.*95000/.test(n)), 'an invented figure is reported');
assert.ok(wrong.notes.some((n) => /steps add up to 2, but the question is worth 5/.test(n)), 'wrong totals are reported');

const quarters = await importMaterials([file('paper.docx', noPicture)], {
  useAi: true,
  organize: organize({ questions: [{ ...detected.questions[0], steps: [{ title: 'A', marks: 0.25, expected: '', keywords: '' }] }] })
});
assert.equal(quarters.setups[0].granularity, 0.25, 'quarter marks in the scheme set the increment');

// --- documents that only look like the template go to the AI ---
assert.equal(parseTextTemplate('Question: one\nKeywords: a\nQuestion: two\nSteps:\nProvision | 1\n'), null, 'two questions are not the template');
assert.equal(parseTextTemplate('Question: one\nMarking scheme: see below'), null, 'a template needs step rows');

// --- splitting a script by question ---
const script = ['--- Page 1 ---', 'Q2 Section 185 prohibits loans.', 'Rough note', '--- Page 2 ---', 'Q1 4,50,000', 'Depreciation = 90,000', 'Q2 continued: exemptions apply.'].join('\n');
const setups = [sanitizeSetup({ code: 'Q1', questionText: 'Dep' }), sanitizeSetup({ code: 'Q2', questionText: 'Law' }), sanitizeSetup({ code: 'Q3', questionText: 'Tax' })];
assert.match(buildSegmentPrompt(setups, script), /L5: Q1 4,50,000/);
const split = sliceAnswers(script, setups, {
  answers: [
    { code: 'Q1', attempted: true, ranges: [{ startLine: 5, endLine: 6 }] },
    { code: 'q2', attempted: true, ranges: [{ startLine: 2, endLine: 2 }, { startLine: 7, endLine: 99 }] },
    { code: 'Q3', attempted: false, ranges: [] }
  ]
});
assert.equal(split.answers[0].text, 'Q1 4,50,000\nDepreciation = 90,000');
assert.equal(split.answers[1].text, 'Q2 Section 185 prohibits loans.\nQ2 continued: exemptions apply.', 'split answers are joined, out-of-range lines ignored');
assert.equal(split.answers[2].attempted, false);
assert.equal(split.unassignedLines, 1, 'the rough note is counted, page markers are not');

// --- numerical marking ---
assert.deepEqual(extractFigures('₹5,00,000 and 500000, Sec 12, 90,000.50, 45.0'), ['500000', '90000.50']);
assert.equal(normalize('₹5,00,000'), normalize('5,00,000'));

const numeric = sanitizeSetup(detected.questions[0]);
const theory = sanitizeSetup(detected.questions[1]);
assert.match(buildGradingPrompt(numeric, 'x'), /COMPUTATION/);
assert.doesNotMatch(buildGradingPrompt(theory, 'x'), /COMPUTATION/);
assert.match(buildGradingPrompt(numeric, 'x'), /Uses a figure from an earlier step/);
assert.match(buildGradingPrompt(numeric, 'x'), /TOPIC: Depreciation/);

const mark = (awarded, ownFigure, answer) =>
  finalizeResult(
    numeric,
    answer,
    {
      steps: [
        { awardedMarks: 2, evidenceQuote: '', reasoning: '', confidence: 0.9, ownFigureApplied: false },
        { awardedMarks: awarded, evidenceQuote: '', reasoning: '', confidence: 0.9, ownFigureApplied: ownFigure }
      ]
    },
    DEFAULT_SETTINGS
  );
const figureFlag = /Step 2: full marks, but none of the expected figures/;
assert.match(mark(2, false, '4,50,000 then 80,000').flags.join('\n'), figureFlag, 'full marks with the wrong figure is flagged');
assert.doesNotMatch(mark(2, true, '4,00,000 then 80,000').flags.join('\n'), figureFlag, 'own-figure credit explains a different figure');
assert.doesNotMatch(mark(2, false, '4,50,000 then ₹90,000').flags.join('\n'), figureFlag, 'matching figures are fine in any format');
assert.equal(mark(2, true, 'x').steps[1].ownFigureApplied, true);

const skipped = finalizeResult(numeric, '', {}, DEFAULT_SETTINGS, { notAttempted: true });
assert.equal(skipped.totalAwarded, 0);
assert.equal(skipped.maxMarks, 4);
assert.deepEqual(skipped.flags, ['No answer to this question was found in the script. Check the full transcript.']);

// --- documents labelled QUESTION: / STEPS: / KEYWORDS: are read without AI ---
for (const [text, value] of [['½ Mark', 0.5], ['1½ Marks', 1.5], ['1 1/2 marks', 1.5], ['0.5 M', 0.5], ['5 MARKS', 5], ['none', null]]) {
  assert.equal(parseMarks(text), value, text);
}
const labelledXml = [
  para('QUESTION:'),
  para('A trader gives you the following:'),
  `<w:tbl>${row(cell('Particulars'), cell('Amount'))}${row(cell('Net profit'), cell('₹8,00,000'))}${row(cell('Donation debited'), cell('₹25,000'))}</w:tbl>`,
  para('Required: Compute income.'),
  para('Total Marks: 2'),
  para('STEPS:'),
  para('Step 1: Start with net profit (½ Mark)'),
  para('Net profit = ₹8,00,000'),
  para('Step 2: Add back donation (½ Mark)'),
  para('Donation – ₹25,000'),
  para('Step 3: Prepare the final computation (1 Mark)'),
  `<w:tbl>${row(cell('Particulars'), cell('Amount'))}${row(cell('Income'), cell('₹8,25,000'))}</w:tbl>`,
  para('KEYWORDS:'),
  para('Donation: Disallowed under Section 37.'),
  para('MARKS DISTRIBUTION:'),
  `<w:tbl>${row(cell('Particulars'), cell('Marks'))}${row(cell('Step 1'), cell('0.5'))}${row(cell('Step 2'), cell('0.5'))}${row(cell('Step 3'), cell('1'))}${row(cell('TOTAL'), cell('2 MARKS'))}</w:tbl>`,
  para('FINAL ANSWER: ₹8,25,000')
].join('');
const noAi = { useAi: true, organize: () => assert.fail('a labelled document must not need the AI') };
const labelledDocx = await buildDocx(labelledXml);
const fromLabelled = await importMaterials([file('PGBP Test.docx', labelledDocx)], noAi);
assert.equal(fromLabelled.setups.length, 1);
const lq = fromLabelled.setups[0];
assert.equal(lq.code, 'PGBP Test', 'a single unnumbered question is named after its file');
assert.equal(lq.questionType, 'numerical');
assert.equal(lq.maxMarks, 2);
assert.equal(lq.granularity, 0.5);
assert.deepEqual(lq.steps.map((st) => [st.title, st.marks]), [['Start with net profit', 0.5], ['Add back donation', 0.5], ['Prepare the final computation', 1]]);
assert.match(lq.questionText, /\| Donation debited \| ₹25,000 \|/);
assert.doesNotMatch(lq.questionText, /Total Marks/);
assert.equal(lq.steps[0].expected, 'Net profit = ₹8,00,000');
assert.match(lq.steps[2].expected, /\| Income \| ₹8,25,000 \|/);
assert.equal(lq.steps[2].dependsOnEarlierFigure, true);
assert.equal(lq.steps[0].dependsOnEarlierFigure, false);
assert.equal(lq.keywords, 'Donation: Disallowed under Section 37.');
assert.match(lq.scheme, /Final answer: ₹8,25,000/);
assert.match(fromLabelled.notes[0], /read exactly, without AI: 1 question\(s\), 3 steps, 2 marks/);
assert.equal(fromLabelled.notes.length, 1, 'nothing to warn about');

// Several files, or several questions in one file, make a paper
const twoFiles = await importMaterials([file('Q-A.docx', labelledDocx), file('Q-B.docx', labelledDocx)], noAi);
assert.deepEqual(twoFiles.setups.map((q) => q.code), ['Q-A', 'Q-B']);
const body = 'STEPS:\nStep 1: Provision (1 Mark)\nSection 185.\nKEYWORDS:\nSection 185';
const many = parseLabelledDocument(`QUESTION 1(a):\nExplain one.\nTotal Marks: 1\n${body}\nQUESTION 2:\nExplain two.\nTotal Marks: 1\n${body}`);
assert.deepEqual(many.map((q) => q.code), ['Q1(a)', 'Q2']);
assert.equal(many[0].questionType, 'theory');
assert.equal(many[0].steps[0].dependsOnEarlierFigure, false);

// Marks only in the marks table are used; wrong totals are reported
const tableMarks = parseLabelledDocument('QUESTION:\nQ\nSTEPS:\nStep 1: A\nx\nStep 2: B\ny\nMARKS DISTRIBUTION:\n| P | Marks |\n| --- | --- |\n| A | 1½ |\n| B | 2 |\n| Total | 3.5 |');
assert.deepEqual(tableMarks[0].steps.map((st) => st.marks), [1.5, 2]);
assert.equal(tableMarks[0].maxMarks, 3.5);
const wrongTotal = await importMaterials([file('t.txt', Buffer.from('QUESTION:\nQ\nTotal Marks: 5\nSTEPS:\nStep 1: A (1 Mark)\nx\nMARKS DISTRIBUTION:\n| P | Marks |\n| --- | --- |\n| A | 1 |\n| Total | 4 |'))], noAi);
assert.ok(wrongTotal.notes.some((n) => /steps add up to 1, but the question is worth 5/.test(n)));
assert.ok(wrongTotal.notes.some((n) => /marks table totals 4, but the question says 5/.test(n)));

// Anything that doesn't clearly fit goes to the AI rather than being misread
assert.equal(parseLabelledDocument('Some notes about a question.'), null);
assert.equal(parseLabelledDocument('QUESTION:\nQ\nSTEPS:\nDo the working.'), null, 'no recognisable steps');
assert.equal(parseLabelledDocument('QUESTION:\nQ\nSTEPS:\nStep 1: A\nx'), null, 'steps without marks');
assert.equal(parseLabelledDocument('QUESTION 1:\nQ\nSTEPS:\nStep 1: A (1 Mark)\nQUESTION 2:\nno steps'), null, 'one unclear question sends the document to the AI');

// A keyword with its explanation matches on the keyword alone
const keywordRun = (setup, aiPresent, answer) =>
  finalizeResult(sanitizeSetup(setup), answer, { steps: [], keywords: [{ keyword: setup.keywords, present: aiPresent, matchedText: '' }] }, DEFAULT_SETTINGS);
const kwSetup = { questionType: 'numerical', questionText: 'q', keywords: 'Income-tax: Disallowed under Section 40(a)(ii).' };
assert.equal(keywordRun(kwSetup, true, 'Add income tax 50,000').keywords[0].exactMatch, true);
assert.doesNotMatch(keywordRun({ ...kwSetup, keywords: 'Bank FD Interest: Deducted.' }, true, 'Less FD int. 40,000').flags.join(), /disagree/, 'an abbreviation in a computation is not flagged');
assert.match(keywordRun(kwSetup, false, 'Add income tax 50,000').flags.join(), /disagree/, 'text found but the AI says absent is flagged');
assert.match(keywordRun({ ...kwSetup, questionType: 'theory' }, true, 'nothing relevant').flags.join(), /disagree/, 'theory answers keep the strict check');

console.log('All Word, multi-question and numerical tests passed.');
