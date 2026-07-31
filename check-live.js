#!/usr/bin/env node
/**
 * TikTok LIVE Checker v2
 * Reads TikTok user IDs from Google Sheets,
 * checks LIVE status via TikTok internal API (api-live/user/room/),
 * and writes results to Google Sheets.
 */

const { google } = require('googleapis');

// ========== Constants ==========
// スプレッドシートIDは環境変数から（公開リポジトリのためハードコード禁止。GitHub ActionsはSecrets、ローカルは.env.local）
const SPREADSHEET_ID_SOURCE = process.env.SPREADSHEET_ID_SOURCE;   // Read-only source
const SPREADSHEET_ID_RESULTS = process.env.SPREADSHEET_ID_RESULTS; // Results output
if (!SPREADSHEET_ID_SOURCE || !SPREADSHEET_ID_RESULTS) {
  console.error('環境変数 SPREADSHEET_ID_SOURCE / SPREADSHEET_ID_RESULTS が未設定です');
  process.exit(1);
}
const SHEET_NAME_USERS = '\u30ea\u30b9\u30c8\u30a2\u30c3\u30d7\u4e00\u89a7';
const SHEET_NAME_RESULTS = '\u7d50\u679c';
const USER_COLUMN = 'B';
const START_ROW = 3;
const BATCH_SIZE = 8;
const BATCH_DELAY = 1000;
const REQUEST_TIMEOUT = 10000;
const TOTAL_TIMEOUT = 27 * 60 * 1000; // フォロワー約790人の監視合流で対象約8,350人に増えたため25→27分（GitHub job上限30分、checkout等の前処理を差し引いても安全圏）
// エラー率がこれを超えたら結果を保存しない（壊れたデータで上書きしないため）
const MAX_ERROR_RATE = 0.3;
const MIN_COVERAGE = 0.9; // ★#34 タイムアウトで打ち切った場合、この割合未満しかチェックできていなければ保存しない（未チェック分をoffline扱いで消さない）

// GAS Webアプリ（チェック対象の取得 + 結果のダッシュボード同期に使用）
const GAS_URL = process.env.GAS_URL;
if (!GAS_URL) {
  console.error('環境変数 GAS_URL が未設定です');
  process.exit(1);
}

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
let notFoundCount = 0; // ★ user_not_found(削除済みアカウント)。エラーではないが可視化する
let rateLimitCount = 0; // ★ HTTP403等のレート制限シグナル
let timedOut = false; // ★#34 タイムアウトで途中打ち切りしたか

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

// ★2026-07-31 分割巡回(シャーディング)
//   監視対象が9,400人超に増え1回の実行(25分)で全員は回れないため、毎回一定数ずつ区切って
//   チェックし、次回はその続きから回る。オフセットは結果シートのメタ行に保存する。
//   未チェックの人は前回のLIVE状態を引き継ぐ(マージ)ため、結果シートの内容は常に全員分になる。
const SHARD_SIZE = Number(process.env.SHARD_SIZE || 3000);
const OFFSET_LABEL = '巡回オフセット';

async function readPrevResults(sheets) {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID_RESULTS,
      range: `${SHEET_NAME_RESULTS}!A1:B20000`,
    });
    const rows = resp.data.values || [];
    let offset = 0;
    const prevLive = [];
    let inList = false;
    for (const r of rows) {
      const a = (r[0] || '').trim();
      const b = (r[1] || '').trim();
      if (a === OFFSET_LABEL) { offset = parseInt(b) || 0; continue; }
      if (a === 'ユーザー名') { inList = true; continue; } // 「ユーザー名」ヘッダー以降がリスト
      if (inList && a) prevLive.push(a);
    }
    return { offset, prevLive };
  } catch (e) {
    logError(`Failed to read previous results (${e.message}), starting from offset 0`);
    return { offset: 0, prevLive: [] };
  }
}

