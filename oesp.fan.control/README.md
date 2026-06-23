# fan monitor - fnOS FPK 应用

飞牛 fnOS 温度监控与风扇策略 FPK 应用。

## 功能

- 监控 CPU 温度（通过 /sys/class/hwmon 与 /sys/class/thermal）
- 监控硬盘温度（通过 smartctl -A）
- 显示温度历史曲线（最近 1440 个采样点）
- 设置风扇开启/关闭温度阈值
- 支持 dry-run 与 command 两种风扇控制模式
- 兼容 x86_64 与 aarch64 平台

## 项目结构

```
fan.monitor/
├── app/
│   ├── server/          # Node.js 后端服务
│   │   ├── server.js    # 主服务程序
│   │   └── package.json
│   ├── ui/             # 应用入口配置
│   │   ├── config       # 桌面图标配置
│   │   └── images/     # 应用图标
│   └── www/            # Web UI
│       ├── index.html    # 主页面
│       ├── style.css     # 样式
│       └── main.js      # 前端逻辑
├── cmd/                # 生命周期脚本
├── config/             # 权限与资源配置
├── wizard/             # 安装/卸载向导
├── manifest            # 应用描述文件
├── ICON.PNG           # 64x64 图标
└── ICON_256.PNG       # 256x256 图标
```

## 构建步骤

### 1. 安装 fnpack 工具

在 fnOS 系统上，通过应用中心安装 `fnpack` 应用。

### 2. 构建 FPK 包

```bash
cd /path/to/fan.monitor
fnpack build
```

构建成功后会生成 `fan.monitor.fpk` 文件。

### 3. 本地测试

```bash
# 从源码目录直接安装（推荐）
appcenter-cli install-local

# 或安装打包好的 FPK
appcenter-cli install-fpk fan.monitor.fpk
```

### 4. 验证

- 在 fnOS 桌面找到 fan monitor 图标
- 点击打开 Web UI
- 检查温度显示是否正常
- 测试风扇阈值设置

## 注意事项

1. **温度传感器权限**：可能需要 root 权限或特定用户组权限才能读取 /sys/class/thermal 和 /sys/class/hwmon
2. **硬盘温度**：需要安装 smartmontools 包（`smartctl` 命令）
3. **风扇控制**：不同设备的风扇控制接口差异很大，默认使用 dry-run 模式
4. **真实风扇控制**：在 Web UI 中切换到 command 模式，并填入设备专用的风扇控制命令

## 平台差异

- **x86_64**：通常可通过 coretemp/k10temp 内核模块读取 CPU 温度，NVMe 硬盘通过 smartctl 读取
- **aarch64**：通常依赖 SOC  thermal_zone，风扇控制可能需要厂商专用工具

## 故障排查

查看服务日志：
```bash
cat /var/lib/fan.monitor/var/fan-monitor.log
```

手动启动服务（调试）：
```bash
export TRIM_SERVICE_PORT=5066
export TRIM_APPDEST=/var/lib/fan.monitor/target
export TRIM_PKGVAR=/var/lib/fan.monitor/var
cd /var/lib/fan.monitor/target/server
node server.js
```
