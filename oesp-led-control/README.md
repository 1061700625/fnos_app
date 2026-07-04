# OESP LED 控制

OESP LED 控制是一个用于飞牛 fnOS 系统的应用，用于控制 OESP 设备上的 LED 灯。

## 作者

- 作者：小锋学长生活大爆炸
- GitHub：https://github.com/1061700625/fnos_app

## 功能特性

- 控制所有 LED 的开关
- 调节单个 LED 的亮度
- 支持临时控制和永久设置
- 美观的 Web 界面
- 响应式设计，支持多种设备

## 安装说明

1. 在飞牛 fnOS 系统上打开应用中心
2. 点击「手动安装」
3. 上传 `oesp-led-control.fpk` 文件
4. 按照向导完成安装

## 使用说明

1. 安装完成后，点击应用图标打开 Web 界面
2. 在界面上可以看到所有可用的 LED
3. 点击开关按钮或拖动滑块控制 LED
4. 点击「保存配置」按钮保存当前状态，下次重启后生效

## 开发说明

### 项目结构

```
oesp-led-control/
├── app/
│   ├── server/     # 后端服务
│   ├── ui/         # 应用入口配置
│   └── www/        # 前端界面
├── cmd/            # 生命周期脚本
├── config/         # 配置文件
├── wizard/         # 安装向导
└── manifest        # 应用清单
```

### 技术栈

- 后端：Node.js + Express
- 前端：Vue.js 3
- 系统：飞牛 fnOS

## 许可证

MIT
