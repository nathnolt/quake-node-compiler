import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import readline from 'readline';
import { execSync, execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);

const DEFAULT_TOOLS_VERSION = 'v0.18.1';
const COMMON_ENGINES = ['quakespasm', 'ironwail', 'joequake', 'vkquake', 'fteqw', 'darkplaces'];

// Configuration structure with inline profile pipelines and arguments
const DEFAULT_CONFIG = {
  settings: {
    tools: '',
    mod: 'id1',
    game: '',
    profile: 'medium',
    run: 'true'
  },
  'profile:fast': {
    qbsp: '-bsp2',
    light: '-fast',
    vis: '-fast'
  },
  'profile:medium': {
    qbsp: '-bsp2',
    light: '-bounce 1',
    vis: ''
  },
  'profile:prod': {
    qbsp: '-bsp2',
    light: '-extra -soft -bounce 2',
    vis: '-level 4'
  },
  'profile:qbsp': {
    qbsp: '-bsp2'
  }
};


main()

function isExecutableFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const ignoredExts = ['.txt', '.html', '.htm', '.md', '.png', '.jpg', '.cfg', '.pak', '.bsp', '.map', '.lit', '.vis', '.log', '.zip', '.rar', '.7z', '.json', '.ini', '.pdf', '.doc', '.cpp', '.h', '.o'];
  if (ignoredExts.includes(ext)) return false;

  if (os.platform() === 'win32' && ext !== '.exe') return false;

  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
  } catch {
    return false;
  }

  if (os.platform() !== 'win32') {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
    } catch {
      return false;
    }
  }

  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);

    if (os.platform() === 'win32') return buffer[0] === 0x4D && buffer[1] === 0x5A;

    const isElf = buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46;
    const magicBE = buffer.readUInt32BE(0);
    const magicLE = buffer.readUInt32LE(0);
    const machOMagics = [0xFEEDFACE, 0xCEFAEDFE, 0xFEEDFACF, 0xCFFAEDFE, 0xCAFEBABE, 0xBEBAFECA];
    const isMachO = machOMagics.includes(magicBE) || machOMagics.includes(magicLE);

    return isElf || isMachO;
  } catch {
    return false;
  }
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function chooseFromList(promptText, items) {
  console.log(`\n${promptText}`);
  items.forEach((item, index) => console.log(` [${index + 1}] ${item}`));
  while (true) {
    const choice = await askQuestion(`Select an option (1-${items.length}): `);
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= items.length) return items[num - 1];
    console.log('Invalid selection. Try again.');
  }
}

function parseIni(content) {
  const result = {};
  let currentSection = 'default';
  
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1).trim();
      result[currentSection] = result[currentSection] || {};
    } else {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex !== -1) {
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        result[currentSection] = result[currentSection] || {};
        result[currentSection][key] = value;
      } else {
        result[currentSection] = result[currentSection] || {};
        result[currentSection][trimmed] = '';
      }
    }
  });
  return result;
}

function stringifyIni(data) {
  let output = '';
  for (const [section, keys] of Object.entries(data)) {
    output += `[${section}]\n`;
    for (const [k, v] of Object.entries(keys)) {
      output += v ? `${k} = ${v}\n` : `${k} =\n`;
    }
    output += '\n';
  }
  return output;
}

function mergeWithDefaults(userConfig) {
  let modified = false;
  const merged = JSON.parse(JSON.stringify(userConfig || {}));

  for (const [section, keys] of Object.entries(DEFAULT_CONFIG)) {
    if (!merged[section]) {
      merged[section] = JSON.parse(JSON.stringify(keys));
      modified = true;
      continue;
    }

    for (const [k, v] of Object.entries(keys)) {
      if (merged[section][k] === undefined) {
        merged[section][k] = v;
        modified = true;
        console.log(`Restored missing config option: [${section}] -> ${k}=${v}`);
      }
    }
  }

  return { config: merged, modified };
}

function createDefaultConfig(configPath, overrides = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (overrides.settings) {
    Object.assign(config.settings, overrides.settings);
  }

  fs.writeFileSync(configPath, stringifyIni(config));
  console.log(`Created default config.ini at: ${configPath}`);
  return config;
}

async function loadParseConfig(rootDir) {
  const configPath = path.join(SCRIPT_DIR, 'config.ini');
  const ext = os.platform() === 'win32' ? '.exe' : '';

  if (!fs.existsSync(configPath)) {
    console.log('\n--- First-Time Setup: config.ini not found ---');
    const toolsPath = await locateToolsDirectory(rootDir);
    const runInput = await askQuestion('Should the engine auto-run after compilation? (true/false) [default: true]: ');
    const run = runInput.toLowerCase() === 'false' ? 'false' : 'true';
    const gamePath = run === 'true' ? await locateGameEngine(rootDir) : '';
    const modName = await askQuestion('Target Mod Name (leave blank for id1): ');

    return createDefaultConfig(configPath, {
      settings: {
        tools: toolsPath,
        game: gamePath,
        mod: modName || 'id1',
        run: run
      }
    });
  }

  console.log(`Loading config from: ${configPath}`);
  const rawContent = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseIni(rawContent);

  let { config, modified } = mergeWithDefaults(parsed);

  const toolsDir = config.settings.tools;
  const qbspPath = toolsDir ? path.join(toolsDir, `qbsp${ext}`) : '';

  if (!toolsDir || !isExecutableFile(qbspPath)) {
    console.log(`\nWarning: Configured tools path is invalid or missing qbsp executable. Re-scanning...`);
    const newToolsPath = await locateToolsDirectory(rootDir);
    config.settings.tools = newToolsPath;
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(configPath, stringifyIni(config));
    console.log(`Updated config.ini with default values.`);
  }

  return config;
}

