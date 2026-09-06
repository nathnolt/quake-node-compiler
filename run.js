import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import readline from 'readline';
import { execSync, execFileSync, spawn } from 'child_process';

const DEFAULT_TOOLS_VERSION = 'v0.18.1';
const COMMON_ENGINES = ['quakespasm', 'ironwail', 'joequake', 'vkquake', 'fteqw', 'darkplaces'];

// Helper to verify if a file is an actual executable by extension, permissions, and magic bytes
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

    if (os.platform() === 'win32') {
      return buffer[0] === 0x4D && buffer[1] === 0x5A;
    }

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

// CLI Prompt Helper
function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

// User selection helper
async function chooseFromList(promptText, items) {
  console.log(`\n${promptText}`);
  items.forEach((item, index) => console.log(` [${index + 1}] ${item}`));
  while (true) {
    const choice = await askQuestion(`Select an option (1-${items.length}): `);
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= items.length) {
      return items[num - 1];
    }
    console.log('Invalid selection. Try again.');
  }
}

// INI Parser & Serializer
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
        result[currentSection][trimmed] = true;
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
      if (v === true) {
        output += `${k}\n`;
      } else {
        output += `${k}=${v}\n`;
      }
    }
    output += '\n';
  }
  return output;
}

// Find highest root folder containing "id1"
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

  if (!highestId1Dir) {
    throw new Error('Could not find any directory containing an "id1" folder in the path tree.');
  }
  return highestId1Dir;
}

// BFS traversal across folders
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
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'compile') {
          queue.push(fullPath);
        }
      }
      if (matchFn(entry, fullPath)) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
}

// Find newest .map file (ignoring any inside compile folders)
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

// Downloads
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
  } else {
    execSync(`tar -xf "${zipPath}" -C "${targetDir}"`, { stdio: 'inherit' });
  }
}

