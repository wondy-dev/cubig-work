#!/usr/bin/env node

/**
 * CUBIG 마케팅 통합 대시보드 - 데이터 수집기
 *
 * 4개 API에서 데이터를 수집하여 outputs/dashboard/data.json에 저장
 * - GA4 Data API (CUBIG 공홈 + LLM Capsule)
 * - Google Search Console (cubig.ai + llmcapsule.ai)
 * - Naver Ads API
 * - META Ads API
 *
 * 사용법: node collect-all.js [--period 7|14|30]
 */

const { google } = require('googleapis');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ========== 환경변수 (.env 수동 파싱 또는 process.env에서 읽기) ==========
function loadEnv() {
  // GitHub Actions 등 CI 환경에서는 process.env 사용
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    return process.env;
  }
  const envPath = path.join(__dirname, '..', '..', '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
  }
  return env;
}

const ENV = loadEnv();

// ========== 경로 상수 ==========
const IS_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
const CREDENTIALS_PATH = IS_CI
  ? path.join(process.env.GITHUB_WORKSPACE || '.', 'google_credentials.json')
  : path.join(__dirname, '../../slack/google_credentials.json');
const TOKEN_PATH = IS_CI
  ? path.join(process.env.GITHUB_WORKSPACE || '.', 'drive_token.json')
  : path.join(__dirname, '../../google-drive/drive_token.json');
const OUTPUT_DIR = IS_CI
  ? path.join(process.env.GITHUB_WORKSPACE || '.', 'outputs/dashboard')
  : path.join(__dirname, '../../../outputs/dashboard');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'data.json');

// ========== 날짜 유틸 ==========
function fmt(d) { return d.toISOString().split('T')[0]; }
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d;
}

// 기간 파라미터 파싱
const args = process.argv.slice(2);
const periodIdx = args.indexOf('--period');
const PERIOD = periodIdx !== -1 ? parseInt(args[periodIdx + 1]) || 7 : 7;

// 이번주/지난주 기간 계산
const TODAY = new Date();
const THIS_WEEK_END = daysAgo(1); // 어제까지
const THIS_WEEK_START = daysAgo(PERIOD);
const LAST_WEEK_END = daysAgo(PERIOD + 1);
const LAST_WEEK_START = daysAgo(PERIOD * 2);

// GSC는 2-3일 딜레이
const GSC_END = daysAgo(3);
const GSC_START = daysAgo(3 + PERIOD);
const GSC_PREV_END = daysAgo(3 + PERIOD + 1);
const GSC_PREV_START = daysAgo(3 + PERIOD * 2);

// ========== Google OAuth ==========
async function getGoogleAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const { client_id, client_secret } = credentials.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/callback');
  oauth2Client.setCredentials(token);
  if (token.expiry_date && Date.now() >= token.expiry_date) {
    const { credentials: newToken } = await oauth2Client.refreshAccessToken();
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(newToken, null, 2));
    oauth2Client.setCredentials(newToken);
  }
  return oauth2Client;
}

