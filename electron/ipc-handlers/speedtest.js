const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * 注册测速相关的 IPC 处理器
 *
 * @param {Object} deps - 依赖注入
 * @param {boolean} deps.isDev - 是否开发环境
 */
function registerSpeedtestHandlers(deps) {
  const { isDev } = deps;

  /**
   * 查找 speedtest.exe 的路径（公共逻辑，消除重复）
   * @returns {{ success: boolean, path?: string, toolsDir?: string, error?: string }}
   */
  function findSpeedtestExe() {
    let toolsDir;

    if (isDev) {
      toolsDir = path.join(process.cwd(), 'tools');
      if (!fs.existsSync(path.join(toolsDir, 'speedtest.exe'))) {
        toolsDir = path.join(process.cwd(), '..', 'tools');
      }
      console.log('开发环境测试工具目录:', toolsDir);
    } else {
      toolsDir = path.join(process.resourcesPath, 'tools');
      console.log('生产环境测试工具目录:', toolsDir);
    }

    let speedtestPath = path.join(toolsDir, 'speedtest.exe');

    // 尝试在 speedtest-cli 子目录查找
    if (!fs.existsSync(speedtestPath)) {
      speedtestPath = path.join(toolsDir, 'speedtest-cli', 'speedtest.exe');
      console.log('尝试在speedtest-cli子目录查找:', speedtestPath);
    }

    // 尝试在 ookla 子目录查找
    if (!fs.existsSync(speedtestPath)) {
      speedtestPath = path.join(toolsDir, 'ookla-speedtest-1.2.0-win64', 'speedtest.exe');
      console.log('尝试在ookla子目录查找:', speedtestPath);
    }

    if (!fs.existsSync(speedtestPath)) {
      console.error('未找到speedtest.exe，请确保文件已放置在正确位置');
      return {
        success: false,
        error: `未找到speedtest.exe。已检查目录: ${toolsDir}`
      };
    }

    console.log('找到speedtest.exe路径:', speedtestPath);
    return { success: true, path: speedtestPath, toolsDir };
  }
  // ---- run-speedtest: JSON 格式输出 ----

  ipcMain.handle('run-speedtest', async (event) => {
    try {
      console.log('执行网络测速...');
      const found = findSpeedtestExe();
      if (!found.success) {
        return { success: false, error: found.error };
      }

      return new Promise((resolve) => {
        console.log('开始执行测速命令...');
        const speedtestProcess = spawn(found.path, ['--format=json', '--accept-license', '--accept-gdpr']);

        let output = '';
        let errorOutput = '';

        speedtestProcess.stdout.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          console.log('Speedtest输出:', chunk);
        });

        speedtestProcess.stderr.on('data', (data) => {
          const chunk = data.toString();
          errorOutput += chunk;
          console.error('Speedtest错误:', chunk);
        });

        speedtestProcess.on('close', (code) => {
          console.log(`Speedtest进程退出，退出码 ${code}`);

          if (event?.sender) {
            const isSuccess = code === 0 || code === 2;
            event.sender.send('speedtest-output', {
              type: 'status',
              message: isSuccess ? '测速完成' : '测速失败',
              phase: isSuccess ? 'complete' : 'error',
              progress: 100,
              exitCode: code
            });
          }

          if (code === 0 || code === 2) {
            resolve({ success: true, data: output });
          } else {
            resolve({ success: false, error: `测速失败，退出码: ${code}` });
          }
        });

        speedtestProcess.on('error', (error) => {
          console.error('启动Speedtest失败:', error);
          resolve({ success: false, error: `启动测速工具失败: ${error.message}` });
        });
      });
    } catch (error) {
      console.error('执行Speedtest时出错:', error);
      return { success: false, error: error.message };
    }
  });

  // ---- run-speedtest-direct: 人类可读格式，实时输出 ----

  ipcMain.handle('run-speedtest-direct', async (event) => {
    try {
      console.log('开始执行直接测速...');
      const found = findSpeedtestExe();
      if (!found.success) {
        return { success: false, error: found.error };
      }

      return new Promise((resolve) => {
        let finalResult = {
          download: 0,
          upload: 0,
          ping: 0,
          jitter: 0,
          server: { host: '', name: '', country: '' }
        };

        if (event?.sender) {
          event.sender.send('speedtest-output', {
            type: 'status',
            message: '测速开始',
            phase: 'start',
            progress: 0
          });
        }

        const speedtestProcess = spawn(found.path, [
          '--accept-license',
          '--accept-gdpr',
          '--progress=yes',
          '--format=human-readable',
          '--unit=Mbps',
          '--precision=2'
        ]);

        speedtestProcess.stdout.on('data', (data) => {
          const output = data.toString().trim();
          console.log('Speedtest输出:', output);

          if (event?.sender) {
            event.sender.send('speedtest-output', { type: 'stdout', message: output });
          }

          // 解析下载速度
          if (output.includes('Download:')) {
            const match = output.match(/Download:\s+([\d\.]+)\s*Mbps/i);
            if (match) {
              const speed = parseFloat(match[1]);
              finalResult.download = speed;
              if (event?.sender) {
                event.sender.send('speedtest-output', {
                  type: 'progress', phase: 'download', downloadSpeed: speed, progress: 60
                });
              }
            }
          }

          // 解析上传速度
          if (output.includes('Upload:')) {
            const match = output.match(/Upload:\s+([\d\.]+)\s*Mbps/i);
            if (match) {
              const speed = parseFloat(match[1]);
              finalResult.upload = speed;
              if (event?.sender) {
                event.sender.send('speedtest-output', {
                  type: 'progress', phase: 'upload', uploadSpeed: speed, progress: 90
                });
              }
            }
          }

          // 解析延迟和抖动
          if (output.includes('Latency')) {
            const latencyMatch = output.match(/(?:Idle\s+)?Latency:\s+([\d\.]+)\s+ms/i);
            const jitterMatch = output.match(/jitter:\s+([\d\.]+)ms/i);

            if (latencyMatch) {
              const ping = parseFloat(latencyMatch[1]);
              finalResult.ping = ping;
              if (event?.sender) {
                event.sender.send('speedtest-output', {
                  type: 'progress', phase: 'ping', ping, progress: 30
                });
              }
            }

            if (jitterMatch) {
              const jitter = parseFloat(jitterMatch[1]);
              finalResult.jitter = jitter;
              if (event?.sender) {
                event.sender.send('speedtest-output', {
                  type: 'progress', phase: 'ping', jitter, progress: 35
                });
              }
              console.log('解析到的抖动值:', jitter);
            }
          }
          // 备用抖动解析
          if (!finalResult.jitter && output.toLowerCase().includes('jitter')) {
            const jitterLine = output.split('\n')
              .find(line => line.toLowerCase().includes('jitter'));
            if (jitterLine) {
              const jm = jitterLine.match(/jitter:\s*([\d\.]+)\s*ms/i) ||
                         jitterLine.match(/jitter[^:]*:\s*([\d\.]+)\s*ms/i) ||
                         jitterLine.match(/jitter[^\d]+([\d\.]+)\s*ms/i);
              if (jm) {
                const jitter = parseFloat(jm[1]);
                finalResult.jitter = jitter;
                if (event?.sender) {
                  event.sender.send('speedtest-output', {
                    type: 'progress', phase: 'ping', jitter, progress: 35
                  });
                }
                console.log('备用方式解析到的抖动值:', jitter);
              }
            }
          }

          // 全文匹配抖动
          if (!finalResult.jitter) {
            const jitterPatterns = [
              /jitter:\s*([\d\.]+)\s*ms/i,
              /jitter[^:]*:\s*([\d\.]+)\s*ms/i,
              /jitter[^\d]+([\d\.]+)\s*ms/i,
              /jitter\s*[=:]\s*([\d\.]+)/i
            ];
            for (const pattern of jitterPatterns) {
              const match = output.match(pattern);
              if (match) {
                const jitter = parseFloat(match[1]);
                finalResult.jitter = jitter;
                if (event?.sender) {
                  event.sender.send('speedtest-output', {
                    type: 'progress', phase: 'ping', jitter, progress: 35
                  });
                }
                console.log('全文匹配解析到的抖动值:', jitter);
                break;
              }
            }
          }

          // 解析服务器信息
          if (output.includes('Server:')) {
            const serverMatch = output.match(/Server:\s+(.+?)(?:\s+Location|\(|$)/i);
            const locationMatch = output.match(/Location:\s+(.+?)(?:\s+|$)/i);
            if (serverMatch) {
              finalResult.server.name = serverMatch[1].trim();
              finalResult.server.host = serverMatch[1].trim();
            }
            if (locationMatch) {
              finalResult.server.country = locationMatch[1].trim();
            }
          }
        });
        speedtestProcess.stderr.on('data', (data) => {
          const output = data.toString().trim();
          console.error('Speedtest错误:', output);
          if (event?.sender) {
            event.sender.send('speedtest-output', { type: 'stderr', message: output });
          }
        });

        speedtestProcess.on('close', (code) => {
          console.log(`Speedtest进程退出，退出码 ${code}`);
          if (event?.sender) {
            const isSuccess = code === 0 || code === 2;
            event.sender.send('speedtest-output', {
              type: 'status',
              message: isSuccess ? '测速完成' : '测速失败',
              phase: isSuccess ? 'complete' : 'error',
              progress: 100,
              exitCode: code
            });
          }

          if (code === 0 || code === 2) {
            resolve({ success: true, data: finalResult });
          } else {
            resolve({ success: false, error: `测速失败，退出码: ${code}` });
          }
        });

        speedtestProcess.on('error', (error) => {
          console.error('启动Speedtest失败:', error);
          if (event?.sender) {
            event.sender.send('speedtest-output', {
              type: 'status',
              message: `启动测速失败: ${error.message}`,
              phase: 'error',
              error: error.message
            });
          }
          resolve({ success: false, error: `启动测速工具失败: ${error.message}` });
        });
      });
    } catch (error) {
      console.error('执行直接测速时出错:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerSpeedtestHandlers };
