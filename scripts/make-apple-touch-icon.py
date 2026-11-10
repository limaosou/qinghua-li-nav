#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 iPhone「添加到主屏幕」专用图标 + 效果预览。

为什么要单独做一张，而不是复用 brand-icon.png / favicon.ico：
  1. iOS 的 apple-touch-icon **不支持透明**，透明像素会被渲染成黑色，
     直接拿透明底图标用会出现黑底黑块，所以输出必须是无 alpha 的 RGB 满版图。
  2. iOS 会把图标裁成圆角超椭圆，图案必须居中留出安全边距，
     否则原图几乎贴边的猫耳朵会被切掉。
  3. 180x180 是 iPhone 6 及以后 @3x 的标准尺寸，iOS 会自动缩放适配其它机型 /
     iPad，只需提供一个 link。

产物：
  public/apple-touch-icon.png            默认：青花蓝渐变底 + 白色反版猫头
  public/apple-touch-icon-porcelain.png 备选：瓷白渐变底 + 原青花蓝猫头（不引用，换口味时改 link 即可）
  预览-青花狸-iPhone主屏幕图标.png        深浅壁纸 x 两种底色的效果对比

换 LOGO 后重跑本脚本即可（源图固定读 public/brand-icon.png）。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
SRC = os.path.join(PUB, 'brand-icon.png')
WORK = 512          # 合成画布，最后缩到 180
SIZE = 180
SCALE = 0.76        # 图案占画布比例：76% 居中，四角圆角裁切后猫耳仍完整

BLUE_TOP = (66, 118, 214)
BLUE_BOTTOM = (28, 60, 138)
PORCELAIN_TOP = (255, 255, 255)
PORCELAIN_BOTTOM = (222, 234, 251)
WHITE = (249, 252, 255)


def gradient(c1, c2):
    """左上 -> 右下的线性渐变底"""
    yy, xx = np.mgrid[0:WORK, 0:WORK]
    t = (xx / (WORK - 1) * 0.55 + yy / (WORK - 1) * 0.45).reshape(WORK, WORK, 1)
    arr = np.asarray(c1, dtype=np.float64) * (1 - t) + np.asarray(c2, dtype=np.float64) * t
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')


def figure(colorize=None):
    """把源图缩放居中到安全区；colorize 给定时按 alpha 蒙版填纯色（做白色反版）。"""
    src = Image.open(SRC).convert('RGBA')
    n = int(WORK * SCALE)
    src = src.resize((n, n), Image.LANCZOS)
    if colorize:
        flat = Image.new('RGBA', (n, n), colorize + (0,))
        flat.putalpha(src.getchannel('A'))
        src = flat
    layer = Image.new('RGBA', (WORK, WORK), (0, 0, 0, 0))
    layer.paste(src, ((WORK - n) // 2, (WORK - n) // 2), src)
    return layer


def compose(bg, layer):
    """不透明底 + 柔和外晕 + 图案 -> 180x180 无 alpha 的 RGB PNG"""
    base = bg.copy()
    glow = Image.new('RGBA', (WORK, WORK), (6, 18, 48, 0))
    glow.putalpha(layer.getchannel('A').filter(ImageFilter.GaussianBlur(9))
                  .point(lambda v: int(v * 0.28)))
    base = Image.alpha_composite(base, glow)
    base = Image.alpha_composite(base, layer)
    return base.convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)


def font(px):
    for p in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf',
              '/System/Library/Fonts/PingFang.ttc'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, px)
            except OSError:
                pass
    return ImageFont.load_default()


def preview(paths):
    """模拟 iOS 主屏幕：浅/深壁纸各一行，两个方案并排，图标做圆角裁切"""
    ROW, W, H, CELL = 360, 960, 720, 480
    canvas = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(canvas)
    f_title, f_label, f_app = font(22), font(18), font(19)
    walls = [((233, 237, 246), '浅色壁纸 / Light'), ((22, 28, 42), '深色壁纸 / Dark')]
    labels = ['A  青花蓝底 · 白猫头（默认）', 'B  瓷白底 · 蓝猫头（备选）']

    for row, (wall, wall_name) in enumerate(walls):
        y0 = row * ROW
        d.rectangle([0, y0, W, y0 + ROW], fill=wall)
        dark = row == 1
        txt = (240, 244, 252) if dark else (38, 46, 64)
        sub = (160, 172, 195) if dark else (110, 122, 145)
        d.text((24, y0 + 16), wall_name, font=f_title, fill=txt)
        d.text((24, y0 + 48), 'iOS 会自动裁成圆角超椭圆，满版不透明底不会出现黑块', font=f_label, fill=sub)

        for col, p in enumerate(paths):
            x0 = col * CELL
            im = Image.open(p).convert('RGBA')
            mask = Image.new('L', (SIZE, SIZE), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                [0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.224), fill=255)
            # 主屏幕图标投影
            shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
            ImageDraw.Draw(shadow).rounded_rectangle(
                [0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.224), fill=(0, 0, 0, 90))
            shadow = shadow.filter(ImageFilter.GaussianBlur(9))
            d.text((x0 + 20, y0 + 76), labels[col], font=f_label, fill=sub)
            ix = x0 + (CELL - SIZE) // 2
            iy = y0 + 104
            canvas.paste(shadow, (ix, iy + 8), shadow)
            canvas.paste(im, (ix, iy), mask)
            name_w = d.textlength('青花狸', font=f_app)
            d.text((x0 + (CELL - name_w) / 2, iy + SIZE + 10), '青花狸', font=f_app, fill=txt)

    out = os.path.join(ROOT, '预览-青花狸-iPhone主屏幕图标.png')
    canvas.save(out)
    return out


def main():
    fig_white = figure(WHITE)     # 反版：按 alpha 蒙版填白
    fig_blue = figure()           # 原版：保留青花蓝
    a = compose(gradient(BLUE_TOP, BLUE_BOTTOM), fig_white)
    b = compose(gradient(PORCELAIN_TOP, PORCELAIN_BOTTOM), fig_blue)
    pa = os.path.join(PUB, 'apple-touch-icon.png')
    pb = os.path.join(PUB, 'apple-touch-icon-porcelain.png')
    a.save(pa, optimize=True)
    b.save(pb, optimize=True)
    out = preview([pa, pb])
    for p in (pa, pb, out):
        im = Image.open(p)
        print(os.path.basename(p), im.size, im.mode, os.path.getsize(p), 'bytes')
    print('corner pixels (must be opaque color, no alpha):',
          a.getpixel((0, 0)), a.getpixel((179, 179)))


if __name__ == '__main__':
    main()
