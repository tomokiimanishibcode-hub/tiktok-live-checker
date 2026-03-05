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
const SHEET_NAME_USERS = '\u4e00\u89a7';
const SHEET_NAME_RESULTS = '\u7d50\u679c';
const USER_COLUMN = 'A';
const START_ROW = 3;
const BATCH_SIZE = 5;
const BATCH_DELAY = 2000;
const REQUEST_TIMEOUT = 10000;
const TOTAL_TIMEOUT = 25 * 60 * 1000;

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

      if (liveStatus !== 4 && data.data.user && data.data.user.roomId) {
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
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    if (checkTimeout()) {
      log(`Timeout: ${processedCount}/${users.length} users processed, ${liveUsers.length} LIVE`);
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
        log(`LIVE: ${username}`);
      }
    }

    if (processedCount % 100 === 0 || i + BATCH_SIZE >= users.length) {
      log(`Progress: ${processedCount}/${users.length} checked, ${liveUsers.length} LIVE, ${errorCount} errors`);
    }

    if (i + BATCH_SIZE < users.length) {
      await delay(BATCH_DELAY);
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

    await writeResultsToSheets(sheets);

    log(`Done: ${processedCount}/${users.length} users, ${liveUsers.length} LIVE, ${errorCount} errors`);
    process.exit(0);
  } catch (error) {
    logError(`Unexpected error: ${error.message}`);
    process.exit(1);
  }
}

main();
