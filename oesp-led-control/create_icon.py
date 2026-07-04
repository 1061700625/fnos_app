#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import math

def create_icon(size):
    # 创建透明背景
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 背景圆形渐变背景
    bg_size = size
    center = bg_size // 2
    radius = center - 10
    
    # 画渐变背景
    for i in range(radius, 0, -1):
        t = i / radius
        r = int(102 + t * 102)  # #667eea
        g = int(126 + t * 102)
        b = int(234 + t * 102)
        draw.ellipse((center - i, center - i, center + i, center + i), fill=(r, g, b, 255))
    
    # 灯泡主体
    bulb_radius = int(radius * 0.4)
    bulb_center_y = int(center - radius * 0.2)
    
    # 灯泡发光效果
    for i in range(int(bulb_radius + 5), 0, -1):
        t = i / (bulb_radius + 5)
        alpha = int(100 * (1 - t))
        draw.ellipse((center - i, bulb_center_y - i, center + i, bulb_center_y + i), fill=(255, 255, 200, alpha))
    
    # 灯泡
    draw.ellipse((center - bulb_radius, bulb_center_y - bulb_radius, center + bulb_radius, bulb_center_y + bulb_radius), fill=(255, 215, 0, 255))
    
    # 灯泡高光
    highlight_x1 = int(center - bulb_radius * 0.6)
    highlight_y1 = int(bulb_center_y - bulb_radius * 0.6)
    highlight_x2 = int(center - bulb_radius * 0.2)
    highlight_y2 = int(bulb_center_y - bulb_radius * 0.2)
    draw.ellipse((highlight_x1, highlight_y1, highlight_x2, highlight_y2), fill=(255, 255, 255, 180))
    
    # 灯座
    base_width = int(bulb_radius * 1.2)
    base_height = int(bulb_radius * 0.8)
    base_top = int(bulb_center_y + bulb_radius - 5)
    draw.rectangle((center - base_width // 2, base_top, center + base_width // 2, base_top + base_height), fill=(139, 69, 19, 255))
    
    # 灯座条纹
    for i in range(3):
        y = int(base_top + base_height / 4 * (i + 1))
        draw.line((center - base_width // 2 + 5, y, center + base_width // 2 - 5, y), fill=(160, 82, 45, 255), width=int(size/20))
    
    # 光线效果
    ray_length = int(radius * 0.6)
    for i in range(8):
        angle = math.pi * 2 * i / 8
        x1 = int(center + math.cos(angle) * (bulb_radius + 5))
        y1 = int(bulb_center_y + math.sin(angle) * (bulb_radius + 5))
        x2 = int(center + math.cos(angle) * (bulb_radius + ray_length))
        y2 = int(bulb_center_y + math.sin(angle) * (bulb_radius + ray_length))
        draw.line((x1, y1, x2, y2), fill=(255, 255, 200, 150), width=int(size/20))
    
    return img

if __name__ == "__main__":
    # 创建64x64图标
    icon_64 = create_icon(64)
    icon_64.save("/vol1/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/default/projects/oesp-led-control/app/ui/images/icon_64.png")
    
    # 创建256x256图标
    icon_256 = create_icon(256)
    icon_256.save("/vol1/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/default/projects/oesp-led-control/app/ui/images/icon_256.png")
    
    # 也保存根目录的图标
    icon_64.save("/vol1/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/default/projects/oesp-led-control/ICON.PNG")
    icon_256.save("/vol1/@appshare/com.dustinky.qwenpaw/.qwenpaw/workspaces/default/projects/oesp-led-control/ICON_256.PNG")
    
    print("Icons created successfully!")
