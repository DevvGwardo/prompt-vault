// Heuristic prompt quality scorer. Returns { score: 0-100, reasons: [], verdict }.
// Designed to be fast, deterministic, and offline.
//
// Training mode: call train(examples) with labeled {text, label} pairs to build
// a token+bigram affinity model using pointwise mutual information.
// The model biases future scores by up to ±15 based on learned patterns.

const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was',
  'one','our','out','has','have','been','some','them','than','that','this',
  'very','just','with','from','they','what','when','where','which','will',
  'your','its','about','into','over','also','than','then','each','would',
  'could','should','after','before','between','without','because'
]);

// ---- Marker sets (expanded) ----

const CONTEXT_MARKERS = [
  /\bbecause\b/i, /\bso that\b/i, /\bin order to\b/i,
  /\bcurrently\b/i, /\bexpected\b/i, /\bactual\b/i,
  /\bgoal\b/i, /\bgiven\b/i, /\bcontext\b/i,
  /\bbackground\b/i, /\bproblem\b/i, /\bissue\b/i,
  /\bscenario\b/i, /\bsetup\b/i, /\benvironment\b/i,
  /\bpreviously\b/i, /\bbefore this\b/i, /\bafter that\b/i,
  /\bhappens when\b/i, /\bwhen I\b/i, /\bleads to\b/i,
  /\bI have\b/i, /\bwe have\b/i, /\bthere is\b/i,
];

const SPECIFICITY_MARKERS = [
  /\bfile\b/i, /\bfunction\b/i, /\bclass\b/i, /\bcomponent\b/i,
  /\berror\b/i, /\bstack\b/i, /\bline\s+\d+/i, /\.[a-z]{1,4}\b/i,
  /\bmethod\b/i, /\bendpoint\b/i, /\broute\b/i, /\bapi\b/i,
  /\bmodule\b/i, /\bpackage\b/i, /\blibrary\b/i, /\bdependency\b/i,
  /\bconfig\b/i, /\bimport\b/i, /\bexport\b/i, /\binterface\b/i,
  /\btype\b/i, /\bprop\b/i, /\bstate\b/i, /\bhook\b/i,
  /\bdatabase\b/i, /\bschema\b/i, /\btable\b/i, /\bquery\b/i,
  /\brequest\b/i, /\bresponse\b/i, /\bheader\b/i, /\bbody\b/i,
  /\bconsole\b/i, /\blog\b/i, /\bdebug\b/i, /\btrace\b/i,
];

const CONSTRAINT_MARKERS = [
  /\bmust\b/i, /\bshould\b/i, /\bdo not\b/i, /\bdon'?t\b/i,
  /\bonly\b/i, /\bavoid\b/i, /\bprefer\b/i, /\binstead\b/i,
  /\brequire\b/i, /\bnecessary\b/i, /\bimportant\b/i, /\bcritical\b/i,
  /\balways\b/i, /\bnever\b/i, /\bensure\b/i, /\bmake sure\b/i,
  /\bkeep\b/i, /\bmaintain\b/i, /\bpreserve\b/i, /\bconsistent\b/i,
  /\bwithout\b/i, /\bexcept\b/i, /\bunless\b/i, /\bno other\b/i,
  /\bcompatible\b/i, /\bsupport\b/i, /\bhandle\b/i, /\bedge case\b/i,
];

const EXAMPLE_MARKERS = [
  /\bexample\b/i, /\be\.g\.\b/i, /\bi\.e\.\b/i, /\blike this\b/i,
  /\bfor instance\b/i, /\bsuch as\b/i, /\bdemo\b/i, /\bsample\b/i,
  /\bhere is\b/i, /\bas follows\b/i, /\bas shown\b/i,
];

