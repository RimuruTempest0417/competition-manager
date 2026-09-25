#!/usr/bin/env python3
"""把 docs/功能總覽與規劃.md 轉成可直接匯入 Google Docs 的 HTML（<table> 會變原生 Google 表格）。

用法：
  python3 scripts/md-to-docs-html.py [來源.md] [輸出.html]
預設：docs/功能總覽與規劃.md → docs/功能總覽與規劃.html
接著用 scripts/doc-sync.py --upload docs/功能總覽與規劃.html 上傳。

支援：標題（#~####）、標準 Markdown 表格（容忍列與列之間的空行）、有序／無序清單、
      引言（>）、水平線（---）、**粗體**、`程式碼`。刻意保持極簡，因為這份文件只用這些語法。
"""
import html
import os
import re
import sys

DEFAULT_SRC = 'docs/功能總覽與規劃.md'
DEFAULT_DST = 'docs/功能總覽與規劃.html'
TITLE = '比賽管理系統 — 功能總覽與規劃'


def inline(t):
    t = html.escape(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    return t


def is_sep(line):
    return bool(re.match(r'^\|[\s:\-|]+\|$', line.strip()))


def is_row(line):
    return line.strip().startswith('|')


def convert(src):
    lines = src.split('\n')
    out, i = [], 0
    while i < len(lines):
        line = lines[i]

        # 表格：標頭列 + 分隔列 + 資料列（容許列與列之間有空行）
        if is_row(line) and i + 1 < len(lines) and is_sep(lines[i + 1]):
            header = [c.strip() for c in line.strip().strip('|').split('|')]
            i += 2
            rows = []
            while i < len(lines):
                if is_row(lines[i]):
                    rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                    i += 1
                elif not lines[i].strip():
                    j = i
                    while j < len(lines) and not lines[j].strip():
                        j += 1
                    if j < len(lines) and is_row(lines[j]):
                        i = j
                    else:
                        break
                else:
                    break
            out.append('<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">')
            out.append('<tr>' + ''.join(
                f'<th style="background:#f1f5f9;text-align:left">{inline(h)}</th>' for h in header) + '</tr>')
            for r in rows:
                out.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>')
            out.append('</table>')
            continue

        m = re.match(r'^(#{1,4})\s+(.*)$', line)
        if m:
            lvl = len(m.group(1))
            out.append(f'<h{lvl}>{inline(m.group(2))}</h{lvl}>')
            i += 1
            continue

        if line.strip() == '---':
            out.append('<hr>')
            i += 1
            continue

        if line.startswith('> '):
            block = []
            while i < len(lines) and lines[i].startswith('>'):
                block.append(lines[i].lstrip('> ').strip())
                i += 1
            out.append('<blockquote>' + ''.join(f'<p>{inline(b)}</p>' for b in block if b) + '</blockquote>')
            continue

        if re.match(r'^\d+\.\s', line.strip()):
            items = []
            while i < len(lines) and re.match(r'^\d+\.\s', lines[i].strip()):
                items.append(re.sub(r'^\d+\.\s*', '', lines[i].strip()))
                i += 1
            out.append('<ol>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ol>')
            continue

        if re.match(r'^[-・]\s', line.strip()):
            items = []
            while i < len(lines) and re.match(r'^[-・]\s', lines[i].strip()):
                items.append(re.sub(r'^[-・]\s*', '', lines[i].strip()))
                i += 1
            out.append('<ul>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ul>')
            continue

        if line.strip():
            out.append(f'<p>{inline(line.strip())}</p>')
        i += 1

    return f"""<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>{TITLE}</title>
<style>body{{font-family:-apple-system,"PingFang TC",Arial,sans-serif;line-height:1.6;max-width:1000px;margin:0 auto;padding:24px}}
table{{border:1px solid #cbd5e1;border-collapse:collapse;width:100%;margin:10px 0 18px}}
th{{border:1px solid #cbd5e1;background:#f1f5f9;text-align:left;padding:6px 8px;font-size:14px}}
td{{border:1px solid #cbd5e1;padding:6px 8px;font-size:13px;vertical-align:top}}
h1{{font-size:24px}}h2{{font-size:19px;border-bottom:2px solid #e2e8f0;padding-bottom:4px;margin-top:28px}}
h3{{font-size:16px;margin-top:20px}}code{{background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:12px}}
blockquote{{background:#f8fafc;border-left:4px solid #94a3b8;margin:0 0 18px;padding:8px 14px;font-size:13px}}
hr{{border:0;border-top:1px solid #e2e8f0;margin:22px 0}}</style></head>
<body>
{chr(10).join(out)}
</body></html>"""


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    dst = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DST
    if not os.path.exists(src):
        sys.exit(f'❌ 找不到來源檔：{src}')
    doc = convert(open(src, encoding='utf-8').read())
    open(dst, 'w', encoding='utf-8').write(doc)
    print(f'✅ {src} → {dst}（{len(doc)} 字元，{doc.count("<table")} 張表格、{doc.count("<tr>")} 列）')


if __name__ == '__main__':
    main()