async function fetchUserListFromSheets(sheets) {
  // ★ 優先: GASから「チェック対象」リストを取得（他社所属/対象外/削除済/未対応を除外済み）
  //    → チェック数が減り、全員を制限時間内にカバーできる
  try {
    const resp = await fetch(`${GAS_URL}?action=getLiveTargets`, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
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
    const resp = await fetch(`${GAS_URL}?action=runLiveCheck`, { redirect: 'follow', signal: AbortSignal.timeout(90000) });
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
    // AbortSignal.timeout: ボディ読み取り(json())までタイムアウト保護が効く
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'ja-JP,ja;q=0.9',
        'Referer': 'https://www.tiktok.com/',
        'Origin': 'https://www.tiktok.com',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      // ★ 403/429はレート制限。適応スロットルの判断材料として別カウントする
      if (response.status === 403 || response.status === 429) rateLimitCount++;
      logError(`${username}: HTTP ${response.status}`);
      errorCount++;
      return false;
    }

    const data = await response.json();

    if (data.statusCode !== 0) {
      // ★2026-07-31 修正: user_not_found(19881007)は「アカウント削除/存在しない」という正当な応答であり
      //   エラーではない。#12で一律エラー計上にした結果、削除済みアカウントが多いリストでエラー率が
      //   50%超に膨らみ→適応スロットルが常時60秒停止→25分で22%しか処理できず→エラー率30%超で
      //   保存スキップ、という連鎖でLIVEチェックが数日間まるごと機能停止していた。
      //   ソフトブロック検知の意図は残すため、user_not_found以外のstatusCodeのみエラー計上する。
      if (data.statusCode !== 19881007) errorCount++;
      else notFoundCount++;
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
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
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
      timedOut = true; // ★#34 途中打ち切りを記録し、mainのカバレッジゲートで部分結果の上書き保存を止める
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

async function writeResultsToSheets(sheets, checkedUsers, prevLiveUsers, nextOffset) {
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID_RESULTS,
      range: SHEET_NAME_RESULTS,
    });

    const timestamp = new Date().toISOString();
    // \u2605 \u30b7\u30e3\u30fc\u30c9\u5916(\u4eca\u56de\u672a\u30c1\u30a7\u30c3\u30af)\u306e\u4eba\u306f\u524d\u56de\u306eLIVE\u72b6\u614b\u3092\u5f15\u304d\u7d99\u304e\u3001\u7d50\u679c\u306f\u5e38\u306b\u5168\u54e1\u5206\u306b\u306a\u308b\u3088\u3046\u30de\u30fc\u30b8\u3059\u308b
    const checkedSet = new Set(checkedUsers.map(u => u.toLowerCase()));
    const carried = prevLiveUsers.filter(u => !checkedSet.has(u.toLowerCase()));
    const merged = [...new Set([...liveUsers, ...carried])];
    const rows = [
      ['\u30c1\u30a7\u30c3\u30af\u65e5\u6642', timestamp],
      ['LIVE\u914d\u4fe1\u4e2d\u306e\u30e6\u30fc\u30b6\u30fc\u6570', merged.length],
      ['\u30c1\u30a7\u30c3\u30af\u6e08\u307f\u30e6\u30fc\u30b6\u30fc\u6570', processedCount],
      ['\u30a8\u30e9\u30fc\u6570', errorCount],
      ['\u524a\u9664\u6e08\u307f\u30a2\u30ab\u30a6\u30f3\u30c8\u6570', notFoundCount],
      [OFFSET_LABEL, nextOffset],
      [''],
      ['\u30e6\u30fc\u30b6\u30fc\u540d', 'LIVE URL'],
    ];

    for (const username of merged) {
      rows.push([username, `https://www.tiktok.com/@${username}/live`]);
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID_RESULTS,
      range: `${SHEET_NAME_RESULTS}!A1`,
      valueInputOption: 'RAW', // ★#40 数字だけのユーザー名が数値/日付に変換されるのを防ぐ（そのまま文字列で保存）
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

    let users = await fetchUserListFromSheets(sheets);

    if (users.length === 0) {
      log('No users to check');
      process.exit(0);
    }

    // ★ 分割巡回: 前回の続き(オフセット)からSHARD_SIZE人だけをチェックする
    const allUsers = users;
    const N = allUsers.length;
    const { offset: prevOffset, prevLive: prevLiveUsers } = await readPrevResults(sheets);
    const size = Math.min(SHARD_SIZE, N);           // 対象が少ない場合は全員（重複させない）
    const startAt = ((prevOffset % N) + N) % N;
    const shard = [];
    for (let i = 0; i < size; i++) shard.push(allUsers[(startAt + i) % N]); // 末尾まで来たら先頭へ回る
    const nextOffset = (startAt + size) % N;
    users = shard;

    log(`Checking ${users.length}/${allUsers.length} users (shard ${startAt}〜, next offset ${nextOffset}, prev LIVE ${prevLiveUsers.length})`);
    await processUsers(users);

    // ★ 品質ガード: エラー率が高すぎる場合は保存しない（前回の正常データを保持）
    //   分母からuser_not_found(正当な応答)を除く＝実際の通信失敗率で判定する
    const effective = Math.max(1, processedCount - notFoundCount);
    const errorRate = errorCount / effective;
    if (errorRate > MAX_ERROR_RATE) {
      log(`SKIPPED write/sync: error rate ${(errorRate * 100).toFixed(0)}% exceeds ${MAX_ERROR_RATE * 100}% (errors ${errorCount}, rateLimit ${rateLimitCount}, notFound ${notFoundCount}) — keeping previous good data`);
      process.exit(0);
    }

    // ★#34 カバレッジガード: タイムアウトで大半が未チェックのまま部分結果を保存すると、
    //      そのシャードのLIVE配信者がoffline扱いで消える。規定割合に満たなければ保存を見送る。
    const coverage = users.length > 0 ? processedCount / users.length : 0;
    if (timedOut && coverage < MIN_COVERAGE) {
      log(`SKIPPED write/sync: only ${(coverage * 100).toFixed(0)}% of shard checked before timeout (< ${MIN_COVERAGE * 100}%) — keeping previous good data`);
      process.exit(0);
    }

    // 実際にチェックできた分だけを「今回更新した人」として渡す（タイムアウトで未処理の分は前回状態を維持）
    await writeResultsToSheets(sheets, users.slice(0, processedCount), prevLiveUsers, nextOffset);

    // ダッシュボードへ自動同期（失敗しても結果シートには書き込み済み）
    await syncToDashboard();

    log(`Done: ${processedCount}/${users.length} shard users, ${liveUsers.length} LIVE in shard, ${errorCount} errors, ${notFoundCount} notFound, next offset ${nextOffset}`);
    process.exit(0);
  } catch (error) {
    logError(`Unexpected error: ${error.message}`);
    process.exit(1);
  }
}

main();
