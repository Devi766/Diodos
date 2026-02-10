'use strict';

/**
 * Auto-updater module
 * Handles checking for new application versions from GitHub releases.
 */

const RELEASE_API_ENDPOINTS = [
  'https://api.github.com/repos/GtxFury/FlyClash/releases/latest',
  'https://mirror.ghproxy.com/https://api.github.com/repos/GtxFury/FlyClash/releases/latest',
  'https://gh.api.99988866.xyz/https://api.github.com/repos/GtxFury/FlyClash/releases/latest'
];

const AUTO_UPDATE_IPC_CHANNEL = 'auto-update-available';

let cachedFetchFn = null;

async function resolveFetchFn() {
  if (cachedFetchFn) {
    return cachedFetchFn;
  }

  if (typeof globalThis.fetch === 'function') {
    cachedFetchFn = globalThis.fetch.bind(globalThis);
    return cachedFetchFn;
  }

  const { default: fetchFn } = await import('node-fetch');
  cachedFetchFn = fetchFn;
  return cachedFetchFn;
}

function normalizeVersionString(value) {
  if (!value) return '0.0.0';
  const cleaned = String(value).trim().replace(/^v/i, '');
  const main = cleaned.split(/[-+]/)[0];
  return main || '0.0.0';
}

function compareVersionsString(a, b) {
  const aParts = normalizeVersionString(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const bParts = normalizeVersionString(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i += 1) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }

  return 0;
}

async function fetchLatestReleaseInfo() {
  const fetchFn = await resolveFetchFn();
  const errors = [];

  for (const endpoint of RELEASE_API_ENDPOINTS) {
    try {
      const response = await fetchFn(endpoint, {
        headers: {
          Accept: 'application/vnd.github+json'
        }
      });

      if (!response.ok) {
        errors.push(`${endpoint}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const tagName = data?.tag_name || data?.name || '';

      return {
        release: {
          version: normalizeVersionString(tagName || data?.tag_name || data?.name),
          displayVersion: tagName || data?.name || '',
          body: data?.body || '',
          url: data?.html_url || (tagName ? `https://github.com/GtxFury/FlyClash/releases/tag/${tagName}` : 'https://github.com/GtxFury/FlyClash/releases'),
          name: data?.name || '',
          publishedAt: data?.published_at || ''
        },
        source: endpoint
      };
    } catch (error) {
      errors.push(`${endpoint}: ${error?.message || error}`);
    }
  }

  return { release: null, error: errors.join(' | ') || 'Unknown error' };
}

/**
 * Create an auto-updater instance bound to the given dependencies.
 * @param {object} deps
 * @param {object} deps.app - Electron app module
 * @param {object} deps.state - Shared application state
 * @param {object} deps.dbManager - Database manager
 * @param {string} deps.APP_VERSION - Current application version
 */
function createAutoUpdater({ app, state, dbManager, APP_VERSION }) {
  let startupUpdateCheckScheduled = false;

  async function runStartupUpdateCheck() {
    try {
      const autoCheckEnabled = dbManager.getSetting('autoCheckUpdate', true);
      if (!autoCheckEnabled) {
        console.log('[AutoUpdate] 自动更新检查已禁用，跳过');
        return;
      }

      const { release, error } = await fetchLatestReleaseInfo();
      if (!release) {
        if (error) {
          console.warn('[AutoUpdate] 获取版本信息失败:', error);
        }
        return;
      }

      const currentVersion = typeof app.getVersion === 'function' ? app.getVersion() : APP_VERSION;
      if (compareVersionsString(release.version, currentVersion) > 0) {
        if (state.mainWindow?.webContents && !state.mainWindow.webContents.isDestroyed()) {
          state.mainWindow.webContents.send(AUTO_UPDATE_IPC_CHANNEL, {
            release,
            currentVersion
          });
          console.log('[AutoUpdate] 检测到新版本，已通知渲染进程');
        }
      } else {
        console.log('[AutoUpdate] 当前已是最新版本');
      }
    } catch (error) {
      console.error('[AutoUpdate] 启动检查失败:', error);
    }
  }

  function scheduleStartupUpdateCheck() {
    if (startupUpdateCheckScheduled) return;
    startupUpdateCheckScheduled = true;

    const triggerCheck = () => {
      runStartupUpdateCheck();
    };

    if (state.mainWindow?.webContents) {
      state.mainWindow.webContents.once('did-finish-load', triggerCheck);
    } else {
      setTimeout(() => scheduleStartupUpdateCheck(), 1000);
    }
  }

  return {
    scheduleStartupUpdateCheck,
    runStartupUpdateCheck,
    fetchLatestReleaseInfo,
    compareVersionsString,
    normalizeVersionString,
    resolveFetchFn,
  };
}

module.exports = {
  createAutoUpdater,
  // Also export standalone utilities for use by other modules
  resolveFetchFn,
  normalizeVersionString,
  compareVersionsString,
  fetchLatestReleaseInfo,
  AUTO_UPDATE_IPC_CHANNEL,
  RELEASE_API_ENDPOINTS,
};
