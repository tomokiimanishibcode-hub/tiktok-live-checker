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
// ★2026-07-31 実測: 8並列×1秒(≒8req/s)だと約500件でTikTokにIPブロックされ、以降ほぼ全て403になる
//   （実機ログ: 993エラー中271が403、400件までは0エラー→その後100%失敗）。
//   ブロックされてからでは1回の実行が丸ごと無駄になるため、最初から低速で回し切る方針に変更。
//   2並列×1.5秒 ≒ 1.3req/s。25分で約2,000件を安定処理できる想定。
const BATCH_SIZE = 2;
const BATCH_DELAY = 1500;
const REQUEST_TIMEOUT = 10000;
const TOTAL_TIMEOUT = 27 * 60 * 1000; // フォロワー約790人の監視合流で対象約8,350人に増えたため25→27分（GitHub job上限30分、checkout等の前処理を差し引いても安全圏）
// エラー率がこれを超えたら結果を保存しない（壊れたデータで上書きしないため）
// MAX_ERROR_RATEも同様に廃止（極端な全滅時のみ0.9で判定する）
// ★#34のMIN_COVERAGEは2026-07-31に廃止。分割巡回＋マージで「正常応答が取れた人だけ更新」する設計になり、
//   未チェック分がoffline扱いで消える事故が構造的に起きなくなったため、部分結果もそのまま保存してよい。

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
// ★ 正常に応答が取れた人だけを「チェック済み」とする。403等で応答が取れなかった人を
//   チェック済み扱いにすると、配信中でも結果から消えてしまう（状態不明≠オフライン）。
const respondedUsers = [];
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
    log(`Timeout: exceeded ${Math.round(TOTAL_TIMEOUT/60000)} minutes. Stopping.`);
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
const SHARD_SIZE = Number(process.env.SHARD_SIZE || 1500); // 低速化(1.3req/s)に合わせて25分で回り切れる量に
const OFFSET_LABEL = '巡回オフセット';

const PREV_READ_RETRIES = 3;
const PREV_READ_RETRY_DELAY = 5000;

async function readPrevResults(sheets) {
  // ★ 読取失敗を offset 0 / prevLive [] で握り潰すと、巡回位置が先頭に巻き戻り、
  //   さらに前回のLIVE中ユーザーが引き継がれず全消しで上書きされる。
  //   数回リトライし、それでも失敗したら例外を投げて実行ごと中断する
  //   （シートへ一切書き込まないので、前回状態とオフセットはそのまま保存される）。
  let resp;
  for (let attempt = 1; attempt <= PREV_READ_RETRIES; attempt++) {
    try {
      resp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID_RESULTS,
        range: `${SHEET_NAME_RESULTS}!A1:B20000`,
      });
      break;
    } catch (e) {
      logError(`Failed to read previous results (attempt ${attempt}/${PREV_READ_RETRIES}): ${e.message}`);
      if (attempt === PREV_READ_RETRIES) {
        throw new Error(`Failed to read previous results after ${PREV_READ_RETRIES} attempts: ${e.message}`);
      }
      await delay(PREV_READ_RETRY_DELAY);
    }
  }

  // ここに来たら読取は成功。シートが空(初回)なら offset 0 / prevLive [] を返す（失敗とは区別する）
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
      else { notFoundCount++; respondedUsers.push(username); } // 削除済み＝正常応答なのでチェック済み扱い
      return false;
    }
    respondedUsers.push(username); // statusCode 0 ＝ 正常応答

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
  let rlWindow = 0; // ★ 403/429の累積カウント（休止したらリセット）

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    if (checkTimeout()) {
      timedOut = true; // ★#34 途中打ち切りを記録し、mainのカバレッジゲートで部分結果の上書き保存を止める
      log(`Timeout: ${processedCount}/${users.length} users processed, ${liveUsers.length} LIVE`);
      return;
    }

    const batch = users.slice(i, i + BATCH_SIZE);
    const errBefore = errorCount;
    const rlBefore = rateLimitCount;

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

    // ★2026-07-31 レート制限(403/429)の即時検知: 一度ブロックされると60秒では解けず、
    //   実測では以降ほぼ全リクエストが失敗して1回の実行が丸ごと無駄になっていた。
    //   403を検知したら短い判定を待たずに5分休止＋減速し、回復を待ってから続行する。
    //   ★ 1バッチ内の増分で判定するとBATCH_SIZE=2では最大2しか増えず永久に発火しないため、
    //     バッチをまたいで累積(rlWindow)し、3件たまった時点で休止する。
    const rlNow = rateLimitCount;
    rlWindow += rlNow - rlBefore;
    if (rlWindow >= 3) {
      currentDelay = Math.min(currentDelay * 2, 6000);
      // ★ 休止で残り時間を使い切ると1件も書き込めないまま強制終了になるため、残り時間の半分までに制限する
      const remaining = TOTAL_TIMEOUT - (Date.now() - startTime);
      const pauseMs = Math.max(0, Math.min(300000, Math.floor(remaining / 2)));
      log(`Rate limit hit (403/429 x${rlWindow}) — pausing ${Math.round(pauseMs / 1000)}s, delay now ${currentDelay}ms`);
      rlWindow = 0;
      await delay(pauseMs);
      recentErrors = 0; recentChecked = 0;
      continue;
    }
    // ★ 適応スロットル: 直近100件のエラー率が高ければ60秒休止して減速
    recentErrors += errorCount - errBefore;
    recentChecked += batch.length;
    if (recentChecked >= 100) {
      if (recentErrors / recentChecked > 0.5) {
        currentDelay = Math.min(currentDelay * 2, 6000);
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
    users = shard;

    log(`Checking ${users.length}/${allUsers.length} users (shard ${startAt}〜, prev LIVE ${prevLiveUsers.length})`);
    await processUsers(users);

    // ★2026-07-31 分割巡回＋マージ導入により、部分結果の保存は安全になった
    //   （今回チェックできた人だけを更新し、未チェックの人は前回状態をそのまま引き継ぐため
    //    「未チェック＝オフライン扱いで消える」事故が構造的に起きない）。
    //   よって従来の「全体エラー率で丸ごと保存スキップ」「カバレッジ90%未満で丸ごと破棄」は廃止。
    //   ブロックされた回でも進んだ分は必ず前進し、次回はその続きから再開できる。
    //   ただしエラー率が極端(90%超=ほぼ全滅)なら、その回の結果は信用せず保存しない。
    const effective = Math.max(1, processedCount - notFoundCount);
    const errorRate = errorCount / effective;
    if (errorRate > 0.9) {
      log(`SKIPPED write/sync: error rate ${(errorRate * 100).toFixed(0)}% — nearly all requests failed (errors ${errorCount}, rateLimit ${rateLimitCount}, notFound ${notFoundCount})`);
      process.exit(0);
    }

    // ★ オフセットは試行した数だけ進める（タイムアウト分は次回に回る）
    const nextOffset = (startAt + Math.max(processedCount, 1)) % N;
    log(`Shard done: attempted ${processedCount}, valid responses ${respondedUsers.length}, next offset ${nextOffset}`);

    // ★ 正常応答が取れた人だけを「更新対象」として渡す。403等で不明だった人は前回状態を維持する
    await writeResultsToSheets(sheets, respondedUsers, prevLiveUsers, nextOffset);

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
