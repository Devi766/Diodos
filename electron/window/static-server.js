'use strict';

const http = require('http');
const path = require('path');
const serveStatic = require('serve-static');
const finalhandler = require('finalhandler');

/**
 * Create a static file server for production mode page loading.
 *
 * @param {object} deps
 * @returns {{ loadPageWithServer: Function }}
 */
function createStaticServer(deps) {
  const { state } = deps;

  async function loadPageWithServer(pageName) {
    try {
      // Close existing server if running
      if (global.staticServer && global.staticServer.listening) {
        global.staticServer.close();
      }

      const serve = serveStatic(path.join(__dirname, '../../out'), {
        index: ['index.html'],
        extensions: ['html'],
        fallthrough: false,
      });

      const server = http.createServer((req, res) => {
        console.log(`[StaticServer] ${req.method} ${req.url}`);
        serve(req, res, (err) => {
          if (err) {
            console.error('[StaticServer] Error:', err);
            res.statusCode = err.status || 500;
            res.end(err.message);
            return;
          }
          finalhandler(req, res)(err);
        });
      });

      const port = await new Promise((resolve) => {
        server.listen(0, () => {
          const address = server.address();
          console.log(`Static file server running at http://localhost:${address.port}`);
          resolve(address.port);
        });
      });

      global.staticServer = server;

      let urlPath;
      switch (pageName) {
        case 'nodes':
          urlPath = '/nodes/';
          break;
        case 'settings':
          urlPath = '/settings/';
          break;
        case 'subscriptions':
          urlPath = '/subscriptions/';
          break;
        default:
          urlPath = '/';
          break;
      }

      const pageUrl = `http://localhost:${port}${urlPath}`;
      console.log(`Loading page URL: ${pageUrl}`);
      return state.mainWindow.loadURL(pageUrl);
    } catch (error) {
      console.error('Failed to load page:', error);
      throw error;
    }
  }

  return { loadPageWithServer };
}

module.exports = { createStaticServer };
