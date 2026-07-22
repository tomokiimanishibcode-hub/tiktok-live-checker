/**
 * TikTok配信者リスト - LIVE確認機能 v4（GitHub Actions連携版）
 *
 * 仕組み:
 * - GitHub Actionsが30分ごとにTikTok APIをチェックし、結果スプレッドシートに書き込む
 * - このGASはその結果スプレッドシートを読み取って表示するだけ
 * - 「今すぐチェック」ボタンでGitHub Actions workflowを手動トリガー可能
 * - TikTok APIをGASから直接呼ばないので、タイムアウトしない
 */

var RESULTS_SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('resultsSheetId'); // 公開リポのためID直書き禁止（GAS側でScript Propertiesに設定）
var RESULTS_SHEET_NAME = '結果';

// GitHub Actions設定（今すぐチェック機能用）
var GITHUB_OWNER = 'tomokiimanishibcode-hub';
var GITHUB_REPO = 'tiktok-live-checker';
var GITHUB_WORKFLOW = 'check-live.yml';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('TikTok配信者リスト')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 結果スプレッドシートから最新のLIVE結果を取得
 * GitHub Actionsが書き込んだデータを読み取る
 */
function getLatestResults() {
  try {
    var ss = SpreadsheetApp.openById(RESULTS_SPREADSHEET_ID);
    var sheet = ss.getSheetByName(RESULTS_SHEET_NAME);

    if (!sheet) {
      return { success: false, message: 'シート「' + RESULTS_SHEET_NAME + '」が見つかりません' };
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 1) {
      return { success: true, liveUsers: [], total: 0, errors: 0, checkedAt: 'データなし', liveCount: 0 };
    }

    // 全データを一括読み取り（高速）
    var data = sheet.getRange(1, 1, lastRow, 2).getValues();

    // check-live.jsが書き込むフォーマット:
    // Row 1: チェック日時 | timestamp
    // Row 2: LIVE配信中のユーザー数 | count
    // Row 3: チェック済みユーザー数 | count
    // Row 4: エラー数 | count
    // Row 5: (空行)
    // Row 6: ユーザー名 | LIVE URL (ヘッダー)
    // Row 7+: username | URL

    // サマリー情報を取得（キーワードで検索して確実に取得）
    var checkedAt = 'データなし';
    var liveCount = 0;
    var totalChecked = 0;
    var errorCount = 0;
    var headerRowIndex = -1;

    for (var i = 0; i < data.length; i++) {
      var label = String(data[i][0]).trim();
      var value = data[i][1];

      if (label.indexOf('チェック日時') !== -1) {
        checkedAt = value ? String(value) : 'データなし';
      } else if (label.indexOf('LIVE') !== -1 && label.indexOf('ユーザー数') !== -1) {
        liveCount = value ? Number(value) : 0;
      } else if (label.indexOf('チェック済み') !== -1) {
        totalChecked = value ? Number(value) : 0;
      } else if (label.indexOf('エラー') !== -1) {
        errorCount = value ? Number(value) : 0;
      } else if (label === 'ユーザー名') {
        headerRowIndex = i;
        break;
      }
    }

    // ヘッダー行の次からLIVEユーザーデータを取得
    var liveUsers = [];
    if (headerRowIndex >= 0) {
      for (var j = headerRowIndex + 1; j < data.length; j++) {
        var username = data[j][0];
        var url = data[j][1];
        if (username && String(username).trim()) {
          liveUsers.push({
            username: String(username).trim(),
            url: url ? String(url).trim() : 'https://www.tiktok.com/@' + String(username).trim() + '/live'
          });
        }
      }
    }

    return {
      success: true,
      liveUsers: liveUsers,
      liveCount: liveCount,
      total: totalChecked,
      errors: errorCount,
      checkedAt: checkedAt
    };

  } catch (e) {
    return { success: false, message: 'エラー: ' + e.message };
  }
}

/**
 * GitHub Actions workflowを手動トリガー（今すぐチェック機能）
 * Script PropertiesにGITHUB_TOKENが設定されている必要がある
 */
function triggerGitHubActions() {
  try {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('GITHUB_TOKEN');

    if (!token) {
      return { success: false, message: 'GITHUB_TOKENが設定されていません。\nスクリプトプロパティに設定してください。' };
    }

    var url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/actions/workflows/' + GITHUB_WORKFLOW + '/dispatches';

    var options = {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      contentType: 'application/json',
      payload: JSON.stringify({ ref: 'main' }),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();

    if (code === 204) {
      return { success: true, message: 'チェックを開始しました。1〜2分後に「最新結果を表示」を押してください。' };
    } else {
      var body = response.getContentText();
      return { success: false, message: 'GitHub APIエラー (HTTP ' + code + '): ' + body };
    }

  } catch (e) {
    return { success: false, message: 'エラー: ' + e.message };
  }
}
