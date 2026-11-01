// Reads evaluation materials (question, steps, ICAI keywords, layout, marking scheme) from
// Excel, CSV, plain text and Word files, and builds the downloadable fill-in templates.
// Files that follow a template are parsed without AI; anything else is handed to `organize`,
// which can find any number of questions in a single document.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import path from 'path';
import { extractFigures, normalize, sanitizeSetup, splitLines } from './lib.js';

// Sample content used only to fill the downloadable templates, so the format is obvious.
export const EXAMPLE_SETUP = {
  code: 'Law Q1(a)',
  questionText:
    'ABC Private Limited proposes to give a loan of ₹10 lakh to Mr. X, a director of the company, at 6% interest p.a. ' +
    'Examine, with reference to the provisions of the Companies Act, 2013, whether the company can give this loan.',
  maxMarks: 4,
  granularity: 0.5,
  steps: [
    {
      title: 'Relevant provision: Section 185',
      marks: 1,
      expected: 'States that a company shall not, directly or indirectly, advance any loan to any of its directors.',
      keywords: 'Section 185, loan to director'
    },
    {
      title: 'Exemption for private companies',
      marks: 1,
      expected:
        'Section 185 does not apply to a private company where no body corporate has invested in its share capital, ' +
        'borrowings are less than twice its paid-up share capital or ₹50 crore (whichever is lower), and there is no subsisting default.',
      keywords: 'private company, exemption, body corporate'
    },
    { title: 'Application to the facts', marks: 1, expected: 'Applies the provision and the exemption conditions to ABC and Mr. X.', keywords: '' },
    { title: 'Conclusion', marks: 1, expected: 'Loan is prohibited unless ABC meets all the exemption conditions.', keywords: '' }
  ],
  keywords: ['Section 185', 'director', 'loan | advance', 'private company', 'exemption | exempt | not apply', 'body corporate'],
  layout: 'Provision → Facts → Analysis → Conclusion',
  scheme: 'Paste the ICAI suggested answer / marking scheme here.',
  instructions: ''
};

const FIELD_ALIASES = {
  code: ['question code', 'code', 'question no', 'question number', 'q no'],
  questionText: ['question', 'question text'],
  maxMarks: ['max marks', 'maximum marks', 'total marks'],
  granularity: ['mark increment', 'increment', 'mark in steps of', 'marking increment'],
  layout: ['layout', 'expected layout', 'structure', 'answer layout', 'expected layout structure'],
  scheme: ['marking scheme', 'suggested answer', 'model answer', 'icai suggested answer', 'scheme'],
  instructions: ['instructions', 'extra instructions', 'examiner instructions'],
  keywords: ['keywords', 'icai keywords']
};

const labelKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
const fieldFor = (label) => Object.keys(FIELD_ALIASES).find((f) => FIELD_ALIASES[f].includes(labelKey(label)));

function emptySetup() {
  return { code: '', topic: '', questionType: '', questionText: '', maxMarks: 0, granularity: 0, steps: [], keywords: [], layout: '', scheme: '', instructions: '' };
}

function assignField(into, field, value) {
  const text = String(value ?? '').trim();
  if (!text) return;
  if (field === 'keywords') into.keywords.push(...splitLines(text));
  else if (field === 'maxMarks' || field === 'granularity') into[field] = Number(text) || into[field];
  else if (field === 'code' || field === 'questionText') into[field] = into[field] || text;
  else into[field] = into[field] ? `${into[field]}\n\n${text}` : text;
}

