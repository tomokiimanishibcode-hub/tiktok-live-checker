#!/usr/bin/env node

/**
 * TikTok LIVE ãã§ãã«ã¼ v2
 * Google Sheets ãã TikTok ã¦ã¼ã¶ã¼IDãåå¾ãã¦ã
 * TikTok åé¨API (api-live/user/room/) ãä½¿ã£ã¦ LIVE éä¿¡ä¸­ãã©ãããç¢ºèªãã
 * çµæã Google Sheets ã«æ¸ãè¾¼ã¿ã¾ãã
 */

const { google } = require('googleapis');

// ========== å®æ°ã¨è¨­å® ==========
const SPREADSHEET_ID_SOURCE = '1UVyeNE9wv5Opany5gpMg5TBOs87LGBvhH-D9EvVl8W0';  // 読み取り専用（みんなのスプレッドシート）
const SPREADSHEET_ID_RESULTS = '1Esn_gh-BBYFlIHiQTHFSC-AGQA51qCSNBaZ22mOqEyU'; // 結果書き込み用
const SHEET_NAME_USERS = '一覧';
const SHEET_NAME_RESULTS = '結果';
const USER_COLUMN = 'A';
const START_ROW = 3; // 3è¡ç®ããéå§
const BATCH_SIZE = 5; // ä¸åº¦ã«å¦çããã¦ã¼ã¶ã¼æ°
const BATCH_DELAY = 2000; // ãããéã®éå»¶ï¼ããªç§ï¼
const REQUEST_TIMEOUT = 10000; // ãªã¯ã¨ã¹ãã®ã¿ã¤ã ã¢ã¦ãï¼ããªç§ï¼
const TOTAL_TIMEOUT = 25 * 60 * 1000; // ç·å®è¡æéã®ä¸éï¼25åï¼

// TikTok API è¨­å®
const TIKTOK_API_URL = 'https://www.tiktok.com/api-live/user/room/';
const TIKTOK_API_PARAMS = {
  aid: '1988',
  app_name: 'tiktok_web',
  device_platform: 'web_pc',
  sourceType: '54',
};

// User-Agent ãè¨­å®ï¼ãããæ¤åºåé¿ï¼
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ========== ã°ã­ã¼ãã«å¤æ° ==========
let isTestMode = false;
let maxUsers = Infinity;
const startTime = Date.now();
let processedCount = 0;
let liveUsers = [];
let errorCount = 0;

// ========== ã¦ã¼ãã£ãªãã£é¢æ° ==========

/**
 * ã­ã°åºåï¼ã¿ã¤ã ã¹ã¿ã³ãä»ãï¼
 */
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * ã¨ã©ã¼ã­ã°åºå
 */
function logError(message) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

/**
 * çµéæéããã§ãã¯
 */
function checkTimeout() {
  const elapsed = Date.now() - startTime;
  if (elapsed > TOTAL_TIMEOUT) {
    log(`ã¿ã¤ã ã¢ã¦ã: 25åä»¥ä¸çµéãã¦ãã¾ããå¦çãä¸­æ­ãã¾ãã`);
    return true;
  }
  return false;
}

/**
 * éå»¶ãå®è£ï¼Promise ãã¼ã¹ï¼
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Google Sheets API ã¯ã©ã¤ã¢ã³ããåæå
 */