// ========== GA4 수집 ==========
async function collectGA4(auth) {
  console.log('  [GA4] 수집 시작...');
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });

  const CUBIG_PROPERTY = '435023747';
  const LLM_PROPERTY = '487240636';
  const SYNTITAN_PROPERTY = '518703311';

  async function runReport(propertyId, config) {
    try {
      const res = await analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: config
      });
      return res.data;
    } catch (err) {
      console.error(`    GA4 리포트 오류 (${propertyId}):`, err.message);
      return { rows: [] };
    }
  }

  function parseRows(data) {
    if (!data.rows) return [];
    return data.rows.map(row => {
      const dims = (row.dimensionValues || []).map(v => v.value);
      const mets = (row.metricValues || []).map(v => {
        const n = Number(v.value);
        return isNaN(n) ? v.value : n;
      });
      return { dims, mets };
    });
  }

  const thisWeek = { startDate: fmt(THIS_WEEK_START), endDate: fmt(THIS_WEEK_END) };
  const lastWeek = { startDate: fmt(LAST_WEEK_START), endDate: fmt(LAST_WEEK_END) };

  // --- CUBIG 공홈 (SynTitan + MKT) ---
  // 전체 트래픽 (이번주 + 지난주)
  const cubigTraffic = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    metrics: [
      { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
      { name: 'screenPageViews' }, { name: 'userEngagementDuration' }, { name: 'engagementRate' }
    ]
  });

  // 일별 트래픽 추이
  const cubigDaily = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });

  // 일별 참여시간 (날짜 필터링용)
  const cubigDailyEngagement = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'userEngagementDuration' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });

  // 블로그 일별 트래픽 (cubig.ai/blogs/ 전용)
  const cubigBlogDaily = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    dimensionFilter: {
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/blogs/' } }
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });

  // 블로그 조회수 Top 20
  const cubigBlogPages = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'averageSessionDuration' }],
    dimensionFilter: {
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/blogs/' } }
    },
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 20
  });

  // 일별 블로그 페이지 (날짜 필터용)
  const cubigDailyBlogPages = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'averageSessionDuration' }],
    dimensionFilter: {
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/blogs/' } }
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });

  // SynTitan 관련 페이지
  const syntitanPages = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
    dimensionFilter: {
      orGroup: {
        expressions: [
          { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: 'syntitan' } } },
          { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: 'ai-ready-data' } } }
        ]
      }
    },
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 20
  });

  // 국가별 사용자
  const cubigCountries = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    limit: 15
  });

  // 유입 채널별
  const cubigChannels = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
  });

  // 주요 이벤트 (전환)
  const cubigEvents = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 15
  });

  // SynTitan ← cubig.ai 경유 유입 (SynTitan 속성에서 sessionSource=cubig.ai인 세션)
  const synFromCubig = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'CONTAINS', value: 'cubig' } }
    }
  });

  // SynTitan ← cubig.ai 일별 (날짜 필터용)
  const synFromCubigDaily = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'CONTAINS', value: 'cubig' } }
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });

  // --- LLM Capsule ---
  const llmTraffic = await runReport(LLM_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    metrics: [
      { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
      { name: 'screenPageViews' }, { name: 'userEngagementDuration' }, { name: 'engagementRate' }
    ]
  });

  const llmDaily = await runReport(LLM_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });

  const llmBlogPages = await runReport(LLM_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'averageSessionDuration' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 20
  });

  const llmCountries = await runReport(LLM_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    limit: 15
  });

  const llmChannels = await runReport(LLM_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
  });

  // LLM Capsule channels already collected above (llmChannels)

  // --- SynTitan (syntitan.ai) ---
  const synTraffic = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    metrics: [
      { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
      { name: 'screenPageViews' }, { name: 'userEngagementDuration' }, { name: 'engagementRate' }
    ]
  });

  const synDaily = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });

  const synCountries = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    limit: 15
  });

  const synChannels = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek, lastWeek],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
  });

  // 일별 채널 (날짜 필터용) — cubig, llm, syn
  const cubigDailyChannels = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });
  const llmDailyChannels = await runReport(LLM_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });
  const synDailyChannels = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });

  // 일별 국가 (날짜 필터용) — cubig, llm, syn
  const cubigDailyCountries = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'country' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });
  const llmDailyCountries = await runReport(LLM_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'country' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });
  const synDailyCountries = await runReport(SYNTITAN_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'country' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });

  // 일별 Referral 소스 (날짜 필터용)
  const cubigDailyReferral = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'date' }, { name: 'sessionSource' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Referral' } }
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 50000
  });

  // Referral 소스 세분화 (채널=Referral인 경우의 sessionSource)
  const cubigReferralSources = await runReport(CUBIG_PROPERTY, {
    dateRanges: [thisWeek],
    dimensions: [{ name: 'sessionSource' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Referral' } }
    },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 10
  });

  console.log('  [GA4] 수집 완료');

  return {
    cubig: {
      traffic: parseRows(cubigTraffic),
      daily: parseRows(cubigDaily),
      dailyEngagement: parseRows(cubigDailyEngagement),
      blogDaily: parseRows(cubigBlogDaily),
      blogPages: parseRows(cubigBlogPages),
      dailyBlogPages: parseRows(cubigDailyBlogPages),
      syntitanPages: parseRows(syntitanPages),
      countries: parseRows(cubigCountries),
      channels: parseRows(cubigChannels),
      events: parseRows(cubigEvents),
      syntitanClicks: parseRows(synFromCubig),
      synFromCubigDaily: parseRows(synFromCubigDaily),
      referralSources: parseRows(cubigReferralSources),
      dailyChannels: parseRows(cubigDailyChannels),
      dailyCountries: parseRows(cubigDailyCountries),
      dailyReferral: parseRows(cubigDailyReferral)
    },
    llm: {
      traffic: parseRows(llmTraffic),
      daily: parseRows(llmDaily),
      blogPages: parseRows(llmBlogPages),
      countries: parseRows(llmCountries),
      channels: parseRows(llmChannels),
      dailyChannels: parseRows(llmDailyChannels),
      dailyCountries: parseRows(llmDailyCountries)
    },
    syn: {
      traffic: parseRows(synTraffic),
      daily: parseRows(synDaily),
      countries: parseRows(synCountries),
      channels: parseRows(synChannels),
      dailyChannels: parseRows(synDailyChannels),
      dailyCountries: parseRows(synDailyCountries)
    }
  };
}

