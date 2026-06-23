const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');

const PORT = Number(process.env.PORT || process.env.TRIM_SERVICE_PORT || 5066);
const APP_DEST = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const DATA_DIR = process.env.TRIM_PKGVAR || path.resolve(__dirname, 'data');
const STATIC_DIR = path.resolve(APP_DEST, 'www');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_POINTS = 1440;
const MIN_SAMPLE_INTERVAL_MS = 1000;
const MAX_SAMPLE_INTERVAL_MS = 600000;

const DEFAULT_CONFIG = {
  // 模式：disabled=不控制（恢复系统自动）；auto=根据温度自动；manual-on=风扇常开；manual-off=风扇常关
  mode: 'disabled',
  cpuFanOnC: 65,
  cpuFanOffC: 50,
  sampleIntervalMs: 1000,
  fans: [],
  notes: 'mode: disabled=不控制；auto=自动；manual-on=常开；manual-off=常关。'
};

let config = { ...DEFAULT_CONFIG };
let history = [];
let state = {
  platform: '',
  fanStatus: 'disabled',
  fanPwm: -1,        // 最后一次写入的 PWM 值（-1=未知，0=关闭，1~255=开启）
  lastAction: 'none',
  lastActionAt: 0,
  lastError: '',
  sensors: { cpu: [], disks: [] },
  fans: []
};

let tickTimer = null;

// ===== 工具函数 =====
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadAll() {
  ensureDataDir();
  config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  history = readJson(HISTORY_FILE, []);
  state = { ...state, ...readJson(STATE_FILE, {}) };
  // 迁移旧配置
  if (config.controlEnabled !== undefined) delete config.controlEnabled;
  if (config.manualOverride !== undefined) {
    if (config.manualOverride === 'on') config.mode = 'manual-on';
    else if (config.manualOverride === 'off') config.mode = 'manual-off';
    else config.mode = 'auto';
    delete config.manualOverride;
  }
  // 迁移旧 manual 模式（无 -on/-off 后缀）
  if (config.mode === 'manual') {
    // 根据旧的 manualPwm 值判断
    if (config.manualPwm === 0) config.mode = 'manual-off';
    else config.mode = 'manual-on';
    delete config.manualPwm;
  }
  if (config.manualPwm !== undefined) delete config.manualPwm;
  const VALID_MODES = ['disabled','auto','manual-on','manual-off'];
  if (!VALID_MODES.includes(config.mode)) config.mode = 'disabled';
}

function saveConfig() { ensureDataDir(); writeJson(CONFIG_FILE, config); }
function saveHistory() { ensureDataDir(); writeJson(HISTORY_FILE, history.slice(-MAX_POINTS)); }
function saveState() { ensureDataDir(); writeJson(STATE_FILE, state); }

// ===== 风扇检测与控制 =====

// 读取文件内容的工具函数
function readFileTrimmed(filePath, defaultVal) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw || defaultVal;
  } catch (e) {
    return defaultVal;
  }
}

function readIntFile(filePath) {
  try {
    return Number(fs.readFileSync(filePath, 'utf8').trim());
  } catch (e) {
    return null;
  }
}

