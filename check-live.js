#!/usr/bin/env node

/**
 * TikTok LIVE チェッカー v2
 * Google Sheets から TikTok ユーザーIDを取得して、
 * TikTok 内部API (api-live/user/room/) を使って LIVE 配信中かどうかを確認し、
 * 結果を Google Sheets に書き込みます。
 */

const { google } = require('googleapis');

// ========== 定数と設定 ==========
const SPREADSHEET_ID = '1UVyeNE9wv5Opany5gpMg5TBOs87LGBvhH-D9EvVl8W0';
const SHEET_NAME_USERS = '一覧';
const SHEET_NAME_RESULTS = '結果';
const USER_COLUMN = 'A';
const START_ROW = 3; // 3行目から開始
const BATCH_SIZE = 5; // 一度に処理するユーザー数
const BATCH_DELAY = 2000; // バッチ間の遅延（ミリ秒）
const REQUEST_TIMEOUT = 10000; // リクエストのタイムアウト（ミリ秒）
const TOTAL_TIMEOUT = 25 * 60 * 1000; // 総実行時間の上限（25分）

// TikTok API 設定
const TIKTOK_API_URL = 'https://www.tiktok.com/api-live/user/room/';
const TIKTOK_API_PARAMS = {
  aid: '1988',
  app_name: 'tiktok_web',
  device_platform: 'web_pc',
  sourceType: '54',
};

// User-Agent を設定（ボット検出回避）
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ========== グローバル変数 ==========
let isTestMode = false;
let maxUsers = Infinity;
const startTime = Date.now();
let processedCount = 0;
let liveUsers = [];
let errorCount = 0;

// ========== ユーティリティ関数 ==========

/**
 * ログ出力（タイムスタンプ付き）
 */
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * エラーログ出力
 */
function logError(message) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

/**
 * 経過時間をチェック
 */
function checkTimeout() {
  const elapsed = Date.now() - startTime;
  if (elapsed > TOTAL_TIMEOUT) {
    log(`タイムアウト: 25分以上経過しています。処理を中断します。`);
    return true;
  }
  return false;
}

/**
 * 遅延を実装（Promise ベース）
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Google Sheets API クライアントを初期化
 */
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
    logError(`Google Sheets API の初期化に失敗しました: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Google Sheets からユーザーリストを取得
 */
async function fetchUserListFromSheets(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_USERS}!${USER_COLUMN}${START_ROW}:${USER_COLUMN}`,
    });

    const rows = response.data.values || [];
    let users = rows.map(row => row[0]).filter(username => username && username.trim());

    // テストモードの場合は最初のN ユーザーのみ
    if (isTestMode && users.length > maxUsers) {
      users = users.slice(0, maxUsers);
      log(`テストモード: 最初の${maxUsers}ユーザーのみ処理します`);
    }

    log(`取得されたユーザー数: ${users.length}`);
    return users;
  } catch (error) {
    logError(`ユーザーリスト取得エラー: ${error.message}`);
    throw error;
  }
}

/**
 * TikTok API を使って LIVE ステータスをチェック
 * api-live/user/room/ エンドポイントを使用
 */
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

    // API レスポンスを解析
    // statusCode: 0 = 成功
    if (data.statusCode !== 0) {
      // statusCode が 0 以外の場合、ユーザーが存在しないかエラー
      return false;
    }

    // liveRoom が存在し、status が 2 (配信中) であれば LIVE
    // status: 2 = 配信中, 4 = 配信終了
    if (data.data && data.data.liveRoom) {
      const liveStatus = data.data.liveRoom.status;
      // status 2 = 配信中
      if (liveStatus === 2) {
        return true;
      }
      // status 4 = 配信終了（最近まで配信していた）
      // それ以外の status も配信中の可能性がある
      // roomId が存在し、streamData があれば配信中とみなす
      if (liveStatus !== 4 && data.data.user && data.data.user.roomId) {
        return true;
      }
    }

    return false;
  } catch (error) {
    if (error.name === 'AbortError') {
      logError(`${username}: リクエストタイムアウト`);
    } else {
      logError(`${username}: チェック失敗 - ${error.message}`);
    }
    errorCount++;
    return false;
  }
}

/**
 * ユーザーを処理（バッチ単位）
 */
async function processUsers(users) {
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    // タイムアウトチェック
    if (checkTimeout()) {
      log(`タイムアウト: ${processedCount}/${users.length} ユーザー処理済み、${liveUsers.length}が LIVE 配信中`);
      return;
    }

    const batch = users.slice(i, i + BATCH_SIZE);
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
        log(`✓ ${username} は LIVE 配信中です`);
      }
    }

    // 100ユーザーごとに進捗表示
    if (processedCount % 100 === 0 || i + BATCH_SIZE >= users.length) {
      log(`進捗: ${processedCount}/${users.length} ユーザーをチェック（${liveUsers.length}が LIVE 中、${errorCount}エラー）`);
    }

    // バッチ間の遅延
    if (i + BATCH_SIZE < users.length) {
      await delay(BATCH_DELAY);
    }
  }
}

/**
 * 結果を Google Sheets に書き込み
 */
async function writeResultsToSheets(sheets) {
  try {
    // "結果" シートをクリア
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME_RESULTS,
    });

    // 結果を作成
    const timestamp = new Date().toISOString();
    const rows = [
      ['チェック日時', timestamp],
      ['LIVE 配信中のユーザー数', liveUsers.length],
      ['チェック済みユーザー数', processedCount],
      ['エラー数', errorCount],
      [''],
      ['ユーザー名', 'LIVE URL'],
    ];

    for (const username of liveUsers) {
      rows.push([username, `https://www.tiktok.com/@${username}/live`]);
    }

    // Google Sheets に書き込み
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME_RESULTS}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rows,
      },
    });

    log(`結果を Google Sheets に書き込みました`);
  } catch (error) {
    logError(`結果の書き込みエラー: ${error.message}`);
    throw error;
  }
}

// ========== メイン処理 ==========

async function main() {
  try {
    // コマンドライン引数をチェック
    if (process.argv.includes('--test')) {
      isTestMode = true;
      maxUsers = 50;
      log('テストモードで実行します');
    }

    log('TikTok LIVE チェッカー v2 (API方式) を開始します');

    // Google Sheets API クライアントを初期化
    const sheets = await initializeGoogleSheetsClient();
    log('Google Sheets API を初期化しました');

    // ユーザーリストを取得
    const users = await fetchUserListFromSheets(sheets);

    if (users.length === 0) {
      log('チェック対象のユーザーがありません');
      process.exit(0);
    }

    // ユーザーをチェック
    log(`${users.length}ユーザーのチェックを開始します（API方式: api-live/user/room/）`);
    await processUsers(users);

    // 結果を書き込み
    await writeResultsToSheets(sheets);

    log(`チェック完了: ${processedCount}/${users.length} ユーザー、${liveUsers.length}が LIVE 配信中、${errorCount}エラー`);
    process.exit(0);
  } catch (error) {
    logError(`予期しないエラーが発生しました: ${error.message}`);
    process.exit(1);
  }
}

main();
