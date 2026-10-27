'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const ROOT = path.resolve(__dirname, '..');
const versionArg = process.argv[2] || '';
const version = versionArg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Usage: node tools/build-release.js vX.Y.Z [release|.release/version]');
const schema = Number(process.env.MARAND_RELEASE_SCHEMA || 2);
if (![1, 2].includes(schema)) throw new Error('MARAND_RELEASE_SCHEMA must be 1 or 2.');
const DEFAULT_OUT = path.join(ROOT, '.release', version);
const CI_OUT = path.join(ROOT, 'release');
const OUT = path.resolve(process.argv[3] || DEFAULT_OUT);
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const allowedOutputs = new Set([DEFAULT_OUT, CI_OUT].map(pathKey));
if (!allowedOutputs.has(pathKey(OUT))) throw new Error('Output must be the default version folder or the project release folder.');
for (let current = OUT; current !== ROOT; current = path.dirname(current)) {
  const relative = path.relative(ROOT, current);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Output folder must stay inside this project.');
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Output path cannot contain a symbolic link.');
}
const FILES = [
  'server.js', 'views.js', 'manage.js', 'package.json', 'schema.sql',
  'administracja/updater.js', 'administracja/restore-import.ps1',
  ...fs.readdirSync(path.join(ROOT, 'modules')).filter(file => file.endsWith('.js')).sort().map(file => path.posix.join('modules', file)),
  'INSTALL_SERVER.cmd', 'INSTALL_SERVER.ps1', 'SERVER_QUICKSTART.md', 'tools/build-release.js', 'tools/pack-finishing-import.py', 'tools/FINISHING_IMPORT.md',
  'administracja/control-server.ps1', 'administracja/run-server.ps1', 'administracja/set-github-token.ps1',
  'administracja/backup_scheduled.ps1', 'administracja/wykonaj.ps1', 'administracja/KOPIA.cmd',
  'administracja/AKTUALIZUJ.cmd', 'administracja/START_SERVER.cmd', 'administracja/STOP_SERVER.cmd', 'administracja/STATUS_SERVER.cmd',
  'administracja/SET_GITHUB_TOKEN.cmd', 'administracja/konfiguracja.przyklad.json',
  'NODE_SETUP.md', 'static/app.css', 'static/app.js', 'static/card.css', 'static/logo.jpg', 'seed/data.json',
];

async function copyFile(relative) {
  const from = path.join(ROOT, relative), to = path.join(OUT, relative);
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) throw new Error(`Required release file is missing: ${relative}`);
  if (path.extname(relative).toLowerCase() === '.ps1') {
    const contents = await fsp.readFile(from);
    if (!contents.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
      throw new Error(`PowerShell release scripts must be saved as UTF-8 with BOM for Windows PowerShell 5.1: ${relative}`);
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(contents.subarray(UTF8_BOM.length));
    } catch {
      throw new Error(`PowerShell release script is not valid UTF-8: ${relative}`);
    }
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
}
async function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const results = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in a release: ${full}`);
    if (entry.isDirectory()) results.push(...await filesUnder(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}
async function main() {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });
  for (const file of FILES) await copyFile(file);
  const packagePath = path.join(OUT, 'package.json');
  const packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
  packageJson.version = version;
  await fsp.writeFile(packagePath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(OUT, version), `${version}\n`, 'utf8');
  const packaged = await filesUnder(OUT);
  const manifest = {
    version,
    schema,
    protocol: 2,
    runtime: 'node>=24.15',
    files: Object.fromEntries(await Promise.all(packaged.map(async file => {
      const relative = path.relative(OUT, file).split(path.sep).join('/');
      const digest = crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
      return [relative, digest];
    }))),
  };
  await fsp.writeFile(path.join(OUT, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Release files prepared: ${OUT} (${packaged.length} files, v${version})`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
