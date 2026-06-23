const els = {
  cpuTemp: document.getElementById('cpuTemp'),
  diskTemp: document.getElementById('diskTemp'),
  fanStatus: document.getElementById('fanStatus'),
  platform: document.getElementById('platform'),
  sampleInterval: document.getElementById('sampleInterval'),
  fanList: document.getElementById('fanList'),
  fanStatusList: document.getElementById('fanStatusList'),
  message: document.getElementById('message'),
  form: document.getElementById('settings'),
  sampleNow: document.getElementById('sampleNow'),
  chart: document.getElementById('chart'),
  modeDisabled: document.getElementById('modeDisabled'),
  modeAuto: document.getElementById('modeAuto'),
  modeManualOn: document.getElementById('modeManualOn'),
  modeManualOff: document.getElementById('modeManualOff'),
  autoSettings: document.getElementById('autoSettings'),
  sampleIntervalCard: document.getElementById('sampleIntervalCard'),
  intervalModal: document.getElementById('intervalModal'),
  modalInterval: document.getElementById('modalInterval'),
  modalCancel: document.querySelector('.modal-cancel'),
  modalOk: document.querySelector('.modal-ok'),
};

let historyData = [];
let appConfig = {};
let refreshTimer = null;
let cpuPopupItems = [];
let diskPopupItems = [];
let toastTimer = null;

function showToast(msg, duration) {
  duration = duration || 2200;
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, duration);
}

function fmtTemp(v) {
  return Number.isFinite(v) ? v.toFixed(1) + ' °C' : '--';
}