function findThermalBinaryBinding(chipName) {
  const normalized = chipName.toLowerCase().replace(/_/g, '-');
  try {
    const entries = fs.readdirSync('/sys/class/thermal').filter(n => n.startsWith('cooling_device'));
    for (const dev of entries) {
      const devPath = '/sys/class/thermal/' + dev;
      const type = readFileTrimmed(devPath + '/type', '');
      if (type.toLowerCase().replace(/_/g, '-') !== normalized) continue;
      const maxState = readIntFile(devPath + '/max_state');
      if (maxState !== 1) continue;

      // 找到这个 cooling device 绑定的 thermal zone
      const zones = fs.readdirSync('/sys/class/thermal').filter(n => n.startsWith('thermal_zone'));
      for (const zone of zones) {
        const zonePath = '/sys/class/thermal/' + zone;
        const links = fs.readdirSync(zonePath).filter(n => /^cdev\d+$/.test(n));
        for (const link of links) {
          try {
            const linkPath = zonePath + '/' + link;
            const target = fs.readlinkSync(linkPath);
            if (target.includes(dev) || target === '../' + dev) {
              // 找到绑定的 trip point
              const tripIndex = readIntFile(zonePath + '/' + link + '_trip_point');
              if (tripIndex === null || tripIndex < 0) continue;
              const tripPrefix = zonePath + '/trip_point_' + tripIndex;
              const tripType = readFileTrimmed(tripPrefix + '_type', '');
              if (tripType !== 'active') continue;
              const tripPath = tripPrefix + '_temp';
              if (!fs.existsSync(tripPath)) continue;

              return {
                zonePath,
                zoneType: readFileTrimmed(zonePath + '/type', zone),
                tripPath,
                tripHystPath: tripPrefix + '_hyst',
                policyPath: zonePath + '/policy',
                policy: readFileTrimmed(zonePath + '/policy', ''),
                defaultTripTemp: readIntFile(tripPath), // 系统默认的 trip temp（毫摄氏度）
                coolingDevPath: devPath
              };
            }
          } catch (e) { continue; }
        }
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

function detectFanControls() {
  const fans = [];
  try {
    const hwmons = fs.readdirSync('/sys/class/hwmon').filter(n => n.startsWith('hwmon'));
    for (const hw of hwmons) {
      const base = path.join('/sys/class/hwmon', hw);
      const chipName = fs.existsSync(path.join(base, 'name'))
        ? fs.readFileSync(path.join(base, 'name'), 'utf8').trim() : hw;
      const pwmFiles = fs.readdirSync(base).filter(n => /^pwm\d+$/.test(n));
      for (const pwmFile of pwmFiles) {
        const pwmPath = path.join(base, pwmFile);
        const enablePath = path.join(base, pwmFile + '_enable');
        let currentPwm = null;
        try { currentPwm = Number(fs.readFileSync(pwmPath, 'utf8').trim()); } catch (e) {}

        // 检测是否是 thermal_binary 二态风扇（OES Plus gpio_fan）
        const binding = findThermalBinaryBinding(chipName);

        fans.push({
          id: hw + '_' + pwmFile,
          label: chipName + ' / ' + pwmFile,
          pwmPath,
          enablePath: fs.existsSync(enablePath) ? enablePath : null,
          currentPwm,
          // 新增：风扇控制类型
          controlType: binding ? 'thermal_binary' : 'pwm',
          thermalBinding: binding, // null 或 { zonePath, tripPath, defaultTripTemp, ...}
        });
      }
    }
  } catch (e) {
    state.lastError = '风扇检测失败：' + e.message;
  }
  return fans;
}

// 控制二态风扇（thermal_binary）：通过修改 thermal trip point 实现
// 开启 = 把 trip_temp 设为低温（如 40°C = 40000 mC），让内核认为"一直过热"
// 关闭 = 恢复系统默认的 trip_temp
function applyThermalBinaryFan(fan, turnOn) {
  const binding = fan.thermalBinding;
  if (!binding) {
    state.lastError = '缺少 thermal binding 信息';
    return false;
  }
  try {
    if (turnOn) {
      fs.writeFileSync(binding.tripPath, '40000');
    } else {
      const defaultTemp = binding.defaultTripTemp || 60000;
      fs.writeFileSync(binding.tripPath, String(defaultTemp));
    }
    state.lastError = '';
    return true;
  } catch (e) {
    state.lastError = e.message;
    return false;
  }
}

function applyFanPwm(pwmValue) {
  const fans = detectFanControls();
  if (!fans.length) {
    state.fanStatus = 'no-fan';
    state.fanPwm = -1;
    state.lastError = '未检测到可控制的风扇';
    return false;
  }
  state.fans = fans;
  let ok = 0, errMsg = '';

  for (const fan of fans) {
    try {
      if (fan.controlType === 'thermal_binary') {
        // 二态风扇：pwmValue > 0 = 开启，pwmValue == 0 = 关闭
        const turnOn = pwmValue > 0;
        if (applyThermalBinaryFan(fan, turnOn)) {
          ok++;
        } else {
          errMsg += fan.label + '：' + (state.lastError || '未知错误') + '；';
        }
      } else {
        // 普通 PWM 风扇：直接写 pwm 文件
        if (fan.enablePath) fs.writeFileSync(fan.enablePath, '1');
        fs.writeFileSync(fan.pwmPath, String(pwmValue));
        ok++;
      }
    } catch (e) {
      errMsg += fan.label + '：' + e.message + '；';
    }
  }

  if (ok > 0) {
    state.lastError = '';
    state.fanPwm = pwmValue;
    return true;
  }
  state.fanStatus = 'error';
  state.fanPwm = -1;
  state.lastError = errMsg || '所有风扇控制失败';
  return false;
}

function restoreSystemAuto() {
  const fans = detectFanControls();
  state.fans = fans;
  for (const fan of fans) {
    try {
      if (fan.controlType === 'thermal_binary') {
        // 二态风扇：恢复系统默认的 trip_temp
        const binding = fan.thermalBinding;
        if (binding && binding.defaultTripTemp) {
          fs.writeFileSync(binding.tripPath, String(binding.defaultTripTemp));
        }
      } else {
        // 普通 PWM 风扇：恢复系统自动模式
        if (fan.enablePath) {
          fs.writeFileSync(fan.enablePath, '2');
        }
      }
    } catch (e) {
      state.lastError = (state.lastError ? state.lastError + '；' : '') + fan.label + '：' + e.message;
    }
  }
  state.fanPwm = -1;
}

// ===== 温度采集 =====
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readSysfsThermal() {
  const items = [];
  try {
    const zonesRoot = '/sys/class/thermal';
    const zones = fs.readdirSync(zonesRoot).filter(n => n.startsWith('thermal_zone'));
    for (const zone of zones) {
      const base = path.join(zonesRoot, zone);
      const typeFile = path.join(base, 'type');
      const tempFile = path.join(base, 'temp');
      const type = fs.existsSync(typeFile) ? fs.readFileSync(typeFile, 'utf8').trim() : zone;
      const raw = fs.existsSync(tempFile) ? fs.readFileSync(tempFile, 'utf8').trim() : '';
      let temp = numberOrNull(raw);
      if (temp !== null && temp > 1000) temp = temp / 1000;
      if (temp !== null && temp > 0 && temp < 130) items.push({ label: type, temp });
    }
  } catch (e) {}
  return items;
}

async function readHwmonCpu() {
  const items = [];
  try {
    const root = '/sys/class/hwmon';
    const hwmons = fs.readdirSync(root).filter(n => n.startsWith('hwmon'));
    for (const hw of hwmons) {
      const base = path.join(root, hw);
      const nameFile = path.join(base, 'name');
      const chip = fs.existsSync(nameFile) ? fs.readFileSync(nameFile, 'utf8').trim() : hw;
      const files = fs.readdirSync(base).filter(n => /^temp\d+_input$/.test(n));
      for (const file of files) {
        const index = file.match(/^temp(\d+)_input$/);
        if (!index) continue;
        const labelFile = path.join(base, 'temp' + index[1] + '_label');
        const label = fs.existsSync(labelFile)
          ? fs.readFileSync(labelFile, 'utf8').trim() : chip + ' temp' + index[1];
        const raw = fs.readFileSync(path.join(base, file), 'utf8').trim();
        let temp = numberOrNull(raw);
        if (temp !== null && temp > 1000) temp = temp / 1000;
        if (temp !== null && temp > 0 && temp < 130) items.push({ label, chip, temp });
      }
    }
  } catch (e) {}
  return items;
}

async function readSmartctlDisks() {
  const disks = [];
  let list = [];
  try {
    const { stdout } = await promisify(require('child_process').execFile)('lsblk', ['-dn', '-o', 'NAME,TYPE'], { timeout: 5000 });
    list = stdout.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[1] === 'disk').map(p => '/dev/' + p[0]);
  } catch (e) {
    try {
      list = fs.readdirSync('/dev').filter(n => /^(sd[a-z]+|nvme\d+n\d+)$/.test(n)).map(n => '/dev/' + n);
    } catch (e2) {}
  }
  for (const dev of list.slice(0, 16)) {
    try {
      const { stdout } = await promisify(require('child_process').execFile)('smartctl', ['-A', dev], { timeout: 8000 });
      let temp = null;
      for (const line of stdout.split('\n')) {
        if (/Temperature_Celsius|Airflow_Temperature_Cel|Composite_Temperature/i.test(line)) {
          const nums = line.match(/(-?\d+)/g);
          if (nums && nums.length) temp = Number(nums[nums.length - 1]);
        }
        const nvme = line.match(/Temperature:\s+([0-9.]+)\s+Celsius/i);
        if (nvme) temp = Number(nvme[1]);
      }
      if (Number.isFinite(temp) && temp > 0 && temp < 130) {
        disks.push({ label: dev, temp, supportsTemp: true });
      } else {
        disks.push({ label: dev, temp: null, supportsTemp: false, error: 'temperature not supported' });
      }
    } catch (e) {
      disks.push({ label: dev, temp: null, supportsTemp: false, error: 'smartctl unavailable or permission denied' });
    }
  }
  return disks;
}

async function collectTemperatures() {
  const [thermal, hwmon, disks] = await Promise.all([readSysfsThermal(), readHwmonCpu(), readSmartctlDisks()]);
  const cpuCandidates = [].concat(hwmon, thermal).filter(i =>
    /cpu|core|package|x86_pkg|k10temp|zenpower|acpi|soc|thermal/i.test(i.label || i.chip || ''));
  const cpuSources = cpuCandidates.length ? cpuCandidates : [].concat(hwmon, thermal);
  const cpuTemps = cpuSources.map(i => i.temp).filter(Number.isFinite);
  const diskTemps = disks.filter(d => d.temp !== null).map(d => d.temp);

  const point = {
    ts: Date.now(),
    cpu: cpuTemps.length ? Math.max(...cpuTemps) : null,
    disk: diskTemps.length ? Math.max(...diskTemps) : null,
    cpuAvg: cpuTemps.length ? cpuTemps.reduce((a, b) => a + b, 0) / cpuTemps.length : null,
    diskAvg: diskTemps.length ? diskTemps.reduce((a, b) => a + b, 0) / diskTemps.length : null
  };
  state.sensors = { cpu: cpuSources, disks };
  history.push(point);
  history = history.slice(-MAX_POINTS);
  return point;
}

// ===== 核心风扇策略 =====
// 四种模式（互斥）：
//   disabled  ：不控制风扇，恢复系统自动模式
//   auto      ：根据 CPU 温度 + 滞回阈值自动开关风扇
//   manual-on ：风扇常开（PWM=255）
//   manual-off：风扇常关（PWM=0）
async function applyFanPolicy(point) {
  if (config.mode === 'disabled') {
    restoreSystemAuto();
    state.fanStatus = 'disabled';
    return;
  }

  if (config.mode === 'manual-on') {
    applyFanPwm(255);
    if (state.fanStatus !== 'manual-on') {
      state.fanStatus = 'manual-on';
      state.lastAction = '常开';
      state.lastActionAt = Date.now();
      saveState();
    }
    return;
  }

  if (config.mode === 'manual-off') {
    applyFanPwm(0);
    if (state.fanStatus !== 'manual-off') {
      state.fanStatus = 'manual-off';
      state.lastAction = '常关';
      state.lastActionAt = Date.now();
      saveState();
    }
    return;
  }

  // === auto 模式 ===
  const cpu = point.cpu;
  if (cpu === null) return;

  // 初始化：如果状态不是 auto-*，根据当前温度初始化
  const currentStatus = state.fanStatus;
  if (currentStatus !== 'auto-on' && currentStatus !== 'auto-off') {
    if (cpu >= config.cpuFanOnC) {
      applyFanPwm(255);
      state.fanStatus = 'auto-on';
      state.lastAction = 'auto init on: cpu=' + cpu.toFixed(1);
      state.lastActionAt = Date.now();
      saveState();
      return;
    } else {
      applyFanPwm(0);
      state.fanStatus = 'auto-off';
      state.lastAction = 'auto init off: cpu=' + cpu.toFixed(1);
      state.lastActionAt = Date.now();
      saveState();
      return;
    }
  }

  const isOn = state.fanStatus === 'auto-on';

  if (!isOn && cpu >= config.cpuFanOnC) {
    applyFanPwm(255);
    state.fanStatus = 'auto-on';
    state.lastAction = 'auto on: cpu=' + cpu.toFixed(1) + ' >= ' + config.cpuFanOnC;
    state.lastActionAt = Date.now();
    saveState();
  } else if (isOn && cpu <= config.cpuFanOffC) {
    applyFanPwm(0);
    state.fanStatus = 'auto-off';
    state.lastAction = 'auto off: cpu=' + cpu.toFixed(1) + ' <= ' + config.cpuFanOffC;
    state.lastActionAt = Date.now();
    saveState();
  }
  // 滞回区间：保持当前状态
}

async function tick() {
  try {
    const point = await collectTemperatures();
    await applyFanPolicy(point);
    saveHistory();
    saveState();
  } catch (err) {
    state.lastError = String(err.message || err);
    saveState();
  }
}

function restartTickTimer() {
  if (tickTimer) clearInterval(tickTimer);
  const interval = Math.max(MIN_SAMPLE_INTERVAL_MS,
    Math.min(config.sampleIntervalMs || 1000, MAX_SAMPLE_INTERVAL_MS));
  tickTimer = setInterval(tick, interval);
}

// ===== HTTP 服务 =====
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 64) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
  });
}