// Search for validated qbsp binary
async function locateToolsDirectory(rootDir) {
  const ext = os.platform() === 'win32' ? '.exe' : '';
  const qbspName = `qbsp${ext}`.toLowerCase();

  console.log('Searching for valid qbsp build tools executable...');
  const foundExecutables = findMatchesBFS(rootDir, (entry, fullPath) => {
    return entry.isFile() && entry.name.toLowerCase() === qbspName && isExecutableFile(fullPath);
  });

  const candidateDirs = [...new Set(foundExecutables.map(filePath => path.dirname(filePath)))];

  if (candidateDirs.length === 1) {
    console.log(`Found build tools in: ${candidateDirs[0]}`);
    return candidateDirs[0];
  }

  if (candidateDirs.length > 1) {
    return await chooseFromList('Multiple directories with qbsp found. Which build tools do you want to use?', candidateDirs);
  }

  console.log('No qbsp executable found. Downloading ericw-tools...');
  const toolsDir = path.join(rootDir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  const zipPath = path.join(toolsDir, 'ericw-tools.zip');
  await downloadFile(getDownloadUrl(), zipPath);
  extractZipNative(zipPath, toolsDir);
  fs.unlinkSync(zipPath);

  const newBinDir = path.join(toolsDir, `ericw-tools-${DEFAULT_TOOLS_VERSION}`, 'bin');
  
  if (os.platform() !== 'win32') {
    ['qbsp', 'vis', 'light'].forEach(bin => {
      const p = path.join(newBinDir, `${bin}${ext}`);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    });
  }

  return newBinDir;
}

// Game engine binary resolution
async function locateGameEngine(rootDir) {
  const engines = findMatchesBFS(rootDir, (entry, fullPath) => {
    if (!entry.isFile()) return false;
    
    const ext = path.extname(entry.name);
    const nameWithoutExt = path.basename(entry.name, ext).toLowerCase();

    if (!COMMON_ENGINES.includes(nameWithoutExt)) return false;

    return isExecutableFile(fullPath);
  });

  if (engines.length === 1) return engines[0];
  if (engines.length > 1) {
    return await chooseFromList('Multiple Quake game engines detected:', engines);
  }
  return '';
}

// Config setup & validation
async function ensureConfig(rootDir) {
  const configPath = path.join(rootDir, 'config.ini');
  const ext = os.platform() === 'win32' ? '.exe' : '';

  if (fs.existsSync(configPath)) {
    const configData = parseIni(fs.readFileSync(configPath, 'utf-8'));
    const toolsDir = configData.settings?.tools;
    const qbspPath = toolsDir ? path.join(toolsDir, `qbsp${ext}`) : '';

    if (toolsDir && isExecutableFile(qbspPath)) {
      console.log(`Loaded config: ${configPath}`);
      return configData;
    }

    console.log(`Warning: Configured tools path is invalid or missing executable qbsp. Re-scanning...`);
    const newToolsPath = await locateToolsDirectory(rootDir);
    configData.settings = configData.settings || {};
    configData.settings.tools = newToolsPath;
    
    fs.writeFileSync(configPath, stringifyIni(configData));
    console.log(`Updated config.ini with valid tools path: ${newToolsPath}`);
    return configData;
  }

  console.log('\n--- First-Time Setup: config.ini not found ---');
  const toolsPath = await locateToolsDirectory(rootDir);
  const runInput = await askQuestion('Should the engine auto-run after compilation? (true/false) [default: true]: ');
  const run = runInput.toLowerCase() === 'false' ? 'false' : 'true';

  let gamePath = '';
  if (run === 'true') {
    gamePath = await locateGameEngine(rootDir);
  }

  const modName = await askQuestion('Target Mod Name (leave blank for id1): ');

  const initialConfig = {
    settings: {
      tools: toolsPath,
      mod: modName,
      game: gamePath,
      output: '/built/',
      buildconfig: 'full',
      run: run
    },
    'config.full': {
      'qbsp {map}': true,
      'light {map}': true,
      'vis {map}': true
    },
    'config.qbsp': { '-bsp2': true },
    'config.light': { '-extra': true, '-soft': true },
    'config.vis': { '-fast': true }
  };

  fs.writeFileSync(configPath, stringifyIni(initialConfig));
  console.log(`Created config.ini at: ${configPath}`);
  return initialConfig;
}

function executeTool(executablePath, args) {
  console.log(`\n========================================`);
  console.log(`Executing: ${path.basename(executablePath)} ${args.join(' ')}`);
  console.log(`========================================\n`);

  try {
    execFileSync(executablePath, args, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Execution failed: ${path.basename(executablePath)}`);
    process.exit(1);
  }
}

async function main() {
  try {
    const rootDir = findQuakeRoot();
    process.chdir(rootDir);
    console.log(`Quake Root Path: ${rootDir}`);

    const config = await ensureConfig(rootDir);
    const mapFile = findNewestMapFile(rootDir);
    const mapName = path.basename(mapFile, '.map');
    const mapSourceDir = path.dirname(mapFile);
    
    console.log(`Map target: ${mapFile}`);

    // Create ./compile/mapname folder in the same directory where the .map file is located
    const compileDir = path.join(mapSourceDir, 'compile', mapName);
    fs.mkdirSync(compileDir, { recursive: true });

    // Copy original .map to the isolated compile directory
    const compileMapFile = path.join(compileDir, `${mapName}.map`);
    fs.copyFileSync(mapFile, compileMapFile);

    const toolsDir = config.settings.tools;
    const ext = os.platform() === 'win32' ? '.exe' : '';

    const pipeline = ['qbsp', 'light', 'vis'];
    for (const tool of pipeline) {
      const toolPath = path.join(toolsDir, `${tool}${ext}`);
      const flags = Object.keys(config[`config.${tool}`] || {});
      executeTool(toolPath, [...flags, compileMapFile]);
    }

    // Determine target mod directory (e.g. <rootDir>/id1/maps/)
    const targetMod = config.settings.mod || 'id1';
    const destinationDir = path.join(rootDir, targetMod, 'maps');
    fs.mkdirSync(destinationDir, { recursive: true });

    // Copy ONLY the generated .bsp file to the mod maps folder
    const bspFileName = `${mapName}.bsp`;
    const srcBspPath = path.join(compileDir, bspFileName);
    const destBspPath = path.join(destinationDir, bspFileName);

    if (fs.existsSync(srcBspPath)) {
      fs.copyFileSync(srcBspPath, destBspPath);
      console.log(`\nSuccessfully copied BSP: ${bspFileName} -> ${destinationDir}`);
    } else {
      throw new Error(`Compilation finished, but expected BSP file was not found at: ${srcBspPath}`);
    }

    if (config.settings.run === 'true') {
      const gameExec = config.settings.game;
      if (gameExec && fs.existsSync(gameExec)) {
        const gameArgs = ['+map', mapName];
        if (config.settings.mod) {
          gameArgs.unshift('-game', config.settings.mod);
        }
        console.log(`\nLaunching engine: ${gameExec} ${gameArgs.join(' ')}`);
        spawn(gameExec, gameArgs, { cwd: path.dirname(gameExec), detached: true, stdio: 'ignore' }).unref();
      } else {
        console.warn('Game engine executable missing or unconfigured. Skipping launch.');
      }
    }

    console.log('\nCompilation pipeline finished!');
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();