async function initializeGoogleSheetsClient() {
  try {
    const credentialsJson = process.env.GOOGLE_CREDENTIALS;

    if (!credentialsJson) {
      logError('ç°å¢å¤æ° GOOGLE_CREDENTIALS ãè¨­å®ããã¦ãã¾ãã');
      process.exit(1);
    }

    const credentials = JSON.parse(credentialsJson);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    logError(`Google Sheets API ã®åæåã«å¤±æãã¾ãã: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Google Sheets ããã¦ã¼ã¶ã¼ãªã¹ããåå¾
 */
async function fetchUserListFromSheets(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID_SOURCE,
      range: `${SHEET_NAME_USERS}!${USER_COLUMN}${START_ROW}:${USER_COLUMN}`,
    });

    const rows = response.data.values || [];
    let users = rows.map(row => row[0]).filter(username => username && username.trim());

    // ãã¹ãã¢ã¼ãã®å ´åã¯æåã®N ã¦ã¼ã¶ã¼ã®ã¿
    if (isTestMode && users.length > maxUsers) {
      users = users.slice(0, maxUsers);
      log(`ãã¹ãã¢ã¼ã: æåã®${maxUsers}ã¦ã¼ã¶ã¼ã®ã¿å¦çãã¾ã`);
    }

    log(`åå¾ãããã¦ã¼ã¶ã¼æ°: ${users.length}`);
    return users;
  } catch (error) {
    logError(`ã¦ã¼ã¶ã¼ãªã¹ãåå¾ã¨ã©ã¼: ${error.message}`);
    throw error;
  }
}

/**
 * TikTok API ãä½¿ã£ã¦ LIVE ã¹ãã¼ã¿ã¹ããã§ãã¯
 * api-live/user/room/ ã¨ã³ããã¤ã³ããä½¿ç¨
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

    // API ã¬ã¹ãã³ã¹ãè§£æ
    // statusCode: 0 = æå
    if (data.statusCode !== 0) {
      // statusCode ã 0 ä»¥å¤ã®å ´åãã¦ã¼ã¶ã¼ãå­å¨ããªããã¨ã©ã¼
      return false;
    }

    // liveRoom ãå­å¨ããstatus ã 2 (éä¿¡ä¸­) ã§ããã° LIVE
    // status: 2 = éä¿¡ä¸­, 4 = éä¿¡çµäº
    if (data.data && data.data.liveRoom) {
      const liveStatus = data.data.liveRoom.status;
      // status 2 = éä¿¡ä¸­
      if (liveStatus === 2) {
        return true;
      }
      // status 4 = éä¿¡çµäºï¼æè¿ã¾ã§éä¿¡ãã¦ããï¼
      // ããä»¥å¤ã® status ãéä¿¡ä¸­ã®å¯è½æ§ããã
      // roomId ãå­å¨ããstreamData ãããã°éä¿¡ä¸­ã¨ã¿ãªã
      if (liveStatus !== 4 && data.data.user && data.data.user.roomId) {
        return true;
      }
    }

    return false;
  } catch (error) {
    if (error.name === 'AbortError') {
      logError(`${username}: ãªã¯ã¨ã¹ãã¿ã¤ã ã¢ã¦ã`);
    } else {
      logError(`${username}: ãã§ãã¯å¤±æ - ${error.message}`);
    }
    errorCount++;
    return false;
  }
}

/**
 * ã¦ã¼ã¶ã¼ãå¦çï¼ãããåä½ï¼
 */
async function processUsers(users) {
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    // ã¿ã¤ã ã¢ã¦ããã§ãã¯
    if (checkTimeout()) {
      log(`ã¿ã¤ã ã¢ã¦ã: ${processedCount}/${users.length} ã¦ã¼ã¶ã¼å¦çæ¸ã¿ã${liveUsers.length}ã LIVE éä¿¡ä¸­`);
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
        log(`â ${username} ã¯ LIVE éä¿¡ä¸­ã§ã`);
      }
    }

    // 100ã¦ã¼ã¶ã¼ãã¨ã«é²æè¡¨ç¤º
    if (processedCount % 100 === 0 || i + BATCH_SIZE >= users.length) {
      log(`é²æ: ${processedCount}/${users.length} ã¦ã¼ã¶ã¼ããã§ãã¯ï¼${liveUsers.length}ã LIVE ä¸­ã${errorCount}ã¨ã©ã¼ï¼`);
    }

    // ãããéã®éå»¶
    if (i + BATCH_SIZE < users.length) {
      await delay(BATCH_DELAY);
    }
  }
}

/**
 * çµæã Google Sheets ã«æ¸ãè¾¼ã¿
 */
async function writeResultsToSheets(sheets) {
  try {
    // "çµæ" ã·ã¼ããã¯ãªã¢
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID_RESULTS,
      range: SHEET_NAME_RESULTS,
    });

    // çµæãä½æ
    const timestamp = new Date().toISOString();
    const rows = [
      ['ãã§ãã¯æ¥æ', timestamp],
      ['LIVE éä¿¡ä¸­ã®ã¦ã¼ã¶ã¼æ°', liveUsers.length],
      ['ãã§ãã¯æ¸ã¿ã¦ã¼ã¶ã¼æ°', processedCount],
      ['ã¨ã©ã¼æ°', errorCount],
      [''],
      ['ã¦ã¼ã¶ã¼å', 'LIVE URL'],
    ];

    for (const username of liveUsers) {
      rows.push([username, `https://www.tiktok.com/@${username}/live`]);
    }

    // Google Sheets ã«æ¸ãè¾¼ã¿
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID_RESULTS,
      range: `${SHEET_NAME_RESULTS}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rows,
      },
    });

    log(`çµæã Google Sheets ã«æ¸ãè¾¼ã¿ã¾ãã`);
  } catch (error) {
    logError(`çµæã®æ¸ãè¾¼ã¿ã¨ã©ã¼: ${error.message}`);
    throw error;
  }
}

// ========== ã¡ã¤ã³å¦ç ==========

async function main() {
  try {
    // ã³ãã³ãã©ã¤ã³å¼æ°ããã§ãã¯
    if (process.argv.includes('--test')) {
      isTestMode = true;
      maxUsers = 50;
      log('ãã¹ãã¢ã¼ãã§å®è¡ãã¾ã');
    }

    log('TikTok LIVE ãã§ãã«ã¼ v2 (APIæ¹å¼) ãéå§ãã¾ã');

    // Google Sheets API ã¯ã©ã¤ã¢ã³ããåæå
    const sheets = await initializeGoogleSheetsClient();
    log('Google Sheets API ãåæåãã¾ãã');

    // ã¦ã¼ã¶ã¼ãªã¹ããåå¾
    const users = await fetchUserListFromSheets(sheets);

    if (users.length === 0) {
      log('ãã§ãã¯å¯¾è±¡ã®ã¦ã¼ã¶ã¼ãããã¾ãã');
      process.exit(0);
    }

    // ã¦ã¼ã¶ã¼ããã§ãã¯
    log(`${users.length}ã¦ã¼ã¶ã¼ã®ãã§ãã¯ãéå§ãã¾ãï¼APIæ¹å¼: api-live/user/room/ï¼`);
    await processUsers(users);

    // çµæãæ¸ãè¾¼ã¿
    await writeResultsToSheets(sheets);

    log(`ãã§ãã¯å®äº: ${processedCount}/${users.length} ã¦ã¼ã¶ã¼ã${liveUsers.length}ã LIVE éä¿¡ä¸­ã${errorCount}ã¨ã©ã¼`);
    process.exit(0);
  } catch (error) {
    logError(`äºæããªãã¨ã©ã¼ãçºçãã¾ãã: ${error.message}`);
    process.exit(1);
  }
}

main();
