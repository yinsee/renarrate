import { readFile, writeFile } from 'node:fs/promises';
import { exists } from './tools.js';


function stripSpecialTokens(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<\|?(?:eos|end_of_turn|endoftext|im_end|end)\|?>/gi, '')
    .replace(/<\/s>/gi, '')
    .replace(/^\s*Thinking Process:[\s\S]*?(?=\{)/i, '');
}

function stripFence(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced ? fenced[1] : text).trim();
}

function balanceJson(s) {
  let depthCurly = 0;
  let depthSquare = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depthCurly++;
    else if (ch === '}') depthCurly--;
    else if (ch === '[') depthSquare++;
    else if (ch === ']') depthSquare--;
  }
  let suffix = '';
  while (depthSquare-- > 0) suffix += ']';
  while (depthCurly-- > 0) suffix += '}';
  return s + suffix;
}

function extractJson(text) {
  const cleaned = stripFence(stripSpecialTokens(text));
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  if (start < 0) {
    throw new Error(`LLM did not return JSON:\n${text.slice(-800)}`);
  }
  const fromStart = cleaned.slice(start);
  try { return JSON.parse(fromStart); } catch {}
  try { return JSON.parse(balanceJson(fromStart)); } catch {}
  const end = cleaned.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(balanceJson(cleaned.slice(start, end + 1))); } catch {}
  }
  throw new Error(`LLM did not return valid JSON:\n${text.slice(-800)}`);
}

// Gemma sporadically strips filler words ("okay", "so", "um") from the rewritten text
// AND drops their original indices, leaving 1-3 word gaps in the chunk coverage. The text
// is correct; only the index bookkeeping is wrong. Close small gaps by extending the
// previous sentence's lastWord, and clamp the first/last sentence to cover the chunk
// boundaries. Returns the (possibly mutated) sentences. Larger gaps are left alone so
// validateSentences can still reject genuine truncations.
const MAX_REPAIRABLE_GAP = 3;
function repairSentences(sentences, wordCount) {
  if (!Array.isArray(sentences) || sentences.length === 0) return sentences;
  const first = sentences[0];
  if (typeof first.firstWord === 'number' && first.firstWord > 0 && first.firstWord <= MAX_REPAIRABLE_GAP) {
    first.firstWord = 0;
  }
  for (let i = 1; i < sentences.length; i++) {
    const prev = sentences[i - 1];
    const cur = sentences[i];
    if (typeof prev.lastWord !== 'number' || typeof cur.firstWord !== 'number') continue;
    const gap = cur.firstWord - (prev.lastWord + 1);
    if (gap > 0 && gap <= MAX_REPAIRABLE_GAP) {
      prev.lastWord = cur.firstWord - 1;
    }
  }
  const last = sentences[sentences.length - 1];
  if (typeof last.lastWord === 'number' && last.lastWord < wordCount - 1 && (wordCount - 1 - last.lastWord) <= MAX_REPAIRABLE_GAP) {
    last.lastWord = wordCount - 1;
  }
  return sentences;
}

function validateSentences(sentences, wordCount) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('LLM returned no sentences');
  }
  repairSentences(sentences, wordCount);
  let expectedStart = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (typeof s.firstWord !== 'number' || typeof s.lastWord !== 'number') {
      throw new Error(`sentence ${i}: firstWord/lastWord must be numbers`);
    }
    if (s.firstWord !== expectedStart) {
      throw new Error(`sentence ${i}: expected firstWord=${expectedStart}, got ${s.firstWord}`);
    }
    if (s.lastWord < s.firstWord) {
      throw new Error(`sentence ${i}: lastWord (${s.lastWord}) < firstWord (${s.firstWord})`);
    }
    if (typeof s.text !== 'string' || s.text.trim().length === 0) {
      throw new Error(`sentence ${i}: missing text`);
    }
    expectedStart = s.lastWord + 1;
  }
  if (expectedStart !== wordCount) {
    throw new Error(`sentences cover ${expectedStart} words, expected ${wordCount}`);
  }
}

function extractMustKeepTokens(words) {
  const fullText = words.map((w) => w.text).join(' ');
  const tokens = new Set();
  const patterns = [
    /\b\d+(?:[.,]\d+)*%?\b/g,
    /\b[A-Z]{2,}\b/g,
    /\b[a-zA-Z]+_[a-zA-Z0-9_]+\b/g,
    /\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g,
  ];
  for (const re of patterns) {
    for (const m of fullText.matchAll(re)) tokens.add(m[0]);
  }
  return Array.from(tokens);
}

