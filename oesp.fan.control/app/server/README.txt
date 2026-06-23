fan monitor backend

采集策略：
- CPU 温度：优先读取 /sys/class/hwmon 与 /sys/class/thermal，兼容 x86_64 与 arm/aarch64 常见传感器命名。
- 硬盘温度：优先用 lsblk 枚举 /dev/sdX 与 /dev/nvmeXnY，再调用 smartctl -A 读取 SMART 温度。
- 风扇控制：默认 dry-run，仅记录期望状态；如设备提供专有 fancontrol/ipmitool/sysfs 命令，可在 Web UI 中配置 fanOnCommand/fanOffCommand 并切换到 command 模式。

平台差异：
- x86 设备常见 k10temp/coretemp/nvme/smartctl，部分主板风扇需要 root 或 ipmitool。
- arm 设备常见 soc/thermal_zone，风扇控制接口更依赖厂商内核暴露路径。
- 本应用 manifest 使用 platform=all，并在运行时探测能力，避免分别打包 arm/x86。