// Recognizes a table by its header row. Returns true when the table was used.
function readTable(rows, into) {
  const header = (rows[0] || []).map(labelKey);
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const body = rows.slice(1);

  const fieldCol = col('field');
  const valueCol = col('value');
  if (fieldCol >= 0 && valueCol >= 0) {
    body.forEach((r) => {
      const field = fieldFor(r[fieldCol]);
      if (field) assignField(into, field, r[valueCol]);
    });
    return true;
  }

  const titleCol = col('step', 'step title', 'title', 'criteria', 'criterion', 'step description');
  const marksCol = col('marks', 'max marks', 'mark');
  if (titleCol >= 0 && marksCol >= 0) {
    const expectedCol = col('what earns the marks', 'what earns marks', 'expected', 'expected answer', 'points', 'description');
    const stepKwCol = col('step keywords', 'keywords');
    body.forEach((r) => {
      const title = String(r[titleCol] ?? '').trim();
      if (!title) return;
      into.steps.push({
        title,
        marks: Number(r[marksCol]) || 0,
        expected: expectedCol >= 0 ? String(r[expectedCol] ?? '').trim() : '',
        keywords: stepKwCol >= 0 ? String(r[stepKwCol] ?? '').trim() : ''
      });
    });
    return true;
  }

  const kwCol = col('keyword', 'keywords', 'icai keyword', 'icai keywords');
  if (kwCol >= 0) {
    body.forEach((r) => {
      const kw = String(r[kwCol] ?? '').trim();
      if (kw) into.keywords.push(kw);
    });
    return true;
  }
  return false;
}

// Title rows above the header are common, so try the first few rows as the header.
function readTableWithOffset(rows, into) {
  for (let start = 0; start < Math.min(5, rows.length); start++) {
    if (readTable(rows.slice(start), into)) return true;
  }
  return false;
}

const tableToText = (rows) => rows.map((r) => r.filter((c) => String(c ?? '').trim()).join(' | ')).filter(Boolean).join('\n');

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const TEXT_HEADINGS = [
  ['question code', 'code'],
  ['code', 'code'],
  ['max marks', 'maxMarks'],
  ['maximum marks', 'maxMarks'],
  ['mark increment', 'granularity'],
  ['question', 'questionText'],
  ['steps', 'steps'],
  ['icai keywords', 'keywords'],
  ['keywords', 'keywords'],
  ['expected layout', 'layout'],
  ['layout', 'layout'],
  ['marking scheme', 'scheme'],
  ['suggested answer', 'scheme'],
  ['instructions', 'instructions']
];
const HEADING_RX = new RegExp(`^\\s*(${TEXT_HEADINGS.map(([h]) => h).join('|')})\\s*:\\s*(.*)$`, 'i');

// Parses the plain-text template ("QUESTION:", "STEPS:", "KEYWORDS:" ...). Returns null unless it
// is clearly the template: one question with valid step rows. A document that only happens to use
// a few of these headings, or holds several questions, must go to the AI instead of being misread.
export function parseTextTemplate(text) {
  const sections = {};
  const counts = {};
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = HEADING_RX.exec(line);
    if (m) {
      current = TEXT_HEADINGS.find(([h]) => h === m[1].toLowerCase())[1];
      sections[current] = sections[current] || [];
      counts[current] = (counts[current] || 0) + 1;
      if (m[2].trim()) sections[current].push(m[2]);
    } else if (current) {
      sections[current].push(line);
    }
  }
  if (Object.keys(sections).length < 2 || counts.questionText > 1 || counts.code > 1) return null;

  const into = emptySetup();
  for (const [field, lines] of Object.entries(sections)) {
    if (field === 'steps') {
      lines.forEach((line) => {
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2 || !parts[0] || !Number.isFinite(Number(parts[1]))) return;
        into.steps.push({ title: parts[0], marks: Number(parts[1]), expected: parts[2] || '', keywords: parts[3] || '' });
      });
    } else {
      assignField(into, field, lines.join('\n').trim());
    }
  }
  if (!into.steps.length) return null;
  return into;
}

async function readWorkbook(buffer, into, rawTexts, name) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  let used = 0;
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let i = 1; i <= row.cellCount; i++) cells.push(row.getCell(i).text);
      rows.push(cells);
    });
    if (!rows.length || /^help$/i.test(sheet.name)) return;
    if (readTableWithOffset(rows, into)) used += 1;
    else rawTexts.push(`From ${name}, sheet "${sheet.name}":\n${tableToText(rows)}`);
  });
  return used;
}

// ---------- Word documents ----------

