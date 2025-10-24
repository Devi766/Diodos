// 批量测速功能模块
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const dgram = require('dgram'); // 添加UDP功能支持
const crypto = require('crypto'); // 用于生成随机测试数据
const puppeteer = require('puppeteer');
const { app } = require('electron'); // 添加Electron app模块，用于获取应用路径

// 需要在初始化时传入的依赖项
let switchNode = null;
let fetchMihomoAPI = null;
let activeApiConfig = null;
let isInitialized = false;

// 添加测速状态管理
let isTesting = false;
let activeTestController = null; // 存储当前测试的AbortController

/**
 * 初始化批量测速模块
 * @param {Object} deps 依赖项 
 */
function initBatchSpeedtest(deps) {
  // 保存依赖项
  switchNode = deps.switchNode;
  fetchMihomoAPI = deps.fetchMihomoAPI;
  activeApiConfig = deps.activeApiConfig;
  isInitialized = true;
  
  console.log('[batchspeedtest] 模块已初始化');
}

/**
 * 取消当前正在进行的测速
 * @returns {boolean} 是否成功取消
 */
function cancelBatchSpeedtest() {
  if (!isTesting || !activeTestController) {
    console.log('[batchspeedtest] 没有正在进行的测速可以取消');
    return false;
  }
  
  try {
    console.log('[batchspeedtest] 正在取消测速...');
    activeTestController.abort();
    isTesting = false;
    activeTestController = null;
    return true;
  } catch (error) {
    console.error('[batchspeedtest] 取消测速失败:', error);
    return false;
  }
}

/**
 * 通过代理进行速度测试
 * @param {Object} options 测试选项
 * @returns {Promise<Object>} 测试结果
 */
async function runProxySpeedtest(options) {
  if (!isInitialized) {
    throw new Error('批量测速模块未初始化');
  }
  
  const { url, proxy, maxTestTime = 10000, proxyGroup = null } = options; // 默认最大测试时间10秒
  
  if (!url) {
    return { success: false, error: '缺少测试URL' };
  }
  
  if (!proxy || !proxy.host || !proxy.port || !proxy.nodeName) {
    return { success: false, error: '代理配置不完整' };
  }
  
  try {
    // 设置测速状态
    isTesting = true;
    
    // 先切换到指定节点
    if (proxy.nodeName) {
      console.log(`[batchspeedtest] 切换到节点: ${proxy.nodeName}`);
      try {
        // 添加重试机制，最多尝试3次
        let retryCount = 0;
        const maxRetries = 3;
        let switched = false;
        
        while (!switched && retryCount < maxRetries) {
          try {
            await switchNode(proxy.nodeName, proxyGroup);
            switched = true;
            console.log(`[batchspeedtest] 成功切换到节点: ${proxy.nodeName}${retryCount > 0 ? ` (重试${retryCount}次)` : ''}`);
          } catch (switchError) {
            retryCount++;
            if (retryCount >= maxRetries) {
              throw switchError; // 重试次数用完，抛出错误
            }
            console.warn(`[batchspeedtest] 切换到节点 ${proxy.nodeName} 失败，正在重试 (${retryCount}/${maxRetries})...`);
            // 等待一段时间再重试，每次增加延迟
            await new Promise(r => setTimeout(r, 1000 * retryCount));
          }
        }
      } catch (nodeError) {
        isTesting = false; // 重置测试状态
        console.error(`[batchspeedtest] 切换节点失败 (${proxy.nodeName}):`, nodeError);
        return { 
          success: false, 
          error: `切换到节点 ${proxy.nodeName} 失败: ${nodeError.message}`,
          skipNode: true // 标记这个节点应该被跳过
        };
      }
    }
    
    // 组装代理URL
    const proxyUrl = `http://${proxy.host}:${proxy.port}`;
    console.log(`[batchspeedtest] 使用代理: ${proxyUrl}`);
    
    // 创建代理对象 - 使用HttpsProxyAgent而不是ProxyAgent
    const proxyAgent = new HttpsProxyAgent(proxyUrl);
    
    // 使用动态引入的node-fetch
    const { default: fetch } = await import('node-fetch');
    
    // 记录开始时间
    const startTime = Date.now();
    
    // 设置超时 - 略大于最大测试时间
    const timeout = maxTestTime + 5000;
    
    console.log(`[batchspeedtest] 开始测速: ${url}, 最大测试时间: ${maxTestTime}ms`);
    
    // 速度测量相关变量
    let totalBytes = 0;
    let instantSpeed = 0;
    let speedMax = 0;
    let speedAvg = 0;
    let speedSamples = [];
    let lastCheckTime = startTime;
    let lastBytes = 0;
    
    // 创建abort控制器用于中断请求
    const controller = new AbortController();
    activeTestController = controller; // 保存到全局变量以便取消
    const signal = controller.signal;
    
    // 设置最大测试时间计时器
    const timeoutId = setTimeout(() => {
      console.log(`[batchspeedtest] 已达到最大测试时间: ${maxTestTime}ms, 停止测试`);
      controller.abort();
    }, maxTestTime);
    
    // 简化版测速逻辑，不依赖流API
    try {
      // 设置进度记录器
      const progressInterval = setInterval(() => {
        if (totalBytes > lastBytes) {
          const now = Date.now();
          const timeSince = now - lastCheckTime;
          
          if (timeSince > 0) {
            const bytesInInterval = totalBytes - lastBytes;
            const speedInMbps = (bytesInInterval * 8) / (timeSince / 1000) / 1000000;
            
            speedSamples.push(speedInMbps);
            if (speedInMbps > speedMax) {
              speedMax = speedInMbps;
            }
            
            // 计算平均速度
            speedAvg = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
            
            console.log(`[batchspeedtest] 测速采样 ${speedSamples.length}: ${speedInMbps.toFixed(2)} Mbps, 最大: ${speedMax.toFixed(2)} Mbps, 平均: ${speedAvg.toFixed(2)} Mbps, 总量: ${totalBytes} 字节`);
            
            lastCheckTime = now;
            lastBytes = totalBytes;
          }
        }
      }, 500);
      
      // 发起请求，使用更简单的方式
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        },
        timeout: timeout,
        agent: proxyAgent,
        signal: signal
      });
      
      if (!response.ok) {
        clearTimeout(timeoutId);
        clearInterval(progressInterval);
        console.error(`[batchspeedtest] 测速请求失败: HTTP ${response.status}`);
        return {
          success: false,
          error: `测速请求失败: HTTP ${response.status}`
        };
      }
      
      // 使用arraybuffer方式读取数据
      const chunks = [];
      
      // 判断是否支持流API
      if (typeof response.arrayBuffer === 'function') {
        // 直接使用arraybuffer
        const startDownload = Date.now();
        
        // 尝试读取响应直到超时或完成
        const downloadPromise = new Promise(async (resolve) => {
          try {
            // 分块读取
            let chunk;
            // 如果支持读取流
            if (response.body && typeof response.body.on === 'function') {
              response.body.on('data', (data) => {
                totalBytes += data.length;
                chunks.push(data);
              });
              
              await new Promise((resolve) => {
                response.body.on('end', resolve);
                response.body.on('error', resolve);
              });
            } else {
              // 直接读取整个响应
              try {
                const buffer = await response.buffer();
                totalBytes = buffer.length;
                chunks.push(buffer);
              } catch (e) {
                console.log('[batchspeedtest] 使用buffer方法读取失败，尝试替代方案');
                // 如果buffer方法失败，使用arrayBuffer
                try {
                  const buffer = await response.arrayBuffer();
                  totalBytes = buffer.byteLength;
                  chunks.push(Buffer.from(buffer));
                } catch (innerError) {
                  console.error('[batchspeedtest] 所有读取方法都失败了', innerError);
                }
              }
            }
            resolve();
          } catch (error) {
            console.error('[batchspeedtest] 下载过程中出错:', error);
            resolve();
          }
        });
        
        // 等待下载完成或超时
        await Promise.race([
          downloadPromise,
          new Promise((resolve) => setTimeout(resolve, maxTestTime))
        ]);
      } else {
        // 不支持arrayBuffer，使用text方法
        const text = await response.text();
        totalBytes = text.length;
      }
      
      // 清理定时器
      clearInterval(progressInterval);
      clearTimeout(timeoutId);
      
      // 计算最终结果
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      
      // 至少得到一个采样，如果没有采样使用总体计算
      if (speedSamples.length === 0) {
        // 模拟一个采样点
        speedAvg = (totalBytes * 8) / (totalTime / 1000) / 1000000;
        speedMax = speedAvg;
        speedSamples.push(speedAvg);
      }
      
      console.log(`[batchspeedtest] 测速完成: 下载=${totalBytes}字节, 时间=${totalTime}ms, 平均速度=${speedAvg.toFixed(2)}Mbps, 最大速度=${speedMax.toFixed(2)}Mbps, 样本数=${speedSamples.length}`);
      
      return {
        success: true,
        data: {
          downloadSpeed: speedAvg,
          maxSpeed: speedMax,
          fileSize: totalBytes,
          timeMs: totalTime,
          samples: speedSamples.length
        }
      };
    } catch (error) {
      clearTimeout(timeoutId);
      console.error(`[batchspeedtest] 测速出错:`, error);
      
      // 如果已经有采样数据，仍然返回结果
      if (speedSamples.length > 0) {
        return {
          success: true,
          data: {
            downloadSpeed: speedAvg,
            maxSpeed: speedMax,
            fileSize: totalBytes,
            timeMs: Date.now() - startTime,
            samples: speedSamples.length
          }
        };
      }
      
      return {
        success: false,
        error: `测速出错: ${error.message}`
      };
    }
  } catch (error) {
    console.error(`[batchspeedtest] 测速出错:`, error);
    return {
      success: false,
      error: `测速出错: ${error.message}`
    };
  }
}

