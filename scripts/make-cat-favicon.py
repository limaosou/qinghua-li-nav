#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「极简实心猫头」浏览器收藏夹 / 标签 / 主屏图标。

背景：旧 Q 猫是镂空细线稿，缩到收藏夹 ~24px 发虚；第一版实心猫加了胡须/尾巴
      仍显脏糊。最终版遵循「大色块、少细节」：钴蓝满版底 + 白猫轮廓 + 两只大眼，
      像豆瓣/宝塔那种实心图标，极小尺寸依然锐利。

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
    """极简实心猫头：白脸 + 双耳 + 两只大眼，去掉胡须/尾巴/鼻耳内细节。

    浏览器收藏夹图标只有 ~24px，细节越多越糊（旧版细线 Q 猫 + 第一版带胡须尾巴
    都验证过发虚）。本版遵循「大色块、少细节」：只有蓝底 + 白猫轮廓 + 两只大眼，
    缩到极小依然锐利，风格对齐豆瓣/宝塔那种实心图标。
    """
    im = Image.new('RGB', (size, size), bg)
    d = ImageDraw.Draw(im)
    s = size
    # 白脸（大椭圆，居中）
    d.ellipse((0.22*s, 0.30*s, 0.78*s, 0.84*s), fill=WHITE)
    # 两只三角耳
    d.polygon([(0.24*s, 0.38*s), (0.20*s, 0.14*s), (0.44*s, 0.30*s)], fill=WHITE)
    d.polygon([(0.76*s, 0.38*s), (0.80*s, 0.14*s), (0.56*s, 0.30*s)], fill=WHITE)
    # 两只大眼（唯一内部细节，够大才不糊）
    d.ellipse((0.36*s, 0.50*s, 0.44*s, 0.59*s), fill=bg)
    d.ellipse((0.56*s, 0.50*s, 0.64*s, 0.59*s), fill=bg)
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