// mammoth drops Word equations, so rewrite each one as a plain text run first.
// a/b fractions, powers, subscripts and roots are spelled out, innermost first.
export function flattenEquations(xml) {
  const text = (fragment) => (fragment.match(/<m:t(?:\s[^>]*)?>([^<]*)<\/m:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
  const part = (inner, tag) => text((inner.match(new RegExp(`<m:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</m:${tag}>`)) || [])[1] || '');
  const STRUCTURE = /<m:(f|sSup|sSub|rad)>((?:(?!<m:(?:f|sSup|sSub|rad)>)[\s\S])*?)<\/m:\1>/;
  let out = String(xml);
  for (let m = STRUCTURE.exec(out); m; m = STRUCTURE.exec(out)) {
    const [whole, kind, inner] = m;
    const plain =
      kind === 'f'
        ? `(${part(inner, 'num')})/(${part(inner, 'den')})`
        : kind === 'sSup'
        ? `${part(inner, 'e')}^(${part(inner, 'sup')})`
        : kind === 'sSub'
        ? `${part(inner, 'e')}_${part(inner, 'sub')}`
        : `sqrt(${part(inner, 'e')})`;
    out = out.replace(whole, () => `<m:r><m:t>${plain}</m:t></m:r>`);
  }
  let count = 0;
  out = out
    .replace(/<\/?m:oMathPara(?:\s[^>]*)?>|<m:oMathParaPr>[\s\S]*?<\/m:oMathParaPr>/g, '')
    .replace(/<m:oMath(?:\s[^>]*)?>([\s\S]*?)<\/m:oMath>/g, (_, inner) => {
      count += 1;
      return `<w:r><w:t xml:space="preserve"> ${text(inner)} </w:t></w:r>`;
    });
  return { xml: out, count };
}

function tableToMarkdown(tableHtml) {
  const grid = [];
  const carried = []; // cells still covered by a rowspan from an earlier row
  for (const [row] of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const cells = [];
    let col = 0;
    const skipCarried = () => {
      while (carried[col] > 0) {
        carried[col] -= 1;
        cells[col++] = '';
      }
    };
    for (const [, , attrs, inner] of row.matchAll(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g)) {
      skipCarried();
      const value = inner.replace(/<[^>]+>/g, ' ').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
      const colspan = Number((attrs.match(/colspan="(\d+)"/) || [])[1]) || 1;
      const rowspan = Number((attrs.match(/rowspan="(\d+)"/) || [])[1]) || 1;
      for (let i = 0; i < colspan; i++) {
        if (rowspan > 1) carried[col] = rowspan - 1;
        cells[col++] = i === 0 ? value : '';
      }
    }
    skipCarried();
    grid.push(cells);
  }
  if (!grid.length) return '';
  const width = Math.max(...grid.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
  return `\n\n${[line(grid[0]), line(Array(width).fill('---')), ...grid.slice(1).map(line)].join('\n')}\n\n`;
}

// Keeps what matters for marking: tables stay tables, so figures stay in their rows and columns.
export function htmlToMarkdown(html) {
  let out = String(html).replace(/<img[^>]*src="doc-image:(\d+)"[^>]*>/g, '[Embedded image $1]');
  const INNERMOST_TABLE = /<table[^>]*>(?:(?!<table)[\s\S])*?<\/table>/;
  for (let m = INNERMOST_TABLE.exec(out); m; m = INNERMOST_TABLE.exec(out)) {
    out = out.replace(m[0], () => tableToMarkdown(m[0]));
  }
  return out
    .replace(/<h([1-6])[^>]*>/g, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|h[1-6]|ul|ol)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const AI_READABLE_IMAGE = /^image\/(png|jpeg|webp)$/;

// Returns the document as Markdown, plus its pictures as files the AI can look at, and anything
// that could not be read. imageCounter numbers pictures across all uploaded documents.
export async function readDocx(buffer, name, imageCounter = { next: 1 }) {
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('this is not a valid Word document');
  const original = await documentFile.async('string');
  const { xml, count: equations } = flattenEquations(original);
  zip.file('word/document.xml', xml);
  const prepared = await zip.generateAsync({ type: 'nodebuffer' });

  const images = [];
  let unreadableImages = 0;
  const { value: html } = await mammoth.convertToHtml(
    { buffer: prepared },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        if (!AI_READABLE_IMAGE.test(image.contentType)) {
          unreadableImages += 1;
          return { src: 'unreadable' };
        }
        const data = await image.readAsBuffer();
        const number = imageCounter.next++;
        images.push({ originalname: `Embedded image ${number} (${name})`, buffer: data, size: data.length, mimetype: image.contentType });
        return { src: `doc-image:${number}` };
      })
    }
  );
  return {
    markdown: htmlToMarkdown(html),
    images,
    equations,
    // Old-style equations are stored as embedded objects, which cannot be read from the file
    unreadable: unreadableImages + (original.match(/<w:object[\s>]/g) || []).length
  };
}

// ---------- labelled documents ----------

// "½ Mark", "1½ Marks", "1 1/2 marks", "0.5 M", "5 MARKS"
export function parseMarks(text) {
  const clean = String(text ?? '').trim();
  const fraction = { '½': 0.5, '¼': 0.25, '¾': 0.75, '1/2': 0.5, '1/4': 0.25, '3/4': 0.75 };
  const mixed = clean.match(/^(\d+)?\s*(½|¼|¾|1\/2|1\/4|3\/4)/);
  if (mixed) return Number(mixed[1] || 0) + fraction[mixed[2]];
  const plain = clean.match(/^\d+(?:\.\d+)?/);
  return plain ? Number(plain[0]) : null;
}

const SECTION_RX = /^(?:#+\s*)?(topic|chapter|question(?:\s+(?:no\.?\s*)?[\w().-]+)?|steps?|marking scheme|keywords?|icai keywords?|marks? distribution|final answer|expected layout|layout|instructions)\s*:\s*(.*)$/i;
const STEP_RX = /^(?:#+\s*)?(?:[-*]\s*)?step\s*\d+\s*[:.\-–—]\s*(.+)$/i;
const STEP_MARKS_RX = /\s*(?:[([]\s*([^)\]]*?\b(?:marks?|m))\s*[)\]]|[-–—]\s*([\d½¼¾./ ]+\s*(?:marks?|m)))\s*$/i;
const TOTAL_MARKS_RX = /^(?:total|max(?:imum)?)\s*marks?\s*[:\-–—]\s*(.+)$/i;
const tableCells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const isTableLine = (line) => line.trim().startsWith('|');
const isSeparator = (line) => /^\|[\s|:-]+\|$/.test(line.trim());
// Money or a calculation, as opposed to references like "Section 185" or "Act, 2013"
const hasAmount = (text) => /₹|\brs\.?\s*\d|\d,\d{2,3}\b|\d\s*(?:lakhs?|crores?)\b|=\s*\(?\d/i.test(text);

function sectionKind(label) {
  const key = label.toLowerCase();
  if (key.startsWith('question')) return 'question';
  if (key === 'topic' || key === 'chapter') return 'topic';
  if (key.startsWith('step')) return 'steps';
  if (key.includes('keyword')) return 'keywords';
  if (key.includes('distribution')) return 'distribution';
  if (key.includes('final')) return 'finalAnswer';
  if (key.includes('layout')) return 'layout';
  if (key.includes('scheme')) return 'scheme';
  return 'instructions';
}

function parseLabelledQuestion(sections, label) {
  const steps = [];
  for (const line of sections.steps || []) {
    const heading = line.match(STEP_RX);
    if (heading) {
      const marks = heading[1].match(STEP_MARKS_RX);
      steps.push({
        title: (marks ? heading[1].slice(0, marks.index) : heading[1]).trim(),
        marks: marks ? parseMarks(marks[1] || marks[2]) : null,
        body: []
      });
    } else if (steps.length) {
      steps[steps.length - 1].body.push(line);
    }
  }
  if (!steps.length || !(sections.question || []).some((l) => l.trim())) return null;

  // Marks left out of a step heading can come from the marks table, which lists them in step order
  const distribution = (sections.distribution || []).filter((l) => isTableLine(l) && !isSeparator(l)).slice(1).map(tableCells);
  const distributed = distribution.filter((r) => !/^total/i.test(r[0] || '')).map((r) => parseMarks(r[r.length - 1]));
  if (distributed.length === steps.length) {
    steps.forEach((st, i) => {
      if (st.marks === null) st.marks = distributed[i];
    });
  }
  if (steps.some((st) => st.marks === null)) return null;

  const questionLines = [];
  let maxMarks = 0;
  for (const line of sections.question) {
    const total = line.trim().match(TOTAL_MARKS_RX);
    if (total) maxMarks = parseMarks(total[1]) || 0;
    else questionLines.push(line);
  }
  const tableTotal = distribution.find((r) => /^total/i.test(r[0] || ''));
  const distributionTotal = tableTotal ? parseMarks(tableTotal[tableTotal.length - 1]) : null;

  const expected = (st) => st.body.join('\n').replace(/\n{2,}/g, '\n').trim();
  const finalAnswer = (sections.finalAnswer || []).join('\n').trim();
  const allWorking = [...steps.map(expected), finalAnswer].join(' ');
  const stepsWithAmounts = steps.filter((st) => hasAmount(expected(st))).length;
  const scheme = steps.map((st) => `${st.title} (${st.marks} marks)\n${expected(st)}`.trim()).join('\n\n');

  const setup = {
    ...emptySetup(),
    code: label,
    topic: (sections.topic || []).join(' ').trim(),
    questionType: stepsWithAmounts * 2 >= steps.length || hasAmount(finalAnswer) ? 'numerical' : stepsWithAmounts ? 'mixed' : 'theory',
    questionText: questionLines.join('\n').trim(),
    maxMarks: maxMarks || distributionTotal || 0,
    steps: steps.map((st) => ({
      title: st.title,
      marks: st.marks,
      expected: expected(st),
      keywords: '',
      // A step that totals or concludes is built from figures worked out in earlier steps
      dependsOnEarlierFigure: steps[0] !== st && /comput|final|total|prepare|calculat|net\b/i.test(st.title) && hasAmount(allWorking)
    })),
    keywords: (sections.keywords || [])
      .filter((l) => !isSeparator(l))
      .map((l) => (isTableLine(l) ? tableCells(l).filter(Boolean).join(': ') : l.replace(/^\s*[-*•]\s*/, '').trim()))
      .filter(Boolean),
    layout: (sections.layout || []).join('\n').trim(),
    scheme: [(sections.scheme || []).join('\n').trim() || scheme, finalAnswer && `Final answer: ${finalAnswer}`].filter(Boolean).join('\n\n'),
    instructions: (sections.instructions || []).join('\n').trim()
  };
  setup.distributionTotal = distributionTotal;
  return setup;
}

// Reads documents labelled with QUESTION:, STEPS: ("Step 1: ... (½ Mark)"), KEYWORDS:, MARKS
// DISTRIBUTION: and FINAL ANSWER:, with any number of questions, without AI. Figures can't be
// miscopied this way. Returns null when any question doesn't clearly fit, so it goes to the AI.
export function parseLabelledDocument(text) {
  const questions = [];
  let sections = null;
  let topic = null;
  let current = null;
  let label = '';
  const finish = () => {
    if (sections) questions.push({ sections, label });
  };
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(SECTION_RX);
    if (m) {
      const kind = sectionKind(m[1]);
      if (kind === 'question') {
        finish();
        sections = { ...(topic ? { topic } : {}) };
        label = (m[1].match(/^question\s+(?:no\.?\s*)?(.+)$/i) || [])[1] || '';
      } else if (kind === 'topic' && !sections) {
        topic = [m[2]];
        continue;
      }
      if (!sections) return null;
      current = kind;
      sections[current] = sections[current] || [];
      if (m[2].trim()) sections[current].push(m[2]);
    } else if (sections && current) {
      sections[current].push(line);
    }
  }
  finish();
  if (!questions.length) return null;
  const parsed = questions.map((q, i) => parseLabelledQuestion(q.sections, q.label ? `Q${q.label}` : `Q${i + 1}`));
  return parsed.every(Boolean) ? parsed : null;
}

function mergeSetups(primary, secondary) {
  const merged = { ...primary };
  for (const key of ['code', 'topic', 'questionType', 'questionText', 'layout', 'scheme', 'instructions']) {
    if (!merged[key] && secondary[key]) merged[key] = secondary[key];
  }
  if (!merged.maxMarks && secondary.maxMarks) merged.maxMarks = secondary.maxMarks;
  if (!merged.steps.length && secondary.steps?.length) merged.steps = secondary.steps;
  const seen = new Set(merged.keywords.map((k) => k.toLowerCase()));
  (secondary.keywords || []).forEach((k) => {
    if (!seen.has(k.toLowerCase())) merged.keywords.push(k);
  });
  return merged;
}

const BINARY_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/;

const hasContent = (q) => Boolean(q.code || q.questionText || q.scheme || q.steps.length || q.keywords.length);

// Plain checks on what was detected, so the examiner knows exactly what to look at.
function reviewQuestions(questions, sourceText, notes) {
  const sourceFigures = sourceText === null ? null : new Set(extractFigures(sourceText));
  questions.forEach((q, i) => {
    const name = q.code || `Question ${i + 1}`;
    const stepTotal = q.steps.reduce((sum, st) => sum + (Number(st.marks) || 0), 0);
    if (!q.maxMarks && !stepTotal) notes.push(`${name}: no marks found. Enter the max marks.`);
    if (q.maxMarks && q.steps.length && Math.abs(stepTotal - q.maxMarks) > 0.001) {
      notes.push(`${name}: steps add up to ${stepTotal}, but the question is worth ${q.maxMarks}. Check the steps.`);
    }
    if (!q.steps.length) notes.push(`${name}: no stepwise marks found. The model will work out the steps from the marking scheme while marking.`);
    if (!q.scheme && !q.steps.length) notes.push(`${name}: no marking scheme found.`);
    if (sourceFigures) {
      const detected = [q.questionText, q.scheme, ...q.steps.map((st) => st.expected)].join(' ');
      const invented = extractFigures(detected).filter((f) => !sourceFigures.has(f));
      if (invented.length) notes.push(`${name}: figures not found in the document, so check them: ${invented.slice(0, 6).join(', ')}`);
    }
  });
}

function finishSetup(q, i, paperTitle) {
  const marks = q.steps.map((st) => Number(st.marks) || 0);
  const needsQuarters = marks.some((m) => Math.abs(m * 2 - Math.round(m * 2)) > 0.001);
  return sanitizeSetup({
    ...q,
    paperTitle,
    code: q.code || `Q${i + 1}`,
    granularity: q.granularity || (needsQuarters ? 0.25 : 0.5)
  });
}

// files: multer files. organize(rawTexts, binaryFiles) is called only when some material does not
// follow a template and useAi is true. It returns { document: { paperTitle, questions }, usage }.
export async function importMaterials(files, { useAi, organize }) {
  const into = emptySetup();
  const rawTexts = [];
  const binaries = [];
  const notes = [];
  const imageCounter = { next: 1 };
  const labelled = [];
  const baseName = (f) => path.basename(f.originalname, path.extname(f.originalname));

  // One question and no number of its own: the file name identifies it best
  const addLabelled = (f, parsed) => {
    if (parsed.length === 1 && /^Q1$/.test(parsed[0].code)) parsed[0].code = baseName(f);
    labelled.push(...parsed);
    const marks = parsed.reduce((sum, q) => sum + q.steps.reduce((t, st) => t + st.marks, 0), 0);
    const steps = parsed.reduce((sum, q) => sum + q.steps.length, 0);
    notes.push(`${f.originalname}: read exactly, without AI: ${parsed.length} question(s), ${steps} steps, ${marks} marks`);
  };

  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    try {
      if (ext === '.xlsx') {
        const used = await readWorkbook(f.buffer, into, rawTexts, f.originalname);
        notes.push(used ? `${f.originalname}: read ${used} table(s) from the template format` : `${f.originalname}: no template tables found, sent to AI`);
      } else if (ext === '.xls') {
        notes.push(`${f.originalname}: old .xls format is not supported. Open it in Excel and save as .xlsx.`);
      } else if (ext === '.doc') {
        notes.push(`${f.originalname}: old .doc format is not supported. Open it in Word and save as .docx.`);
      } else if (ext === '.csv') {
        const rows = parseCsv(f.buffer.toString('utf-8'));
        if (readTableWithOffset(rows, into)) notes.push(`${f.originalname}: read as a template table`);
        else {
          rawTexts.push(`From ${f.originalname}:\n${tableToText(rows)}`);
          notes.push(`${f.originalname}: not in template format, sent to AI`);
        }
      } else if (ext === '.docx') {
        const doc = await readDocx(f.buffer, f.originalname, imageCounter);
        const parsed = doc.images.length ? null : parseTextTemplate(doc.markdown);
        const labelledDoc = parsed || doc.images.length ? null : parseLabelledDocument(doc.markdown);
        if (parsed) {
          Object.assign(into, mergeSetups(into, parsed));
          notes.push(`${f.originalname}: read from the text template format`);
        } else if (labelledDoc) {
          addLabelled(f, labelledDoc);
        } else {
          rawTexts.push(`From ${f.originalname}:\n${doc.markdown}`);
          binaries.push(...doc.images);
          const found = [doc.images.length && `${doc.images.length} image(s)`, doc.equations && `${doc.equations} equation(s)`].filter(Boolean);
          notes.push(`${f.originalname}: sent to AI to detect the questions${found.length ? `, with ${found.join(' and ')}` : ''}`);
        }
        if (doc.unreadable) {
          notes.push(`${f.originalname}: ${doc.unreadable} picture(s) or old-style equation(s) could not be read. Save the file as PDF and upload that instead, or retype them.`);
        }
      } else if (['.txt', '.md'].includes(ext)) {
        const text = f.buffer.toString('utf-8');
        const parsed = parseTextTemplate(text);
        const labelledDoc = parsed ? null : parseLabelledDocument(text);
        if (parsed) {
          Object.assign(into, mergeSetups(into, parsed));
          notes.push(`${f.originalname}: read from the text template format`);
        } else if (labelledDoc) {
          addLabelled(f, labelledDoc);
        } else {
          rawTexts.push(`From ${f.originalname}:\n${text.trim()}`);
          notes.push(`${f.originalname}: free text, sent to AI`);
        }
      } else if (BINARY_TYPES.test(f.mimetype)) {
        binaries.push(f);
        notes.push(`${f.originalname}: PDF/image, read by AI`);
      } else {
        notes.push(`${f.originalname}: file type not supported (use .docx, .xlsx, .csv, .txt, .pdf or images)`);
      }
    } catch (err) {
      notes.push(`${f.originalname}: could not be read (${err.message})`);
    }
  }

  let questions = [into];
  let paperTitle = '';
  let usage = null;
  if (rawTexts.length || binaries.length) {
    if (useAi) {
      const ai = await organize(rawTexts, binaries);
      usage = ai.usage;
      paperTitle = String(ai.document?.paperTitle || '').trim();
      const detected = (Array.isArray(ai.document?.questions) ? ai.document.questions : []).map(sanitizeAiSetup).filter(hasContent);
      if (!detected.length) notes.push('The AI did not find any question in the materials. Fill in the fields below.');
      if (!hasContent(into)) {
        if (detected.length) questions = detected;
      } else if (detected.length) {
        // Values from a template are exact, so they win over what the AI read for the same question
        const match = detected.length === 1 ? 0 : detected.findIndex((q) => into.code && normalize(q.code) === normalize(into.code));
        questions = match >= 0 ? detected.map((q, i) => (i === match ? mergeSetups(into, q) : q)) : [into, ...detected];
      }
      // A picture in the materials means figures can legitimately come from outside the text
      reviewQuestions(questions, binaries.length ? null : rawTexts.join('\n'), notes);
      if (questions.length > 1) notes.unshift(`Detected ${questions.length} questions. Check each one below.`);
    } else {
      if (rawTexts.length) {
        into.scheme = [into.scheme, ...rawTexts].filter(Boolean).join('\n\n');
        notes.push('AI organizing is off: free text was added to the marking scheme box as it is.');
      }
      if (binaries.length) notes.push('AI organizing is off: PDFs and images were skipped.');
    }
  }

  if (labelled.length) {
    reviewQuestions(labelled, null, notes);
    labelled.forEach((q) => {
      if (q.distributionTotal !== null && q.maxMarks && q.distributionTotal !== q.maxMarks) {
        notes.push(`${q.code}: the marks table totals ${q.distributionTotal}, but the question says ${q.maxMarks}. Check the marks.`);
      }
    });
    questions = hasContent(questions[0]) ? [...labelled, ...questions] : [...labelled, ...questions.slice(1)];
    if (questions.length > 1 && !notes[0].startsWith('Detected')) notes.unshift(`Detected ${questions.length} questions. Check each one below.`);
  }

  return { setups: questions.map((q, i) => finishSetup(q, i, paperTitle)), paperTitle, notes, usage };
}