/**
 * 执行真实的UDP测试
 * @param {Object} options 测试选项
 * @returns {Promise<Object>} UDP测试结果
 */
async function testUdpConnectivity(options) {
  if (!isInitialized) {
    throw new Error('批量测速模块未初始化');
  }

  const { proxy, testServers = defaultUdpTestServers } = options;
  
  if (!proxy || !proxy.host || !proxy.port || !proxy.nodeName) {
    return { 
      success: false, 
      error: '代理配置不完整',
      udpType: 'Unknown'
    };
  }

  try {
    // 先切换到指定节点
    if (proxy.nodeName) {
      console.log(`[batchspeedtest] UDP测试：切换到节点: ${proxy.nodeName}`);
      await switchNode(proxy.nodeName);
    }
    
    // 创建UDP客户端
    const client = dgram.createSocket('udp4');
    
    let testResults = [];
    let successCount = 0;
    
    // 设置接收响应处理程序
    const receivePromise = new Promise((resolve) => {
      let responseCount = 0;
      const expectedResponses = testServers.length;
      const timeout = setTimeout(() => {
        client.close();
        resolve(testResults);
      }, 10000); // 10秒超时
      
      client.on('message', (msg, rinfo) => {
        // 记录收到的响应
        const serverIp = rinfo.address;
        const serverPort = rinfo.port;
        
        // 查找是哪个测试服务器响应了
        const serverIndex = testServers.findIndex(s => 
          s.address === serverIp && (s.port === serverPort || serverPort === 0 || serverPort === 53));
          
        if (serverIndex >= 0) {
          testResults[serverIndex] = {
            server: testServers[serverIndex],
            success: true,
            time: Date.now()
          };
          successCount++;
        }
        
        responseCount++;
        if (responseCount >= expectedResponses || successCount >= 3) {
          clearTimeout(timeout);
          client.close();
          resolve(testResults);
        }
      });
      
      client.on('error', (err) => {
        console.error(`[batchspeedtest] UDP测试错误:`, err);
        clearTimeout(timeout);
        client.close();
        resolve(testResults);
      });
    });
    
    // 向每个测试服务器发送UDP数据包
    const sendPromises = testServers.map((server, index) => {
      return new Promise((resolve) => {
        // 生成随机测试数据
        const testData = crypto.randomBytes(64);
        
        // 初始化测试结果
        testResults[index] = {
          server: server,
          success: false,
          time: Date.now()
        };
        
        // 发送UDP数据包
        client.send(testData, server.port, server.address, (err) => {
          if (err) {
            console.error(`[batchspeedtest] 发送UDP到${server.address}:${server.port}失败:`, err);
          } else {
            console.log(`[batchspeedtest] 已发送UDP数据包到${server.address}:${server.port}`);
          }
          resolve();
        });
      });
    });
    
    // 等待所有数据包发送完成
    await Promise.all(sendPromises);
    
    // 等待接收响应
    const results = await receivePromise;
    
    // 分析UDP类型
    let udpType = determineUdpType(results, successCount);
    
    return {
      success: true,
      udpType: udpType,
      successCount: successCount,
      details: results
    };
  } catch (error) {
    console.error(`[batchspeedtest] UDP测试出错:`, error);
    return {
      success: false,
      error: `UDP测试出错: ${error.message}`,
      udpType: 'Unknown'
    };
  }
}

/**
 * 根据UDP测试结果确定NAT类型
 * @param {Array} results 测试结果
 * @param {number} successCount 成功响应数量
 * @returns {string} UDP类型
 */
function determineUdpType(results, successCount) {
  // 如果成功响应数量为0，则表示UDP完全受阻
  if (successCount === 0) {
    return 'Blocked';
  }
  
  // 如果成功响应数量等于测试服务器数量，则可能是完全锥型NAT
  if (successCount === results.length) {
    return 'FullCone';
  }
  
  // 如果只有部分服务器响应，则可能是限制型NAT
  if (successCount > 0 && successCount < results.length) {
    // 根据响应模式确定NAT类型
    if (successCount >= results.length / 2) {
      return 'PortRestrictedCone';
    } else {
      return 'Symmetric';
    }
  }
  
  return 'Unknown';
}

// 默认UDP测试服务器
const defaultUdpTestServers = [
  { address: '8.8.8.8', port: 53, name: 'Google DNS' },
  { address: '1.1.1.1', port: 53, name: 'Cloudflare DNS' },
  { address: '9.9.9.9', port: 53, name: 'Quad9 DNS' },
  { address: '208.67.222.222', port: 53, name: 'OpenDNS' },
  { address: '94.140.14.14', port: 53, name: 'AdGuard DNS' }
];

/**
 * 保存测速报告
 * @param {Object} reportData 报告数据
 * @param {string} userDataPath 用户数据路径
 * @returns {Promise<Object>} 保存结果
 */