function normalizeForCheck(s) {
  return s.toLowerCase().replace(/[^a-z0-9%._]/g, '');
}

function validateMustKeep(segments, mustKeep) {
  if (mustKeep.length === 0) return;
  const combined = normalizeForCheck(segments.map((s) => s.text).join(' '));
  const missing = mustKeep.filter((tok) => !combined.includes(normalizeForCheck(tok)));
  if (missing.length > 0) {
    throw new Error(`LLM dropped required tokens: ${missing.join(', ')}`);
  }
}

async function callLlm({ llmUrl, llmModel, systemPrompt, userMessage }) {
  let res;
  try {
    res = await fetch(`${llmUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmModel,
        temperature: 0.6,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    throw new Error(`LLM fetch failed: ${err.message}${cause}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content;
  if (!content) throw new Error(`LLM response missing content:\n${JSON.stringify(data)}`);
  return content;
}

// Recursively split text at the punctuation boundary closest to its midpoint until
// every piece is <= maxWords. Used to enforce per-variant sentence length caps that
// the LLM occasionally violates (notably trump, who runs on tangents).
function splitTextByWords(text, maxWords) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return [words.join(' ')];
  const target = Math.floor(words.length / 2);
  let splitAt = -1;
  let bestDist = Infinity;
  for (let i = 1; i < words.length - 1; i++) {
    if (/[.!?—;,]$/.test(words[i - 1])) {
      const d = Math.abs(i - target);
      if (d < bestDist) { bestDist = d; splitAt = i; }
    }
  }
  if (splitAt < 0) splitAt = target;
  const left = words.slice(0, splitAt).join(' ');
  const right = words.slice(splitAt).join(' ');
  return [...splitTextByWords(left, maxWords), ...splitTextByWords(right, maxWords)];
}

function ensureTerminalPunct(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function splitLongSegments(segments, maxWords) {
  if (!maxWords || maxWords < 5) return segments;
  const out = [];
  for (const seg of segments) {
    const parts = splitTextByWords(seg.text, maxWords);
    if (parts.length === 1) {
      out.push(seg);
      continue;
    }
    const counts = parts.map((p) => p.split(/\s+/).filter(Boolean).length);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const span = seg.end - seg.start;
    let cursor = seg.start;
    for (let i = 0; i < parts.length; i++) {
      const partEnd = i === parts.length - 1 ? seg.end : cursor + (span * counts[i]) / total;
      out.push({ start: cursor, end: partEnd, text: ensureTerminalPunct(parts[i]) });
      cursor = partEnd;
    }
  }
  return out;
}

function chunkWords(words, chunkSize) {
  if (!chunkSize || chunkSize <= 0 || words.length <= chunkSize) {
    return [{ lo: 0, hi: words.length, words }];
  }
  const chunks = [];
  let lo = 0;
  while (lo < words.length) {
    const hi = Math.min(lo + chunkSize, words.length);
    chunks.push({ lo, hi, words: words.slice(lo, hi) });
    lo = hi;
  }
  return chunks;
}

function languagePromptPrefix(outputLanguage) {
  if (!outputLanguage || outputLanguage.code === 'en') return '';
  const name = outputLanguage.name;
  const profanity = outputLanguage.profanityGuidance ? `\n${outputLanguage.profanityGuidance}\n` : '';
  return `*** HARD REQUIREMENT — OUTPUT LANGUAGE: ${name} ***

Every sentence's "text" field MUST be written entirely in natural, fluent, native ${name}. No English narrative words. Common English verbs and nouns ("click", "select", "run", "can", "with", "this", "model", "editor", "system", "training", "from", "here", "next", "then", "once", "completed", "use", "upload", "images") MUST be translated into ${name}. Do NOT mix languages in the narrative — if it is not in the mustKeep list, translate it.

The ONLY exceptions are mustKeep tokens — numbers, percentages (e.g. "24.4%"), ALL-CAPS acronyms (e.g. "OCR"), and snake_case / camelCase identifiers (e.g. "object_classification") — which stay verbatim.

The variant style guide below describes tone using English examples. Apply that TONE to ${name} — do not word-for-word transliterate the English pidgin/slang into ${name}. Find the closest natural ${name} register for the same attitude.
${profanity}
---

`;
}

function languagePromptNote(outputLanguage) {
  if (!outputLanguage || outputLanguage.code === 'en') return '';
  return ` Write each sentence's "text" entirely in ${outputLanguage.name}; do not leave any English narrative words.`;
}

async function beautifyChunk({ chunk, baseIndex, llmUrl, llmModel, systemPrompt, validate, maxSentenceWords, outputLanguage }) {
  const compact = chunk.map((w, i) => ({ i, text: w.text }));
  const mustKeep = extractMustKeepTokens(chunk);
  const lastIdx = chunk.length - 1;
  const baseNote = `Cover word indices 0 through ${lastIdx} inclusive. Every firstWord and lastWord must be between 0 and ${lastIdx}. First sentence's firstWord must be 0; last sentence's lastWord must be ${lastIdx}.${languagePromptNote(outputLanguage)}`;
  const effectiveSystemPrompt = languagePromptPrefix(outputLanguage) + systemPrompt;
  const effectiveValidate = outputLanguage && outputLanguage.code !== 'en' ? null : validate;

  const MAX_ATTEMPTS = 5;
  let lastErr = null;
  let correction = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const noteWithCorrection = correction ? `${baseNote} ${correction}` : baseNote;
      const userMessage = JSON.stringify({ note: noteWithCorrection, mustKeep, words: compact });
      const content = await callLlm({ llmUrl, llmModel, systemPrompt: effectiveSystemPrompt, userMessage });
      let parsed;
      try {
        parsed = extractJson(content);
      } catch (err) {
        console.error(`--- LLM raw content (len=${content.length}) first 400 ---`);
        console.error(content.slice(0, 400));
        console.error('--- last 400 ---');
        console.error(content.slice(-400));
        console.error('--- end ---');
        throw err;
      }
      const sentences = parsed.sentences;
      validateSentences(sentences, chunk.length);

      let segments = sentences.map((s) => ({
        start: chunk[s.firstWord].start,
        end: chunk[s.lastWord].end,
        text: s.text.trim(),
      }));

      validateMustKeep(segments, mustKeep);

      if (effectiveValidate) {
        try {
          effectiveValidate(segments);
        } catch (err) {
          if (attempt < MAX_ATTEMPTS) throw err;
          console.error(`       chunk@${baseIndex} variant validator soft-failed on final attempt: ${err.message} — accepting`);
        }
      }

      if (maxSentenceWords) {
        segments = splitLongSegments(segments, maxSentenceWords);
      }
      return segments;
    } catch (err) {
      lastErr = err;
      correction = `PREVIOUS ATTEMPT FAILED: ${err.message}. Fix it this time.`;
      if (attempt < MAX_ATTEMPTS) {
        console.error(`       chunk@${baseIndex} attempt ${attempt} failed: ${err.message} — retrying`);
      }
    }
  }
  throw lastErr;
}

