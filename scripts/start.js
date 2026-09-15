const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const IS_WIN = process.platform === 'win32';
const HUNTER_URL = 'http://127.0.0.1:8770';
const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

function log(message) {
  console.log(`[Opportunity Hunter] ${message}`);
}

function fail(message) {
  console.error(`\n[Opportunity Hunter] ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
    ...options,
  });
  return result;
}

function commandExists(command) {
  const checker = IS_WIN ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const result = {};
  for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function ensureLocalEnv() {
  const existingText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const env = readEnvFile();
  const additions = [];

  if (!env.OLLAMA_URL) additions.push(`OLLAMA_URL=${DEFAULT_OLLAMA_URL}`);
  if (!env.OLLAMA_MODEL) additions.push('OLLAMA_MODEL=qwen3.5:9b');
  if (!env.SEARXNG_URL) additions.push(`SEARXNG_URL=${DEFAULT_SEARXNG_URL}`);
  if (!env.HUNTER_SEARCH_PROVIDER) additions.push('HUNTER_SEARCH_PROVIDER=searxng');

  if (additions.length) {
    const prefix = existingText && !existingText.endsWith('\n') ? '\n' : '';
    const heading = existingText ? '\n# Opportunity Hunter local defaults\n' : '# Opportunity Hunter local defaults\n';
    fs.appendFileSync(ENV_FILE, `${prefix}${heading}${additions.join('\n')}\n`, 'utf8');
    log(`${fs.existsSync(ENV_FILE) ? 'Updated' : 'Created'} .env with local defaults.`);
  }

  return { ...process.env, ...readEnvFile() };
}

function dockerReady() {
  const result = run('docker', ['info'], { quiet: true });
  return result.status === 0;
}

async function ensureDocker() {
  if (!commandExists('docker')) {
    fail('Docker is not installed. Install Docker Desktop once, then run npm run start again: https://www.docker.com/products/docker-desktop/');
  }

  if (dockerReady()) return;

  if (IS_WIN) {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Docker', 'Docker Desktop.exe'),
    ].filter(Boolean);
    const dockerDesktop = candidates.find(file => fs.existsSync(file));
    if (dockerDesktop) {
      log('Docker Desktop is installed but not running. Starting it...');
      const child = spawn(dockerDesktop, [], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  }

  log('Waiting for Docker...');
  for (let i = 0; i < 90; i += 1) {
    if (dockerReady()) return;
    await sleep(1000);
  }
  fail('Docker did not become ready. Open Docker Desktop once and verify that its engine starts, then rerun npm run start.');
}

async function requestOk(url, timeoutMs = 2500) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitFor(url, label, seconds = 90) {
  for (let i = 0; i < seconds; i += 1) {
    if (await requestOk(url)) return;
    await sleep(1000);
  }
  fail(`${label} did not become ready at ${url}.`);
}

async function ensureSearxng(env) {
  log('Starting local SearXNG...');
  const result = run('docker', ['compose', '-f', 'docker-compose.yml', 'up', '-d', 'searxng']);
  if (result.status !== 0) fail('Could not start the SearXNG Docker container.');

  const base = (env.SEARXNG_URL || DEFAULT_SEARXNG_URL).replace(/\/$/, '');
  await waitFor(`${base}/search?q=opportunity+hunter+health&format=json`, 'SearXNG', 90);
  log(`SearXNG ready: ${base}`);
}

async function ollamaReady(baseUrl) {
  return requestOk(`${baseUrl.replace(/\/$/, '')}/api/tags`);
}

async function ensureOllama(env) {
  const base = (env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  if (!(await ollamaReady(base))) {
    if (!commandExists('ollama')) {
      fail('Ollama is not installed. Install it once from https://ollama.com/download and then run npm run start again.');
    }
    log('Ollama is installed but not running. Starting it...');
    const child = spawn('ollama', ['serve'], { cwd: ROOT, detached: true, stdio: 'ignore', shell: false });
    child.unref();
    await waitFor(`${base}/api/tags`, 'Ollama', 45);
  }

  const model = env.OLLAMA_MODEL || 'qwen3.5:9b';
  let tags = null;
  try {
    tags = await new Promise((resolve, reject) => {
      http.get(`${base}/api/tags`, { timeout: 3000 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
      }).on('error', reject);
    });
  } catch (_) {
    tags = null;
  }

  const models = Array.isArray(tags?.models) ? tags.models.map(item => String(item.name || item.model || '')) : [];
  const present = models.some(name => name === model || name.startsWith(`${model}:`) || model.startsWith(`${name}:`));
  if (!present) {
    log(`Ollama model ${model} is missing. Pulling it now (first run can be large)...`);
    const result = run('ollama', ['pull', model]);
    if (result.status !== 0) fail(`Could not pull Ollama model ${model}.`);
  }
  log(`Ollama ready: ${model}`);
}

function findPython() {
  const candidates = IS_WIN
    ? [
        { command: 'py', args: ['-3.11'] },
        { command: 'py', args: ['-3'] },
        { command: 'python', args: [] },
      ]
    : [
        { command: 'python3.11', args: [] },
        { command: 'python3', args: [] },
        { command: 'python', args: [] },
      ];

  for (const candidate of candidates) {
    if (!commandExists(candidate.command)) continue;
    const result = run(candidate.command, [...candidate.args, '--version'], { quiet: true });
    if (result.status === 0) return candidate;
  }
  return null;
}

function ensurePythonEnvironment() {
  const venvPython = IS_WIN
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');

  if (!fs.existsSync(venvPython)) {
    const python = findPython();
    if (!python) fail('Python is not installed. Install Python 3.11+ once, then run npm run start again.');
    log('Creating Python virtual environment...');
    const result = run(python.command, [...python.args, '-m', 'venv', '.venv']);
    if (result.status !== 0) fail('Could not create the Python virtual environment.');
  }

  log('Checking Python dependencies...');
  const install = run(venvPython, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt']);
  if (install.status !== 0) fail('Python dependency installation failed.');
  return venvPython;
}

function openBrowser(url) {
  try {
    let child;
    if (IS_WIN) child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_) {
    // The URL is printed below even if no browser command is available.
  }
}

async function main() {
  log('Booting local stack...');
  const env = ensureLocalEnv();
  await ensureDocker();
  await ensureSearxng(env);
  await ensureOllama(env);
  const python = ensurePythonEnvironment();

  log(`Starting Hunter: ${HUNTER_URL}`);
  const hunter = spawn(python, ['-m', 'opportunity_hunter.server'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: false,
  });

  let shuttingDown = false;
  const stopHunter = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!hunter.killed) hunter.kill(signal || 'SIGTERM');
  };
  process.on('SIGINT', () => stopHunter('SIGINT'));
  process.on('SIGTERM', () => stopHunter('SIGTERM'));

  for (let i = 0; i < 45; i += 1) {
    if (hunter.exitCode !== null) fail(`Hunter exited early with code ${hunter.exitCode}.`);
    if (await requestOk(`${HUNTER_URL}/api/status`)) {
      log(`Everything is ready. Opening ${HUNTER_URL}`);
      openBrowser(HUNTER_URL);
      break;
    }
    await sleep(1000);
  }

  hunter.on('exit', code => {
    process.exit(code === null ? 0 : code);
  });
}

main().catch(error => fail(error?.stack || String(error)));
