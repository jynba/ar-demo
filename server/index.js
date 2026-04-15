const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3030);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const TARGETS_DIR = path.join(RUNTIME_DIR, 'targets');
const VENDOR_DIR = path.join(PROJECT_ROOT, 'vendor', 'NFT-Marker-Creator');
const VENDOR_APP = path.join(VENDOR_DIR, 'app.js');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MODEL_URL =
  'https://cdn.jsdelivr.net/gh/AR-js-org/AR.js/aframe/examples/image-tracking/nft/trex/scene.gltf';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.iset': 'application/octet-stream',
  '.fset': 'application/octet-stream',
  '.fset3': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sanitizeTaskId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function inferExtensionFromMime(contentType = '') {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  return '';
}

function inferExtensionFromFileName(fileName = '') {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') return ext === '.jpeg' ? '.jpg' : ext;
  return '';
}

function buildBaseUrl(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  const forwardedProto = req.headers['x-forwarded-proto'];
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
  const protocol = forwardedProto || 'http';
  return `${protocol}://${host}`;
}

function buildTargetPrefixPath(taskId) {
  return `targets/${taskId}/${taskId}`;
}

function normalizePathname(pathname = '/') {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  return collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_UPLOAD_BYTES} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(delimiter);

  while (start !== -1) {
    start += delimiter.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;

    const nextBoundary = buffer.indexOf(delimiter, start);
    if (nextBoundary === -1) break;

    let part = buffer.subarray(start, nextBoundary);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      start = nextBoundary;
      continue;
    }

    const headerText = part.subarray(0, headerEnd).toString('utf8');
    const body = part.subarray(headerEnd + 4);
    const headers = {};

    for (const line of headerText.split('\r\n')) {
      const index = line.indexOf(':');
      if (index === -1) continue;
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }

    parts.push({ headers, body });
    start = nextBoundary;
  }

  return parts;
}

function parseContentDisposition(value = '') {
  const result = {};
  for (const segment of value.split(';')) {
    const trimmed = segment.trim();
    const [key, rawValue] = trimmed.split('=');
    if (!rawValue) continue;
    result[key] = rawValue.trim().replace(/^"|"$/g, '');
  }
  return result;
}

async function saveUploadedFile(parts, taskDir, taskId) {
  const filePart = parts.find((part) => {
    const disposition = parseContentDisposition(part.headers['content-disposition']);
    return disposition.name === 'image' && disposition.filename;
  });

  if (!filePart) return null;

  const disposition = parseContentDisposition(filePart.headers['content-disposition']);
  const ext =
    inferExtensionFromFileName(disposition.filename) || inferExtensionFromMime(filePart.headers['content-type']);

  if (!ext) {
    const error = new Error('Only JPG and PNG uploads are supported.');
    error.statusCode = 400;
    throw error;
  }

  const sourceFileName = `source-original${ext}`;
  const targetPath = path.join(taskDir, sourceFileName);
  await fsp.writeFile(targetPath, filePart.body);

  return {
    sourceFileName,
    sourcePath: targetPath,
    sourceKind: 'upload',
    sourceOriginalName: disposition.filename,
  };
}