async function saveSpeedtestReport(reportData, userDataPath) {
  console.log('[saveSpeedtestReport] Received reportData.testResults length:', reportData?.testResults?.length);
  if (reportData?.testResults?.length > 50) {
    console.log('[saveSpeedtestReport] reportData.testResults[0].name:', reportData.testResults[0]?.name);
    console.log('[saveSpeedtestReport] reportData.testResults[55].name:', reportData.testResults[55]?.name);
    console.log('[saveSpeedtestReport] reportData.testResults[56].name:', reportData.testResults[56]?.name);
  }
  
  try {
    if (!reportData) {
      return { success: false, error: '报告数据为空' };
    }
    
    // 检查测试结果是否存在且非空
    if (!reportData.testResults || !Array.isArray(reportData.testResults) || reportData.testResults.length === 0) {
      console.error('[batchspeedtest] 无法保存报告: 测试结果为空或无效', 
        {hasResults: !!reportData.testResults, type: reportData.testResults ? typeof reportData.testResults : 'undefined'});
      return { success: false, error: '测试结果为空或无效，请重新测试' };
    }
    
    // 创建报告存储目录
    const reportsDir = path.join(userDataPath, 'speedtest-reports');
    try {
      await fs.mkdir(reportsDir, { recursive: true });
    } catch (err) {
      console.error('创建报告目录失败:', err);
      // 继续执行，尝试保存到已存在的目录
    }
    
    // 生成唯一报告ID
    const reportId = `report-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const reportFilePath = path.join(reportsDir, `${reportId}.json`);
    const tempFilePath = path.join(reportsDir, `${reportId}_temp.json`);
    
    // 准备基本元数据 - 不含大量节点数据和logo路径
    const basicMeta = {
      id: reportId,
      timestamp: Date.now(),
      createdDate: new Date().toISOString(),
      name: reportData.name || '未命名报告',
      proxyGroupName: reportData.proxyGroupName,
      testConfig: reportData.testConfig,
      reportNote: reportData.reportNote,
      testTime: reportData.testTime,
      nodeCount: reportData.testResults ? reportData.testResults.length : 0
    };
    
    // 创建完整报告数据的副本，避免直接修改原始数据
    const fullReportData = {
      ...basicMeta,
      skippedNodes: reportData.skippedNodes,
      excludedNodes: reportData.excludedNodes,
      includedNodes: reportData.includedNodes
    };
    
    // 添加测试结果数据
    if (reportData.testResults && reportData.testResults.length > 0) {
      // 高效复制和处理测试结果
      const safeResults = [];
      for (const result of reportData.testResults) {
        // 过滤掉可能导致循环引用或过大的字段
        const { 
          name, type, delay, httpDelay, downloadSpeed, maxSpeed, 
          rttDeviation, udpType, fileSize, timeMs, samples 
        } = result;
        
        safeResults.push({
          name, type, delay, httpDelay, downloadSpeed, maxSpeed,
          rttDeviation, udpType, fileSize, timeMs, samples
        });
      }
      fullReportData.testResults = safeResults;
    }
    
    // 保存完整报告数据
    console.log(`[batchspeedtest] 保存完整报告数据 (${fullReportData.testResults?.length || 0} 个节点)`);
    try {
      await fs.writeFile(reportFilePath, JSON.stringify(fullReportData, null, 2), 'utf8');
      // 删除临时文件
      try { await fs.unlink(tempFilePath); } catch (e) { /* 忽略临时文件删除错误 */ }
      
      // 检查是否存在用户自定义logo
      const userLogoPath = path.join(userDataPath, 'custom_logo.png');
      try {
        // 尝试检查用户自定义logo
        await fs.access(userLogoPath);
        console.log(`[batchspeedtest] 检测到用户自定义Logo，将用于报告: ${userLogoPath}`);
      } catch (userLogoErr) {
        console.log(`[batchspeedtest] 未检测到用户自定义Logo，将使用默认Logo`);
      }
    } catch (err) {
      console.error(`[batchspeedtest] 保存完整报告数据失败:`, err);
      // 保存大数据失败，尝试分块保存
      console.log(`[batchspeedtest] 尝试分块保存大型数据...`);
      
      try {
                 // 直接保存所有测试结果，不分批处理
         if (fullReportData.testResults && fullReportData.testResults.length > 0) {
           console.log(`[batchspeedtest] 一次性保存所有 ${fullReportData.testResults.length} 个节点数据`);
           
           // 使用流式写入确保大数据也能正确保存
           const fs = require('fs');
           const writeStream = fs.createWriteStream(reportFilePath);
           
           writeStream.write(JSON.stringify(fullReportData, null, 2));
           writeStream.end();
           
           // 等待写入完成
           await new Promise((resolve, reject) => {
             writeStream.on('finish', () => {
               console.log(`[batchspeedtest] 流式写入完成`);
               resolve();
             });
             writeStream.on('error', (err) => {
               console.error(`[batchspeedtest] 流式写入错误:`, err);
               reject(err);
             });
           });
           
           console.log(`[batchspeedtest] 数据保存完成, 共 ${fullReportData.testResults.length} 个节点`);
        } else {
          // 如果没有测试结果，直接保存基础数据
          await fs.writeFile(reportFilePath, JSON.stringify(fullReportData, null, 2), 'utf8');
        }
        
        // 删除临时文件
        try { await fs.unlink(tempFilePath); } catch (e) { /* 忽略临时文件删除错误 */ }
      } catch (batchErr) {
        console.error(`[batchspeedtest] 分批保存也失败了:`, batchErr);
        
        // 如果分批保存也失败了，使用临时文件作为最终保存的报告
        try {
          await fs.copyFile(tempFilePath, reportFilePath);
          console.log(`[batchspeedtest] 使用简化版报告作为备份, 节点数据可能不完整`);
        } catch (finalErr) {
          console.error(`[batchspeedtest] 最终备份尝试也失败:`, finalErr);
          return { success: false, error: '保存报告失败，所有尝试都已失败' };
        }
      }
    }
    
        // 在报告保存后，准备logo文件
    try {
      // 设置FlyClash logo路径
      const logoPath = 'flyclash_logo.png';  // 只在左上角显示
      
      // 完整路径
      const logoFullPath = path.join(reportsDir, logoPath);
      
      // 源文件路径 - 尝试多个可能的位置
      const possibleLogoPaths = [
        path.join(__dirname, '..', 'public', 'logo.png'),         // 标准开发环境路径
        path.join(__dirname, '..', 'out', 'logo.png'),           // 产品构建输出路径
        path.join(process.resourcesPath, 'app.asar', 'public', 'logo.png'),  // Electron打包路径1
        path.join(process.resourcesPath, 'app.asar', 'out', 'logo.png'),     // Electron打包路径2
        path.join(process.resourcesPath, 'public', 'logo.png'),   // 资源文件夹路径1
        path.join(process.resourcesPath, 'out', 'logo.png')       // 资源文件夹路径2
      ];
      
      // 尝试找到有效的logo源文件
      let validLogoPath = null;
      for (const testPath of possibleLogoPaths) {
        try {
          await fs.access(testPath);
          validLogoPath = testPath;
          console.log(`[batchspeedtest] 找到有效的logo源文件: ${validLogoPath}`);
          break;
        } catch (e) {
          console.log(`[batchspeedtest] Logo源文件不存在于: ${testPath}`);
        }
      }
      
      if (!validLogoPath) {
        console.error('[batchspeedtest] 无法在任何位置找到logo源文件');
      } else {
        // 确保目标目录存在
        await fs.mkdir(reportsDir, { recursive: true });
        
        // 检查FlyClash logo是否已存在，不存在则复制
        const logoExists = await fs.access(logoFullPath).then(() => true).catch(() => false);
        if (!logoExists) {
          // 复制logo文件到报告目录
          await fs.copyFile(validLogoPath, logoFullPath);
          console.log(`[batchspeedtest] FlyClash Logo已成功复制: ${logoFullPath}`);
        } else {
          console.log(`[batchspeedtest] FlyClash Logo已存在于: ${logoFullPath}`);
        }
      }
      
      // 无论如何，尝试更新报告元数据，添加logo信息
      try {
        const reportData = JSON.parse(await fs.readFile(reportFilePath, 'utf8'));
        reportData.logoPath = logoPath;        // FlyClash logo路径 (左上角)
        await fs.writeFile(reportFilePath, JSON.stringify(reportData, null, 2), 'utf8');
        console.log(`[batchspeedtest] 测速报告(含Logo信息)已更新`);
      } catch (err) {
        console.error(`[batchspeedtest] 更新Logo信息失败:`, err);
        // 这不影响基本报告功能
      }
    } catch (logoErr) {
      console.error(`[batchspeedtest] 处理Logo文件失败，但不影响报告基本功能:`, logoErr);
      // Logo处理失败不影响主要功能
    }
    
    console.log(`[batchspeedtest] 测速报告已成功保存: ${reportFilePath}`);
    return {
      success: true,
      reportId,
      filePath: reportFilePath
    };
  } catch (error) {
    console.error(`[batchspeedtest] 保存报告出错:`, error);
    return {
      success: false,
      error: `保存报告出错: ${error.message}`
    };
  }
}

/**
 * 获取历史测速报告列表
 * @param {string} userDataPath 用户数据路径
 * @returns {Promise<Object>} 报告列表
 */
async function getSpeedtestReports(userDataPath) {
  try {
    // 报告存储目录
    const reportsDir = path.join(userDataPath, 'speedtest-reports');
    
    try {
      await fs.mkdir(reportsDir, { recursive: true });
    } catch (err) {
      console.error('确保报告目录存在时出错:', err);
    }
    
    // 读取目录内容
    const files = await fs.readdir(reportsDir);
    
    // 过滤JSON文件
    const reportFiles = files.filter(file => file.endsWith('.json'));
    
    // 读取报告摘要信息
    const reports = [];
    
    for (const file of reportFiles) {
      try {
        const filePath = path.join(reportsDir, file);
        const fileContent = await fs.readFile(filePath, 'utf8');
        const report = JSON.parse(fileContent);
        
        // 提取摘要信息
        reports.push({
          id: report.id,
          timestamp: report.timestamp,
          createdDate: report.createdDate,
          name: report.name || report.testConfig || report.proxyGroupName || '未命名报告', // 更新 name 字段的备选逻辑
          nodeCount: report.testResults ? report.testResults.length : 0,
          testConfig: report.testConfig, // <--- 添加此行
          proxyGroupName: report.proxyGroupName // <--- 添加此行
        });
      } catch (err) {
        console.error(`读取报告摘要失败: ${file}`, err);
      }
    }
    
    // 按时间戳降序排序
    reports.sort((a, b) => b.timestamp - a.timestamp);
    
    return {
      success: true,
      reports
    };
  } catch (error) {
    console.error(`[batchspeedtest] 获取报告列表出错:`, error);
    return {
      success: false,
      error: `获取报告列表出错: ${error.message}`
    };
  }
}

/**
 * 获取指定测速报告的内容
 * @param {string} reportId 报告ID
 * @param {string} userDataPath 用户数据路径
 * @returns {Promise<Object>} 报告内容
 */
async function getSpeedtestReport(reportId, userDataPath) {
  try {
    if (!reportId) {
      return { success: false, error: '报告ID为空' };
    }
    
    // 报告存储目录
    const reportsDir = path.join(userDataPath, 'speedtest-reports');
    const reportFilePath = path.join(reportsDir, `${reportId}.json`);
    
    // 检查报告文件是否存在
    try {
      await fs.access(reportFilePath);
    } catch (err) {
      return { success: false, error: '报告不存在' };
    }
    
    // 读取报告内容
    const reportContent = await fs.readFile(reportFilePath, 'utf8');
    const report = JSON.parse(reportContent);
    
    return {
      success: true,
      report
    };
  } catch (error) {
    console.error(`[batchspeedtest] 获取报告内容出错:`, error);
    return {
      success: false,
      error: `获取报告内容出错: ${error.message}`
    };
  }
}

/**
 * 使用Puppeteer生成测速报告
 * @param {Object} reportData 报告数据
 * @param {string} userDataPath 用户数据路径
 * @param {string|null} saveFilePath 用户指定的保存路径，如果为null则使用临时文件
 * @returns {Promise<Object>} 生成结果
 */
async function generateSpeedtestReportWithPuppeteer(reportData, userDataPath, saveFilePath = null) {
  // console.log('[PuppeteerGen] reportData.testResults length:', reportData?.testResults?.length);
  // if (reportData?.testResults?.length > 50) {
  //   console.log('[PuppeteerGen] reportData.testResults[0].name:', reportData.testResults[0]?.name);
  //   console.log('[PuppeteerGen] reportData.testResults[55].name:', reportData.testResults[55]?.name);
  //   console.log('[PuppeteerGen] reportData.testResults[56].name:', reportData.testResults[56]?.name);
  // }
  
  const logFilePath = path.join(userDataPath, 'puppeteer_launch.log');
  const homeDir = os.homedir(); // Get user's home directory

  async function writeToLaunchLog(message, toConsole = true) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;
    if (toConsole) {
      if (message.toLowerCase().includes('fail') || message.toLowerCase().includes('error')) {
        console.warn(`[batchspeedtest] ${message}`);
      } else {
        console.log(`[batchspeedtest] ${message}`);
      }
    }
    try {
      await fs.appendFile(logFilePath, logMessage, 'utf8');
    } catch (err) {
      console.error('[batchspeedtest] Failed to write to puppeteer_launch.log:', err);
    }
  }

  await writeToLaunchLog(`[PuppeteerGen Start] Report for ${reportData?.name || 'N/A'}. UserDataPath: ${userDataPath}. SaveFilePath: ${saveFilePath}`, false);

  try {
    if (!reportData || !reportData.testResults || reportData.testResults.length === 0) {
      await writeToLaunchLog('Report data is empty or has no test results.');
      return { success: false, error: '报告数据为空或无测试结果' };
    }

    const reportsDir = path.join(userDataPath, 'speedtest-reports');
    try {
      await fs.mkdir(reportsDir, { recursive: true });
    } catch (err) {
      await writeToLaunchLog(`创建报告目录失败: ${err.message}`);
      // Continue, try saving to existing dir
    }

    const reportId = `report-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const htmlFilePath = path.join(reportsDir, `${reportId}.html`);
    const pngFilePath = saveFilePath || path.join(reportsDir, `${reportId}.png`);

    const fullReportData = {
      id: reportId,
      timestamp: Date.now(),
      createdDate: new Date().toISOString(),
      name: reportData.name || '未命名报告',
      proxyGroupName: reportData.proxyGroupName,
      testConfig: reportData.testConfig,
      reportNote: reportData.reportNote,
      testTime: reportData.testTime,
      nodeCount: reportData.testResults ? reportData.testResults.length : 0,
      skippedNodes: reportData.skippedNodes,
      excludedNodes: reportData.excludedNodes,
      includedNodes: reportData.includedNodes,
      testResults: reportData.testResults.map(result => ({
        name: result.name, type: result.type, delay: result.delay, httpDelay: result.httpDelay,
        downloadSpeed: result.downloadSpeed, maxSpeed: result.maxSpeed,
        rttDeviation: result.rttDeviation, udpType: result.udpType,
        fileSize: result.fileSize, timeMs: result.timeMs, samples: result.samples
      })),
      logoPath: 'flyclash_logo.png' // Assume logo is copied separately or relative
    };

    await writeToLaunchLog(`开始生成Puppeteer报告: ${reportId} for ${fullReportData.name}`);

    // Prepare logo (copied from existing logic, simplified for brevity here)
    // Ensure this part correctly copies the logo to reportsDir if needed for the HTML report
    try {
        const logoDestPath = path.join(reportsDir, 'flyclash_logo.png');
        const possibleLogoSources = [
            path.join(__dirname, '..', 'public', 'logo.png'),
            path.join(app.getAppPath(), 'public', 'logo.png'),
            // Add other paths as in original code
        ];
        let foundLogo = false;
        for (const sourcePath of possibleLogoSources) {
            try {
                await fs.access(sourcePath);
                await fs.copyFile(sourcePath, logoDestPath);
                await writeToLaunchLog(`Logo copied from ${sourcePath} to ${logoDestPath}`);
                foundLogo = true;
                break;
            } catch { /* try next path */ }
        }
        if (!foundLogo) await writeToLaunchLog('Logo source file not found in checked paths.');
    } catch(logoErr) {
        await writeToLaunchLog(`Preparing logo file failed: ${logoErr.message}`);
    }


    const html = generateReportHtml(fullReportData);
    try {
      await fs.writeFile(htmlFilePath, html, 'utf8');
    } catch (htmlErr) {
      await writeToLaunchLog(`生成HTML文件失败: ${htmlErr.message}`);
      return { success: false, error: `生成HTML文件失败: ${htmlErr.message}` };
    }

    let browser;
    const launchAttemptsInfo = [];
    const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--single-process']; // Added more args

    async function tryLaunchBrowser(options, attemptName) {
      let currentBrowser;
      const attemptMessage = `尝试启动浏览器: ${attemptName} with options: ${JSON.stringify(options.channel || options.executablePath)}`;
      await writeToLaunchLog(attemptMessage);
      launchAttemptsInfo.push(attemptMessage);
      try {
        currentBrowser = await puppeteer.launch({
          headless: 'new', // Consider 'shell' for newer Puppeteer versions for system browsers
          args: puppeteerArgs,
          ...options,
          timeout: 60000, // Increased timeout for browser launch
        });
        const successMsg = `成功启动浏览器: ${attemptName}`;
        await writeToLaunchLog(successMsg);
        launchAttemptsInfo.push(successMsg);
        return currentBrowser;
      } catch (e) {
        const errorMsg = `启动浏览器 ${attemptName} 失败: ${e.message}`;
        await writeToLaunchLog(errorMsg);
        launchAttemptsInfo.push(errorMsg);
        if (e.message.includes('Target closed')) {
             await writeToLaunchLog(`  ^^^ Target closed error often indicates an issue with browser compatibility or args.`);
        }
        if (e.message.includes('Exited with code 1')) {
             await writeToLaunchLog(`  ^^^ Exited with code 1 can mean a missing dependency or incompatible browser version.`);
        }
        return null;
      }
    }

    // 1. Attempt Bundled Chromium (if puppeteer full package is used)
    try {
      const bundledPath = puppeteer.executablePath();
      if (bundledPath && typeof bundledPath === 'string' && bundledPath.length > 0) {
         // Check if path seems valid before trying (basic check)
        if (await fs.access(bundledPath).then(() => true).catch(() => false)) {
            browser = await tryLaunchBrowser({ executablePath: bundledPath }, 'Puppeteer Bundled Chromium');
        } else {
            await writeToLaunchLog(`Bundled path reported but not accessible: ${bundledPath}`);
            launchAttemptsInfo.push(`Bundled path reported but not accessible: ${bundledPath}`);
        }
      } else {
        await writeToLaunchLog('puppeteer.executablePath() did not return a valid path. Skipping bundled attempt.');
        launchAttemptsInfo.push('Bundled path not found or invalid via puppeteer.executablePath().');
      }
    } catch (e) {
      await writeToLaunchLog(`Error getting puppeteer.executablePath(): ${e.message}. This might happen if using puppeteer-core without CHROME_PATH set, or if puppeteer install was incomplete.`);
      launchAttemptsInfo.push(`Error getting puppeteer.executablePath(): ${e.message}`);
    }
    
    // Define potential paths
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];

    // 2. Attempt System Chrome (Specific Paths then Channel)
    if (!browser) {
      for (const p of chromePaths) {
        if (await fs.access(p).then(() => true).catch(() => false)) {
          browser = await tryLaunchBrowser({ executablePath: p }, `System Chrome at ${p}`);
          if (browser) break;
        } else {
          await writeToLaunchLog(`Chrome path not found or accessible: ${p}`);
          launchAttemptsInfo.push(`Chrome path not accessible: ${p}`);
        }
      }
    }
    if (!browser) {
      browser = await tryLaunchBrowser({ channel: 'chrome' }, 'System Chrome (Channel)');
    }

    // 3. Attempt System Edge (Specific Paths then Channel)
    if (!browser) {
      for (const p of edgePaths) {
         if (await fs.access(p).then(() => true).catch(() => false)) {
            browser = await tryLaunchBrowser({ executablePath: p }, `System Edge at ${p}`);
            if (browser) break;
        } else {
          await writeToLaunchLog(`Edge path not found or accessible: ${p}`);
          launchAttemptsInfo.push(`Edge path not accessible: ${p}`);
        }
      }
    }
    if (!browser) {
      browser = await tryLaunchBrowser({ channel: 'msedge' }, 'System Edge (Channel)');
    }
    
    // Fallback to general puppeteer-core behavior if CHROME_PATH is set
    if (!browser && process.env.PUPPETEER_EXECUTABLE_PATH) {
        await writeToLaunchLog(`Attempting PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
        browser = await tryLaunchBrowser({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }, `PUPPETEER_EXECUTABLE_PATH`);
    }


    if (!browser) {
      const baseMessage = '无法启动浏览器以生成报告。所有尝试均失败。';
      const suggestion = '可能原因: 1. 未安装兼容的Chrome/Edge浏览器或安装路径非标准且无法被自动检测。 2. Puppeteer自带的浏览器核心在应用打包时未能正确处理 (如asar解压)。 3. 权限问题或安全软件阻止浏览器启动。 4. 环境变量 (如PUPPETEER_EXECUTABLE_PATH) 配置不正确 (如果使用 puppeteer-core)。';
      const troubleshooting = '建议操作: 1. 确保已安装最新稳定版的Chrome或Microsoft Edge。 2. 如果是打包应用，请检查打包配置，确保Puppeteer的浏览器组件被正确解压 (asarUnpack)。 3. 尝试以管理员身份运行应用。 4. 查阅应用数据目录下的 puppeteer_launch.log 获取详细启动尝试信息。';
      const attemptsSummary = launchAttemptsInfo.join('; ');
      const finalErrorMsg = `${baseMessage}\n启动尝试摘要: ${attemptsSummary}\n\n${suggestion}\n\n${troubleshooting}`;
      await writeToLaunchLog(finalErrorMsg, false); // Log the full error to file
      console.error(`[batchspeedtest] Puppeteer 启动失败。详情请查看 puppeteer_launch.log。摘要: ${attemptsSummary}`);
      return {
        success: false,
        error: `${baseMessage} 详情请查看应用日志文件 puppeteer_launch.log。 (摘要: ${attemptsSummary.substring(0,200)}...)`,
      };
    }

    try {
      const page = await browser.newPage();
      await page.setViewport({
        width: 1200,
        height: 800, // Initial height, will be adjusted
        deviceScaleFactor: 2
      });

      await page.goto(`file://${htmlFilePath}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1000)); // Wait for rendering

      const pageDimensions = await page.evaluate(() => {
        return {
          height: document.documentElement.scrollHeight,
        };
      });

      const actualPageHeight = pageDimensions.height;
      const viewportHeight = Math.max(1000, actualPageHeight + 50);
      await writeToLaunchLog(`Evaluated scrollHeight: ${actualPageHeight}, Setting viewport height to: ${viewportHeight}`);
      await page.setViewport({ width: 1200, height: viewportHeight });
      await new Promise(r => setTimeout(r, 500));

      await writeToLaunchLog('Taking screenshot...');
      await page.screenshot({ path: pngFilePath });
      await writeToLaunchLog(`PNG报告已生成: ${pngFilePath}`);

      return {
        success: true,
        reportId,
        filePath: pngFilePath,
        htmlPath: htmlFilePath,
        savedToUserPath: !!saveFilePath
      };
    } finally {
      if (browser) {
        await browser.close();
        await writeToLaunchLog('Browser closed.');
      }
    }
  } catch (error) {
    await writeToLaunchLog(`Puppeteer生成报告时发生顶层错误: ${error.message}\nStack: ${error.stack}`);
    console.error(`[batchspeedtest] Puppeteer生成报告出错:`, error);
    return {
      success: false,
      error: `生成报告出错: ${error.message}. 详情请查看 puppeteer_launch.log`
    };
  }
}