// ========== Google Search Console 수집 ==========
async function collectGSC(auth) {
  console.log('  [GSC] 수집 시작...');
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  async function query(siteUrl, config) {
    try {
      const res = await searchconsole.searchanalytics.query({ siteUrl, requestBody: config });
      return (res.data.rows || []).map(r => ({
        keys: r.keys || [],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position
      }));
    } catch (err) {
      console.error(`    GSC 오류 (${siteUrl}):`, err.message);
      return [];
    }
  }

  const thisWeek = { startDate: fmt(GSC_START), endDate: fmt(GSC_END) };
  const lastWeek = { startDate: fmt(GSC_PREV_START), endDate: fmt(GSC_PREV_END) };

  // cubig.ai
  const cubigOverview = await query('sc-domain:cubig.ai', { ...thisWeek, dimensions: [], type: 'web' });
  const cubigOverviewPrev = await query('sc-domain:cubig.ai', { ...lastWeek, dimensions: [], type: 'web' });
  const cubigQueries = await query('sc-domain:cubig.ai', { ...thisWeek, dimensions: ['query'], type: 'web', rowLimit: 20 });
  const cubigPages = await query('sc-domain:cubig.ai', {
    ...thisWeek, dimensions: ['page'], type: 'web', rowLimit: 15,
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/blogs/' }] }]
  });
  const cubigDaily = await query('sc-domain:cubig.ai', { ...thisWeek, dimensions: ['date'], type: 'web' });

  // SynTitan 관련 키워드
  const syntitanQueries = await query('sc-domain:cubig.ai', {
    ...thisWeek, dimensions: ['query'], type: 'web', rowLimit: 10,
    dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'contains', expression: 'syntitan' }] }]
  });

  // 블로그 유입 검색 키워드 (page contains /blogs/ → query 차원)
  const cubigBlogQueries = await query('sc-domain:cubig.ai', {
    ...thisWeek, dimensions: ['query'], type: 'web', rowLimit: 15,
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/blogs/' }] }]
  });
  const cubigBlogQueriesPrev = await query('sc-domain:cubig.ai', {
    ...lastWeek, dimensions: ['query'], type: 'web', rowLimit: 100,
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/blogs/' }] }]
  });

  // 전기간 쿼리 (신규 키워드 비교용)
  const cubigQueriesPrev = await query('sc-domain:cubig.ai', { ...lastWeek, dimensions: ['query'], type: 'web', rowLimit: 100 });
  // 최근 2주 쿼리 (NEW 뱃지 기준: 2주간 없던 키워드만 NEW)
  const twoWeeksAgo = { startDate: fmt(daysAgo(17)), endDate: fmt(daysAgo(3)) };
  const cubigRecent2w = await query('sc-domain:cubig.ai', { ...twoWeeksAgo, dimensions: ['query'], type: 'web', rowLimit: 200 });
  const cubigBlogRecent2w = await query('sc-domain:cubig.ai', {
    ...twoWeeksAgo, dimensions: ['query'], type: 'web', rowLimit: 200,
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/blogs/' }] }]
  });
  const llmRecent2w = await query('sc-domain:llmcapsule.ai', { ...twoWeeksAgo, dimensions: ['query'], type: 'web', rowLimit: 200 });
  const synRecent2w = await query('https://syntitan.ai/', { ...twoWeeksAgo, dimensions: ['query'], type: 'web', rowLimit: 200 });
  const cubigBlogPagesPrev = await query('sc-domain:cubig.ai', {
    ...lastWeek, dimensions: ['page'], type: 'web', rowLimit: 15,
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/blogs/' }] }]
  });

  // llmcapsule.ai
  const llmOverview = await query('sc-domain:llmcapsule.ai', { ...thisWeek, dimensions: [], type: 'web' });
  const llmOverviewPrev = await query('sc-domain:llmcapsule.ai', { ...lastWeek, dimensions: [], type: 'web' });
  const llmQueries = await query('sc-domain:llmcapsule.ai', { ...thisWeek, dimensions: ['query'], type: 'web', rowLimit: 15 });
  const llmQueriesPrev = await query('sc-domain:llmcapsule.ai', { ...lastWeek, dimensions: ['query'], type: 'web', rowLimit: 100 });

  // syntitan.ai (https:// prefix — sc-domain 권한 없음)
  const synOverview = await query('https://syntitan.ai/', { ...thisWeek, dimensions: [], type: 'web' });
  const synOverviewPrev = await query('https://syntitan.ai/', { ...lastWeek, dimensions: [], type: 'web' });
  const synQueries = await query('https://syntitan.ai/', { ...thisWeek, dimensions: ['query'], type: 'web', rowLimit: 15 });
  const synQueriesPrev = await query('https://syntitan.ai/', { ...lastWeek, dimensions: ['query'], type: 'web', rowLimit: 100 });

  console.log('  [GSC] 수집 완료');

  return {
    cubig: {
      overview: cubigOverview[0] || null,
      overviewPrev: cubigOverviewPrev[0] || null,
      queries: cubigQueries,
      queriesPrev: cubigQueriesPrev,
      blogPages: cubigPages,
      blogPagesPrev: cubigBlogPagesPrev,
      blogQueries: cubigBlogQueries,
      blogQueriesPrev: cubigBlogQueriesPrev,
      recent2w: cubigRecent2w,
      blogRecent2w: cubigBlogRecent2w,
      daily: cubigDaily,
      syntitanQueries
    },
    llm: {
      overview: llmOverview[0] || null,
      overviewPrev: llmOverviewPrev[0] || null,
      queries: llmQueries,
      queriesPrev: llmQueriesPrev,
      recent2w: llmRecent2w
    },
    syn: {
      overview: synOverview[0] || null,
      overviewPrev: synOverviewPrev[0] || null,
      queries: synQueries,
      queriesPrev: synQueriesPrev,
      recent2w: synRecent2w
    }
  };
}