const STRUCTURE_MARKERS = [
  /^#{1,3}\s/m,                  // markdown headings
  /```[\s\S]*?```/,              // fenced code blocks
  /`[^`]+`/,                     // inline code
  /^\s*[-*+]\s/m,                // unordered lists
  /^\s*\d+[.)]\s/m,              // ordered lists
  /^\s*>+\s/m,                   // blockquotes
  /\*\*[^*]+\*\*/,               // bold text
];

const VAGUE_PHRASES = [
  /^(fix it|fix this|make it work|do it|continue|yes|no|ok|cool|nice)\.?$/i,
  /^(please )?(help|debug|refactor)\.?$/i
];

const AMBIGUITY_TERMS = /\b(stuff|things|something|whatever|somehow|anyway|kinda|sorta|sort of|i think|i guess|probably|maybe|possibly|might be|not sure|idk|dunno|etc\.|and so on|like|basically|actually|literally|honestly|essentially|generally|usually|sometimes|often|a bit|a little|somewhat|somehow|for some reason)\b/gi;

// ---- Training model (in-memory, rebuilt by train()) ----
let _model = null; // { tokenBias: { word: number }, bigramBias: { 'word1 word2': number }, totalGood: number, totalBad: number, version: number }
let _modelVersion = 0;

function tokenize(text) {
  return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t =>
    t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t)
  );
}

function bigrams(text) {
  const tokens = tokenize(text);
  const result = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    result.push(tokens[i] + ' ' + tokens[i + 1]);
  }
  return result;
}

function train(examples) {
  // Build token+bigram goodness model using pointwise mutual information.
  // Uses Laplace smoothing for robustness with small datasets.
  const goodFreq = {};    // feature -> good-prompt count
  const badFreq = {};     // feature -> bad-prompt count
  let goodPrompts = 0;
  let badPrompts = 0;

  for (const { text, label } of examples) {
    const isGood = label === 'good' || label === 'implicit_good';
    const isBad = label === 'bad' || label === 'implicit_bad';
    if (!isGood && !isBad) continue;

    if (isGood) goodPrompts++; else badPrompts++;

    // Single tokens (deduped per prompt)
    const tokens = new Set(tokenize(text));
    // Bigrams (deduped per prompt)
    const bg = new Set(bigrams(text));
    const allFeatures = new Set([...tokens, ...bg]);

    for (const f of allFeatures) {
      if (isGood) { goodFreq[f] = (goodFreq[f] || 0) + 1; }
      else        { badFreq[f]  = (badFreq[f]  || 0) + 1;  }
    }
  }

  const totalGood = goodPrompts || 1;
  const totalBad = badPrompts || 1;
  const total = totalGood + totalBad;
  const baseGoodRate = totalGood / total;

  // Laplace smoothing parameters
  const alpha = 1; // smoothing factor

  const tokenBias = {};
  const bigramBias = {};

  const allFeatures = new Set([...Object.keys(goodFreq), ...Object.keys(badFreq)]);

  for (const feature of allFeatures) {
    const gf = (goodFreq[feature] || 0) + alpha;
    const bf = (badFreq[feature] || 0) + alpha;

    // PMI-style: how much more likely is this feature in good vs bad prompts?
    const pGood = gf / (totalGood + alpha * 2);
    const pBad  = bf / (totalBad  + alpha * 2);

    // Log-odds ratio, clipped for stability
    const odds = pGood / (pBad || 0.001);
    let bias = Math.log(Math.max(0.05, Math.min(20, odds)));

    // Scale by how often the feature appears (more occurrences = more confidence)
    const rawCount = (goodFreq[feature] || 0) + (badFreq[feature] || 0);
    const confidence = Math.min(1, Math.log2(rawCount + 1) / 4);

    bias *= confidence;

    // Determine if this is a bigram (contains space)
    if (feature.includes(' ')) {
      bigramBias[feature] = bias;
    } else {
      tokenBias[feature] = bias;
    }
  }

  _model = {
    tokenBias, bigramBias,
    totalGood, totalBad,
    baseGoodRate,
    version: ++_modelVersion
  };
  return _model;
}

function computeBias(text) {
  if (!_model || !text) return 0;

  const tokens = tokenize(text);
  const bg = bigrams(text);

  let sum = 0;
  let count = 0;

  for (const t of tokens) {
    const b = _model.tokenBias[t];
    if (b != null) { sum += b; count++; }
  }
  for (const b of bg) {
    const bias = _model.bigramBias[b];
    if (bias != null) { sum += bias * 1.5; count++; } // bigrams get 1.5x weight
  }

  if (!count) return 0;

  // Average bias, then scale to the ±15 point range
  const avgBias = sum / count;
  // Scale factor adapts to dataset size — with few labels, be conservative
  const labelCount = _model.totalGood + _model.totalBad;
  const scaleFactor = Math.min(12, 3 + Math.log2(Math.max(2, labelCount)) * 2);
  return Math.max(-15, Math.min(15, avgBias * scaleFactor));
}

function modelInfo() {
  if (!_model) return null;
  const tokens = Object.keys(_model.tokenBias).length;
  const bigrams = Object.keys(_model.bigramBias).length;
  return {
    version: _model.version,
    tokens,
    bigrams,
    totalGood: _model.totalGood,
    totalBad: _model.totalBad,
    labelCount: _model.totalGood + _model.totalBad
  };
}

// ---- Heuristic scoring ----

function countMatches(text, patterns) {
  let n = 0;
  for (const re of patterns) {
    if (re.test(text)) n++;
  }
  return n;
}

function lengthScore(len) {
  // Sigmoid-like curve: penalize very short, reward moderate, plateau at long.
  // Maps character length to [-15, +15] range.
  if (len === 0) return -15;
  const x = Math.log2(Math.max(1, len));
  // x is ~0 for len=1, ~5 for len=32, ~6.6 for len=100, ~8.3 for len=300, ~10 for len=1024
  // Target: peak around len=200-600, penalize below 60, neutral above 1200
  const raw = (x - 5.5) * 4; // center at ~45 chars
  return Math.round(Math.max(-15, Math.min(15, raw)));
}

function ambiguityScore(text) {
  // Count vague/filler terms per 100 words. Returns penalty [0, -15].
  const words = text.split(/\s+/).length || 1;
  const matches = (text.match(AMBIGUITY_TERMS) || []).length;
  const rate = matches / (words / 100); // per 100 words
  // Rate: 0 → 0 penalty, 5+ → full -15 penalty
  return -Math.round(Math.min(15, rate * 3));
}

function redundancyScore(text) {
  // Detect adjacent sentences with high word overlap (>60%).
  // Returns penalty [0, -10].
  const sentences = text.split(/[.!?\n]+/).map(s => {
    const words = s.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    return new Set(words);
  }).filter(s => s.size >= 3);

  let redundantPairs = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    const a = sentences[i];
    const b = sentences[i + 1];
    if (a.size === 0 || b.size === 0) continue;
    let overlap = 0;
    for (const w of a) { if (b.has(w)) overlap++; }
    const ratio = overlap / Math.min(a.size, b.size);
    if (ratio > 0.6) redundantPairs++;
  }

  return -Math.min(10, redundantPairs * 4);
}

function structureScore(text) {
  // Reward well-organized prompts. 0 to +15.
  let score = 0;

  const hasFencedCode = /```[\s\S]*?```/.test(text);
  const hasInlineCode = /`[^`]+`/.test(text);
  const hasHeadings = /^#{1,3}\s/m.test(text);
  const hasUnorderedList = /^\s*[-*+]\s/m.test(text);
  const hasOrderedList = /^\s*\d+[.)]\s/m.test(text);
  const hasBold = /\*\*[^*]+\*\*/.test(text);
  const hasBlockquote = /^\s*>+\s/m.test(text);

  if (hasHeadings) score += 4;
  if (hasFencedCode) score += 5;
  else if (hasInlineCode) score += 2;
  if (hasUnorderedList || hasOrderedList) score += 3;
  if (hasBold) score += 2;
  if (hasBlockquote) score += 1;

  // Section count: blank-line separated blocks
  const sections = text.split(/\n\s*\n/).filter(s => s.trim().length > 20).length;
  if (sections >= 5) score += 3;
  else if (sections >= 3) score += 2;
  else if (sections >= 2) score += 1;

  return Math.min(15, score);
}