async function saveRemoteImage(imageUrl, taskDir, taskId) {
  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    const error = new Error('image_url must be a valid absolute URL.');
    error.statusCode = 400;
    throw error;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    const error = new Error('Only http and https image URLs are supported.');
    error.statusCode = 400;
    throw error;
  }

  const response = await fetch(parsedUrl);
  if (!response.ok) {
    const error = new Error(`Failed to download image: ${response.status} ${response.statusText}`);
    error.statusCode = 400;
    throw error;
  }

  const contentType = response.headers.get('content-type') || '';
  const ext = inferExtensionFromMime(contentType) || inferExtensionFromFileName(parsedUrl.pathname) || '.jpg';
  if (!['.jpg', '.png'].includes(ext)) {
    const error = new Error('Downloaded file must be JPG or PNG.');
    error.statusCode = 400;
    throw error;
  }

  const arrayBuffer = await response.arrayBuffer();
  const body = Buffer.from(arrayBuffer);
  if (body.length > MAX_UPLOAD_BYTES) {
    const error = new Error(`Downloaded image exceeds ${MAX_UPLOAD_BYTES} bytes.`);
    error.statusCode = 400;
    throw error;
  }

  const sourceFileName = `source-original${ext}`;
  const sourcePath = path.join(taskDir, sourceFileName);
  await fsp.writeFile(sourcePath, body);

  return {
    sourceFileName,
    sourcePath,
    sourceKind: 'url',
    sourceOriginalUrl: imageUrl,
  };
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} exited with code ${code}.`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function normalizeSourceImage(taskDir, taskId, sourcePath) {
  const normalizedFileName = `${taskId}.jpg`;
  const normalizedPath = path.join(taskDir, normalizedFileName);

  await runCommand('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '960', sourcePath, '--out', normalizedPath]);

  return {
    normalizedFileName,
    normalizedPath,
  };
}

function buildGeneratorArgs(relativeInputPath, relativeOutputPath) {
  const runner = [
    'global.fetch = undefined;',
    `process.argv = ${JSON.stringify(['node', 'app.js', '-i', relativeInputPath, '-o', relativeOutputPath])};`,
    "require('./app.js');",
  ].join(' ');

  return ['-e', runner];
}

async function runMarkerCreator(taskId, taskDir, sourceFileName) {
  const relativeInputPath = path.relative(VENDOR_DIR, path.join(taskDir, sourceFileName));
  const relativeOutputPath = path.relative(VENDOR_DIR, taskDir);
  const args = buildGeneratorArgs(relativeInputPath, relativeOutputPath);

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: VENDOR_DIR,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Marker generation failed with exit code ${code}.`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });

  const requiredFiles = ['.iset', '.fset', '.fset3'].map((ext) => path.join(taskDir, `${taskId}${ext}`));
  for (const filePath of requiredFiles) {
    await fsp.access(filePath, fs.constants.R_OK);
  }

  return result;
}