// ========== Naver Ads 수집 ==========
async function collectNaverAds() {
  console.log('  [Naver Ads] 수집 시작...');
  const API_KEY = ENV.NAVER_ADS_API_KEY;
  const SECRET_KEY = ENV.NAVER_ADS_SECRET_KEY;
  const CUSTOMER_ID = ENV.NAVER_ADS_CUSTOMER_ID;
  const BASE_URL = 'api.searchad.naver.com';

  if (!API_KEY || !SECRET_KEY || !CUSTOMER_ID) {
    console.log('    Naver Ads 환경변수 누락 - 스킵');
    return { campaigns: [], stats: [] };
  }

  function generateSignature(timestamp, method, apiPath) {
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(`${timestamp}.${method}.${apiPath}`);
    return hmac.digest('base64');
  }

  function apiRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now().toString();
      const signature = generateSignature(timestamp, method, apiPath);
      const options = {
        hostname: BASE_URL, path: apiPath, method,
        headers: {
          'X-Timestamp': timestamp, 'X-API-KEY': API_KEY,
          'X-Customer': CUSTOMER_ID, 'X-Signature': signature,
          'Content-Type': 'application/json'
        }
      };
      if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
          } else { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  try {
    // 캠페인 목록
    const campaigns = await apiRequest('GET', '/ncc/campaigns');
    if (!Array.isArray(campaigns)) return { campaigns: [], stats: [] };

    const campaignList = campaigns.map(c => ({
      id: c.nccCampaignId,
      name: c.name,
      type: c.campaignTp,
      status: c.status,
      dailyBudget: c.dailyBudget || 0
    }));

    // 캠페인별 통계 (이번주) — POST 방식
    const stats = [];
    for (const c of campaigns) {
      try {
        const body = JSON.stringify({
          id: c.nccCampaignId,
          fields: ['impCnt', 'clkCnt', 'salesAmt', 'cpc', 'ctr'],
          timeRange: { since: fmt(THIS_WEEK_START), until: fmt(THIS_WEEK_END) }
        });
        const s = await apiRequest('POST', '/stats', body);
        if (s.data && s.data.length > 0) {
          stats.push({ ...s.data[0], campaignName: c.name, campaignId: c.nccCampaignId });
        }
      } catch (e) {
        // PAUSED 캠페인은 통계 없음 — 무시
      }
    }

    // 캠페인별 통계 (지난주)
    const statsPrev = [];
    for (const c of campaigns) {
      try {
        const body = JSON.stringify({
          id: c.nccCampaignId,
          fields: ['impCnt', 'clkCnt', 'salesAmt', 'cpc', 'ctr'],
          timeRange: { since: fmt(LAST_WEEK_START), until: fmt(LAST_WEEK_END) }
        });
        const s = await apiRequest('POST', '/stats', body);
        if (s.data && s.data.length > 0) {
          statsPrev.push({ ...s.data[0], campaignName: c.name, campaignId: c.nccCampaignId });
        }
      } catch (e) { /* skip */ }
    }

    // 일별 캠페인 통계 (날짜 필터용) — 활성 캠페인만
    const statsDaily = [];
    const activeCampaigns = campaigns.filter(c => c.status === 'ELIGIBLE' || c.status === 'ACTIVE');
    for (const c of activeCampaigns) {
      const d = new Date(THIS_WEEK_START);
      while (d <= THIS_WEEK_END) {
        const dayStr = fmt(d);
        try {
          const body = JSON.stringify({
            id: c.nccCampaignId,
            fields: ['impCnt', 'clkCnt', 'salesAmt', 'cpc', 'ctr'],
            timeRange: { since: dayStr, until: dayStr }
          });
          const s = await apiRequest('POST', '/stats', body);
          if (s.data && s.data.length > 0 && (s.data[0].impCnt > 0 || s.data[0].clkCnt > 0 || s.data[0].salesAmt > 0)) {
            statsDaily.push({ ...s.data[0], date: dayStr, campaignName: c.name, campaignId: c.nccCampaignId });
          }
        } catch (e) { /* skip */ }
        d.setDate(d.getDate() + 1);
      }
    }

    console.log('  [Naver Ads] 수집 완료');
    return { campaigns: campaignList, stats, statsPrev, statsDaily };
  } catch (err) {
    console.error('    Naver Ads 오류:', err.message);
    return { campaigns: [], stats: [], statsPrev: [], statsDaily: [] };
  }
}

