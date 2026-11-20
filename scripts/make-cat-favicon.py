#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「实心猫头」浏览器收藏夹 / 标签 / 主屏图标。

背景：旧的 Q 猫是镂空细线稿，缩到浏览器收藏夹 32px 只剩几根细线、发虚；
      宝塔/豆瓣等清晰图标都是实心色块。本脚本改用纯几何实心猫头：
      钴蓝满版底 + 白色实心猫脸（双眼 + 猫耳 + Q 尾巴），小尺寸依然醒目。

产物：
  public/favicon.ico          多尺寸 ICO（16/32/48/64/128/256），浏览器标签 + 收藏夹
  public/favicon-dark.ico     深色标签栏版本（更深蓝底）
  public/apple-touch-icon.png 180x180 满版 RGB（iOS 不接受透明）
  public/brand-icon.png       512x512 源图（满版，供其它脚本复用）

用法：python3 scripts/make-cat-favicon.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
BLUE = (30, 86, 165)
BLUE_DARK = (16, 50, 105)
WHITE = (250, 252, 255)


def cat_icon(size, bg, square=True):
    """实心猫头图标。square=True 满版方底（iOS/收藏夹裁圆），False 圆形底。"""
    im = Image.new('RGB', (size, size), bg)
    d = ImageDraw.Draw(im)
    s = size
    if not square:
        # 圆形底（四角透明效果用同色，保持满版即可，浏览器自裁圆）
        pass
    # 白脸
    d.ellipse((0.20*s, 0.28*s, 0.80*s, 0.86*s), fill=WHITE)
    # 猫耳
    d.polygon([(0.22*s, 0.36*s), (0.17*s, 0.10*s), (0.42*s, 0.28*s)], fill=WHITE)
    d.polygon([(0.78*s, 0.36*s), (0.83*s, 0.10*s), (0.58*s, 0.28*s)], fill=WHITE)
    # 耳内蓝
    d.polygon([(0.24*s, 0.32*s), (0.21*s, 0.17*s), (0.36*s, 0.27*s)], fill=bg)
    d.polygon([(0.76*s, 0.32*s), (0.79*s, 0.17*s), (0.64*s, 0.27*s)], fill=bg)
    # 双眼
    d.ellipse((0.36*s, 0.50*s, 0.41*s, 0.56*s), fill=bg)
    d.ellipse((0.59*s, 0.50*s, 0.64*s, 0.56*s), fill=bg)
    # 鼻子
    d.polygon([(0.47*s, 0.62*s), (0.53*s, 0.62*s), (0.50*s, 0.66*s)], fill=bg)
    # 胡须（粗短线）
    w = max(2, int(0.014*s))
    for dy in (-0.025, 0.025):
        d.line((0.26*s, (0.665+dy)*s, 0.42*s, (0.665+dy)*s), fill=bg, width=w)
        d.line((0.58*s, (0.665+dy)*s, 0.74*s, (0.665+dy)*s), fill=bg, width=w)
    # Q 尾巴（粗圆环）
    d.ellipse((0.62*s, 0.72*s, 0.93*s, 0.91*s), outline=WHITE, width=max(3, int(0.05*s)))
    return im


def main():
    src = cat_icon(512, BLUE)
    src.save(os.path.join(PUB, 'brand-icon.png'))

    src_dark = cat_icon(512, BLUE_DARK)
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    src.save(os.path.join(PUB, 'favicon.ico'), format='ICO', sizes=ico_sizes)
    src_dark.save(os.path.join(PUB, 'favicon-dark.ico'), format='ICO', sizes=ico_sizes)

    apple = cat_icon(180, BLUE)
    apple.save(os.path.join(PUB, 'apple-touch-icon.png'))
    print('已生成：favicon.ico / favicon-dark.ico / apple-touch-icon.png / brand-icon.png')


if __name__ == '__main__':
    main()
