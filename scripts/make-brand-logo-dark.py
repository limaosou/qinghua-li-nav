#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把浅色版横版 LOGO（钴蓝线稿）反白成深色主题用的版本。

为什么不用纯白：
  纯白 #FFFFFF 在 #101820 的深青底上像一块贴上去的剪贴画——太亮、太实、
  没有青花瓷该有的“釉”感，也会压过旁边 #D6E4F5 的站名字重。
  这里改成“月白釉”：整体淡淡偏蓝青，并给一条极轻的竖向渐变（上亮下暗），
  横版 LOGO 在 36px 高度下几乎看不出渐变，但整体会显得有受光的瓷面质感，
  而不是一张白纸片。

做法只取原图的 alpha 通道当遮罩，颜色整层重新铺，所以线稿纹样（缠枝花、
拱桥、鱼尾）的锯齿边缘原样保留，不会糊。

⚠️ 2026-11-19 起深色 LOGO 已换成「青花瓷立体浮雕 QHL」透明图（由 AI 抠图生成），
   本脚本（线稿反白版）不再用于生成正式深色 LOGO，仅为保留历史做法。
   默认输出已改到临时文件名，避免误跑覆盖正式图 public/brand-logo-dark.png。
   如需再生成线稿风格版本，请显式 --out 指定目标。

用法：
  python scripts/make-brand-logo-dark.py                # 生成到 /tmp（不会覆盖正式图）
  python scripts/make-brand-logo-dark.py --out public/brand-logo-dark.png  # 显式覆盖才生效
"""

import argparse
import os
from PIL import Image, ImageFilter

PUB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public')
SRC = os.path.join(PUB, 'brand-logo-light.png')

# 默认“月白釉”（提亮版）：上端 #E8F1FB → 下端 #C6DBF3
# 2026-11-19：原 D2E3F8→A8C4E8 在深底上偏灰暗、细部发闷；整体提亮并拉开
# 与深底的对比，同时保留上亮下暗的淡青蓝渐变（不铺纯白，避免过曝失釉感）。
DEF_TOP = 'E8F1FB'
DEF_BOTTOM = 'C6DBF3'


def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def build(top, bottom, out, grow=0):
    src = Image.open(SRC).convert('RGBA')
    w, h = src.size
    alpha = src.getchannel('A')

    # 细线在 36px 高度下会被缩到 0.1~0.3 物理像素，白线一旦不足 1px 就灰掉，
    # 纹样看起来像噪点。按原图尺寸做一点膨胀（默认 5px ≈ 屏上 0.3px），
    # 线稿更"实"，但轮廓基本不变形。
    if grow > 1:
        k = grow if grow % 2 else grow + 1
        # MaxFilter 会把抗锯齿的灰边吃成硬边，膨胀后补一点高斯柔化，边缘才不锯齿
        alpha = alpha.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.GaussianBlur(0.8))

    # 竖向线性渐变层
    t, b = hex2rgb(top), hex2rgb(bottom)
    grad = Image.new('RGB', (1, h))
    for y in range(h):
        k = y / max(h - 1, 1)
        grad.putpixel((0, y), tuple(round(t[i] + (b[i] - t[i]) * k) for i in range(3)))
    grad = grad.resize((w, h), Image.BILINEAR)

    res = grad.convert('RGBA')
    res.putalpha(alpha)
    res.save(out)
    print('写出 %s  (%dx%d)  %s → %s' % (os.path.relpath(out, os.getcwd()), w, h, top, bottom))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', default=DEF_TOP)
    ap.add_argument('--bottom', default=DEF_BOTTOM)
    ap.add_argument('--out', default='/tmp/brand-logo-dark-lineart.png')
    ap.add_argument('--grow', type=int, default=5, help='alpha 膨胀半径（奇数），0/1 = 不膨胀')
    a = ap.parse_args()
    build(a.top, a.bottom, a.out, a.grow)
