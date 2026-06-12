#!/usr/bin/env node
/**
 * TikTok LIVE Checker v2
 * Reads TikTok user IDs from Google Sheets,
 * checks LIVE status via TikTok internal API (api-live/user/room/),
 * and writes results to Google Sheets.
 */

const { google } = require('googleapis');

// ========== Constants ==========
const SPREADSHEET_ID_SOURCE = '1UVyeNE9wv5Opany5gpMg5TBOs87LGBvhH-D9EvVl8W0';  // Read-only source
const SPREADSHEET_ID_RESULTS = '1Esn_gh-BBYFlIHiQTHFSC-AGQA51qCSNBaZ22mOqEyU'; // Results output
const SHEET_NAME_USERS = '\u30ea\u30b9\u30c8\u30a2\u30c3\u30d7\u4e00\u89a7';
const SHEET_NAME_RESULTS = '\u7d50\u679c';
const USER_COLUMN = 'B';
const START_ROW = 3;
const BATCH_SIZE = 8;
const BATCH_DELAY = 1000;
const REQUEST_TIMEOUT = 10000;
const TOTAL_TIMEOUT = 25 * 60 * 1000;
// エラー率がこれを超えたら結果を保存しない（壊れたデータで上書きしないため）
const MAX_ERROR_RATE = 0.3;

// GAS Webアプリ（チェック対象の取得 + 結果のダッシュボード同期に使用）
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxCBQkUOtfv8LpYdTWy-Lz3vYafGOB-JG8-f6jXCxsKL3u9MyPSLwsfVb8XeVxFfpQJ/exec';

// TikTok API config
const TIKTOK_API_URL = 'https://www.tiktok.com/api-live/user/room/';
const TIKTOK_API_PARAMS = {
  aid: '1988',
  app_name: 'tiktok_web',
  device_platform: 'web_pc',
  sourceType: '54',
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ========== Global variables ==========
let isTestMode = false;
let maxUsers = Infinity;
const startTime = Date.now();
let processedCount = 0;
let liveUsers = [];
let errorCount = 0;

// ========== Utility functions ==========

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function logError(message) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

function checkTimeout() {
  const elapsed = Date.now() - startTime;
  if (elapsed > TOTAL_TIMEOUT) {
    log('Timeout: exceeded 25 minutes. Stopping.');
    return true;
  }
  return false;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function initializeGoogleSheetsClient() {
  try {
    const credentialsJson = process.env.GOOGLE_CREDENTIALS;
    if (!credentialsJson) {
      logError('GOOGLE_CREDENTIALS environment variable is not set');
      process.exit(1);
    }

    const credentials = JSON.parse(credentialsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    logError(`Failed to initialize Google Sheets API: ${error.message}`);
    process.exit(1);
  }
}

async function fetchUserListFromSheets(sheets) {
  // ★ 優先: GASから「チェック対象」リストを取得（他社所属/対象外/削除済/未対応を除外済み）
  //    → チェック数が減り、全員を制限時間内にカバーできる
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(`${GAS_URL}?action=getLiveTargets`, { redirect: 'follow', signal: controller.signal });
    clearTimeout(timeoutId);
    if (resp.ok) {
      const data = await resp.json();
      if (data.ids && data.ids.length > 0) {
        let users = data.ids;
        log(`Targets from GAS: ${users.length} (excluded: ${data.excluded || 0} of ${data.total || '?'})`);
        if (isTestMode && users.length > maxUsers) {
          users = users.slice(0, maxUsers);
          log(`Test mode: processing first ${maxUsers} users only`);
        }
        return users;
      }
    }
    logError('GAS getLiveTargets returned no data, falling back to sheet read');
  } catch (error) {
    logError(`GAS getLiveTargets failed (${error.message}), falling back to sheet read`);
  }

  // フォールバック: ソースシートを直接読む（除外なし全件）
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID_SOURCE,
      range: `${SHEET_NAME_USERS}!${USER_COLUMN}${START_ROW}:${USER_COLUMN}`,
    });

    const rows = response.data.values || [];
    let users = rows.map(row => row[0]).filter(username => username && username.trim());

    if (isTestMode && users.length > maxUsers) {
      users = users.slice(0, maxUsers);
      log(`Test mode: processing first ${maxUsers} users only`);
    }

    log(`Users found: ${users.length}`);
    return users;
  } catch (error) {
    logError(`Error fetching user list: ${error.message}`);
    throw error;
  }
}

