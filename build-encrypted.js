#!/usr/bin/env node

/**
 * dashboard.html에 복호화 키를 삽입합니다.
 * 이후 staticrypt로 암호화되므로 키는 안전하게 보호됩니다.
 * 
 * data.json은 encrypt-data.js로 별도 암호화됩니다.
 */

const fs = require('fs');
const path = require('path');

const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');
const OUTPUT_PATH = path.join(__dirname, 'dashboard-build.html');
const PASSWORD = process.env.STATICRYPT_PASSWORD;

if (!PASSWORD) {
  console.error('STATICRYPT_PASSWORD 환경변수가 필요합니다.');
  process.exit(1);
}

let html = fs.readFileSync(DASHBOARD_PATH, 'utf8');

// DECRYPTION_KEY 변수를 </head> 앞에 삽입
// 이 키는 StaticCrypt로 암호화된 HTML 안에 들어가므로 외부에서 볼 수 없음
const keyScript = `<script>var DECRYPTION_KEY="${PASSWORD}";</script>`;
html = html.replace('</head>', keyScript + '\n</head>');

fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
console.log(`dashboard-build.html 생성 완료 (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