function findQuakeRoot(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);
  let highestId1Dir = null;

  while (true) {
    const id1Path = path.join(currentDir, 'id1');
    if (fs.existsSync(id1Path) && fs.statSync(id1Path).isDirectory()) {
      highestId1Dir = currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  if (!highestId1Dir) throw new Error('Could not find any directory containing an "id1" folder.');
  return highestId1Dir;
}

function findMatchesBFS(rootDir, matchFn) {
  const matches = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'compile') {
        queue.push(fullPath);
      }
      if (matchFn(entry, fullPath)) matches.push(fullPath);
    }
  }
  return matches;
}

function findNewestMapFile(dir) {
  let newestFile = null;
  let newestMtime = 0;

  function scan(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory() && entry.name !== 'tools' && entry.name !== 'compile' && !entry.name.startsWith('.')) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.map')) {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs > newestMtime) {
          newestMtime = stats.mtimeMs;
          newestFile = fullPath;
        }
      }
    }
  }

  scan(dir);
  if (!newestFile) throw new Error(`No .map files found within ${dir}`);
  return newestFile;
}

function getDownloadUrl() {
  const platform = os.platform();
  const arch = os.arch();
  let filename = '';

  if (platform === 'linux') filename = `ericw-tools-${DEFAULT_TOOLS_VERSION}-Linux.zip`;
  else if (platform === 'win32') filename = arch === 'x64' ? `ericw-tools-${DEFAULT_TOOLS_VERSION}-win64.zip` : `ericw-tools-${DEFAULT_TOOLS_VERSION}-win32.zip`;
  else if (platform === 'darwin') filename = `ericw-tools-${DEFAULT_TOOLS_VERSION}-Darwin.zip`;
  else throw new Error(`Unsupported platform: ${platform}`);

  return `https://github.com/ericwa/ericw-tools/releases/download/${DEFAULT_TOOLS_VERSION}/${filename}`;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = (targetUrl) => {
      https.get(targetUrl, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return request(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`Failed to download: Status ${res.statusCode}`));
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => fs.unlink(destPath, () => reject(err)));
    };
    request(url);
  });
}

