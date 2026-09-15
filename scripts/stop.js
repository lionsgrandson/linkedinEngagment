const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function run(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
}

console.log('[Opportunity Hunter] Stopping SearXNG...');
const result = run('docker', ['compose', '-f', 'docker-compose.yml', 'down']);
if (result.status !== 0) {
  console.error('[Opportunity Hunter] Could not stop the Docker stack.');
  process.exit(result.status || 1);
}
console.log('[Opportunity Hunter] SearXNG stopped. Ollama is left running because other local apps may use it.');
