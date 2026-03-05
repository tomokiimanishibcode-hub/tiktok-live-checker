#!/usr/bin/env node

/**
 * TikTok LIVE チェッカー
 * Google Sheets から TikTok ユーザーIDを取得して、LIVE 配信中かどうかを確認し、
 * 結果を Google Sheets に書き込みます。
 */

const { google } = require('googleapis');

const SPREADSHEET_ID = '1UVyeNE9wv5Opany5gpMg5TBOs87LGBvhH-D9EvVl8W0';
const SHEET_NAME_USERS = '一覧';
const SHEET_NAME_RESULTS = '結果';
const USER_COLUMN = 'A';
const START_ROW = 3;
const BATCH_SIZE = 10;
const BATCH_DELAY = 2000;
const REQUEST_TIMEOUT = 10000;
const TOTAL_TIMEOUT = 25 * 60 * 1000;
const LIVE_MARKERS = ['room_id', '"isLive":true', 'LiveRoom'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let isTestMode = false;
let maxUsers = Infinity;
const startTime = Date.now();
let processedCount = 0;
let liveUsers = [];

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(message) {
  console.error(`[${new Date().toISOString()}] ERROR: ${message}`);
}

function checkTimeout() {
  if (Date.now() - startTime > TOTAL_TIMEOUT) {
    log('タイムアウト: 25分以上経過。処理を中断します。');
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
      logError('環境変数 GOOGLE_CREDENTIALS が設定されていません');
      process.exit(1);
    }
    const credentials = JSON.parse(credentialsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    logError(`Google Sheets API の初期化に失敗: ${error.message}`);
    process.exit(1);
  }
}

async function fetchUserListFromSheets(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_USERS}!${USER_COLUMN}${START_ROW}:${USER_COLUMN}`,
    });
    const rows = response.data.values || [];
    let users = rows.map(row => row[0]).filter(u => u && u.trim());
    if (isTestMode && users.length > maxUsers) {
      users = users.slice(0, maxUsers);
      log(`テストモード: 最初の${maxUsers}ユーザーのみ処理`);
    }
    log(`取得されたユーザー数: ${users.length}`);
    return users;
  } catch (error) {
    logError(`ユーザーリスト取得エラー: ${error.message}`);
    throw error;
  }
}

async function checkTikTokLiveStatus(username) {
  const url = `https://www.tiktok.com/@${username}/live`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja-JP,ja;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    const first10k = text.substring(0, 10240);
    for (const marker of LIVE_MARKERS) {
      if (first10k.includes(marker)) return true;
    }
    return false;
  } catch (error) {
    if (error.name === 'AbortError') {
      logError(`${username}: リクエストタイムアウト`);
    } else {
      logError(`${username}: チェック失敗 - ${error.message}`);
    }
    return false;
  }
}

async function processUsers(users) {
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    if (checkTimeout()) {
      log(`${processedCount}/${users.length} ユーザー中、${liveUsers.length}が LIVE 配信中`);
      return;
    }
    const batch = users.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(username =>
        checkTikTokLiveStatus(username)
          .then(isLive => ({ username, isLive }))
          .catch(() => ({ username, isLive: false }))
      )
    );
    for (const { username, isLive } of results) {
      processedCount++;
      if (isLive) {
        liveUsers.push(username);
        log(`\u2713 ${username} は LIVE 配信中です`);
      }
    }
    log(`進捗: ${processedCount}/${users.length} (${liveUsers.length}が LIVE 中)`);
    if (i + BATCH_SIZE < users.length) await delay(BATCH_DELAY);
  }
}

async function writeResultsToSheets(sheets) {
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME_RESULTS,
    });
    const rows = [
      ['チェック日時', new Date().toISOString()],
      ['LIVE 配信中のユーザー数', liveUsers.length],
      [''],
      ['ユーザー名'],
    ];
    for (const username of liveUsers) rows.push([username]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_RESULTS}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
    log('結果を Google Sheets に書き込みました');
  } catch (error) {
    logError(`結果の書き込みエラー: ${error.message}`);
    throw error;
  }
}

async function main() {
  try {
    if (process.argv.includes('--test')) {
      isTestMode = true;
      maxUsers = 50;
      log('テストモードで実行します');
    }
    log('TikTok LIVE チェッカーを開始します');
    const sheets = await initializeGoogleSheetsClient();
    log('Google Sheets API を初期化しました');
    const users = await fetchUserListFromSheets(sheets);
    if (users.length === 0) {
      log('チェック対象のユーザーがありません');
      process.exit(0);
    }
    log(`${users.length}ユーザーのチェックを開始します`);
    await processUsers(users);
    await writeResultsToSheets(sheets);
    log(`チェック完了: ${processedCount}/${users.length} ユーザー、${liveUsers.length}が LIVE 配信中`);
    process.exit(0);
  } catch (error) {
    logError(`予期しないエラー: ${error.message}`);
    process.exit(1);
  }
}

main();