function extractZipNative(zipPath, targetDir) {
  if (os.platform() === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`, { stdio: 'inherit' });
    return;
  }

  try {
    execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'inherit' });
  } catch {
    try {
      execSync(`python3 -m zipfile -e "${zipPath}" "${targetDir}"`, { stdio: 'inherit' });
    } catch {
      try {
        execSync(`7z x -y "${zipPath}" -o"${targetDir}"`, { stdio: 'inherit' });
      } catch (err) {
        throw new Error(`Failed to extract zip file. Please install 'unzip' or 'python3'. Details: ${err.message}`);
      }
    }
  }
}

async function locateToolsDirectory(rootDir) {
  const ext = os.platform() === 'win32' ? '.exe' : '';
  const qbspName = `qbsp${ext}`.toLowerCase();

  console.log('Searching for valid qbsp build tools executable...');
  let foundExecutables = findMatchesBFS(rootDir, (entry, fullPath) => {
    return entry.isFile() && entry.name.toLowerCase() === qbspName && isExecutableFile(fullPath);
  });

  let candidateDirs = [...new Set(foundExecutables.map(filePath => path.dirname(filePath)))];

  if (candidateDirs.length === 1) return candidateDirs[0];
  if (candidateDirs.length > 1) return await chooseFromList('Multiple directories with qbsp found:', candidateDirs);

  console.log('No qbsp executable found. Downloading ericw-tools...');
  const toolsDir = path.join(rootDir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  const zipPath = path.join(toolsDir, 'ericw-tools.zip');
  await downloadFile(getDownloadUrl(), zipPath);
  
  console.log('Extracting ericw-tools archive...');
  extractZipNative(zipPath, toolsDir);
  fs.unlinkSync(zipPath);

  const extractedFiles = findMatchesBFS(toolsDir, (entry) => entry.isFile() && entry.name.toLowerCase() === qbspName);
  if (extractedFiles.length === 0) {
    throw new Error(`Extraction failed: qbsp executable was not found inside ${toolsDir}`);
  }

  const extractedBinDir = path.dirname(extractedFiles[0]);

  if (os.platform() !== 'win32') {
    ['qbsp', 'vis', 'light', 'bsputil'].forEach(bin => {
      const p = path.join(extractedBinDir, bin);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    });
  }

  return extractedBinDir;
}

async function locateGameEngine(rootDir) {
  const engines = findMatchesBFS(rootDir, (entry, fullPath) => {
    if (!entry.isFile()) return false;
    const nameWithoutExt = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
    return COMMON_ENGINES.includes(nameWithoutExt) && isExecutableFile(fullPath);
  });

  if (engines.length === 1) return engines[0];
  if (engines.length > 1) return await chooseFromList('Multiple Quake game engines detected:', engines);
  return '';
}

function executeTool(executablePath, args, isMandatory = false, cwd = process.cwd()) {
  const toolName = path.basename(executablePath);
  console.log(`\n========================================`);
  console.log(`Running: ${toolName} ${args.join(' ')}`);
  console.log(`Working Directory: ${cwd}`);
  console.log(`========================================\n`);

  try {
    execFileSync(executablePath, args, { stdio: 'inherit', cwd });
    return true;
  } catch (err) {
    if (isMandatory) {
      console.error(`\n❌ FATAL ERROR: Mandatory step '${toolName}' failed. Build aborted.`);
      process.exit(1);
    } else {
      console.warn(`\n⚠️  WARNING: Tool '${toolName}' failed or crashed!`);
      console.warn(`👉 Action: Skipping '${toolName}' and proceeding with the build using existing artifacts.`);
      return false;
    }
  }
}

async function main() {
  try {
    const rootDir = findQuakeRoot();
    process.chdir(rootDir);
    console.log(`Quake Root Path: ${rootDir}`);
    console.log(`Script Directory: ${SCRIPT_DIR}`);

    const config = await loadParseConfig(rootDir);

    const cliArg = process.argv[2]?.toLowerCase();
    let profileName = config.settings.profile || 'medium';

    if (cliArg) {
      const aliases = {
        'all': 'prod',
        'full': 'prod',
        'production': 'prod',
        'qbsp_only': 'qbsp'
      };
      profileName = aliases[cliArg] || cliArg;
      console.log(`Profile override via CLI: '${cliArg}' -> target profile [${profileName}]`);
    }

    const mapFile = findNewestMapFile(rootDir);
    const mapName = path.basename(mapFile, '.map');

    console.log(`Map target: ${mapFile}`);
    
    
    const mapDir = path.dirname(mapFile);
    
    
    const compileDir = path.join(mapDir, 'compile', mapName);
    fs.mkdirSync(compileDir, { recursive: true });
    
    const compileMapFile = path.join(compileDir, `${mapName}.map`);
    fs.copyFileSync(mapFile, compileMapFile);

    const toolsDir = config.settings.tools;
    const ext = os.platform() === 'win32' ? '.exe' : '';
    const targetMod = config.settings.mod || 'id1';

    const profileSection = config[`profile:${profileName}`];
    
    if (!profileSection) {
      throw new Error(`Profile 'profile:${profileName}' is not defined in config.ini.`);
    }

    const pipelineTools = Object.keys(profileSection);
    console.log(`Active Profile: [${profileName}] -> Pipeline: ${pipelineTools.join(' -> ')}`);

    for (const [tool, flagString] of Object.entries(profileSection)) {
      const toolPath = path.join(toolsDir, `${tool}${ext}`);
      
      const userFlags = flagString ? flagString.trim().split(/\s+/).filter(Boolean) : [];

      const toolArgs = [...userFlags];
      if (targetMod !== 'id1' && !toolArgs.includes('-gamedir')) {
        toolArgs.push('-gamedir', targetMod);
      }
      toolArgs.push(compileMapFile);

      const isMandatory = tool === 'qbsp';
      executeTool(toolPath, toolArgs, isMandatory, rootDir);
    }

    const destinationDir = path.join(rootDir, targetMod, 'maps');
    fs.mkdirSync(destinationDir, { recursive: true });

    const bspFileName = `${mapName}.bsp`;
    const srcBspPath = path.join(compileDir, bspFileName);
    const destBspPath = path.join(destinationDir, bspFileName);

    if (fs.existsSync(srcBspPath)) {
      fs.copyFileSync(srcBspPath, destBspPath);
      console.log(`\nSuccessfully copied BSP: ${bspFileName} -> ${destinationDir}`);
    } else {
      throw new Error(`Expected BSP file was not found at: ${srcBspPath}`);
    }

    if (config.settings.run === 'true') {
      const gameExec = config.settings.game;
      if (gameExec && fs.existsSync(gameExec)) {
        const gameArgs = ['+map', mapName];
        if (config.settings.mod && config.settings.mod !== 'id1') {
          gameArgs.unshift('-game', config.settings.mod);
        }
        console.log(`\nLaunching engine: ${gameExec} ${gameArgs.join(' ')}`);
        spawn(gameExec, gameArgs, { cwd: rootDir, detached: true, stdio: 'ignore' }).unref();
      } else {
        console.warn('Game engine executable missing or unconfigured. Skipping launch.');
      }
    }

    console.log('\nCompilation completed!');
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}
