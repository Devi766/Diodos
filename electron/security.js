/**
 * Security utilities — input validation and security checks
 */
const path = require('path');
const fs = require('fs');
const url = require('url');

/**
 * Validates whether a URL is safe and well-formed.
 * @param {string} urlString - The URL string to validate
 * @returns {object} - Validation result { valid: boolean, error?: string, url?: string }
 */
function validateUrl(urlString) {
  if (!urlString) {
    return { valid: false, error: 'URL is required' };
  }

  const trimmedUrl = urlString.trim();

  // Local file import identifiers bypass standard URL validation
  if (trimmedUrl.startsWith('local:')) {
    return { valid: true, url: trimmedUrl };
  }

  try {
    const parsedUrl = new URL(trimmedUrl);

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
    }

    const dangerousChars = /[|;`$(){}<>]/g;
    const pathToCheck = parsedUrl.pathname + parsedUrl.search;
    if (dangerousChars.test(pathToCheck)) {
      return { valid: false, error: 'URL contains unsafe characters' };
    }

    return { valid: true, url: parsedUrl.href };
  } catch (e) {
    // Attempt to prepend https:// if no protocol is present
    if (!trimmedUrl.match(/^https?:\/\//i)) {
      try {
        const parsedWithProtocol = new URL('https://' + trimmedUrl);
        return { valid: true, url: parsedWithProtocol.href };
      } catch (e2) {
        // fall through
      }
    }

    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validates whether a file path is safe.
 * @param {string} filePath - The file path to validate
 * @returns {object} - Validation result { valid: boolean, error?: string, path?: string }
 */
function validateFilePath(filePath) {
  if (!filePath) {
    return { valid: false, error: 'File path is required' };
  }

  const normalized = path.normalize(filePath);

  if (normalized.includes('..')) {
    return { valid: false, error: 'File path must not contain path traversal sequences' };
  }

  const dangerousChars = /[&|;`$(){}]/g;
  if (dangerousChars.test(normalized)) {
    return { valid: false, error: 'File path contains unsafe characters' };
  }

  return { valid: true, path: normalized };
}

/**
 * Validates a proxy configuration object.
 * @param {object} config - The proxy configuration object
 * @returns {object} - Validation result { valid: boolean, error?: string, config?: object }
 */
function validateProxyConfig(config) {
  if (!config) {
    return { valid: false, error: 'Configuration object is required' };
  }

  if (config['mixed-port'] !== undefined) {
    const port = parseInt(config['mixed-port'], 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      return { valid: false, error: 'Invalid port number; must be between 1024 and 65535' };
    }
  }

  if (config.tun && config.tun.enable === true) {
    if (config.tun.device && !/^[a-zA-Z0-9_-]+$/.test(config.tun.device)) {
      return { valid: false, error: 'TUN device name contains invalid characters' };
    }
  }

  if (config.dns && config.dns.nameserver && Array.isArray(config.dns.nameserver)) {
    const commonDnsRegex = /^(dhcp|system|local|(\d{1,3}\.){3}\d{1,3}(:\d+)?|(https?|tls|tcp|udp):\/\/.+)$/i;
    for (const ns of config.dns.nameserver) {
      if (ns && typeof ns === 'string' && !commonDnsRegex.test(ns)) {
        console.warn(`[Security] Unusual DNS nameserver format detected: ${ns}`);
      }
    }
  }

  return { valid: true, config };
}

/**
 * Safe User-Agent whitelist
 */
const ALLOWED_USERAGENTS = {
  'Clash': 'Clash/2.0.0',
  'Mihomo': 'Mihomo/1.14.0',
  'MihomoParty': 'clash.meta',
  'Chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'FlyClash': 'FlyClash/1.0.0'
};

/**
 * Returns a safe User-Agent string from the whitelist.
 * @param {string} uaKey - User-Agent key name
 * @param {string} appVersion - Application version string
 * @returns {string} - Safe User-Agent string
 */
function getSafeUserAgent(uaKey, appVersion) {
  if (uaKey === 'FlyClash' && appVersion) {
    return `FlyClash/${appVersion}`;
  }
  return ALLOWED_USERAGENTS[uaKey] || ALLOWED_USERAGENTS['MihomoParty'];
}

/**
 * Records a security event to the console and optionally to a log file.
 * @param {string} event - Event name
 * @param {object} details - Event details
 * @param {string} logPath - Optional log file path
 */
function logSecurityEvent(event, details, logPath) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    details
  };

  console.warn(`[Security] ${JSON.stringify(logEntry)}`);

  if (logPath) {
    try {
      fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
    } catch (e) {
      console.error('[Security] Failed to write security log:', e);
    }
  }
}

module.exports = {
  validateUrl,
  validateFilePath,
  validateProxyConfig,
  getSafeUserAgent,
  ALLOWED_USERAGENTS,
  logSecurityEvent
}; 