async function readMeta(taskId) {
  const safeTaskId = sanitizeTaskId(taskId);
  if (!safeTaskId) return null;
  const metaPath = path.join(TARGETS_DIR, safeTaskId, 'meta.json');
  try {
    const text = await fsp.readFile(metaPath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseQuality(stdout = '') {
  const match = stdout.match(/Confidence level:\s+\[[^\]]+\]\s+([0-9.]+)\/5\s+\|\|\s+Entropy:\s+([0-9.]+)/);
  if (!match) return null;

  return {
    confidence: Number(match[1]),
    entropy: Number(match[2]),
  };
}

function buildViewerHtml(targetPrefixUrl, sourceImageUrl = '') {
  const normalizedTargetPrefix = String(targetPrefixUrl || '').replace(/^\/+/, '');
  const normalizedSourceImageUrl = String(sourceImageUrl || '').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dynamic Trex Viewer</title>
    <script src="https://unpkg.com/aframe@1.0.4/dist/aframe.min.js"></script>
    <script src="https://unpkg.com/@ar-js-org/ar.js@3.4.4/aframe/build/aframe-ar-nft.js"></script>
    <style>
      body {
        margin: 0;
        overflow: hidden;
        font-family: "Avenir Next", "PingFang SC", sans-serif;
        background: #0c1116;
      }
      .overlay {
        position: fixed;
        inset: 0 auto auto 0;
        width: min(380px, calc(100% - 24px));
        margin: 12px;
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(8, 12, 18, 0.72);
        color: #f9f3e5;
        z-index: 1000;
        backdrop-filter: blur(10px);
      }
      .overlay strong {
        display: block;
        margin-bottom: 6px;
      }
      .overlay p {
        margin: 0;
        line-height: 1.5;
        color: rgba(249, 243, 229, 0.84);
      }
    </style>
  </head>
  <body>
    <div class="overlay">
      <strong>Dynamic Trex Viewer</strong>
      <p>Point the camera at the exact source image used to build this target. The target is dynamic, the AR content stays fixed to the Trex model.</p>
    </div>

    <a-scene
      vr-mode-ui="enabled: false;"
      renderer="logarithmicDepthBuffer: true;"
      embedded
      arjs="trackingMethod: best; sourceType: webcam; debugUIEnabled: false;"
    >
      <a-nft
        type="nft"
        url="${normalizedTargetPrefix}"
        smooth="true"
        smoothCount="10"
        smoothTolerance="0.01"
        smoothThreshold="5"
      >
        <a-entity position="100 100 100" rotation="-90 0 0">
          <a-entity
            gltf-model="${MODEL_URL}"
            scale="5 5 5"
            position="0 0 0"
          ></a-entity>
          ${normalizedSourceImageUrl
      ? `<a-plane
            src="${normalizedSourceImageUrl}"
            position="100 100 0"
            rotation="0 0 0"
            width="100"
            height="100"
            transparent="true"
            material="side: double"
          ></a-plane>`
      : ''
    }
        </a-entity>
      </a-nft>
      <a-entity camera></a-entity>
    </a-scene>
  </body>
</html>`;
}

async function writeMeta(taskDir, payload) {
  const metaPath = path.join(taskDir, 'meta.json');
  await fsp.writeFile(metaPath, JSON.stringify(payload, null, 2));
}

async function createTarget(req, res) {
  const contentType = req.headers['content-type'] || '';
  const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const taskDir = path.join(TARGETS_DIR, taskId);
  await ensureDir(taskDir);

  const startedAt = new Date();
  let sourceInfo = null;
  let normalizedInfo = null;

  try {
    if (contentType.startsWith('multipart/form-data')) {
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) {
        throw Object.assign(new Error('Missing multipart boundary.'), { statusCode: 400 });
      }
      const body = await readRequestBody(req);
      const parts = parseMultipart(body, boundaryMatch[1]);
      sourceInfo = await saveUploadedFile(parts, taskDir, taskId);
      if (!sourceInfo) {
        throw Object.assign(new Error('Multipart request must include an image file named "image".'), {
          statusCode: 400,
        });
      }
    } else {
      const body = await readRequestBody(req);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      if (!payload.image_url) {
        throw Object.assign(new Error('Provide image_url or upload an image file.'), { statusCode: 400 });
      }
      sourceInfo = await saveRemoteImage(payload.image_url, taskDir, taskId);
    }

    normalizedInfo = await normalizeSourceImage(taskDir, taskId, sourceInfo.sourcePath);

    const pendingMeta = {
      task_id: taskId,
      status: 'processing',
      created_at: startedAt.toISOString(),
      source_kind: sourceInfo.sourceKind,
      source_file_name: normalizedInfo.normalizedFileName,
      source_original_file_name: sourceInfo.sourceFileName,
      source_original_name: sourceInfo.sourceOriginalName || null,
      source_original_url: sourceInfo.sourceOriginalUrl || null,
    };
    await writeMeta(taskDir, pendingMeta);

    const generatorResult = await runMarkerCreator(taskId, taskDir, normalizedInfo.normalizedFileName);

    const baseUrl = buildBaseUrl(req);
    const targetPrefixPath = buildTargetPrefixPath(taskId);
    const targetPrefixUrl = `${baseUrl}${targetPrefixPath}`;
    const viewerUrl = `${baseUrl}/viewer/${taskId}`;
    const completedAt = new Date();
    const quality = parseQuality(generatorResult.stdout);
    const successMeta = {
      ...pendingMeta,
      status: 'ready',
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      quality,
      generator_stdout: generatorResult.stdout,
      generator_stderr: generatorResult.stderr,
      target_prefix_path: targetPrefixPath,
      target_prefix_url: targetPrefixUrl,
      viewer_url: viewerUrl,
      files: {
        source: `${baseUrl}/targets/${taskId}/${normalizedInfo.normalizedFileName}`,
        source_original: `${baseUrl}/targets/${taskId}/${sourceInfo.sourceFileName}`,
        iset: `${targetPrefixUrl}.iset`,
        fset: `${targetPrefixUrl}.fset`,
        fset3: `${targetPrefixUrl}.fset3`,
      },
    };
    await writeMeta(taskDir, successMeta);

    sendJson(res, 200, {
      ok: true,
      task_id: taskId,
      status: 'ready',
      quality,
      target_prefix_path: targetPrefixPath,
      target_prefix_url: targetPrefixUrl,
      viewer_url: viewerUrl,
    });
  } catch (error) {
    const failureMeta = {
      task_id: taskId,
      status: 'failed',
      created_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      error: error.message,
      generator_stdout: error.stdout || '',
      generator_stderr: error.stderr || '',
      source_kind: sourceInfo?.sourceKind || null,
      source_file_name: normalizedInfo?.normalizedFileName || null,
      source_original_file_name: sourceInfo?.sourceFileName || null,
      source_original_name: sourceInfo?.sourceOriginalName || null,
      source_original_url: sourceInfo?.sourceOriginalUrl || null,
    };
    await writeMeta(taskDir, failureMeta);

    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || 'Target generation failed.',
      task_id: taskId,
    });
  }
}

async function serveFile(res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendText(res, 404, 'File not found.');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = normalizePathname(url.pathname);

  if (req.method === 'GET' && pathname === '/') {
    return serveFile(res, path.join(DIST_DIR, 'index.html'));
  }

  if (req.method === 'GET' && pathname.startsWith('/asset/')) {
    return serveFile(res, path.join(DIST_DIR, pathname));
  }

  if (req.method === 'POST' && pathname === '/api/targets') {
    return createTarget(req, res);
  }

  if (req.method === 'GET' && pathname.startsWith('/api/targets/')) {
    const taskId = sanitizeTaskId(pathname.replace('/api/targets/', ''));
    const meta = await readMeta(taskId);
    if (!meta) {
      return sendJson(res, 404, { ok: false, error: 'Task not found.' });
    }
    return sendJson(res, 200, { ok: true, ...meta });
  }

  if (req.method === 'GET' && pathname.startsWith('/viewer/')) {
    const viewerId = pathname.replace('/viewer/', '');
    if (viewerId === 'static-trex') {
      const html = buildViewerHtml('asset/trex', 'asset/test.jpg');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    const taskId = sanitizeTaskId(viewerId);
    const meta = await readMeta(taskId);
    if (!meta || meta.status !== 'ready') {
      return sendText(res, 404, 'Viewer task not found or not ready yet.');
    }

    const html = buildViewerHtml(
      meta.target_prefix_path || buildTargetPrefixPath(taskId),
      meta.files?.source_original || meta.files?.source || '',
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  if (req.method === 'GET' && pathname.startsWith('/targets/')) {
    const relativePath = pathname.replace('/targets/', '');
    const safePath = path.normalize(relativePath);
    if (safePath.startsWith('..')) {
      return sendText(res, 400, 'Invalid target path.');
    }
    return serveFile(res, path.join(TARGETS_DIR, safePath));
  }

  sendText(res, 404, 'Not found.');
}

async function bootstrap() {
  await ensureDir(TARGETS_DIR);
  if (!fs.existsSync(VENDOR_APP)) {
    throw new Error('NFT Marker Creator is missing. Clone it into vendor/NFT-Marker-Creator first.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error('[ar-demo] request failed', error);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { ok: false, error: error.message || 'Internal server error.' });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[ar-demo] server listening on http://localhost:${PORT}`);
    console.log(`[ar-demo] runtime targets dir: ${TARGETS_DIR}`);
  });
}

bootstrap().catch((error) => {
  console.error('[ar-demo] bootstrap failed', error);
  process.exit(1);
});