/**
 * 使用Puppeteer生成报告并复制到剪贴板
 * @param {Object} reportData 报告数据
 * @param {Object} clipboard Electron剪贴板对象
 * @param {Object} nativeImage Electron原生图像对象
 * @param {string} userDataPath 用户数据路径
 * @returns {Promise<Object>} 操作结果
 */
async function copySpeedtestReportWithPuppeteer(reportData, clipboard, nativeImage, userDataPath) {
  try {
    // 先生成报告图片
    const report = await generateSpeedtestReportWithPuppeteer(reportData, userDataPath);
    if (!report.success) {
      return report;
    }

    // 读取生成的PNG文件
    const imageData = await fs.readFile(report.filePath);
    
    // 转换为nativeImage并复制到剪贴板
    const image = nativeImage.createFromBuffer(imageData);
    clipboard.writeImage(image);

    return {
      success: true,
      message: '报告已复制到剪贴板'
    };
  } catch (error) {
    console.error(`[batchspeedtest] 复制报告到剪贴板出错:`, error);
    return {
      success: false,
      error: `复制报告到剪贴板出错: ${error.message}`
    };
  }
}

/**
 * 生成报告HTML
 * @param {Object} reportData 报告数据
 * @returns {string} 生成的HTML内容
 */
function generateReportHtml(reportData) {
  console.log('[generateReportHtml] reportData.testResults length:', reportData?.testResults?.length);
  if (reportData?.testResults?.length > 50) {
    console.log('[generateReportHtml] reportData.testResults[0].name:', reportData.testResults[0]?.name);
    console.log('[generateReportHtml] reportData.testResults[55].name:', reportData.testResults[55]?.name);
    console.log('[generateReportHtml] reportData.testResults[56].name:', reportData.testResults[56]?.name);
  }
  
  const { 
    testResults, 
    proxyGroupName, 
    testConfig, 
    reportNote, 
    skippedNodes,
    excludedNodes,
    includedNodes,
    testTime,
    logoPath
  } = reportData;
  
  const formattedTime = new Date(testTime || Date.now()).toLocaleString();
  
  // 构建表格行
  let tableRows = '';
  testResults.forEach((result, index) => {
    // 为不同UDP类型设置不同的徽章样式和图标
    let udpBadgeClass = 'badge-udp-unknown';
    let udpIcon = '';
    
    if (result.udpType) {
      const udpType = result.udpType.toLowerCase();
      if (udpType.includes('fullcone') || udpType.includes('symmetric')) {
        udpBadgeClass = 'badge-udp-good';
        udpIcon = '<svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>';
      } else if (udpType.includes('blocked')) {
        udpBadgeClass = 'badge-udp-bad';
        udpIcon = '<svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
      } else if (udpType !== 'unknown' && udpType !== 'n/a') {
        udpBadgeClass = 'badge-udp-neutral';
        udpIcon = '<svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 0 2 9.3V17h7v-8H5.3A2.7 2.7 0 0 1 8 6.3V17h7v-7h-4v8h7V9.3A6 6 0 0 0 15.3 3Z"></path></svg>';
      } else {
        udpIcon = '<svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
      }
    }
    
    // 处理延迟颜色
    const delay = result.delay > 0 ? result.delay : 0;
    let delayColor = 'text-normal';
    if (delay > 0 && delay <= 150) delayColor = 'text-green';
    else if (delay > 150 && delay <= 300) delayColor = 'text-yellow';
    else if (delay > 300) delayColor = 'text-red';
    
    // 新的速度颜色映射逻辑
    const getSpeedColor = (speed) => {
      if (speed <= 0) return 'speed-na';
      
      // 新的速度颜色映射逻辑 - 调整后
      if (speed < 5) return 'speed-level-green-1';
      if (speed < 20) return 'speed-level-green-2';
      if (speed < 50) return 'speed-level-green-3';
      if (speed < 100) return 'speed-level-green-4';
      if (speed < 200) return 'speed-level-yellow-1';
      if (speed < 300) return 'speed-level-yellow-2';
      if (speed < 400) return 'speed-level-orange-1';
              if (speed < 600) return 'speed-level-orange-2';
        if (speed < 800) return 'speed-level-red-1';
        if (speed < 1000) return 'speed-level-purple-1';
        return 'speed-level-purple-2';
    };
    
    const speedFormat = (speed) => {
      if (speed <= 0) return '<span class="speed-na">N/A</span>';
      const colorClass = getSpeedColor(speed);
      return `<span class="speed-badge ${colorClass}">${speed.toFixed(2)} <span class="speed-unit">Mbps</span></span>`;
    };
    
    tableRows += `
      <tr class="${index % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="text-center">
          <div class="circle-number">${index + 1}</div>
        </td>
        <td class="text-left node-name">
          <div class="node-name-container">
            <span class="node-name-text">${result.name}</span>
            <div class="tooltip">${result.name}</div>
          </div>
        </td>
        <td class="text-center">
          <span class="badge badge-type">
            <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"></path><path d="M15 7h2a5 5 0 1 1 0 10h-2"></path><line x1="8" y1="12" x2="16" y2="12"></line></svg>
            ${result.type || 'N/A'}
          </span>
        </td>
        <td class="text-center ${delayColor}">
          <div class="value-with-icon">
            <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H7.5a2.5 2.5 0 0 0 0 5H17"></path><path d="M17 14H7.5a2.5 2.5 0 0 1 0-5H17"></path></svg>
            ${delay > 0 ? `${delay.toFixed(0)}` : '超时'}
          </div>
        </td>
        <td class="text-center">
          <div class="value-with-icon">
            <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline></svg>
            ${result.rttDeviation > 0 ? `${result.rttDeviation.toFixed(1)}` : '-'}
          </div>
        </td>
        <td class="text-center ${result.httpDelay > 0 ? 'text-normal' : 'text-red'}">
          <div class="value-with-icon">
            <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
            ${result.httpDelay > 0 ? `${result.httpDelay.toFixed(0)}` : '超时'}
          </div>
        </td>
        <td class="text-center speed-value">
          <div class="value-with-icon">
            <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"></path><path d="M16 2v4"></path><path d="M3 10h18"></path><path d="M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10Z"></path><path d="M8 14h8"></path><path d="M8 18h5"></path></svg>
            ${speedFormat(result.downloadSpeed)}
          </div>
        </td>
        <td class="text-center speed-value">
          <div class="value-with-icon">
            <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline></svg>
            ${speedFormat(result.maxSpeed)}
          </div>
        </td>
        <td class="text-center">
          <span class="badge ${udpBadgeClass}">
            ${udpIcon}
            ${result.udpType || 'N/A'}
          </span>
        </td>
      </tr>
    `;
  });
  
  // 生成完整的HTML报告
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FlyClash 节点测速报告</title>
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
        background: #ffffff;
        color: #1e293b;
      }
      
      /* 全局图标样式 */
      .icon-sm {
        width: 16px;
        height: 16px;
        vertical-align: middle;
        stroke-width: 2.2;
      }
      
      .mr-1 {
        margin-right: 4px;
      }
      
      #report-container {
        width: 1200px;
        padding: 40px;
        box-sizing: border-box;
        background: #ffffff;
        background-image: 
          radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.03) 0%, transparent 15%),
          radial-gradient(circle at 90% 5%, rgba(99, 102, 241, 0.04) 0%, transparent 20%),
          radial-gradient(circle at 95% 95%, rgba(236, 72, 153, 0.03) 0%, transparent 15%);
      }
      
      /* 美化报告头部 */
      .report-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 32px;
        border-bottom: 1px solid #e2e8f0;
        padding-bottom: 24px;
        position: relative;
        min-height: 150px;
      }
      
      .report-header::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        width: 80px;
        height: 3px;
        background: linear-gradient(to right, #3b82f6, #8b5cf6);
        border-radius: 3px;
      }
      

      
      .report-title {
        font-size: 32px;
        font-weight: 800;
        color: #0f172a;
        margin-bottom: 8px;
        line-height: 1.2;
        background: linear-gradient(to right, #1d4ed8, #7c3aed);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      
      .report-subtitle {
        font-size: 16px;
        color: #475569;
        margin-bottom: 0;
        line-height: 1.4;
      }
      
      .logo-container {
        display: flex;
        align-items: center;
        margin-bottom: 16px;
      }
      
      .logo-box {
        width: 54px;
        height: 54px;
        margin-right: 16px;
        background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
        border-radius: 12px;
        border: 1px solid #bae6fd;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(186, 230, 253, 0.4);
      }
      
      .logo-box svg {
        width: 32px;
        height: 32px;
        color: #3b82f6;
      }
      
      .logo-box .logo-img {
        width: 38px;
        height: 38px;
        object-fit: contain;
      }
      
      .metadata {
        display: flex;
        margin-top: 28px;
        flex-wrap: wrap;
      }
      
      .metadata-item {
        display: flex;
        align-items: center;
        margin-right: 28px;
        margin-bottom: 8px;
        font-size: 14px;
        color: #64748b;
        background-color: #f8fafc;
        padding: 8px 12px;
        border-radius: 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        border: 1px solid #f1f5f9;
      }
      
      .metadata-icon {
        margin-right: 8px;
        color: #3b82f6;
      }
      
      .metadata-label {
        color: #64748b;
        margin-right: 4px;
        font-weight: 500;
      }
      
      .metadata-value {
        color: #334155;
        font-weight: 600;
      }
      
      .stats-box {
        text-align: center;
        padding: 16px;
        background: linear-gradient(to bottom, #f8fafc, #f1f5f9);
        border-radius: 12px;
        min-width: 130px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
        border: 1px solid #e2e8f0;
      }
      
      .stats-number {
        font-size: 36px;
        font-weight: 800;
        color: #0f172a;
        line-height: 1.1;
        background: linear-gradient(to bottom, #0f172a, #334155);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      
      .stats-label {
        font-size: 14px;
        color: #64748b;
        margin-top: 4px;
        font-weight: 500;
      }
      
      /* 报告标签样式 */
      .report-info-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
        margin-bottom: 30px;
      }
      
      .info-tag {
        display: inline-flex;
        align-items: center;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
      }
      
      .tag-skipped {
        background-color: #fff7ed;
        color: #c2410c;
        border: 1px solid #ffedd5;
      }
      
      .tag-excluded {
        background-color: #f0f9ff;
        color: #0369a1;
        border: 1px solid #e0f2fe;
      }
      
      .tag-included {
        background-color: #f0fdf4;
        color: #166534;
        border: 1px solid #dcfce7;
      }
      
      /* 表格样式 */
      .report-table-container {
        width: 100%;
        overflow-x: auto;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        margin-top: 24px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
        background: linear-gradient(to bottom, #ffffff, #f8fafc);
      }
      
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      
      thead th {
        padding: 14px 12px;
        font-weight: 600;
        vertical-align: middle;
        border-bottom: 1px solid #cbd5e1;
        color: #1e293b;
        background: linear-gradient(to bottom, #f8fafc, #f1f5f9);
        text-align: center;
        position: relative;
      }
      
      thead th:first-child,
      thead th:nth-child(2) {
        text-align: left;
      }
      
      /* 表格头部装饰线 */
      thead th::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 60%;
        height: 2px;
        background: linear-gradient(to right, rgba(59, 130, 246, 0.2), rgba(59, 130, 246, 0.6), rgba(59, 130, 246, 0.2));
        border-radius: 2px;
      }
      
      tbody tr {
        border-bottom: 1px solid #e2e8f0;
        transition: all 0.2s ease;
      }
      
      .row-even {
        background-color: #ffffff;
      }
      
      .row-odd {
        background-color: #f8fafc;
      }
      
      tbody tr:hover {
        background-color: #f1f5f9;
        transform: translateY(-1px);
        box-shadow: 0 3px 6px rgba(0, 0, 0, 0.05);
        z-index: 10;
        position: relative;
      }
      
      tbody tr:last-child {
        border-bottom: none;
      }
      
      tbody td {
        padding: 12px;
        vertical-align: middle;
        font-size: 0.875rem;
        color: #334155;
        text-align: center;
        transition: all 0.2s ease;
      }
      
      tbody tr:hover td {
        color: #1e293b;
      }
      
      tbody td:first-child,
      tbody td:nth-child(2) {
        text-align: left;
      }
      
      /* 序号圆圈样式 */
      .circle-number {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: linear-gradient(135deg, #f1f5f9, #e2e8f0);
        color: #475569;
        font-weight: 600;
        border: 1px solid #e2e8f0;
        font-size: 13px;
        transition: all 0.2s ease;
      }
      
      tbody tr:hover .circle-number {
        background: linear-gradient(135deg, #e0f2fe, #bae6fd);
        color: #0284c7;
        border-color: #7dd3fc;
        box-shadow: 0 2px 4px rgba(56, 189, 248, 0.2);
      }
      
      /* 节点名称容器 */
      .node-name-container {
        display: flex;
        align-items: center;
        position: relative;
      }
      
      .node-name {
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 500;
        transition: all 0.2s ease;
        position: relative;
      }
      
      .node-name-text {
        max-width: 290px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: inline-block;
        cursor: help;
      }
      
      tbody tr:hover .node-name {
        color: #0f172a;
      }
      
      /* 值与图标样式 */
      .value-with-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
        transition: all 0.2s ease;
      }
      
      tbody tr:hover .value-with-icon {
        transform: scale(1.05);
      }
      
      tbody tr:hover .speed-badge {
        transform: translateY(-3px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      }
      
      /* 徽章样式 */
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 0 10px;
        height: 24px;
        line-height: 24px;
        border-radius: 9999px;
        font-size: 0.8rem;
        font-weight: 500;
        border: 1px solid transparent;
        transition: all 0.2s ease;
      }
      
      .badge-type {
        background-color: #eff6ff;
        color: #2563eb;
        border-color: #bfdbfe;
      }
      
      .badge-udp-good {
        background-color: #dcfce7;
        color: #16a34a;
        border-color: #bbf7d0;
      }
      
      .badge-udp-bad {
        background-color: #fee2e2;
        color: #dc2626;
        border-color: #fecaca;
      }
      
      .badge-udp-neutral {
        background-color: #e0e7ff;
        color: #4f46e5;
        border-color: #c7d2fe;
      }
      
      .badge-udp-unknown {
        background-color: #f3f4f6;
        color: #6b7280;
        border-color: #d1d5db;
      }
      
      /* 徽章悬停效果 */
      tbody tr:hover .badge {
        transform: translateY(-1px);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
      
      /* 自定义 tooltip */
      .node-name-container .tooltip {
        visibility: hidden;
        width: 320px;
        background-color: #1e293b;
        color: #fff;
        text-align: center;
        border-radius: 8px;
        padding: 8px 12px;
        position: absolute;
        z-index: 100;
        bottom: 125%;
        left: 0;
        margin-left: 0;
        opacity: 0;
        transition: opacity 0.3s;
        font-weight: 400;
        font-size: 12px;
        box-shadow: 0 10px 15px rgba(0, 0, 0, 0.1);
        pointer-events: none;
        white-space: normal;
        word-break: break-all;
      }
      
      .node-name-container .tooltip::after {
        content: "";
        position: absolute;
        top: 100%;
        left: 15%;
        margin-left: -5px;
        border-width: 5px;
        border-style: solid;
        border-color: #1e293b transparent transparent transparent;
      }
      
      .node-name-text:hover + .tooltip {
        visibility: visible;
        opacity: 1;
      }
      
      .speed-value {
        font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
        font-weight: 500;
      }
      
      .speed-badge {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 12px;
        font-weight: 600;
        color: white;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        transition: all 0.2s ease;
        position: relative;
        z-index: 1;
      }
      
      .speed-badge:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
      }
      
      .speed-badge::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        border-radius: 12px;
        z-index: -1;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      
      .speed-badge:hover::after {
        opacity: 1;
      }
      
      /* 网速颜色级别 - 从绿到金的渐变色系 */
      /* 绿色系列 - 低速 */
      .speed-level-green-1 {
        background: linear-gradient(135deg, #34d399, #10b981);
        border: 1px solid rgba(5, 150, 105, 0.5);
      }
      
      .speed-level-green-1::after {
        background: linear-gradient(135deg, #34d399, #059669);
        filter: blur(6px);
      }
      
      .speed-level-green-2 {
        background: linear-gradient(135deg, #10b981, #059669);
        border: 1px solid rgba(4, 120, 87, 0.5);
      }
      
      .speed-level-green-2::after {
        background: linear-gradient(135deg, #10b981, #047857);
        filter: blur(6px);
      }
      
      .speed-level-green-3 {
        background: linear-gradient(135deg, #059669, #047857);
        border: 1px solid rgba(6, 95, 70, 0.5);
      }
      
      .speed-level-green-3::after {
        background: linear-gradient(135deg, #059669, #065f46);
        filter: blur(6px);
      }
      
      .speed-level-green-4 {
        background: linear-gradient(135deg, #047857, #065f46);
        border: 1px solid rgba(6, 78, 59, 0.5);
      }
      
      .speed-level-green-4::after {
        background: linear-gradient(135deg, #047857, #064e3b);
        filter: blur(6px);
      }
      
      /* 黄色系列 - 中低速 */
      .speed-level-yellow-1 {
        background: linear-gradient(135deg, #fbbf24, #f59e0b);
        border: 1px solid rgba(217, 119, 6, 0.5);
      }
      
      .speed-level-yellow-1::after {
        background: linear-gradient(135deg, #fbbf24, #d97706);
        filter: blur(6px);
      }
      
      .speed-level-yellow-2 {
        background: linear-gradient(135deg, #f59e0b, #d97706);
        border: 1px solid rgba(180, 83, 9, 0.5);
      }
      
      .speed-level-yellow-2::after {
        background: linear-gradient(135deg, #f59e0b, #b45309);
        filter: blur(6px);
      }
      
      /* 橙色系列 - 中速 */
      .speed-level-orange-1 {
        background: linear-gradient(135deg, #f97316, #ea580c);
        border: 1px solid rgba(194, 65, 12, 0.5);
      }
      
      .speed-level-orange-1::after {
        background: linear-gradient(135deg, #f97316, #c2410c);
        filter: blur(6px);
      }
      
      .speed-level-orange-2 {
        background: linear-gradient(135deg, #ea580c, #c2410c);
        border: 1px solid rgba(154, 52, 18, 0.5);
      }
      
      .speed-level-orange-2::after {
        background: linear-gradient(135deg, #ea580c, #9a3412);
        filter: blur(6px);
      }
      
      /* 红色系列 - 高速 */
      .speed-level-red-1 {
        background: linear-gradient(135deg, #ef4444, #b91c1c);
        border: 1px solid rgba(190, 18, 60, 0.5);
        animation: pulse 2.5s infinite;
        position: relative;
        overflow: hidden;
      }
      
      .speed-level-red-1::before {
        content: '';
        position: absolute;
        top: -50%;
        left: -50%;
        width: 200%;
        height: 200%;
        background: linear-gradient(
          45deg,
          transparent 0%,
          rgba(255, 255, 255, 0.15) 50%,
          transparent 100%
        );
        animation: shine 2.5s infinite linear;
        z-index: 0;
      }
      
      .speed-level-red-1::after {
        background: linear-gradient(135deg, #f43f5e, #be123c);
        filter: blur(6px);
      }
      
      /* 红色风格已整合到 speed-level-red-1 中 */
      
      /* 紫色系列 - 极速 */
      .speed-level-purple-1 {
        background: linear-gradient(135deg, #8b5cf6, #7c3aed);
        border: 1px solid rgba(109, 40, 217, 0.5);
        box-shadow: 0 0 10px rgba(139, 92, 246, 0.5);
        animation: purple-pulse 2s infinite;
        position: relative;
        overflow: hidden;
      }
      
      .speed-level-purple-1::before {
        content: '';
        position: absolute;
        top: -50%;
        left: -50%;
        width: 200%;
        height: 200%;
        background: linear-gradient(
          45deg,
          transparent 0%,
          rgba(255, 255, 255, 0.2) 50%,
          transparent 100%
        );
        animation: shine 2s infinite linear;
        z-index: 0;
      }
      
      .speed-level-purple-1::after {
        background: linear-gradient(135deg, #a78bfa, #6d28d9);
        filter: blur(8px);
      }
      
      .speed-level-purple-2 {
        background: linear-gradient(135deg, #a855f7, #7e22ce);
        border: 1px solid rgba(126, 34, 206, 0.5);
        box-shadow: 0 0 15px rgba(168, 85, 247, 0.6);
        animation: purple-pulse 1.5s infinite;
        text-shadow: 0 0 5px rgba(0, 0, 0, 0.3);
        position: relative;
        overflow: hidden;
      }
      
      .speed-level-purple-2::before {
        content: '';
        position: absolute;
        top: -50%;
        left: -50%;
        width: 200%;
        height: 200%;
        background: linear-gradient(
          45deg,
          transparent 0%,
          rgba(255, 255, 255, 0.25) 50%,
          transparent 100%
        );
        animation: shine 1.5s infinite linear;
        z-index: 0;
      }
      
      .speed-level-purple-2::after {
        background: linear-gradient(135deg, #c4b5fd, #6d28d9);
        filter: blur(8px);
      }
      
      /* 速度标签通用内容样式，确保在光效上层 */
      .speed-badge span {
        position: relative;
        z-index: 2;
      }
      
      @keyframes shine {
        0% {
          transform: translateX(-100%) translateY(-100%) rotate(45deg);
        }
        100% {
          transform: translateX(100%) translateY(100%) rotate(45deg);
        }
      }
      
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.4); }
        70% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
        100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); }
      }
      
      @keyframes purple-pulse {
        0% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.6); }
        70% { box-shadow: 0 0 0 8px rgba(139, 92, 246, 0); }
        100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0); }
      }
      
      .speed-na {
        color: #64748b;
        font-style: italic;
      }
      
      .speed-unit {
        font-size: 0.8em;
        color: rgba(255, 255, 255, 0.9);
        margin-left: 4px;
        font-family: system-ui, sans-serif;
        font-weight: normal;
        text-shadow: none;
      }
      
      .text-na {
        color: #64748b;
      }
      
      .text-green {
        color: #16a34a;
      }
      
      .text-yellow {
        color: #ca8a04;
      }
      
      .text-red {
        color: #dc2626;
      }
      
      .text-normal {
        color: #334155;
      }
      
      .report-footer {
        text-align: center;
        margin-top: 36px;
        padding-top: 24px;
        border-top: 1px solid #e2e8f0;
        font-size: 13px;
        color: #64748b;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      
      .footer-logo {
        margin-bottom: 12px;
      }
      
      .footer-text {
        display: flex;
        align-items: center;
        gap: 4px;
      }
    </style>
  </head>
  <body>
    <div id="report-container">
            <div class="report-header">
        <div>
          <div class="logo-container">
            <div class="logo-box">
              <img src="flyclash_logo.png" alt="FlyClash Logo" class="logo-img" onerror="this.style.display='none'; console.error('无法加载Logo图片');" />
            </div>
            <div>
              <h1 class="report-title">配置测速报告</h1>
              <p class="report-subtitle">FlyClash 网络性能分析</p>
            </div>
          </div>
          
          <div class="metadata">
            <div class="metadata-item">
              <svg xmlns="http://www.w3.org/2000/svg" class="metadata-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span class="metadata-label">测试时间:</span>
              <span class="metadata-value">${formattedTime}</span>
            </div>
            
            <div class="metadata-item">
              <svg xmlns="http://www.w3.org/2000/svg" class="metadata-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"></path>
                <path d="m17 4 3 3"></path>
                <path d="m14 7 3 3"></path>
              </svg>
              <span class="metadata-label">配置:</span>
              <span class="metadata-value">${testConfig || proxyGroupName || '未知'}</span>
            </div>
            
            ${reportNote ? `
            <div class="metadata-item">
              <svg xmlns="http://www.w3.org/2000/svg" class="metadata-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              <span class="metadata-label">备注:</span>
              <span class="metadata-value">${reportNote}</span>
            </div>
            ` : ''}
          </div>
        </div>
        
        <div class="stats-box">
          <div class="stats-number">${testResults.length}</div>
          <div class="stats-label">测试节点</div>
        </div>
      </div>
      
      <div class="report-info-tags">
        ${skippedNodes && skippedNodes.length > 0 ? `
        <div class="info-tag tag-skipped">
          <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          跳过 ${skippedNodes.length} 个节点
        </div>
        ` : ''}
        
        ${excludedNodes && excludedNodes.length > 0 ? `
        <div class="info-tag tag-excluded">
          <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 9h.01"></path>
            <path d="M15 9h.01"></path>
            <path d="M8 13h.01"></path>
            <path d="M16 13h.01"></path>
            <path d="M9 17h.01"></path>
            <path d="M15 17h.01"></path>
            <rect x="2" y="3" width="20" height="18" rx="2"></rect>
          </svg>
          排除 ${excludedNodes.length} 个节点
        </div>
        ` : ''}
        
        ${includedNodes && includedNodes.length > 0 ? `
        <div class="info-tag tag-included">
          <svg xmlns="http://www.w3.org/2000/svg" class="icon-sm mr-1" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 11V6a2 2 0 0 1 2-2v0a2 2 0 0 1 2 2v0"></path>
            <path d="M9 11V9a2 2 0 0 1 2-2v2"></path>
            <rect x="3" y="11" width="18" height="10" rx="2"></rect>
          </svg>
          筛选 ${includedNodes.length} 个节点
        </div>
        ` : ''}
      </div>
      
      <div class="report-table-container">
        <table>
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">节点名称</th>
              <th scope="col">类型</th>
              <th scope="col">延迟(ms)</th>
              <th scope="col">偏差(ms)</th>
              <th scope="col">HTTP(ms)</th>
              <th scope="col">平均速度</th>
              <th scope="col">最大速度</th>
              <th scope="col">UDP</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
      
      <div class="report-footer">

        <div class="footer-text">
          <span>由 FlyClash 测速工具生成</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: #64748b;">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <span>${new Date().toISOString().split('T')[0]}</span>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
}

// 导出模块功能
module.exports = {
  initBatchSpeedtest,
  runProxySpeedtest,
  testUdpConnectivity,
  saveSpeedtestReport,
  getSpeedtestReports,
  getSpeedtestReport,
  generateSpeedtestReportWithPuppeteer,
  copySpeedtestReportWithPuppeteer,
  cancelBatchSpeedtest // 导出新增的取消测速函数
};