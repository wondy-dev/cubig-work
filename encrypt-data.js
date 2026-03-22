#!/usr/bin/env node

/**
 * data.json을 AES-256-GCM으로 암호화하여 data.enc를 생성합니다.
 * 비밀번호에서 PBKDF2로 키를 유도합니다.
 * 
 * 출력 형식: base64( salt(16) + iv(12) + encrypted + authTag(16) )
 * 
 * 사용법: STATICRYPT_PASSWORD=비밀번호 node encrypt-data.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'data.json');
const OUTPUT_PATH = path.join(__dirname, 'data.enc');
const PASSWORD = process.env.STATICRYPT_PASSWORD;

if (!PASSWORD) {
  console.error('STATICRYPT_PASSWORD 환경변수가 필요합니다.');
  process.exit(1);
}

if (!fs.existsSync(DATA_PATH)) {
  console.error('data.json이 없습니다.');
  process.exit(1);
}

const data = fs.readFileSync(DATA_PATH, 'utf8');

// 암호화
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(PASSWORD, salt, 100000, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

let encrypted = cipher.update(data, 'utf8');
encrypted = Buffer.concat([encrypted, cipher.final()]);
const authTag = cipher.getAuthTag();

// salt + iv + encrypted + authTag
const result = Buffer.concat([salt, iv, encrypted, authTag]);
const base64Result = result.toString('base64');

fs.writeFileSync(OUTPUT_PATH, base64Result, 'utf8');
console.log(`data.enc 생성 완료 (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);
