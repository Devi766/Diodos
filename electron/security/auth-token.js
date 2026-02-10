'use strict';

/**
 * Auth token module
 * Generates and verifies short-lived security tokens for IPC operations.
 */

const crypto = require('crypto');

let activeAuthToken = null;
let authTokenExpiry = 0;

function generateAuthToken() {
  activeAuthToken = crypto.randomBytes(32).toString('base64url');
  authTokenExpiry = Date.now() + 5 * 60 * 1000;
  return { token: activeAuthToken, expiry: authTokenExpiry };
}

function ensureAuthToken() {
  if (!activeAuthToken || authTokenExpiry <= Date.now()) {
    return generateAuthToken();
  }
  return { token: activeAuthToken, expiry: authTokenExpiry };
}

function verifyAuthToken(token) {
  if (!token || !activeAuthToken) {
    return false;
  }
  if (authTokenExpiry <= Date.now()) {
    activeAuthToken = null;
    return false;
  }
  return token === activeAuthToken;
}

module.exports = {
  generateAuthToken,
  ensureAuthToken,
  verifyAuthToken,
};
