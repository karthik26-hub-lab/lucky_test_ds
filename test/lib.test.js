// Run with: npm test
import assert from 'node:assert/strict';
import { sanitizeSetup, finalizeResult, findUnclear, normalize, buildGradingPrompt } from '../lib.js';

const setup = sanitizeSetup({
  code: 'Q1',
  questionText: 'Can ABC Pvt Ltd lend to its director?',
  maxMarks: 4,
  granularity: 0.5,
  steps: [
    { title: 'Section 185', marks: 1 },
    { title: 'Exemption', marks: 1 },
    { title: 'Application', marks: 1 },
    { title: 'Conclusion', marks: 1 }
  ],
  keywords: 'Section 185\nloan | advance\nbody corporate'
});

const transcript = `--- Page 1 ---
As per Sec. 185 of the Companies Act, 2013 no company shall advance any loan to its director.
However a [UNCLEAR: private] company is exempt if conditions are met.
Conclusion: ABC can give the loan.`;

const raw = {
  steps: [
    { awardedMarks: 1, evidenceQuote: 'as per sec 185 of the companies act', reasoning: 'ok', confidence: 0.95 },
    { awardedMarks: 0.7, evidenceQuote: 'private company is exempt', reasoning: 'partial', confidence: 0.5 },
    { awardedMarks: 5, evidenceQuote: 'this sentence is invented', reasoning: 'x', confidence: 0.9 }
    // step 4 missing on purpose
  ],
  keywords: [
    { keyword: 'Section 185', present: true, matchedText: 'Sec. 185' },
    { keyword: 'loan | advance', present: true, matchedText: 'loan' },
    { keyword: 'body corporate', present: true, matchedText: '' }
  ],
  presentation: { followsLayout: true, comments: '' },
  needsHumanReview: false
};

const result = finalizeResult(setup, transcript, raw);

assert.deepEqual(findUnclear(transcript), ['private']);
assert.equal(normalize('Sec. 185(1)'), 'sec 185 1');

assert.equal(result.steps.length, 4, 'every configured step is returned');
assert.equal(result.steps[1].awardedMarks, 0.5, 'marks rounded to the 0.5 increment');
assert.equal(result.steps[2].awardedMarks, 1, 'marks capped at the step maximum');
assert.equal(result.steps[2].evidenceFound, false, 'invented quote is detected');
assert.equal(result.steps[1].evidenceFound, true, 'quote matches across an [UNCLEAR] tag');
assert.equal(result.steps[3].awardedMarks, 0, 'a step the model skipped gets 0');
assert.equal(result.totalAwarded, 2.5);
assert.equal(result.maxMarks, 4);

assert.equal(result.keywords[0].exactMatch, false, '"Section 185" is not literally in "Sec. 185"');
assert.equal(result.keywords[1].exactMatch, true, 'alternatives are matched');
assert.equal(result.keywords[2].exactMatch, false);

const flagText = result.flags.join('\n');
assert.match(flagText, /unclear word/);
assert.match(flagText, /Step 2: low confidence/);
assert.match(flagText, /Step 3: evidence quote not found/);
assert.match(flagText, /Step 4: the model did not mark this step/);
assert.match(flagText, /keyword\(s\) where the exact text match and the AI disagree/);
assert.equal(result.needsReview, true);

assert.match(buildGradingPrompt(setup, transcript), /Step 4: Conclusion \(max 1 marks\)/);

const mismatch = finalizeResult(sanitizeSetup({ ...setup, maxMarks: 5 }), transcript, raw);
assert.equal(mismatch.warnings.length, 1, 'warns when steps do not add up to max marks');

console.log('All lib tests passed.');
