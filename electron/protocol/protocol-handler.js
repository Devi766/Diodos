'use strict';

/**
 * Protocol URL handler module
 * Handles clash:// and flyclash:// protocol URLs for subscription import.
 */

/**
 * Create a protocol handler.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 * @param {object} deps.app - Electron app module
 */
function createProtocolHandler({ state, app }) {

  function handleProtocolUrl(url) {
    try {
      console.log('收到原始协议URL:', url);

      let subscriptionUrl = null;

      // 情况1: 标准协议URL格式: clash://install-config?url=https://example.com
      if (url.startsWith('clash://') || url.startsWith('flyclash://')) {
        const queryStartIndex = url.indexOf('?url=');
        if (queryStartIndex > 0) {
          subscriptionUrl = url.substring(queryStartIndex + 5);
          const ampIndex = subscriptionUrl.indexOf('&');
          if (ampIndex > 0) {
            subscriptionUrl = subscriptionUrl.substring(0, ampIndex);
          }
        }
      }
      // 情况2: Windows特殊格式: C:\...?url=https%3A%2F%2Fexample.com
      else if (url.includes('?url=')) {
        const urlParam = url.substring(url.indexOf('?url=') + 5);
        const ampIndex = urlParam.indexOf('&');
        subscriptionUrl = ampIndex > 0 ? urlParam.substring(0, ampIndex) : urlParam;
      }

      if (subscriptionUrl) {
        try {
          subscriptionUrl = decodeURIComponent(subscriptionUrl);
          console.log('成功提取到订阅URL:', subscriptionUrl);

          if (subscriptionUrl.startsWith('http')) {
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
              if (state.mainWindow.isMinimized()) state.mainWindow.restore();
              state.mainWindow.show();
              state.mainWindow.focus();

              console.log('向渲染进程发送导入事件');
              state.mainWindow.webContents.send('import-subscription', subscriptionUrl);
              return true;
            }
          } else {
            console.log('提取的URL不是有效的HTTP(S)地址:', subscriptionUrl);
          }
        } catch (decodeError) {
          console.error('URL解码失败:', decodeError);
        }
      } else {
        console.log('未能从协议URL中提取订阅地址');
      }

      return false;
    } catch (error) {
      console.error('处理协议URL时出错:', error);
      return false;
    }
  }

  function registerProtocolEvents() {
    // macOS / Linux: open-url event
    app.on('open-url', (event, url) => {
      event.preventDefault();
      console.log('收到open-url事件，URL:', url);
      handleProtocolUrl(url);
    });

    // Windows: second-instance event
    app.on('second-instance', (event, commandLine, workingDirectory) => {
      console.log('检测到第二个实例启动，命令行参数:', commandLine);

      if (process.platform === 'win32') {
        let foundProtocolArg = false;
        for (const arg of commandLine) {
          if (arg.includes('clash://') ||
              arg.includes('flyclash://') ||
              arg.includes('?url=')) {
            console.log('第二个实例中检测到可能的协议URL参数:', arg);
            foundProtocolArg = true;
            handleProtocolUrl(arg);
          }
        }

        if (!foundProtocolArg) {
          console.log('第二个实例的命令行参数中未找到协议URL');
        }
      }

      // 聚焦到主窗口
      if (state.mainWindow) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.show();
        state.mainWindow.focus();
      }
    });
  }

  return {
    handleProtocolUrl,
    registerProtocolEvents,
  };
}

module.exports = { createProtocolHandler };
