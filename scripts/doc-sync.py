#!/usr/bin/env python3
"""Google Docs 同步工具（competition-manager 專案文件）

用法：
  python3 scripts/doc-sync.py --dump [--out docs/功能總覽與規劃.md]
      讀回 Google Doc 內容並轉成 Markdown（含表格），用於備份或重建來源檔。
  python3 scripts/doc-sync.py --upload <html-or-md-file>
      以 HTML 覆蓋整份文件（Google Docs 會把 <table> 轉成原生表格）。

認證：~/.hermes/google_token.json（OAuth 使用者憑證，由 google-workspace skill 產生）。
     缺少時會提示重新授權，不會自行索取密碼。
"""
import argparse
import html as htmlmod
import json
import os
import re
import sys

DOC_ID = os.environ.get('CM_DOC_ID', '1EOJszJQHm-yoUwh0DguGjy20o5BgvnG3rAQgUyHyVbY')
TOKEN = os.path.expanduser('~/.hermes/google_token.json')
STYLES = {'HEADING_1': '#', 'HEADING_2': '##', 'HEADING_3': '###', 'HEADING_4': '####', 'TITLE': '#'}


def services():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    if not os.path.exists(TOKEN):
        sys.exit('❌ 找不到 OAuth 憑證 %s，請先用 google-workspace skill 完成授權。' % TOKEN)
    tok = json.load(open(TOKEN))
    creds = Credentials.from_authorized_user_file(TOKEN, tok.get('scopes'))
    return (build('docs', 'v1', credentials=creds, cache_discovery=False),
            build('drive', 'v3', credentials=creds, cache_discovery=False))


def para_text(el):
    """逐段組合文字；Google Docs 沒有 code 樣式，這裡用「等寬字型」還原成 Markdown 的 `反引號`，
    讓 dump → 編輯 → upload 的往返不會一直把 `程式碼` 變成普通文字。"""
    out = []
    for e in el.get('paragraph', {}).get('elements', []):
        run = e.get('textRun')
        if not run:
            continue
        text = run.get('content', '')
        font = (run.get('textStyle', {}).get('weightedFontFamily', {}) or {}).get('fontFamily', '')
        if text.strip() and re.search(r'courier|mono|consolas|menlo', font, re.I):
            lead = text[:len(text) - len(text.lstrip())]
            trail = text[len(text.rstrip()):]
            out.append(f'{lead}`{text.strip()}`{trail}')
        else:
            out.append(text)
    return ''.join(out)


def dump_markdown(doc):
    """把文件內容轉成 Markdown；表格輸出成標準 Markdown 表格（含分隔列）。"""
    out = []
    for el in doc.get('body', {}).get('content', []):
        if 'paragraph' in el:
            p = el['paragraph']
            text = para_text(el).rstrip('\n')
            style = p.get('paragraphStyle', {}).get('namedStyleType', 'NORMAL_TEXT')
            if not text.strip():
                continue
            if style in STYLES:
                out.append(f"{STYLES[style]} {text.strip()}")
            elif p.get('bullet'):
                out.append(f"- {text.strip()}")
            else:
                out.append(text.strip())
        elif 'table' in el:
            rows = []
            for row in el['table'].get('tableRows', []):
                cells = []
                for c in row.get('tableCells', []):
                    parts = [para_text(x).strip() for x in c.get('content', []) if 'paragraph' in x]
                    cells.append(' '.join(x for x in parts if x).replace('|', '\\|').replace('\n', ' '))
                rows.append(cells)
            if not rows:
                continue
            width = max(len(r) for r in rows)
            rows = [r + [''] * (width - len(r)) for r in rows]
            block = ['| ' + ' | '.join(rows[0]) + ' |', '|' + '---|' * width]
            block += ['| ' + ' | '.join(r) + ' |' for r in rows[1:]]
            # 表格列必須相連（中間不留空行），否則 Markdown 轉 HTML 時不會被辨識為表格
            out.append('\n'.join(block))
        elif 'sectionBreak' in el or 'tableOfContents' in el:
            pass
    return '\n\n'.join(out) + '\n'


def stats(doc):
    body = doc.get('body', {}).get('content', [])
    tables = [c for c in body if 'table' in c]
    heads = [c for c in body if 'paragraph' in c and
             c['paragraph'].get('paragraphStyle', {}).get('namedStyleType', '').startswith(('HEADING', 'TITLE'))]
    return {'title': doc.get('title'), 'tables': len(tables),
            'rows': sum(len(t['table'].get('tableRows', [])) for t in tables),
            'headings': len(heads), 'chars': len(dump_markdown(doc))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dump', action='store_true')
    ap.add_argument('--out')
    ap.add_argument('--upload')
    ap.add_argument('--stats', action='store_true')
    args = ap.parse_args()

    docs, drive = services()

    if args.dump or args.stats:
        doc = docs.documents().get(documentId=DOC_ID).execute()
        print('📄 文件狀態：', json.dumps(stats(doc), ensure_ascii=False))
        if args.dump:
            md = dump_markdown(doc)
            out_path = args.out or '/dev/stdout'
            if out_path != '/dev/stdout':
                open(out_path, 'w', encoding='utf-8').write(md)
                print(f'💾 已寫入 {out_path}（{len(md)} 字元）')
            else:
                print(md)
            print('標題清單：')
            for line in md.split('\n'):
                if line.startswith('#'):
                    print('  ', line[:70])
        return

    if args.upload:
        from googleapiclient.http import MediaFileUpload
        path = args.upload
        if not os.path.exists(path):
            sys.exit(f'❌ 找不到檔案：{path}')
        mime = 'text/html' if path.endswith('.html') else 'text/plain'
        print('更新前：', json.dumps(stats(docs.documents().get(documentId=DOC_ID).execute()), ensure_ascii=False))
        media = MediaFileUpload(path, mimetype=mime, resumable=False)
        drive.files().update(fileId=DOC_ID, media_body=media, fields='id,name,modifiedTime').execute()
        after = docs.documents().get(documentId=DOC_ID).execute()
        print('更新後：', json.dumps(stats(after), ensure_ascii=False))
        return

    ap.print_help()


if __name__ == '__main__':
    main()
