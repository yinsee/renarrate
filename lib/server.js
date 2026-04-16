import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

import { PIPELINE_DEFAULTS, checkPrereqs, processFile } from './pipeline.js';
import { VARIANTS, getVariant } from './variants.js';
import { LANGUAGES, getLanguage } from './languages.js';
import { exists } from './tools.js';
import { synthF5, loadVoiceRef } from './tts-f5.js';
import { beautifyText } from './beautify.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const WEB_DIR = path.join(ROOT, 'web');

// In-memory job state. Single-user, no persistence.
// jobs[id] = { status, opts, log: [...], subscribers: Set<res>, outputPath?, error? }
const jobs = new Map();

function pushEvent(job, event) {
  job.log.push(event);
  for (const res of job.subscribers) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (event.stage === 'done' || event.stage === 'error') {
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readMultipart(req) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=(.+)$/);
  if (!m) throw new Error('missing multipart boundary');
  const boundary = `--${m[1]}`;

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  const parts = {};
  let pos = 0;
  while (pos < body.length) {
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const header = body.slice(pos, headerEnd).toString('utf8');
    if (header.indexOf(boundary) < 0) { pos = headerEnd + 4; continue; }

    const nameMatch = header.match(/name="([^"]+)"/);
    const filenameMatch = header.match(/filename="([^"]+)"/);
    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(`\r\n${boundary}`, dataStart);
    if (nextBoundary < 0) break;
    const data = body.slice(dataStart, nextBoundary);
    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch) {
        parts[name] = { filename: filenameMatch[1], data };
      } else {
        parts[name] = data.toString('utf8');
      }
    }
    pos = nextBoundary + 2;
  }
  return parts;
}

async function handleStaticIndex(res) {
  try {
    const html = await readFile(path.join(WEB_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    send(res, 500, { error: `web/index.html missing: ${err.message}` });
  }
}

function handleListVariants(res) {
  send(res, 200, { variants: Object.keys(VARIANTS) });
}

function handleListLanguages(res) {
  send(res, 200, { languages: LANGUAGES, default: PIPELINE_DEFAULTS.outputLanguage });
}

async function handleCreateJob(req, res) {
  let parts;
  try {
    parts = await readMultipart(req);
  } catch (err) {
    return send(res, 400, { error: `multipart parse failed: ${err.message}` });
  }
  const file = parts.file;
  const variant = (parts.variant || PIPELINE_DEFAULTS.variant).toString().trim();
  const outputLanguage = (parts.outputLanguage || PIPELINE_DEFAULTS.outputLanguage).toString().trim();
  if (!file || !file.data) return send(res, 400, { error: 'missing file field' });
  if (!VARIANTS[variant]) return send(res, 400, { error: `unknown variant: ${variant}` });
  if (!LANGUAGES.some((l) => l.code === outputLanguage)) {
    return send(res, 400, { error: `unknown outputLanguage: ${outputLanguage}` });
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const jobId = randomUUID();
  const hash = createHash('sha256').update(file.data).digest('hex').slice(0, 12);
  const ext = path.extname(file.filename || '.mov') || '.mov';
  const uploadPath = path.join(UPLOAD_DIR, `${hash}${ext}`);
  if (!(await exists(uploadPath))) {
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(uploadPath);
      ws.on('error', reject);
      ws.on('finish', resolve);
      ws.end(file.data);
    });
  }

  const opts = { ...PIPELINE_DEFAULTS, variant, outputLanguage, force: false };
  const job = { id: jobId, status: 'pending', opts, log: [], subscribers: new Set(), uploadPath };
  jobs.set(jobId, job);

  // Run pipeline asynchronously; events flow through pushEvent → SSE subscribers.
  (async () => {
    try {
      const { tools, problems } = await checkPrereqs(opts);
      if (problems.length > 0) {
        throw new Error(`prereqs failed: ${problems.join('; ')}`);
      }
      job.status = 'running';
      const onProgress = (event) => pushEvent(job, event);
      const { outputPath } = await processFile({
        inputPath: uploadPath,
        opts,
        tools,
        onProgress,
      });
      job.outputPath = outputPath;
      job.status = 'done';
      pushEvent(job, { stage: 'done', message: 'render complete', outputUrl: `/jobs/${jobId}/output` });
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      console.error(`job ${jobId} failed:`, err);
      pushEvent(job, { stage: 'error', message: err.message });
    }
  })();

  send(res, 202, { jobId });
}

function handleEvents(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return send(res, 404, { error: 'unknown job' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  // Replay any events emitted before the subscriber connected.
  for (const evt of job.log) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }

  job.subscribers.add(res);
  req.on('close', () => job.subscribers.delete(res));
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`invalid JSON: ${err.message}`); }
}