function precisionScore(text) {
  // Detect specific technical references. 0 to +10.
  let score = 0;

  // File paths with extensions
  const fileRefs = (text.match(/[\w/.-]+\.[a-z]{1,6}\b/gi) || []).length;
  if (fileRefs >= 3) score += 4;
  else if (fileRefs >= 1) score += 2;

  // Line numbers
  if (/\bline\s+\d+/i.test(text)) score += 2;
  if (/:\d+:\d+/.test(text)) score += 2; // file:line:col

  // Error messages
  if (/\b(error|exception|traceback|stack trace)[:\s]/i.test(text)) score += 2;
  if (/[A-Z][a-z]+Error\b/.test(text)) score += 2; // PascalCaseError

  // URLs / paths
  if (/https?:\/\//.test(text)) score += 1;
  if (/\/[\w-]+\/[\w-]+/.test(text)) score += 1; // unix paths

  return Math.min(10, score);
}

function analyzePrompt(text) {
  const trimmed = (text || '').trim();
  const reasons = [];

  if (!trimmed) {
    return { score: 0, reasons: ['empty'], verdict: 'skip', stats: {} };
  }

  const len = trimmed.length;
  const words = trimmed.split(/\s+/).length;
  const lines = trimmed.split('\n').length;

  // Instant reject: single-word or pure-vague prompts
  if (VAGUE_PHRASES.some(re => re.test(trimmed))) {
    return { score: 5, reasons: ['vague filler phrase'], verdict: 'skip',
      stats: { len, words, lines } };
  }
  if (words <= 2 && !/[{}[\]();"']/.test(trimmed)) {
    return { score: 5, reasons: ['too short'], verdict: 'skip',
      stats: { len, words, lines } };
  }

  // ---- DIMENSION SCORING ----
  // Each dimension contributes independently to the final score.

  // 1. LENGTH: curve-based [-15, +15]
  const lenSc = lengthScore(len);
  if (lenSc < -5) reasons.push(`too short (${len}c)`);
  else if (lenSc > 8) reasons.push(`substantial (${len}c)`);

  // 2. SPECIFICITY: markers [0, +20]
  const spec = countMatches(trimmed, SPECIFICITY_MARKERS);
  const specSc = Math.min(20, spec * 3);

  // 3. CONSTRAINTS: markers [0, +12]
  const cons = countMatches(trimmed, CONSTRAINT_MARKERS);
  const consSc = Math.min(12, cons * 2);

  // 4. CONTEXT: markers [0, +10]
  const ctx = countMatches(trimmed, CONTEXT_MARKERS);
  const ctxSc = Math.min(10, ctx * 2);

  // 5. EXAMPLES: markers [0, +6]
  const ex = countMatches(trimmed, EXAMPLE_MARKERS);
  const exSc = Math.min(6, ex * 3);

  // 6. STRUCTURE: [0, +15]
  const structSc = structureScore(trimmed);

  // 7. PRECISION: [0, +10]
  const precSc = precisionScore(trimmed);

  // 8. AMBIGUITY: [-15, 0]
  const ambigSc = ambiguityScore(trimmed);

  // 9. REDUNDANCY: [-10, 0]
  const redundSc = redundancyScore(trimmed);

  // 10. TRAINING BIAS: [-15, +15]
  const bias = computeBias(trimmed);

  // ---- COMPOSITE SCORE ----
  // Base of 35, then each dimension adds/subtracts.
  // Max theoretical: 35 + 20 + 12 + 10 + 6 + 15 + 10 + 15 = 123 → clamp to 100
  // Min theoretical: 35 - 15 - 15 - 10 = -5 → clamp to 0
  let score = 35
    + lenSc
    + specSc
    + consSc
    + ctxSc
    + exSc
    + structSc
    + precSc
    + ambigSc
    + redundSc
    + bias;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 65 ? 'save' : score >= 40 ? 'maybe' : 'skip';

  // Build reason strings
  if (specSc >= 12) reasons.push(`specific (+${specSc})`);
  else if (specSc >= 6) reasons.push(`some specifics (+${specSc})`);
  if (consSc >= 8) reasons.push(`constrained (+${consSc})`);
  else if (consSc >= 4) reasons.push(`has constraints (+${consSc})`);
  if (ctxSc >= 6) reasons.push(`good context (+${ctxSc})`);
  if (exSc >= 3) reasons.push(`has examples (+${exSc})`);
  if (structSc >= 12) reasons.push(`well-structured (+${structSc})`);
  else if (structSc >= 6) reasons.push(`structured (+${structSc})`);
  if (precSc >= 6) reasons.push(`precise refs (+${precSc})`);
  if (ambigSc <= -8) reasons.push(`vague terms (${ambigSc})`);
  if (redundSc <= -4) reasons.push(`redundant (${redundSc})`);
  if (bias !== 0) reasons.push(`trained: ${bias > 0 ? '+' : ''}${bias.toFixed(1)}`);
  if (lenSc < -5) reasons.push(`too short (${lenSc})`);
  if (!reasons.length) reasons.push('basic');

  const hasCode = /```|`[^`]+`/m.test(trimmed);
  const hasQuestion = /\?/.test(trimmed);
  const hasList = /^\s*[-*\d]+[.)]\s/m.test(trimmed);

  const dimensions = {
    length: lenSc,
    specificity: specSc,
    constraints: consSc,
    context: ctxSc,
    examples: exSc,
    structure: structSc,
    precision: precSc,
    ambiguity: ambigSc,
    redundancy: redundSc,
    training: Math.round(bias * 10) / 10,
    _words: words,
    _lines: lines,
    _chars: len,
    _code: hasCode,
    _list: hasList,
    _question: hasQuestion
  };

  return {
    score,
    reasons,
    verdict,
    bias: Math.round(bias * 10) / 10,
    dimensions,
    stats: { len, words, lines, hasCode, hasQuestion, hasList }
  };
}

// ---- Repetitive phrase detection across prompts ----
// Extracts 3-5 word phrases, normalizes, and finds those appearing in 2+ prompts.

const PHRASE_STOP = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was',
  'one','our','out','has','have','been','some','them','than','that','this',
  'very','just','with','from','they','what','when','where','which','will',
  'your','its','about','into','over','also','than','then','each','would',
  'could','should','after','before','between','without','because',
  'this is','it is','there is','there are','i have','i am','we are',
  'to the','in the','of the','on the','for the','and the',
  'is a','is an','are a','are an','be a','be an',
  'it was','it is','it will','it would','it can','it could',
  'you are','you have','you can','you will','you would',
  'we can','we will','we have','we would',
  'i need','i want','i would','please','thanks','thank you',
  'im','ive','dont','cant','wont','isnt','arent','doesnt',
  'here','there','then','now','just','also','like','make','use',
  'way','thing','stuff','need','want','get','got','put','set',
  'hello','hi','hey','ok','okay','yes','no','maybe',
  'the following','following is','is the following',
  'write','create','generate','implement','build','add','fix',
  'code','file','function','class','component',
  'please','thanks','thank','help','need',
  'can you','could you','would you','will you',
  'should','must','might','maybe','perhaps',
  'well','basically','actually','literally','honestly',
  'first','second','third','finally','lastly',
  'able','going','doing','using','making','working',
  'sure','right','good','bad','great','nice','cool',
  'much','many','more','less','some','any','each','every',
]);