async function api(path, options) {
  options = options || {};
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    method: options.method || 'GET',
    body: options.body
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function setForm(config) {
  appConfig = config;
  const radio = document.querySelector('input[name="mode"][value="' + config.mode + '"]');
  if (radio) radio.checked = true;
  toggleModePanels(config.mode);
  for (const [key, value] of Object.entries(config)) {
    const input = els.form.elements[key];
    if (input && input.type !== 'radio') {
      if (key === 'sampleIntervalMs') {
        input.value = Math.round(value / 1000);
      } else {
        input.value = value;
      }
    }
  }
}

function toggleModePanels(mode) {
  els.autoSettings.classList.toggle('hidden', mode !== 'auto');
}

function updateStatusUI(config, state) {
  if (!config) return;
  const modeNames = { disabled: '默认', auto: '自动', 'manual-on': '常开', 'manual-off': '常关' };
  const modeClasses = { disabled: 'pill-disabled', auto: 'pill-auto', 'manual-on': 'pill-manual-on', 'manual-off': 'pill-manual-off' };
  els.fanStatus.textContent = modeNames[config.mode] || config.mode;
  els.fanStatus.className = 'status-pill ' + (modeClasses[config.mode] || 'pill-disabled');

  const th = document.getElementById('thresholdHint');
  if (th) {
    if (config.mode === 'auto') {
      th.style.display = '';
      th.innerHTML = '开启 <b id="cpuOnLabel">' + fmtTemp(config.cpuFanOnC) + '</b> / 关闭 <b id="cpuOffLabel">' + fmtTemp(config.cpuFanOffC) + '</b>';
    } else if (config.mode === 'disabled') {
      th.style.display = '';
      th.textContent = '由系统控制';
    } else if (config.mode === 'manual-on') {
      th.style.display = '';
      th.textContent = '风扇一直全速';
    } else if (config.mode === 'manual-off') {
      th.style.display = '';
      th.textContent = '风扇一直停止';
    }
  }

  const fanIcon = document.getElementById('fanIcon');
  if (!fanIcon) return;
  fanIcon.classList.remove('fan-on', 'fan-off');
  if (state && state.fanPwm > 0) {
    fanIcon.classList.add('fan-on');
    fanIcon.title = '风扇运转中';
  } else if (state && state.fanPwm === 0) {
    fanIcon.classList.add('fan-off');
    fanIcon.title = '风扇停止';
  } else {
    fanIcon.classList.add('fan-off');
    fanIcon.title = '系统自动控扇';
  }
}

function drawChart() {
  const canvas = els.chart;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(680, Math.floor(rect.width * dpr));
  canvas.height = Math.floor(360 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const pad = { l: 52, r: 20, t: 22, b: 38 };
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const values = historyData.flatMap(p => [p.cpu, p.disk]).filter(Number.isFinite);
  const max = Math.max(80, Math.ceil(Math.max.apply(null, values.concat([60])) / 10) * 10);
  const min = 0;
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const xFor = i => pad.l + (historyData.length <= 1 ? 0 : (i / (historyData.length - 1)) * plotW);
  const yFor = v => pad.t + (1 - (v - min) / (max - min)) * plotH;

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  for (let t = 0; t <= max; t += 10) {
    const y = yFor(t);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(t + '°', 12, y + 4);
  }

  function line(key, color) {
    const points = [];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    historyData.forEach((p, i) => {
      const v = p[key];
      if (!Number.isFinite(v)) return;
      const x = xFor(i);
      const y = yFor(v);
      points.push({ x, y });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = color;
    points.forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  line('cpu', '#e54b4b');
  line('disk', '#2563eb');
}

function renderSensors(state) {
  const fans = (state.fans || []);
  els.fanList.innerHTML = fans.length
    ? fans.map(f => '<li>' + (f.label || f.id || '风扇') + (f.currentPwm !== null ? ' / PWM=' + f.currentPwm : '') + '</li>').join('')
    : '<li>未检测到可控制的风扇。可能需要 root 权限。</li>';
  // 动态显示/隐藏风扇提示
  const fanHint = document.querySelector('.fan-list-section .fan-hint');
  if (fanHint) fanHint.style.display = fans.length > 0 ? '' : 'none';
}

// ===== 温度卡片悬浮弹窗（事件绑定一次）=====
function initPopupListeners() {
  const cpuCard = document.getElementById('cpuCard');
  const cpuPopup = document.getElementById('cpuPopup');
  if (cpuCard && cpuPopup) {
    cpuCard.addEventListener('mouseenter', () => {
      if (cpuPopupItems.length === 0) return;
      cpuPopup.innerHTML = '<ul>' + cpuPopupItems.map(x => '<li>' + x + '</li>').join('') + '</ul>';
      cpuPopup.classList.add('show');
    });
    cpuCard.addEventListener('mouseleave', () => {
      cpuPopup.classList.remove('show');
    });
  }

  const diskCard = document.getElementById('diskCard');
  const diskPopup = document.getElementById('diskPopup');
  if (diskCard && diskPopup) {
    diskCard.addEventListener('mouseenter', () => {
      if (diskPopupItems.length === 0) return;
      diskPopup.innerHTML = '<ul>' + diskPopupItems.map(x => '<li>' + x + '</li>').join('') + '</ul>';
      diskPopup.classList.add('show');
    });
    diskCard.addEventListener('mouseleave', () => {
      diskPopup.classList.remove('show');
    });
  }
}

function updatePopups(state) {
  if (!state) return;
  cpuPopupItems = [];
  diskPopupItems = [];
  (state.sensors && state.sensors.cpu || []).forEach(s => {
    cpuPopupItems.push((s.label || s.chip || 'CPU') + '：' + fmtTemp(s.temp));
  });
  (state.sensors && state.sensors.disks || []).forEach(d => {
    diskPopupItems.push(d.label + '：' + fmtTemp(d.temp) + (d.error ? '（' + d.error + '）' : ''));
  });
}

async function refresh() {
  const [status, hist] = await Promise.all([api('/api/status'), api('/api/history?limit=360')]);
  historyData = hist;
  const latest = status.latest || {};
  els.cpuTemp.textContent = fmtTemp(latest.cpu);
  els.diskTemp.textContent = fmtTemp(latest.disk);
  updateStatusUI(status.config, status.state);
  els.platform.textContent = '平台：' + ((status.state && status.state.platform) || 'unknown');
  els.sampleInterval.textContent = Math.round((status.sampleIntervalMs || 1000) / 1000) + ' 秒';
  renderSensors(status.state);
  updatePopups(status.state);
  drawChart();

  const errEl = document.getElementById('fanError');
  if (errEl) {
    if (status.state && status.state.lastError) {
      errEl.textContent = '⚠️ ' + status.state.lastError;
      errEl.style.display = '';
    } else {
      errEl.textContent = '';
      errEl.style.display = 'none';
    }
  }
}

// ===== 事件绑定 =====

// 双击采样间隔卡片 → 弹出设置弹窗
if (els.sampleIntervalCard) {
  els.sampleIntervalCard.addEventListener('dblclick', () => {
    const sec = appConfig.sampleIntervalMs ? Math.round(appConfig.sampleIntervalMs / 1000) : 1;
    els.modalInterval.value = sec;
    els.intervalModal.style.display = 'flex';
    els.modalInterval.focus();
  });
}
// 点击遮罩关闭弹窗
if (els.intervalModal) {
  els.intervalModal.addEventListener('click', e => {
    if (e.target === els.intervalModal) {
      els.intervalModal.style.display = 'none';
    }
  });
}
// 弹窗：取消
if (els.modalCancel) {
  els.modalCancel.addEventListener('click', () => {
    els.intervalModal.style.display = 'none';
  });
}
// 弹窗：保存采样间隔
if (els.modalOk) {
  els.modalOk.addEventListener('click', async () => {
    const sec = Number(els.modalInterval.value);
    if (!Number.isInteger(sec) || sec < 1 || sec > 600) {
      alert('请输入 1～600 之间的整数');
      return;
    }
    try {
      const data = { sampleIntervalMs: sec * 1000 };
      const result = await api('/api/config', { method: 'POST', body: JSON.stringify(data) });
      Object.assign(appConfig, result.config);
      els.sampleInterval.textContent = sec + ' 秒';
      els.intervalModal.style.display = 'none';
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  });
}

// 模式切换
['modeDisabled', 'modeAuto', 'modeManualOn', 'modeManualOff'].forEach(id => {
  const el = els[id];
  if (!el) return;
  el.addEventListener('change', async () => {
    if (!el.checked) return;
    toggleModePanels(el.value);
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ mode: el.value }) });
      await refresh();
    } catch (err) {
      showToast('切换模式失败：' + err.message);
    }
  });
});

// 保存设置（阈值）
els.form.addEventListener('submit', async e => {
  e.preventDefault();
  const data = {};
  new FormData(els.form).forEach((value, key) => { data[key] = value; });
  ['cpuFanOnC', 'cpuFanOffC'].forEach(key => { data[key] = Number(data[key]); });
  try {
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(data) });
    setForm(result.config);
    showToast('已保存');
  } catch (err) {
    showToast('保存失败：' + err.message);
  }
});

// 立即采样
els.sampleNow.addEventListener('click', async () => {
  els.sampleNow.disabled = true;
  try {
    await api('/api/sample', { method: 'POST', body: '{}' });
    await refresh();
  } finally {
    setTimeout(() => { els.sampleNow.disabled = false; }, 3000);
  }
});

window.addEventListener('resize', drawChart);

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', () => {
  initPopupListeners();
  refresh().then(() => {
    return api('/api/config');
  }).then(cfg => {
    setForm(cfg);
  }).catch(err => { showToast('加载失败：' + err.message); });
  refreshTimer = setInterval(() => refresh().catch(() => {}), 1000);
});