async function handlePreview(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const variantName = (body.variant || PIPELINE_DEFAULTS.variant).toString().trim();
  const outputLanguageCode = (body.outputLanguage || PIPELINE_DEFAULTS.outputLanguage).toString().trim();
  if (!text) return send(res, 400, { error: 'missing text' });
  if (text.length > 500) return send(res, 400, { error: 'text too long (max 500 chars)' });
  let variant;
  try { variant = getVariant(variantName); }
  catch (err) { return send(res, 400, { error: err.message }); }
  const outputLanguage = getLanguage(outputLanguageCode);

  await mkdir(UPLOAD_DIR, { recursive: true });
  const previewPath = path.join(UPLOAD_DIR, `preview_${randomUUID()}.wav`);
  try {
    const rewritten = await beautifyText({
      text,
      llmUrl: PIPELINE_DEFAULTS.llmUrl,
      llmModel: PIPELINE_DEFAULTS.llmModel,
      systemPrompt: variant.systemPrompt,
      outputLanguage,
    });
    console.log(`[preview] ${variantName}/${outputLanguage.code}: "${text}" -> "${rewritten}"`);
    const voiceRefDir = path.resolve(ROOT, 'models/voices');
    const { refAudio, refText } = await loadVoiceRef(voiceRefDir, variant.voiceName);
    await synthF5({
      refAudio,
      refText,
      text: rewritten,
      outputWav: previewPath,
      speed: variant.lengthScale,
    });
    const st = await stat(previewPath);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Rewritten-Text': encodeURIComponent(rewritten),
    });
    const stream = createReadStream(previewPath);
    stream.on('end', () => { unlink(previewPath).catch(() => {}); });
    stream.on('error', () => { unlink(previewPath).catch(() => {}); });
    stream.pipe(res);
  } catch (err) {
    unlink(previewPath).catch(() => {});
    console.error('preview failed:', err);
    send(res, 500, { error: err.message });
  }
}

async function handleOutput(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.outputPath) return send(res, 404, { error: 'output not ready' });
  try {
    const st = await stat(job.outputPath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': st.size,
      'Content-Disposition': `inline; filename="${path.basename(job.outputPath)}"`,
    });
    createReadStream(job.outputPath).pipe(res);
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const method = req.method;

  try {
    if (method === 'GET' && pathname === '/') return handleStaticIndex(res);
    if (method === 'GET' && pathname === '/variants') return handleListVariants(res);
    if (method === 'GET' && pathname === '/languages') return handleListLanguages(res);
    if (method === 'POST' && pathname === '/preview') return handlePreview(req, res);
    if (method === 'POST' && pathname === '/jobs') return handleCreateJob(req, res);

    const jobMatch = pathname.match(/^\/jobs\/([0-9a-f-]+)\/(events|output)$/);
    if (jobMatch) {
      const [, jobId, kind] = jobMatch;
      if (method === 'GET' && kind === 'events') return handleEvents(req, res, jobId);
      if (method === 'GET' && kind === 'output') return handleOutput(req, res, jobId);
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('handler error:', err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
  console.log(`  upload dir:  ${UPLOAD_DIR}`);
  console.log(`  web dir:     ${WEB_DIR}`);
  console.log(`  LLM URL:     ${PIPELINE_DEFAULTS.llmUrl}`);
  console.log(`  LLM model:   ${PIPELINE_DEFAULTS.llmModel}`);
});