function safeJoin(base, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const full = path.resolve(base, clean || 'index.html');
  if (!full.startsWith(base)) return null;
  return full;
}

function serveStatic(req, res) {
  const file = safeJoin(STATIC_DIR, req.url || '/');
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function validateConfig(input) {
  const next = { ...config };
  if (Object.prototype.hasOwnProperty.call(input, 'mode')) {
    const VALID = ['disabled','auto','manual-on','manual-off'];
    if (!VALID.includes(input.mode)) throw new Error('mode 必须是 disabled/auto/manual-on/manual-off');
    next.mode = input.mode;
  }
  ['cpuFanOnC', 'cpuFanOffC'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = Number(input[key]);
      if (!Number.isFinite(value) || value < 0 || value > 120) throw new Error(key + ' must be 0-120');
      next[key] = value;
    }
  });
  if (next.cpuFanOffC >= next.cpuFanOnC) throw new Error('关闭阈值必须小于开启阈值（形成滞回区间）');
  if (Object.prototype.hasOwnProperty.call(input, 'sampleIntervalMs')) {
    const v = Number(input.sampleIntervalMs);
    if (!Number.isFinite(v) || v < MIN_SAMPLE_INTERVAL_MS || v > MAX_SAMPLE_INTERVAL_MS) {
      throw new Error('采样间隔需在 ' + (MIN_SAMPLE_INTERVAL_MS/1000) + '~' + (MAX_SAMPLE_INTERVAL_MS/1000) + ' 秒之间');
    }
    next.sampleIntervalMs = v;
  }
  if (input.fans !== undefined) next.fans = input.fans;
  return next;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname === '/api/status') {
      const latest = history[history.length - 1] || null;
      return sendJson(res, 200, { config, state, latest, sampleIntervalMs: config.sampleIntervalMs });
    }
    if (url.pathname === '/api/history') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 360), MAX_POINTS);
      return sendJson(res, 200, history.slice(-limit));
    }
    if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, config);
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const oldInterval = config.sampleIntervalMs;
      const oldMode = config.mode;
      config = validateConfig(body);

      // 模式切换时的副作用：立即执行并同步状态
      if (body.mode && body.mode !== oldMode) {
        if (body.mode === 'disabled') {
          restoreSystemAuto();
          state.fanStatus = 'disabled';
          state.lastAction = '禁用';
          state.lastActionAt = Date.now();
          saveState();
        }
        if (body.mode === 'manual-on') {
          applyFanPwm(255);
          state.fanStatus = 'manual-on';
          state.lastAction = '常开';
          state.lastActionAt = Date.now();
          saveState();
        }
        if (body.mode === 'manual-off') {
          applyFanPwm(0);
          state.fanStatus = 'manual-off';
          state.lastAction = '常关';
          state.lastActionAt = Date.now();
          saveState();
        }
        if (body.mode === 'auto') {
          const latest = history[history.length - 1] || null;
          const cpu = latest ? latest.cpu : null;
          if (cpu !== null && cpu >= config.cpuFanOnC) {
            applyFanPwm(255);
            if (state.fanStatus !== 'error' && state.fanStatus !== 'no-fan') {
              state.fanStatus = 'auto-on';
            }
          } else {
            applyFanPwm(0);
            if (state.fanStatus !== 'error' && state.fanStatus !== 'no-fan') {
              state.fanStatus = 'auto-off';
            }
          }
          state.lastAction = 'auto init: cpu=' + (cpu !== null ? cpu.toFixed(1) : 'null');
          state.lastActionAt = Date.now();
          saveState();
        }
      }

      saveConfig();
      if (config.sampleIntervalMs !== oldInterval) restartTickTimer();
      return sendJson(res, 200, { ok: true, config });
    }
    if (url.pathname === '/api/sample' && req.method === 'POST') {
      await tick();
      return sendJson(res, 200, { ok: true, latest: history[history.length - 1], state });
    }
    if (url.pathname === '/api/fans/detect' && req.method === 'POST') {
      const fans = detectFanControls();
      config.fans = fans;
      saveConfig();
      return sendJson(res, 200, { ok: true, fans });
    }
    return serveStatic(req, res);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: String(err.message || err) });
  }
});

// 启动
loadAll();
state.platform = os.arch() + '/' + os.platform();
const detectedFans = detectFanControls();
config.fans = detectedFans;
saveConfig();
state.fans = detectedFans;
tick();
restartTickTimer();

server.listen(PORT, '0.0.0.0', () => {
  console.log('fan monitor listening on ' + PORT);
});
