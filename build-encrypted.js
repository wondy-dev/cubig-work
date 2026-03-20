#!/usr/bin/env node

/**
 * data.json을 index.html에 인라인으로 포함시킨 combined.html을 생성합니다.
 * 이후 staticrypt로 암호화하여 최종 index.html을 만듭니다.
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'index.html');
const DATA_PATH = path.join(__dirname, 'data.json');
const COMBINED_PATH = path.join(__dirname, 'combined.html');

// index.html 읽기
let html = fs.readFileSync(INDEX_PATH, 'utf8');

// data.json 읽기
const dataJson = fs.readFileSync(DATA_PATH, 'utf8');

// fetch('data.json') 호출을 인라인 데이터로 교체
// 기존: async function loadData(){try{var r=await fetch('data.json');DATA=await r.json();renderOverview();}...}
// 변경: DATA를 직접 할당하고 renderOverview() 호출
const inlineScript = `<script>var INLINE_DATA = ${dataJson};</script>`;

// </head> 앞에 인라인 데이터 삽입
html = html.replace('</head>', inlineScript + '\n</head>');

// loadData 함수를 인라인 데이터 사용으로 교체
html = html.replace(
  /async function loadData\(\)\{try\{var r=await fetch\('data\.json'\);DATA=await r\.json\(\);renderOverview\(\);\}catch\(e\)\{console\.error\('Dashboard error:',e\);document\.getElementById\('insightBox'\)\.innerHTML='<h3>data\.json loading failed: '\+e\.message\+'<\/h3>';\}\}/,
  "function loadData(){DATA=INLINE_DATA;renderOverview();}"
);

fs.writeFileSync(COMBINED_PATH, html, 'utf8');
console.log(`combined.html 생성 완료 (${(fs.statSync(COMBINED_PATH).size / 1024).toFixed(1)} KB)`);