// ★ チェック完了後にダッシュボード(A2セル+LIVE履歴)へ自動同期
//    → ダッシュボードを開くだけで最新のLIVE状態が表示される
async function syncToDashboard() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const resp = await fetch(`${GAS_URL}?action=runLiveCheck`, { redirect: 'follow', signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await resp.json();
    if (data.liveIds) {
      log(`Dashboard synced: ${data.liveIds.length} LIVE users`);
    } else {
      logError(`Dashboard sync unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
    }
  } catch (error) {
    logError(`Dashboard sync failed: ${error.message}`);
  }
}

async function checkTikTokLiveStatus(username) {
  const params = new URLSearchParams({
    ...TIKTOK_API_PARAMS,
    uniqueId: username,
  });

  const url = `${TIKTOK_API_URL}?${params.toString()}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'ja-JP,ja;q=0.9',
        'Referer': 'https://www.tiktok.com/',
        'Origin': 'https://www.tiktok.com',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logError(`${username}: HTTP ${response.status}`);
      return false;
    }

    const data = await response.json();

    if (data.statusCode !== 0) {
      return false;
    }

    if (data.data && data.data.liveRoom) {
      const liveStatus = data.data.liveRoom.status;

      if (liveStatus === 2) {
        return true;
      }
    }

    return false;
  } catch (error) {
    if (error.name === 'AbortError') {
      logError(`${username}: request timeout`);
    } else {
      logError(`${username}: check failed - ${error.message}`);
    }
    errorCount++;
    return false;
  }
}

async function processUsers(users) {
  let currentDelay = BATCH_DELAY;
  let recentErrors = 0;
  let recentChecked = 0;

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    if (checkTimeout()) {
      log(`Timeout: ${processedCount}/${users.length} users processed, ${liveUsers.length} LIVE`);
      return;
    }

    const batch = users.slice(i, i + BATCH_SIZE);
    const errBefore = errorCount;

    const promises = batch.map(username =>
      checkTikTokLiveStatus(username)
        .then(isLive => ({ username, isLive }))
        .catch(() => ({ username, isLive: false }))
    );

    const results = await Promise.all(promises);

    for (const { username, isLive } of results) {
      processedCount++;
      if (isLive) {
        liveUsers.push(username);
        log(`LIVE: ${username}`);
      }
    }

    // ★ 適応スロットル: 直近100件のエラー率が高ければ60秒休止して減速
    recentErrors += errorCount - errBefore;
    recentChecked += batch.length;
    if (recentChecked >= 100) {
      if (recentErrors / recentChecked > 0.5) {
        currentDelay = Math.min(currentDelay * 2, 8000);
        log(`Throttle detected (${recentErrors}/${recentChecked} errors) — pausing 60s, delay now ${currentDelay}ms`);
        await delay(60000);
      }
      recentErrors = 0;
      recentChecked = 0;
    }

    if (processedCount % 100 === 0 || i + BATCH_SIZE >= users.length) {
      log(`Progress: ${processedCount}/${users.length} checked, ${liveUsers.length} LIVE, ${errorCount} errors`);
    }

    if (i + BATCH_SIZE < users.length) {
      await delay(currentDelay);
    }
  }
}

async function writeResultsToSheets(sheets) {
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID_RESULTS,
      range: SHEET_NAME_RESULTS,
    });

    const timestamp = new Date().toISOString();
    const rows = [
      ['\u30c1\u30a7\u30c3\u30af\u65e5\u6642', timestamp],
      ['LIVE\u914d\u4fe1\u4e2d\u306e\u30e6\u30fc\u30b6\u30fc\u6570', liveUsers.length],
      ['\u30c1\u30a7\u30c3\u30af\u6e08\u307f\u30e6\u30fc\u30b6\u30fc\u6570', processedCount],
      ['\u30a8\u30e9\u30fc\u6570', errorCount],
      [''],
      ['\u30e6\u30fc\u30b6\u30fc\u540d', 'LIVE URL'],
    ];

    for (const username of liveUsers) {
      rows.push([username, `https://www.tiktok.com/@${username}/live`]);
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID_RESULTS,
      range: `${SHEET_NAME_RESULTS}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rows,
      },
    });

    log('Results written to Google Sheets');
  } catch (error) {
    logError(`Error writing results: ${error.message}`);
    throw error;
  }
}

// ========== Main ==========
async function main() {
  try {
    if (process.argv.includes('--test')) {
      isTestMode = true;
      maxUsers = 50;
      log('Running in test mode');
    }

    log('TikTok LIVE Checker v2 (API method) starting');

    const sheets = await initializeGoogleSheetsClient();
    log('Google Sheets API initialized');

    const users = await fetchUserListFromSheets(sheets);

    if (users.length === 0) {
      log('No users to check');
      process.exit(0);
    }

    log(`Checking ${users.length} users (API: api-live/user/room/)`);
    await processUsers(users);

    // ★ 品質ガード: エラー率が高すぎる場合は保存しない（前回の正常データを保持）
    const errorRate = processedCount > 0 ? errorCount / processedCount : 1;
    if (errorRate > MAX_ERROR_RATE) {
      log(`SKIPPED write/sync: error rate ${(errorRate * 100).toFixed(0)}% exceeds ${MAX_ERROR_RATE * 100}% — keeping previous good data`);
      process.exit(0);
    }

    await writeResultsToSheets(sheets);

    // ダッシュボードへ自動同期（失敗しても結果シートには書き込み済み）
    await syncToDashboard();

    log(`Done: ${processedCount}/${users.length} users, ${liveUsers.length} LIVE, ${errorCount} errors`);
    process.exit(0);
  } catch (error) {
    logError(`Unexpected error: ${error.message}`);
    process.exit(1);
  }
}

main();