// ========== META Ads 수집 ==========
async function collectMetaAds() {
  console.log('  [META Ads] 수집 시작...');
  const ACCESS_TOKEN = ENV.META_ADS_ACCESS_TOKEN;
  const ACCOUNT_ID = ENV.META_ADS_ACCOUNT_ID;

  if (!ACCESS_TOKEN || !ACCOUNT_ID) {
    console.log('    META Ads 환경변수 누락 - 스킵');
    return { campaigns: [], insights: [], daily: [], insightsPrev: [] };
  }

  const AD_ACCOUNT_ID = `act_${ACCOUNT_ID}`;

  function metaApiGet(apiPath) {
    return new Promise((resolve, reject) => {
      const separator = apiPath.includes('?') ? '&' : '?';
      const url = `https://graph.facebook.com/v21.0${apiPath}${separator}access_token=${ACCESS_TOKEN}`;
      https.get(url, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed);
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  try {
    // 캠페인 목록
    const campRes = await metaApiGet(`/${AD_ACCOUNT_ID}/campaigns?fields=name,status,objective,daily_budget,lifetime_budget&limit=20`);
    const campaigns = (campRes.data || []).map(c => ({
      id: c.id, name: c.name, status: c.status, objective: c.objective,
      dailyBudget: c.daily_budget ? c.daily_budget / 100 : null,
      lifetimeBudget: c.lifetime_budget ? c.lifetime_budget / 100 : null
    }));

    // 이번주 캠페인별 인사이트
    const insightsRes = await metaApiGet(`/${AD_ACCOUNT_ID}/insights?fields=campaign_name,campaign_id,impressions,clicks,spend,cpc,ctr,reach,actions&level=campaign&time_range={"since":"${fmt(THIS_WEEK_START)}","until":"${fmt(THIS_WEEK_END)}"}&limit=20`);
    const insights = (insightsRes.data || []).map(row => ({
      campaignName: row.campaign_name,
      campaignId: row.campaign_id,
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      spend: Number(row.spend || 0),
      cpc: Number(row.cpc || 0),
      ctr: Number(row.ctr || 0),
      reach: Number(row.reach || 0),
      conversions: row.actions ? row.actions.filter(a => ['lead', 'offsite_conversion', 'onsite_conversion'].includes(a.action_type)).reduce((s, a) => s + parseInt(a.value), 0) : 0,
      actions: row.actions || []
    }));

    // 지난주 캠페인별 인사이트
    const insightsPrevRes = await metaApiGet(`/${AD_ACCOUNT_ID}/insights?fields=campaign_name,campaign_id,impressions,clicks,spend,cpc,ctr,reach,actions&level=campaign&time_range={"since":"${fmt(LAST_WEEK_START)}","until":"${fmt(LAST_WEEK_END)}"}&limit=20`);
    const insightsPrev = (insightsPrevRes.data || []).map(row => ({
      campaignName: row.campaign_name,
      campaignId: row.campaign_id,
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      spend: Number(row.spend || 0),
      cpc: Number(row.cpc || 0),
      ctr: Number(row.ctr || 0),
      reach: Number(row.reach || 0),
      conversions: row.actions ? row.actions.filter(a => ['lead', 'offsite_conversion', 'onsite_conversion'].includes(a.action_type)).reduce((s, a) => s + parseInt(a.value), 0) : 0
    }));

    // 일별 추이 (계정 전체)
    const dailyRes = await metaApiGet(`/${AD_ACCOUNT_ID}/insights?fields=impressions,clicks,spend,reach&time_increment=1&time_range={"since":"${fmt(THIS_WEEK_START)}","until":"${fmt(THIS_WEEK_END)}"}`);
    const daily = (dailyRes.data || []).map(row => ({
      date: row.date_start,
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      spend: Number(row.spend || 0),
      reach: Number(row.reach || 0)
    }));

    // 일별 캠페인별 인사이트 (날짜 필터 시 광고 테이블 재집계용)
    const campaignDailyRes = await metaApiGet(`/${AD_ACCOUNT_ID}/insights?fields=campaign_name,campaign_id,impressions,clicks,spend,cpc,ctr,reach,actions&level=campaign&time_increment=1&time_range={"since":"${fmt(THIS_WEEK_START)}","until":"${fmt(THIS_WEEK_END)}"}&limit=100`);
    const campaignDaily = (campaignDailyRes.data || []).map(row => ({
      date: row.date_start,
      campaignName: row.campaign_name,
      campaignId: row.campaign_id,
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      spend: Number(row.spend || 0),
      cpc: Number(row.cpc || 0),
      ctr: Number(row.ctr || 0),
      reach: Number(row.reach || 0),
      conversions: row.actions ? row.actions.filter(a => ['lead', 'offsite_conversion', 'onsite_conversion'].includes(a.action_type)).reduce((s, a) => s + parseInt(a.value), 0) : 0
    }));

    console.log('  [META Ads] 수집 완료');
    return { campaigns, insights, insightsPrev, daily, campaignDaily };
  } catch (err) {
    console.error('    META Ads 오류:', err.message);
    return { campaigns: [], insights: [], insightsPrev: [], daily: [], campaignDaily: [] };
  }
}

// ========== 메인 ==========
async function main() {
  console.log(`\n========================================`);
  console.log(`  CUBIG 마케팅 대시보드 데이터 수집`);
  console.log(`  기간: ${fmt(THIS_WEEK_START)} ~ ${fmt(THIS_WEEK_END)} (${PERIOD}일)`);
  console.log(`  비교: ${fmt(LAST_WEEK_START)} ~ ${fmt(LAST_WEEK_END)}`);
  console.log(`========================================\n`);

  const auth = await getGoogleAuth();

  // 병렬 수집 (Google API는 같은 auth, Naver/META는 독립)
  const [ga4, gsc, naver, meta] = await Promise.all([
    collectGA4(auth),
    collectGSC(auth),
    collectNaverAds(),
    collectMetaAds()
  ]);

  const data = {
    metadata: {
      collectedAt: new Date().toISOString(),
      period: PERIOD,
      thisWeek: { start: fmt(THIS_WEEK_START), end: fmt(THIS_WEEK_END) },
      lastWeek: { start: fmt(LAST_WEEK_START), end: fmt(LAST_WEEK_END) },
      gscPeriod: { start: fmt(GSC_START), end: fmt(GSC_END) }
    },
    ga4,
    gsc,
    naver,
    meta
  };

  // 출력 디렉토리 생성
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`\n✅ 데이터 수집 완료! → ${OUTPUT_FILE}`);
  console.log(`   파일 크기: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error('❌ 치명적 오류:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
