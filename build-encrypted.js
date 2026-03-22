#!/usr/bin/env node

/**
 * dashboard.html을 staticrypt로 암호화하여 index.html을 생성합니다.
 * data.json은 별도 파일로 배포됩니다 (인라인하지 않음).
 */

const fs = require('fs');
const path = require('path');

const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');

// dashboard.html 존재 확인
if (!fs.existsSync(DASHBOARD_PATH)) {
  console.error('dashboard.html이 없습니다.');
  process.exit(1);
}

const size = fs.statSync(DASHBOARD_PATH).size;
console.log(`dashboard.html 크기: ${(size / 1024).toFixed(1)} KB`);
console.log('data.json은 별도 파일로 배포됩니다.');
