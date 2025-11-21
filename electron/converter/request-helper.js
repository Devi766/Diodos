/**
 * 通用请求工具：支持自定义 UA/代理/跳过证书校验
 */
const http = require('http');
const https = require('https');
const axios = require('axios');
const ProxyAgent = require('proxy-agent');

const DEFAULT_UA = 'FlyClash-Converter/1.0';
const DEFAULT_TIMEOUT = 30000;

function buildAgent(url, settings = {}) {
  const isHttps = url.startsWith('https');
  const insecure = settings.insecure === true;
  const proxy = settings.proxy;

  if (proxy) {
    const agent = new ProxyAgent(proxy);
    // proxy-agent 走 HTTPS 时也会读取 options.rejectUnauthorized
    if (isHttps && agent?.options) {
      agent.options.rejectUnauthorized = !insecure;
    }
    return agent;
  }

  if (isHttps) {
    return new https.Agent({ rejectUnauthorized: !insecure });
  }

  // http 默认 agent 即可
  return undefined;
}

function appendNoCacheParam(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('_t', Date.now().toString());
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_t=${Date.now()}`;
  }
}

async function fetchWithOptions(url, settings = {}, extraHeaders = {}) {
  const headers = {
    'User-Agent': settings.userAgent || DEFAULT_UA,
    ...extraHeaders
  };

  if (settings.noCache) {
    headers['Cache-Control'] = 'no-cache';
    headers['Pragma'] = 'no-cache';
  }

  const agent = buildAgent(url, settings);
  const requestUrl = settings.noCache ? appendNoCacheParam(url) : url;

  const response = await axios.get(requestUrl, {
    timeout: settings.timeout || DEFAULT_TIMEOUT,
    headers,
    httpAgent: agent,
    httpsAgent: agent,
    validateStatus: () => true
  });

  if (response.status >= 200 && response.status < 300) {
    return { data: response.data, headers: response.headers };
  }

  throw new Error(`HTTP ${response.status}`);
}

module.exports = {
  fetchWithOptions,
  DEFAULT_UA,
  DEFAULT_TIMEOUT
};
