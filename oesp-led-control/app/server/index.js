const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const LED_BASE_PATH = '/sys/class/leds';
const CONFIG_PATH = '/var/apps/oesp-led-control/etc';

// 定义反向逻辑的LED列表（这些LED写入0时点亮，写入1时熄灭）
const REVERSED_LEDS = [
    'red:lan'
];

// 检查LED是否是反向逻辑
function isReversed(ledName) {
    return REVERSED_LEDS.includes(ledName);
}

// 转换显示值到实际写入值
function displayToActual(ledName, displayValue) {
    if (isReversed(ledName)) {
        return displayValue > 0 ? 0 : 1;
    }
    return displayValue;
}

// 转换实际读取值到显示值
function actualToDisplay(ledName, actualValue) {
    if (isReversed(ledName)) {
        return actualValue > 0 ? 0 : 1;
    }
    return actualValue;
}

// 检查当前时间是否在睡眠模式时间段内
function isSleepModeActive(sleepModeConfig) {
    if (!sleepModeConfig || !sleepModeConfig.enabled) {
        return false;
    }
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinute;
    
    let startTime = sleepModeConfig.startHour * 60 + sleepModeConfig.startMinute;
    let endTime = sleepModeConfig.endHour * 60 + sleepModeConfig.endMinute;
    
    // 处理跨天的情况（例如22:00到06:00）
    if (endTime <= startTime) {
        // 如果结束时间小于等于开始时间，说明是跨天
        return currentTime >= startTime || currentTime < endTime;
    } else {
        // 同一天的时间段
        return currentTime >= startTime && currentTime < endTime;
    }
}

// 保存LED状态用于睡眠模式结束后恢复
let savedLedState = null;

// 应用睡眠模式（关闭所有LED）
async function applySleepMode() {
    try {
        console.log('Applying sleep mode...');
        
        // 先保存当前状态
        if (!savedLedState) {
            const leds = [];
            const files = await fs.readdir(LED_BASE_PATH);
            
            for (const file of files) {
                const ledPath = path.join(LED_BASE_PATH, file);
                const stat = await fs.stat(ledPath);
                if (stat.isDirectory()) {
                    const brightnessPath = path.join(ledPath, 'brightness');
                    try {
                        const actualBrightness = parseInt(await fs.readFile(brightnessPath, 'utf8'));
                        leds.push({
                            name: file,
                            actualBrightness: actualBrightness
                        });
                    } catch (e) {}
                }
            }
            savedLedState = leds;
            console.log('Saved LED state for sleep mode');
        }
        
        // 关闭所有LED
        const files = await fs.readdir(LED_BASE_PATH);
        for (const file of files) {
            const ledPath = path.join(LED_BASE_PATH, file);
            const stat = await fs.stat(ledPath);
            if (stat.isDirectory()) {
                const brightnessPath = path.join(ledPath, 'brightness');
                try {
                    const actualValue = displayToActual(file, 0);
                    await fs.writeFile(brightnessPath, actualValue.toString());
                } catch (e) {}
            }
        }
        console.log('Sleep mode applied: all LEDs turned off');
    } catch (error) {
        console.error('Error applying sleep mode:', error);
    }
}

// 恢复睡眠模式前的LED状态
async function restoreLedState() {
    try {
        if (!savedLedState) {
            console.log('No saved LED state to restore');
            return;
        }
        
        console.log('Restoring LED state after sleep mode...');
        for (const led of savedLedState) {
            const brightnessPath = path.join(LED_BASE_PATH, led.name, 'brightness');
            try {
                await fs.writeFile(brightnessPath, led.actualBrightness.toString());
            } catch (e) {}
        }
        savedLedState = null;
        console.log('LED state restored');
    } catch (error) {
        console.error('Error restoring LED state:', error);
    }
}

// 加载睡眠模式配置
async function loadSleepModeConfig() {
    try {
        const configPath = path.join(CONFIG_PATH, 'sleep-mode.json');
        const data = await fs.readFile(configPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // 默认配置
        return {
            enabled: false,
            startHour: 22,
            startMinute: 0,
            endHour: 6,
            endMinute: 0
        };
    }
}

// 保存睡眠模式配置
async function saveSleepModeConfig(config) {
    try {
        await fs.mkdir(CONFIG_PATH, { recursive: true });
        const configPath = path.join(CONFIG_PATH, 'sleep-mode.json');
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving sleep mode config:', error);
        return false;
    }
}

// 睡眠模式检查定时器
let sleepModeInterval = null;
let sleepModeActive = false;

// 启动睡眠模式检查
function startSleepModeCheck() {
    if (sleepModeInterval) {
        clearInterval(sleepModeInterval);
    }
    
    // 每分钟检查一次
    sleepModeInterval = setInterval(async () => {
        try {
            const config = await loadSleepModeConfig();
            const shouldBeActive = isSleepModeActive(config);
            
            if (shouldBeActive && !sleepModeActive) {
                sleepModeActive = true;
                await applySleepMode();
            } else if (!shouldBeActive && sleepModeActive) {
                sleepModeActive = false;
                await restoreLedState();
            }
        } catch (error) {
            console.error('Error in sleep mode check:', error);
        }
    }, 60 * 1000); // 每分钟检查
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'www')));