function sanitizeAiSetup(s = {}) {
  return {
    code: String(s.code || '').trim(),
    topic: String(s.topic || '').trim(),
    questionType: String(s.questionType || ''),
    questionText: String(s.questionText || '').trim(),
    maxMarks: Number(s.maxMarks) || 0,
    granularity: 0,
    steps: Array.isArray(s.steps) ? s.steps.filter((st) => st && st.title) : [],
    keywords: Array.isArray(s.keywords) ? s.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    layout: String(s.layout || '').trim(),
    scheme: String(s.scheme || '').trim(),
    instructions: String(s.instructions || '').trim()
  };
}

// ---------- templates ----------

export async function buildExcelTemplate() {
  const ex = EXAMPLE_SETUP;
  const wb = new ExcelJS.Workbook();
  const style = (sheet, widths) => {
    sheet.columns = widths.map((width) => ({ width }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEFC' } };
    sheet.eachRow((row) => (row.alignment = { wrapText: true, vertical: 'top' }));
  };

  const q = wb.addWorksheet('Question');
  q.addRows([
    ['Field', 'Value'],
    ['Question code', ex.code],
    ['Question', ex.questionText],
    ['Max marks', ex.maxMarks],
    ['Mark increment', ex.granularity],
    ['Expected layout', ex.layout],
    ['Marking scheme', ex.scheme],
    ['Instructions', ex.instructions]
  ]);
  style(q, [20, 100]);

  const s = wb.addWorksheet('Steps');
  s.addRows([['Step', 'Marks', 'What earns the marks', 'Step keywords'], ...ex.steps.map((st) => [st.title, st.marks, st.expected, st.keywords])]);
  style(s, [34, 8, 80, 34]);

  const k = wb.addWorksheet('Keywords');
  k.addRows([['Keyword'], ...ex.keywords.map((kw) => [kw])]);
  style(k, [50]);

  const h = wb.addWorksheet('Help');
  h.addRows([
    ['How to fill this template'],
    ['Question sheet: keep the Field names in column A; type your values in column B. Mark increment is 0.25, 0.5 or 1.'],
    ['Steps sheet: one row per marking step. Marks for all steps should add up to Max marks.'],
    ['Keywords sheet: one ICAI keyword per row. Put alternative phrasings in the same cell separated by | (e.g. loan | advance).'],
    ['You can leave any sheet empty and upload that information as a separate PDF, Word or text file instead.']
  ]);
  h.getColumn(1).width = 120;
  h.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function buildTextTemplate() {
  const ex = EXAMPLE_SETUP;
  return [
    '# Evaluation template. Keep the headings (QUESTION CODE:, QUESTION:, ...) and replace the example content.',
    '# STEPS: one per line as  Step | Marks | What earns the marks | Step keywords (comma separated)',
    '# KEYWORDS: one per line; alternatives on the same line separated by |',
    '',
    `QUESTION CODE: ${ex.code}`,
    `MAX MARKS: ${ex.maxMarks}`,
    `MARK INCREMENT: ${ex.granularity}`,
    'QUESTION:',
    ex.questionText,
    '',
    'STEPS:',
    ...ex.steps.map((st) => [st.title, st.marks, st.expected, st.keywords].join(' | ')),
    '',
    'KEYWORDS:',
    ...ex.keywords,
    '',
    'LAYOUT:',
    ex.layout,
    '',
    'MARKING SCHEME:',
    ex.scheme,
    '',
    'INSTRUCTIONS:',
    ''
  ].join('\r\n');
}