function normalizeWord(w) {
  // Strip leading markdown list markers, quotes, and punctuation
  let cleaned = w.replace(/^[-*+]>?\s*/, '').replace(/^['"]+|['"]+$/g, '').replace(/[^a-z0-9'-]/gi, '').toLowerCase();
  return cleaned;
}

function wordsFromText(text) {
  return (text || '').split(/\s+/).map(normalizeWord).filter(w => w.length >= 1);
}

function extractPhrases(text) {
  // Split into paragraphs first — don't cross blank-line or heading boundaries
  const paragraphs = (text || '').split(/\n\s*\n/).filter(p => p.trim());
  const phrases = new Set();

  for (const para of paragraphs) {
    // Also split on heading lines within a paragraph (rare but defensive)
    const chunks = para.split(/\n(?=#{1,3}\s)/);
    for (const chunk of chunks) {
      const words = wordsFromText(chunk);
      for (let n = 3; n <= 5; n++) {
        for (let i = 0; i <= words.length - n; i++) {
          const slice = words.slice(i, i + n);
          if (slice.every(w => w.length < 2 || /^\d+$/.test(w))) continue;
          const phrase = slice.join(' ');
          if (!PHRASE_STOP.has(phrase)) {
            phrases.add(phrase);
          }
        }
      }
    }
  }
  return phrases;
}

function findRepetitivePhrases(texts, minPrompts = 2, topN = 12) {
  const phraseCounts = {};
  for (const { text } of texts) {
    const phrases = extractPhrases(text);
    for (const phrase of phrases) {
      phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
    }
  }
  const repeated = Object.entries(phraseCounts)
    .filter(([, count]) => count >= minPrompts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([phrase, count]) => ({ phrase, count }));
  return repeated;
}

// ---- Optimal prompt generation from top-scored prompts ----

function extractHeadings(text) {
  const matches = text.match(/^#{1,3}\s+(.+)$/gm) || [];
  return matches.map(h => h.replace(/^#{1,3}\s+/, '').trim().toLowerCase());
}

function extractCodeBlocks(text) {
  return (text.match(/```[\s\S]*?```/g) || []).length;
}

function hasPattern(text, re) { return re.test(text); }

function generateOptimalPrompt(prompts) {
  // prompts: array of { id, text, score, verdict }
  // Filter to high-quality prompts
  const top = (prompts || [])
    .filter(p => p.verdict === 'save' || (p.score != null && p.score >= 65))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  if (top.length < 1) {
    return {
      template: '',
      insights: [`You have ${prompts.length} prompt${prompts.length !== 1 ? 's' : ''} but none scored ≥65 or marked "save". Label some prompts as Good to generate a template.`],
      topPhrases: [],
      stats: { analyzedCount: prompts.length, topCount: 0, avgTopScore: 0 }
    };
  }

  // With just 1 qualifying prompt, use it directly but note the limitation
  if (top.length === 1) {
    const p = top[0];
    const headings = extractHeadings(p.text);
    const phrases = [...extractPhrases(p.text)].slice(0, 5).map(phrase => ({ phrase, count: 1, avgScore: p.score || 50, maxScore: p.score || 50 }));
    const insights = ['Only 1 qualifying prompt so far. Label more as "save" for richer patterns.'];
    if (headings.length) insights.push('This prompt uses headings — a good practice.');
    if (extractCodeBlocks(p.text) > 0) insights.push('Includes code blocks — concrete examples score higher.');

    let template = '';
    if (headings.length) {
      for (const h of headings.slice(0, 3)) {
        const cap = h.charAt(0).toUpperCase() + h.slice(1);
        template += `## ${cap}\n`;
        template += `[${h} section from your top prompt]\n\n`;
      }
    } else {
      template = p.text.slice(0, 400) + (p.text.length > 400 ? '\n…' : '');
    }

    return {
      template: template.trim(),
      insights,
      topPhrases: phrases,
      stats: { analyzedCount: prompts.length, topCount: 1, avgTopScore: p.score || 0 }
    };
  }

  const topN = top.slice(0, 15);

  // --- Structural analysis ---
  const headingFreq = {};
  let withHeadings = 0, withCode = 0, withLists = 0, withExamples = 0;
  let withConstraints = 0, withContext = 0, withFileRefs = 0;

  for (const p of topN) {
    const headings = extractHeadings(p.text);
    if (headings.length) withHeadings++;
    for (const h of headings) {
      headingFreq[h] = (headingFreq[h] || 0) + 1;
    }
    if (extractCodeBlocks(p.text) > 0) withCode++;
    if (hasPattern(p.text, /^\s*[-*+]\s/m)) withLists++;
    if (hasPattern(p.text, /\bexample\b|\be\.g\.\b|\bfor instance\b/i)) withExamples++;
    if (countMatches(p.text, CONSTRAINT_MARKERS) >= 3) withConstraints++;
    if (countMatches(p.text, CONTEXT_MARKERS) >= 3) withContext++;
    if (hasPattern(p.text, /[\w/.-]+\.[a-z]{1,6}\b/i)) withFileRefs++;
  }

  const total = topN.length;
  const pct = (n) => Math.round((n / total) * 100);

  // --- Score-weighted phrases ---
  const phraseScores = {};
  const phraseMaxScore = {};
  for (const p of topN) {
    const phrases = extractPhrases(p.text);
    for (const phrase of phrases) {
      phraseScores[phrase] = (phraseScores[phrase] || 0) + (p.score || 50);
      phraseMaxScore[phrase] = Math.max(phraseMaxScore[phrase] || 0, p.score || 50);
      // Also track count for dedup weighting
      if (!phraseScores['_cnt_' + phrase]) phraseScores['_cnt_' + phrase] = 0;
      phraseScores['_cnt_' + phrase]++;
    }
  }

  const topPhrases = Object.keys(phraseScores)
    .filter(k => !k.startsWith('_cnt_'))
    .map(phrase => ({
      phrase,
      count: phraseScores['_cnt_' + phrase] || 1,
      avgScore: Math.round(phraseScores[phrase] / (phraseScores['_cnt_' + phrase] || 1)),
      maxScore: phraseMaxScore[phrase] || 0
    }))
    .filter(p => p.count >= 2)
    .sort((a, b) => b.avgScore - a.avgScore)
    .slice(0, 10);

  // --- Build insights ---
  const insights = [];
  if (withHeadings >= total * 0.5) insights.push(`${pct(withHeadings)}% of your best prompts use headings — keep doing this.`);
  if (withCode >= total * 0.4) insights.push(`${pct(withCode)}% include code blocks — concrete examples score higher.`);
  if (withLists >= total * 0.4) insights.push(`${pct(withLists)}% use bullet lists for requirements or steps.`);
  if (withConstraints >= total * 0.4) insights.push('Clear constraints ("must", "should", "avoid") correlate with high scores.');
  if (withContext >= total * 0.5) insights.push(`${pct(withContext)}% provide background context — helps the model understand.`);
  if (withFileRefs >= total * 0.3) insights.push('Referencing specific files/lines improves precision.');
  if (withExamples >= total * 0.3) insights.push('Including examples of desired output raises scores.');
  if (!insights.length) insights.push('Keep labeling prompts — more data improves the template.');

  // --- Generate template ---
  const topHeadings = Object.entries(headingFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => h);

  const topPhraseTexts = topPhrases.slice(0, 5).map(p => p.phrase);

  let template = '';
  if (topHeadings.length) {
    for (const h of topHeadings) {
      const cap = h.charAt(0).toUpperCase() + h.slice(1);
      template += `## ${cap}\n`;
      if (h.includes('goal') || h.includes('task')) {
        template += `[describe what you want to achieve — be specific about the outcome]\n\n`;
      } else if (h.includes('context') || h.includes('background')) {
        template += `[explain the current situation: what you're using, what's happening, what you've tried]\n\n`;
      } else if (h.includes('requirement') || h.includes('constraint')) {
        template += `- Must [hard requirement]\n- Should [preference]\n- Avoid [anti-pattern]\n\n`;
      } else if (h.includes('example')) {
        template += '```\n[show the expected input/output or code pattern]\n```\n\n';
      } else if (h.includes('error')) {
        template += `Error in [file]:[line] — [error message]\n[stack trace or relevant context]\n\n`;
      } else {
        template += `[specific details about ${cap.toLowerCase()}]\n\n`;
      }
    }
  } else {
    // No headings found — generate a generic template from patterns
    template = `## Goal\n[what you want to achieve]\n\n`;
    if (withContext >= total * 0.5) {
      template += `## Context\n[current setup, what you've tried, what's happening]\n\n`;
    }
    if (withConstraints >= total * 0.4) {
      template += `## Requirements\n- Must [constraint]\n- Should [best practice]\n\n`;
    }
    if (withCode >= total * 0.4) {
      template += `## Example\n\`\`\`\n[relevant code or expected output]\n\`\`\`\n\n`;
    }
  }

  // Append key phrase hints
  if (topPhraseTexts.length) {
    template += `---\n`;
    template += `Your highest-scored prompts frequently use:\n`;
    for (const p of topPhraseTexts) {
      template += `  • "${p}"\n`;
    }
  }

  return {
    template: template.trim(),
    insights,
    topPhrases,
    stats: {
      analyzedCount: prompts.length,
      topCount: top.length,
      avgTopScore: topN.length ? Math.round(topN.reduce((s, p) => s + (p.score || 0), 0) / topN.length) : 0
    }
  };
}

module.exports = { analyzePrompt, train, computeBias, modelInfo, findRepetitivePhrases, generateOptimalPrompt };