// 列出所有可用的 LED
app.get('/api/leds', async (req, res) => {
    try {
        const leds = [];
        const files = await fs.readdir(LED_BASE_PATH);
        
        for (const file of files) {
            const ledPath = path.join(LED_BASE_PATH, file);
            const stat = await fs.stat(ledPath);
            if (stat.isDirectory()) {
                const brightnessPath = path.join(ledPath, 'brightness');
                const maxBrightnessPath = path.join(ledPath, 'max_brightness');
                
                let actualBrightness = 0;
                let maxBrightness = 1;
                
                try {
                    actualBrightness = parseInt(await fs.readFile(brightnessPath, 'utf8'));
                } catch (e) {}
                
                try {
                    maxBrightness = parseInt(await fs.readFile(maxBrightnessPath, 'utf8'));
                } catch (e) {}
                
                const displayBrightness = actualToDisplay(file, actualBrightness);
                
                leds.push({
                    name: file,
                    brightness: displayBrightness,
                    actualBrightness: actualBrightness,
                    maxBrightness: maxBrightness,
                    on: displayBrightness > 0,
                    reversed: isReversed(file)
                });
            }
        }
        
        res.json({ success: true, leds });
    } catch (error) {
        console.error('Error listing LEDs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 控制单个 LED
app.post('/api/leds/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const { brightness, on } = req.body;
        
        // 如果在睡眠模式下，用户手动控制，则暂时禁用睡眠模式直到结束时间
        if (sleepModeActive) {
            // 不阻止用户手动控制，但是我们需要确保用户知道正在睡眠模式
            // 可以考虑添加一个标志，让用户知道
        }
        
        const ledPath = path.join(LED_BASE_PATH, name);
        const brightnessPath = path.join(ledPath, 'brightness');
        
        // 检查 LED 是否存在
        await fs.access(brightnessPath);
        
        let displayBrightness;
        if (typeof brightness !== 'undefined') {
            displayBrightness = brightness;
        } else if (typeof on !== 'undefined') {
            const maxBrightnessPath = path.join(ledPath, 'max_brightness');
            let maxBrightness = 1;
            try {
                maxBrightness = parseInt(await fs.readFile(maxBrightnessPath, 'utf8'));
            } catch (e) {}
            displayBrightness = on ? maxBrightness : 0;
        } else {
            return res.status(400).json({ success: false, error: 'Must provide brightness or on parameter' });
        }
        
        const actualBrightness = displayToActual(name, displayBrightness);
        await fs.writeFile(brightnessPath, actualBrightness.toString());
        
        res.json({ 
            success: true, 
            name, 
            brightness: displayBrightness,
            actualBrightness: actualBrightness,
            on: displayBrightness > 0,
            reversed: isReversed(name),
            sleepModeActive: sleepModeActive
        });
    } catch (error) {
        console.error('Error controlling LED:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 控制所有 LED
app.post('/api/leds', async (req, res) => {
    try {
        const { on, brightness } = req.body;
        const files = await fs.readdir(LED_BASE_PATH);
        const results = [];
        
        for (const file of files) {
            const ledPath = path.join(LED_BASE_PATH, file);
            const stat = await fs.stat(ledPath);
            if (stat.isDirectory()) {
                const brightnessPath = path.join(ledPath, 'brightness');
                
                try {
                    let displayBrightness;
                    if (typeof brightness !== 'undefined') {
                        displayBrightness = brightness;
                    } else if (typeof on !== 'undefined') {
                        const maxBrightnessPath = path.join(ledPath, 'max_brightness');
                        let maxBrightness = 1;
                        try {
                            maxBrightness = parseInt(await fs.readFile(maxBrightnessPath, 'utf8'));
                        } catch (e) {}
                        displayBrightness = on ? maxBrightness : 0;
                    }
                    
                    if (typeof displayBrightness !== 'undefined') {
                        const actualBrightness = displayToActual(file, displayBrightness);
                        await fs.writeFile(brightnessPath, actualBrightness.toString());
                        results.push({
                            name: file,
                            success: true,
                            brightness: displayBrightness,
                            actualBrightness: actualBrightness,
                            on: displayBrightness > 0,
                            reversed: isReversed(file)
                        });
                    }
                } catch (error) {
                    results.push({
                        name: file,
                        success: false,
                        error: error.message
                    });
                }
            }
        }
        
        res.json({ success: true, results, sleepModeActive: sleepModeActive });
    } catch (error) {
        console.error('Error controlling all LEDs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 恢复默认设置
app.post('/api/leds/reset', async (req, res) => {
    try {
        const files = await fs.readdir(LED_BASE_PATH);
        const results = [];
        
        // 为不同的 LED 设置不同的默认值，模拟系统默认行为
        const defaults = {
            'green:power': 1,
            'red:power': 0,
            'green:lan': 1,
            'red:lan': 0,
            'green:disk': 1,
            'green:disk_1': 1,
            'green:disk_2': 1
        };
        
        for (const file of files) {
            const ledPath = path.join(LED_BASE_PATH, file);
            const stat = await fs.stat(ledPath);
            if (stat.isDirectory()) {
                const brightnessPath = path.join(ledPath, 'brightness');
                
                try {
                    const maxBrightnessPath = path.join(ledPath, 'max_brightness');
                    let maxBrightness = 1;
                    try {
                        maxBrightness = parseInt(await fs.readFile(maxBrightnessPath, 'utf8'));
                    } catch (e) {}
                    
                    // 使用默认值，或者默认关闭
                    let displayBrightness = typeof defaults[file] !== 'undefined' 
                        ? defaults[file] * maxBrightness 
                        : 0;
                    
                    const actualBrightness = displayToActual(file, displayBrightness);
                    await fs.writeFile(brightnessPath, actualBrightness.toString());
                    
                    results.push({
                        name: file,
                        success: true,
                        brightness: displayBrightness,
                        actualBrightness: actualBrightness,
                        on: displayBrightness > 0,
                        reversed: isReversed(file)
                    });
                } catch (error) {
                    results.push({
                        name: file,
                        success: false,
                        error: error.message
                    });
                }
            }
        }
        
        // 删除临时配置文件
        const tmpfilesPath = '/etc/tmpfiles.d/oesp-led-control.conf';
        try {
            await fs.unlink(tmpfilesPath);
        } catch (e) {
            // 文件不存在是正常的
        }
        
        res.json({ success: true, results, message: '已恢复默认设置' });
    } catch (error) {
        console.error('Error resetting LEDs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 保存 LED 配置（永久设置）
app.post('/api/config', async (req, res) => {
    try {
        const { config } = req.body;
        const configPath = path.join(CONFIG_PATH, 'led-config.json');
        
        // 确保目录存在
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
        
        // 同时保存为 systemd-tmpfiles 配置，确保开机生效
        const tmpfilesPath = '/etc/tmpfiles.d/oesp-led-control.conf';
        let tmpfilesContent = '# OESP LED Control Configuration\n';
        
        for (const led of config.leds || []) {
            const brightnessPath = path.join(LED_BASE_PATH, led.name, 'brightness');
            const actualBrightness = displayToActual(led.name, led.brightness);
            tmpfilesContent += `w ${brightnessPath} - - - - ${actualBrightness}\n`;
        }
        
        try {
            await fs.writeFile(tmpfilesPath, tmpfilesContent);
        } catch (e) {
            console.warn('Could not write tmpfiles config:', e);
        }
        
        res.json({ success: true, message: '配置保存成功，下次重启后生效' });
    } catch (error) {
        console.error('Error saving config:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 加载 LED 配置
app.get('/api/config', async (req, res) => {
    try {
        const configPath = path.join(CONFIG_PATH, 'led-config.json');
        const configData = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(configData);
        
        res.json({ success: true, config });
    } catch (error) {
        if (error.code === 'ENOENT') {
            // 配置文件不存在，返回默认配置
            res.json({ success: true, config: { leds: [] } });
        } else {
            console.error('Error loading config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
});

// 获取睡眠模式配置
app.get('/api/sleep-mode', async (req, res) => {
    try {
        const config = await loadSleepModeConfig();
        res.json({ 
            success: true, 
            config: config,
            sleepModeActive: sleepModeActive,
            currentTime: new Date().toLocaleString()
        });
    } catch (error) {
        console.error('Error getting sleep mode config:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 保存睡眠模式配置
app.post('/api/sleep-mode', async (req, res) => {
    try {
        const config = req.body;
        await saveSleepModeConfig(config);
        
        // 立即检查是否需要应用睡眠模式
        if (isSleepModeActive(config) && !sleepModeActive) {
            sleepModeActive = true;
            await applySleepMode();
        } else if (!isSleepModeActive(config) && sleepModeActive) {
            sleepModeActive = false;
            await restoreLedState();
        }
        
        res.json({ 
            success: true, 
            message: '睡眠模式配置已保存',
            sleepModeActive: sleepModeActive
        });
    } catch (error) {
        console.error('Error saving sleep mode config:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 启动服务器时加载配置并启动睡眠模式检查
async function startServer() {
    try {
        // 确保配置目录存在
        await fs.mkdir(CONFIG_PATH, { recursive: true });
        
        // 加载睡眠模式配置并启动检查
        startSleepModeCheck();
        
        // 立即检查一次是否需要应用睡眠模式
        const config = await loadSleepModeConfig();
        if (isSleepModeActive(config)) {
            sleepModeActive = true;
            await applySleepMode();
        }
        
        app.listen(PORT, () => {
            console.log(`OESP LED Control Server is running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Error starting server:', error);
    }
}

startServer();
