#!/usr/bin/env python3
"""檢查顏色 class 與主題變數的完整性（Tailwind 靜態檔缺 class 時不會報錯，只會默默失效）。

檢查四件事：
  ① 專案用到的每個顏色 class，都有規則（custom.css 或 tailwind 靜態檔）。
  ② class 規則引用的每個 CSS 變數，都在 :root 定義。
  ③ 兩份深色票（html[data-theme="dark"] 與 media query 內的
     html:not([data-theme="light"])）定義的變數完全相同。
     —— 這是本專案最容易出錯的地方：只改一份，手動切換與跟隨系統就會不一致。
  ④ 定義了卻沒被引用的變數（僅提示，非錯誤）。

用法（在專案根目錄執行）：
    python3 class-coverage.py [--css public/css/custom.css] [--static public/css/tailwind.min.css]
                              [--html public/index.html] [--js public/js/app.js]
"""
import argparse, pathlib, re, sys

ap = argparse.ArgumentParser()
ap.add_argument('--css', default='public/css/custom.css')
ap.add_argument('--static', default='public/css/tailwind.min.css')
ap.add_argument('--html', default='public/index.html')
ap.add_argument('--js', default='public/js/app.js')
A = ap.parse_args()


def read(p):
    return pathlib.Path(p).read_text(encoding='utf-8', errors='replace')


css_raw, static, html, js = read(A.css), read(A.static), read(A.html), read(A.js)
css = re.sub(r'/\*.*?\*/', '', css_raw, flags=re.S)

DARK_ATTR = 'html[data-theme="dark"]'
MEDIA_DARK = '@media (prefers-color-scheme: dark)'


def find_block(text, selector, start=0):
    """回傳 selector 之後第一個大括號區塊的內容與結束位置。"""
    i = text.index(selector, start)
    j = text.index('{', i)
    depth, k = 1, j + 1
    while depth:
        if text[k] == '{':
            depth += 1
        elif text[k] == '}':
            depth -= 1
        k += 1
    return text[j + 1:k - 1], k


# ---------- ④ 解析變數定義 ----------
def vars_in(block):
    return set(re.findall(r'(--[\w-]+)\s*:', block))


try:
    root_block, _ = find_block(css, ':root')
except ValueError:
    sys.exit('找不到 :root —— custom.css 是否還在使用 CSS 變數架構？')

root_vars = vars_in(root_block)

try:
    attr_dark_block, _ = find_block(css, DARK_ATTR)
    attr_dark_vars = vars_in(attr_dark_block)
except ValueError:
    attr_dark_vars = set()

try:
    media_block, _ = find_block(css, MEDIA_DARK)
    media_inner, _ = find_block(media_block, 'html:not([data-theme="light"])')
    media_dark_vars = vars_in(media_inner)
except ValueError:
    media_dark_vars = set()

# class 規則區 = 扣掉 :root / 兩份深色票之後的全部
def strip_blocks(text, blocks):
    for b in blocks:
        text = text.replace(b, ' /* stripped */ ')
    return text

class_rules = css
for b in (root_block, attr_dark_block if attr_dark_vars else '', media_block):
    if b:
        class_rules = class_rules.replace(b, ' ')

# 有寫 fallback 的（var(--x, #fff)）不算「未定義」：fallback 本身就是預設值，
# 例如 .cm-flash 的 --cm-blue-ring 只在有定義時才發光。硬要定義反而多一份要同步的色票。
referenced = {
    name for name, tail in re.findall(r'var\(\s*(--[\w-]+)\s*([^)]*)', class_rules)
    if ',' not in tail
}

# ---------- class 解析 ----------
def selectors_of(block):
    out, depth, buf = [], 0, ''
    for ch in block:
        if ch == '{':
            depth += 1
            if depth == 1:
                out.append(buf.strip()); buf = ''
                continue
        elif ch == '}':
            depth -= 1
            if depth == 0:
                buf = ''
            continue
        if depth == 0:
            buf += ch
    return [s for s in out if s]


def to_class(sel):
    sel = sel.strip()
    if ',' in sel:
        return None
    if not sel.startswith('.'):
        return None
    s = sel.lstrip('.')
    if s.endswith(':hover'):
        s = s[:-6]
    return s.replace('\\', '')


defined_classes = set()
for sel in selectors_of(class_rules):
    for part in sel.split(','):
        c = to_class(part)
        if c:
            defined_classes.add(c)

TOK = re.compile(r'(?<![\w:-])((?:hover:)?(?:bg|text|border|ring|accent)-(?:slate|red|amber|emerald|indigo|'
                 r'purple|rose|blue|white|black|gray|sky)(?:-\d{2,3})?(?:/\d{1,3})?)(?![\w-])')
used = set(TOK.findall(html)) | set(TOK.findall(js))


def in_static(c):
    return ('.' + c.replace(':', '\\:').replace('/', '\\/')) in static


# 刻意不用變數、兩主題同值的 class
KEEP = {
    'text-white', 'text-slate-400', 'border-slate-600',
    'bg-slate-700', 'bg-slate-800', 'bg-slate-900',
    'bg-blue-600', 'bg-blue-700', 'hover:bg-blue-700',
    'bg-amber-600', 'bg-amber-700', 'hover:bg-amber-700',
    'bg-emerald-600', 'bg-emerald-700', 'hover:bg-emerald-700',
}

# accent-* 是表單勾選框的強調色，交給瀏覽器預設（兩主題同值、刻意不用變數）
KEEP |= {c for c in used if c.startswith('accent-')}


failures = []

print(f'使用中的顏色 class：{len(used)}｜custom.css 定義：{len(defined_classes)}')
print(f':root 變數：{len(root_vars)}｜深色票(attr)：{len(attr_dark_vars)}｜深色票(media)：{len(media_dark_vars)}')

# ① class 覆蓋
miss = sorted(c for c in used if c not in defined_classes and c not in KEEP and not in_static(c))
print('\n① light/dark 皆未定義且不在 KEEP、靜態檔也沒有：')
if miss:
    failures.append(f'{len(miss)} 個顏色 class 沒有規則')
    for c in miss:
        print('    ' + c)
else:
    print('    （無）')

# ② 未定義變數
undef = sorted(v for v in referenced if v not in root_vars)
print('\n② class 規則引用了但 :root 未定義的變數：')
if undef:
    failures.append(f'{len(undef)} 個變數未定義')
    for v in undef:
        print('    ' + v)
else:
    print('    （無）')

# ③ 兩份深色票同步
only_attr = sorted(attr_dark_vars - media_dark_vars)
only_media = sorted(media_dark_vars - attr_dark_vars)
print('\n③ 兩份深色票是否一致：')
if only_attr or only_media:
    failures.append('兩份深色票不同步')
    for v in only_attr:
        print(f'    只在 html[data-theme="dark"] 有：{v}')
    for v in only_media:
        print(f'    只在 media query 有：{v}')
else:
    print(f'    （一致，共 {len(attr_dark_vars)} 個）')

# ④ 冗餘變數
unused = sorted(v for v in root_vars if v not in referenced)
print('\n④ 定義了但未被任何 class 規則引用的變數（提示用）：')
print('\n'.join('    ' + v for v in unused) if unused else '    （無）')

if failures:
    print('\n❌ ' + '；'.join(failures))
    sys.exit(1)
print('\n✅ 全部通過')
