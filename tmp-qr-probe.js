
const CMQr = require('./public/js/qr.js');
const urls = [
  'http://127.0.0.1:3326/#c851',
  'https://competition-manager-hazel.vercel.app/#c50',
  'https://competition-manager-hazel.vercel.app/#c1122',
  'http://127.0.0.1:3326/#c50'
];
for (const u of urls) {
  try {
    const r = CMQr.encode(u);
    console.log(`OK  len=${String(u.length).padStart(3)} v${r.version} size=${r.size}  ${u}`);
  } catch (e) {
    console.log(`ERR len=${String(u.length).padStart(3)} ${e.message}  ${u}`);
  }
}
console.log('--- 各版本容量（byte 模式）---');
console.log(JSON.stringify(CMQr.VERSIONS || CMQr.CAPACITY || '(沒有匯出容量表)'));