// One-shot "rewrite this raw string in the narrator's voice" — used by the /preview
// endpoint so the previewed clip reflects how the variant actually rewrites text,
// not the user's literal input. Reuses beautifyChunk with fake per-word timestamps;
// the variant's style validator (profanity density, etc.) is skipped because a
// one-sentence preview has no density to enforce.
export async function beautifyText({ text, llmUrl, llmModel, systemPrompt, outputLanguage = null }) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('empty text');
  const words = tokens.map((w, i) => ({ start: i * 0.5, end: (i + 1) * 0.5, text: w }));
  const segs = await beautifyChunk({
    chunk: words,
    baseIndex: 0,
    llmUrl,
    llmModel,
    systemPrompt,
    validate: null,
    maxSentenceWords: null,
    outputLanguage,
  });
  return segs.map((s) => s.text).join(' ');
}

export async function beautify({
  words,
  llmUrl,
  llmModel,
  systemPrompt,
  chunkSize = null,
  validate = null,
  maxSentenceWords = null,
  outputLanguage = null,
  cachePath,
  force = false,
}) {
  if (!force && cachePath && await exists(cachePath)) {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  }

  const chunks = chunkWords(words, chunkSize);
  const allSegments = [];
  for (const chunk of chunks) {
    if (chunks.length > 1) {
      console.log(`       chunk @${chunk.lo}..${chunk.hi - 1}`);
    }
    const segs = await beautifyChunk({
      chunk: chunk.words,
      baseIndex: chunk.lo,
      llmUrl,
      llmModel,
      systemPrompt,
      validate,
      maxSentenceWords,
      outputLanguage,
    });
    allSegments.push(...segs);
  }

  if (cachePath) await writeFile(cachePath, JSON.stringify(allSegments, null, 2), 'utf8');
  return allSegments;
}
