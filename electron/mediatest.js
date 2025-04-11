// 媒体服务检测模块
// node-fetch是ESM模块，我们需要动态导入
// const nodeFetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// 日志记录器
const logger = {
  logFile: path.join(os.tmpdir(), 'mediatest-log.txt'),
  
  async log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    
    // 控制台输出
    console.log(logMessage);
    
    try {
      // 写入文件
      await fs.appendFile(this.logFile, logMessage, 'utf8');
    } catch (error) {
      console.error('无法写入日志文件:', error);
    }
  },
  
  async error(message) {
    await this.log(message, 'ERROR');
  },
  
  async debug(message) {
    await this.log(message, 'DEBUG');
  },
  
  async logResponse(serviceName, url, response, html) {
    await this.log(`${serviceName} 响应码: ${response.status}`, 'DEBUG');
    
    // 记录响应头
    const headers = [];
    response.headers.forEach((value, name) => {
      headers.push(`${name}: ${value}`);
    });
    await this.log(`${serviceName} 响应头:\n${headers.join('\n')}`, 'DEBUG');
    
    // 记录HTML片段（最多1000字符）
    if (html) {
      const snippet = html.substring(0, 1000) + (html.length > 1000 ? '...' : '');
      await this.log(`${serviceName} HTML片段:\n${snippet}`, 'DEBUG');
    }
  },
  
  async clearLog() {
    try {
      await fs.writeFile(this.logFile, '', 'utf8');
      await this.log('日志已清空', 'INFO');
    } catch (error) {
      console.error('无法清空日志文件:', error);
    }
  },
  
  async getLogPath() {
    return this.logFile;
  }
};

/**
 * 检测流媒体服务的可用性和解锁状态
 * @param {string} serviceName 服务名称，如'Netflix'
 * @param {string} checkUrl 检测URL
 * @returns {Promise<object>} 检测结果
 */
async function testMediaStreaming(serviceName, checkUrl) {
  try {
    await logger.clearLog();
    await logger.log(`开始检测媒体服务: ${serviceName}, URL: ${checkUrl}`);
    console.log(`[mediatest.js] 开始处理服务: ${serviceName}，检测URL: ${checkUrl || '未提供'}`);
    
    // 记录开始时间，用于计算检测耗时
    const startTime = Date.now();
    
    // 动态导入node-fetch
    const { default: fetch } = await import('node-fetch');
    
    // 获取检测代理服务器设置
    const proxyPort = 7890; // mihomo默认端口
    const proxyServer = `http://127.0.0.1:${proxyPort}`;
    await logger.log(`使用代理: ${proxyServer}`);
    
    // 创建代理代理
    const proxyAgent = new HttpsProxyAgent(proxyServer);
    
    // 根据不同的服务设置特定的检测参数
    let detectionResult = {
      available: false,
      fullSupport: false,
      message: '未支持',
      region: null,
      checkTime: 0,
      ipInfo: null, // 添加IP信息字段
      dnsStatus: null, // 添加DNS检测状态
      logPath: await logger.getLogPath() // 添加日志路径
    };
    
    // 使用node-fetch请求相关服务API
    const timeout = 15000; // 15秒超时
    
    try {
      // 构建请求对象
      const baseRequestOptions = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
        },
        timeout: timeout,
        agent: proxyAgent
      };
      
      await logger.log(`准备检测 ${serviceName}, 超时设置: ${timeout}ms`);
      
      // 不同服务的检测策略
      console.log(`[mediatest.js] 使用 switch 语句处理服务: ${serviceName}`);
      switch (serviceName) {
        case 'Netflix': {
          // 参考check.sh实现，检测Netflix
          await logger.log('开始检测Netflix...');
          
          // 检测Netflix自制剧
          await logger.log('检测Netflix自制剧...');
          const originalResponse = await fetch('https://www.netflix.com/title/81280792', baseRequestOptions);
          await logger.log(`Netflix自制剧HTTP状态码: ${originalResponse.status}`);
          const originalHtml = await originalResponse.text();
          await logger.logResponse('Netflix Original', 'https://www.netflix.com/title/81280792', originalResponse, originalHtml);
          
          // Breaking Bad - 非自制剧ID
          await logger.log('检测Netflix非自制剧...');
          const nonOriginalResponse = await fetch('https://www.netflix.com/title/70143836', baseRequestOptions);
          await logger.log(`Netflix非自制剧HTTP状态码: ${nonOriginalResponse.status}`);
          const nonOriginalHtml = await nonOriginalResponse.text();
          await logger.logResponse('Netflix Non-Original', 'https://www.netflix.com/title/70143836', nonOriginalResponse, nonOriginalHtml);
          
          // 检查页面内容是否包含地区限制提示
          // 注意：Netflix页面中的地区限制信息可能被编码或分割，需要多种检测手段
          
          // 1. 检查明显的地区限制文本 - 使用更小的片段增加匹配机会
          const textLimitations = [
            "not available in your country",
            "isn't available to watch in your country",
            "isn't available in your country",
            "not available in your region",
            "isn't available in your region",
            "currently isn't available",
            "isn't available to watch",
            "not available to watch",
            "Oh no! This title",
            "Sorry, this title",
            "unavailable in your area"
          ];
          
          // 检查原创剧和非原创剧页面是否包含这些文本片段
          const hasLimitationText = textLimitations.some(text => 
            originalHtml.includes(text) || nonOriginalHtml.includes(text)
          );
          
          await logger.log(`Netflix地区限制文本检测: ${hasLimitationText ? '检测到限制文本' : '未检测到限制文本'}`);
          
          // 2. 检查特定的HTML元素类和ID
          const limitElements = [
            'data-uia="locally-unavailable"',
            'alert_visualStyles',
            'WarningFillStandard',
            'ui-message-error',
            'error-page',
            'unavailable-content',
            'serviceErrorMessage'
          ];
          
          const hasLimitationElements = limitElements.some(element => 
            originalHtml.includes(element) || nonOriginalHtml.includes(element)
          );
          
          await logger.log(`Netflix限制元素检测: ${hasLimitationElements ? '检测到限制元素' : '未检测到限制元素'}`);
          
          // 3. 检查错误代码
          const errorCodes = [
            "NSES-404",
            "NSES-403",
            "NSES-500",
            "NSES-NTI",  // Netflix Title Inaccessible
            "errorCode:"
          ];
          
          const hasErrorCodes = errorCodes.some(code => 
            originalHtml.includes(code) || nonOriginalHtml.includes(code)
          );
          
          await logger.log(`Netflix错误代码检测: ${hasErrorCodes ? '检测到错误代码' : '未检测到错误代码'}`);
          
          // 4. 检查页面标题
          const errorTitles = [
            "<title>Netflix - 出错了</title>",
            "<title>Netflix - Error</title>",
            "<title>Netflix - ошибка</title>",
            "<title>Netflix - Oops</title>",
            "Netflix - Oh no!"
          ];
          
          const hasErrorTitle = errorTitles.some(title => 
            originalHtml.includes(title) || nonOriginalHtml.includes(title)
          );
          
          await logger.log(`Netflix错误标题检测: ${hasErrorTitle ? '检测到错误标题' : '未检测到错误标题'}`);
          
          // 5. 检查JSON配置中的限制标记
          // Netflix经常在JSON配置中包含地区限制信息
          const jsonLimitations = [
            '"availabilityReason":',
            '"isAvailable":false',
            '"geographicallyAvailable":false',
            '"isPlayable":false',
            '"regionRestriction":'
          ];
          
          const hasJsonLimitation = jsonLimitations.some(json => 
            originalHtml.includes(json) || nonOriginalHtml.includes(json)
          );
          
          await logger.log(`Netflix JSON限制检测: ${hasJsonLimitation ? '检测到JSON限制' : '未检测到JSON限制'}`);
          
          // 综合判断地区限制
          const regionBlocked = hasLimitationText || hasLimitationElements || hasErrorCodes || hasErrorTitle || hasJsonLimitation;
          
          await logger.log(`Netflix区域限制综合检测结果: ${regionBlocked ? '检测到限制' : '无限制'}`);
          
          // 记录页面标题以便调试
          const originalTitleMatch = originalHtml.match(/<title>(.*?)<\/title>/);
          const nonOriginalTitleMatch = nonOriginalHtml.match(/<title>(.*?)<\/title>/);
          
          if (originalTitleMatch) {
            await logger.log(`Netflix自制剧页面标题: ${originalTitleMatch[1]}`);
          }
          
          if (nonOriginalTitleMatch) {
            await logger.log(`Netflix非自制剧页面标题: ${nonOriginalTitleMatch[1]}`);
          }
          
          // 根据状态码和页面内容判断结果
          if (originalResponse.status === 404 && nonOriginalResponse.status === 404) {
            // 404表示资源可能不存在，或者是地区限制
            await logger.log('Netflix检测结果: 可能无法访问(404错误)');
            detectionResult.available = false;
            detectionResult.message = '无法访问(404错误)';
          } else if (originalResponse.status === 403 || nonOriginalResponse.status === 403) {
            // 有403表示IP被封或区域限制
            await logger.log('Netflix检测结果: 不支持访问(403错误)');
            detectionResult.available = false;
            detectionResult.message = '不支持访问(403错误)';
          } else if (originalResponse.status === 200 && nonOriginalResponse.status === 200) {
            // 多重检查以提高准确性 - 即使状态码是200，也要检查是否存在地区限制提示
            if (regionBlocked) {
              // 如果检测到地区限制警告框或文字，这是最明确的标志
              await logger.log('Netflix检测结果: 仅支持自制剧(检测到地区限制提示)');
              detectionResult.available = true;
              detectionResult.fullSupport = false;
              detectionResult.message = '仅支持自制剧';
            } else {
              // 如果两个页面都返回200且没有地区限制提示，则认为支持完整内容
              await logger.log('Netflix检测结果: 完全支持');
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = '解锁所有内容';
            }
          } else if (originalResponse.status === 200) {
            // 只有自制剧返回200
            await logger.log('Netflix检测结果: 仅支持自制剧');
            detectionResult.available = true;
            detectionResult.fullSupport = false;
            detectionResult.message = '仅支持自制剧';
          } else {
            // 其他情况，可能是网络问题
            await logger.log(`Netflix检测结果: 未知错误 (${originalResponse.status}_${nonOriginalResponse.status})`);
            detectionResult.available = false;
            detectionResult.message = `检测失败`;
          }
          
          // 尝试获取区域信息 - 改进国家代码检测
          try {
            const homePageResp = await fetch('https://www.netflix.com/', baseRequestOptions);
            const homePageHtml = await homePageResp.text();
            await logger.logResponse('Netflix Home', 'https://www.netflix.com/', homePageResp, homePageHtml);
            
            // 使用更精确的国家代码匹配模式 - 国际标准ISO代码通常是两个字母
            // 首先尝试直接获取ISO国家代码
            let countryMatch = homePageHtml.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
            
            if (!countryMatch) {
              // 备用匹配模式
              countryMatch = homePageHtml.match(/(?:"\\u[0-9a-f]{4}"\s*:\s*)"([A-Z]{2})"/i);
            }
            
            if (!countryMatch) {
              // 尝试从URL或其他地方获取
              const urlMatch = homePageResp.url.match(/(?:\/([a-z]{2})(?:\/|$))|(?:\.([a-z]{2})(?:\/|$))/i);
              if (urlMatch) {
                const code = urlMatch[1] || urlMatch[2];
                if (code) {
                  detectionResult.region = code.toUpperCase();
                  await logger.log(`从URL检测到Netflix区域: ${detectionResult.region}`);
                }
              }
            } else {
              detectionResult.region = countryMatch[1].toUpperCase();
              await logger.log(`检测到Netflix区域: ${detectionResult.region}`);
            }
            
            // 如果还没找到区域，尝试从语言设置中推断
            if (!detectionResult.region) {
              const langMatch = homePageHtml.match(/(?:"locale"|"requestLocale")\s*:\s*"([a-z]{2})[-_]([A-Z]{2})"/i);
              if (langMatch && langMatch[2]) {
                detectionResult.region = langMatch[2].toUpperCase();
                await logger.log(`从语言设置检测到Netflix区域: ${detectionResult.region}`);
              }
            }
          } catch (e) {
            await logger.error('获取Netflix区域出错:' + e.message);
          }
          
          break;
        }
        
        case 'Disney+': {
          // 参考check.sh实现，使用Disney+ API
          await logger.log('开始检测Disney+...');
          
          try {
            // 使用Disney+的设备API
            const apiResponse = await fetch('https://disney.api.edge.bamgrid.com/devices', {
              method: 'POST',
              headers: {
                'accept-language': 'en-US,en;q=0.9',
                'authorization': 'Bearer ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
                'content-type': 'application/json; charset=UTF-8',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
              },
              body: JSON.stringify({
                "deviceFamily": "browser",
                "applicationRuntime": "chrome",
                "deviceProfile": "windows",
                "attributes": {}
              }),
              timeout: timeout,
              agent: proxyAgent
            });
            
            const apiResult = await apiResponse.text();
            await logger.logResponse('Disney+ API', 'https://disney.api.edge.bamgrid.com/devices', apiResponse, apiResult);
            
            // 检查是否被禁止访问
            if (apiResult.includes('403 ERROR')) {
              await logger.log('Disney+检测结果: IP被Disney+封禁');
              detectionResult.available = false;
              detectionResult.message = 'IP被Disney+封禁';
              break;
            }
            
            // 检查assertion
            const assertionMatch = apiResult.match(/"assertion"\s*:\s*"([^"]+)"/);
            if (!assertionMatch) {
              await logger.log('Disney+检测结果: 页面错误');
              detectionResult.available = false;
              detectionResult.message = '检测失败 (页面错误)';
              break;
            }
            
            const assertion = assertionMatch[1];
            
            // 使用获取到的assertion请求token接口
            const disneyCookie = `{"grant_type":"urn:ietf:params:oauth:grant-type:token-exchange","latitude":"0","longitude":"0","platform":"browser","subject_token":"${assertion}","subject_token_type":"urn:bamtech:params:oauth:token-type:device"}`;
            
            const tokenResponse = await fetch('https://disney.api.edge.bamgrid.com/token', {
              method: 'POST',
              headers: {
                'authorization': 'Bearer ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
                'content-type': 'application/json; charset=UTF-8',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
              },
              body: disneyCookie,
              timeout: timeout,
              agent: proxyAgent
            });
            
            const tokenResult = await tokenResponse.text();
            await logger.logResponse('Disney+ Token', 'https://disney.api.edge.bamgrid.com/token', tokenResponse, tokenResult);
            
            // 检查是否有区域限制
            if (tokenResult.includes('forbidden-location') || 
                tokenResult.includes('403 ERROR')) {
              await logger.log('Disney+检测结果: 区域不支持');
              detectionResult.available = false;
              detectionResult.message = '区域不支持';
            } else {
              // 获取refreshToken，检查区域可用性
              const refreshTokenMatch = tokenResult.match(/"refresh_token"\s*:\s*"([^"]+)"/);
              if (refreshTokenMatch && refreshTokenMatch[1]) {
                const refreshToken = refreshTokenMatch[1];
                
                // 继续获取地区信息
                const disneyContent = `{"query":"\\n    query($preferredLanguages: [String!]!, $platformFamily: PlatformFamily!)\\n    {\\n        me {\\n            account {\\n                attributes {\\n                    preferredLanguages\\n                    preferredMaturityRating {\\n                        ratingSystem\\n                        ratingValue\\n                        }\\n                    }\\n                profiles {\\n                    id\\n                    name\\n                    isDefault\\n                    __typename\\n                }\\n                __typename\\n            }\\n            activeSession {\\n                inSupportedLocation\\n                location {\\n                    countryCode\\n                    __typename\\n                }\\n                __typename\\n            }\\n            subscriptions {\\n                isPaid\\n                __typename\\n            }\\n            __typename\\n        }\\n    }\\n","variables":{"platformFamily":"${platformFamily}","preferredLanguages":["en"]},"operationName": null}`;
                
                const graphqlResponse = await fetch('https://disney.api.edge.bamgrid.com/graph/v1/device/graphql', {
                  method: 'POST',
                  headers: {
                    'authorization': 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
                    'content-type': 'application/json',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
                  },
                  body: disneyContent.replace('${platformFamily}', 'browser'),
                  timeout: timeout,
                  agent: proxyAgent
                });
                
                const graphqlResult = await graphqlResponse.text();
                await logger.logResponse('Disney+ GraphQL', 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql', graphqlResponse, graphqlResult);
                
                // 提取地区信息
                const regionMatch = graphqlResult.match(/"countryCode"\s*:\s*"([^"]+)"/);
                if (regionMatch && regionMatch[1]) {
                  detectionResult.region = regionMatch[1].toUpperCase();
                  await logger.log(`检测到Disney+区域: ${detectionResult.region}`);
                }
                
                // 检查是否支持
                const inSupportedLocationMatch = graphqlResult.match(/"inSupportedLocation"\s*:\s*(true|false)/);
                if (inSupportedLocationMatch) {
                  const inSupportedLocation = inSupportedLocationMatch[1] === 'true';
                  if (inSupportedLocation) {
                    await logger.log(`Disney+检测结果: 完全支持 ${detectionResult.region ? `(区域: ${detectionResult.region})` : ''}`);
                    detectionResult.available = true;
                    detectionResult.fullSupport = true;
                    detectionResult.message = '完全支持';
                  } else {
                    await logger.log(`Disney+检测结果: 区域即将支持 ${detectionResult.region ? `(区域: ${detectionResult.region})` : ''}`);
                    detectionResult.available = true;
                    detectionResult.fullSupport = false;
                    detectionResult.message = `区域即将支持: ${detectionResult.region || 'Unknown'}`;
                  }
                } else {
                  await logger.log(`Disney+检测结果: 完全支持 ${detectionResult.region ? `(区域: ${detectionResult.region})` : ''}`);
                  detectionResult.available = true;
                  detectionResult.fullSupport = true;
                  detectionResult.message = '完全支持';
                }
              } else {
                await logger.log('Disney+检测结果: 完全支持 (无法获取具体区域)');
                detectionResult.available = true;
                detectionResult.fullSupport = true;
                detectionResult.message = '完全支持';
              }
            }
          } catch (error) {
            await logger.error(`Disney+检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测失败';
          }
          
          break;
        }
        
        case 'YouTube Premium': {
          // YouTube Premium检测逻辑，参考check.sh
          await logger.log('开始检测YouTube Premium...');
          
          const response = await fetch('https://www.youtube.com/premium', {
            ...baseRequestOptions,
            headers: {
              ...baseRequestOptions.headers,
              'accept-language': 'en-US,en;q=0.9',
              'cookie': 'YSC=FSCWhKo2Zgw; VISITOR_PRIVACY_METADATA=CgJERRIEEgAgYQ%3D%3D; PREF=f7=4000'
            }
          });
          
          if (!response.ok) {
            await logger.log(`YouTube Premium响应失败: ${response.status}`);
            detectionResult.available = false;
            detectionResult.message = '不支持访问';
          } else {
            const html = await response.text();
            await logger.logResponse('YouTube Premium', 'https://www.youtube.com/premium', response, html);
            
            // 检查是否在中国
            const isCN = html.includes('www.google.cn');
            if (isCN) {
              await logger.log('YouTube Premium检测结果: 区域不支持(中国大陆)');
              detectionResult.available = false;
              detectionResult.message = '区域不支持(中国大陆)';
              detectionResult.region = 'CN';
              break;
            }
            
            // 检查是否支持Premium
            const isNotAvailable = html.includes('Premium is not available in your country');
            const isAdFree = html.includes('ad-free') || html.includes('YouTube and YouTube Music ad-free');
            
            // 尝试检测区域
            const regionMatch = html.match(/(?:"GL":|"countryCode":)\s*"([^"]*)"/);
            if (regionMatch && regionMatch[1]) {
              detectionResult.region = regionMatch[1].toUpperCase();
              await logger.log(`检测到YouTube区域: ${detectionResult.region}`);
            }
            
            if (isNotAvailable) {
              await logger.log('YouTube Premium检测结果: 区域不支持Premium');
              detectionResult.available = false;
              detectionResult.message = '区域不支持Premium';
            } else if (isAdFree) {
              await logger.log(`YouTube Premium检测结果: 支持Premium ${detectionResult.region ? `(区域: ${detectionResult.region})` : ''}`);
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = '支持Premium';
            } else {
              await logger.log('YouTube Premium检测结果: 可访问但状态未知');
              detectionResult.available = true;
              detectionResult.fullSupport = false;
              detectionResult.message = '可访问，状态未知';
            }
          }
          break;
        }
        
        case 'BBC iPlayer': {
          // BBC iPlayer检测逻辑 - 使用官方API接口检测，参考check.sh
          await logger.log('开始检测BBC iPlayer...');
          
          // 使用官方API检测接口
          const response = await fetch('https://open.live.bbc.co.uk/mediaselector/6/select/version/2.0/mediaset/pc/vpid/bbc_one_london/format/json/jsfunc/JS_callbacks0', baseRequestOptions);
          
          if (!response.ok) {
            await logger.log(`BBC iPlayer API响应失败: ${response.status}`);
            detectionResult.available = false;
            detectionResult.message = '访问BBC API失败';
            break;
          }
          
          const apiResult = await response.text();
          await logger.logResponse('BBC iPlayer API', 'https://open.live.bbc.co.uk/mediaselector/6/select/version/2.0/mediaset/pc/vpid/bbc_one_london/format/json/jsfunc/JS_callbacks0', response, apiResult);
          
          // 检查地理限制
          const isBlocked = apiResult.includes('geolocation');
          // 检查是否有可用的UK流媒体链接
          const isOK = apiResult.includes('vs-hls-push-uk');
          
          if (!isBlocked && !isOK) {
            await logger.log('BBC iPlayer检测结果: 页面错误');
            detectionResult.available = false;
            detectionResult.message = '检测失败 (页面错误)';
          } else if (isBlocked) {
            await logger.log('BBC iPlayer检测结果: 区域限制');
            detectionResult.available = false;
            detectionResult.message = '仅限英国地区访问';
          } else if (isOK) {
            await logger.log('BBC iPlayer检测结果: 可用');
            detectionResult.available = true;
            detectionResult.fullSupport = true;
            detectionResult.message = '完全支持';
            detectionResult.region = 'UK'; // BBC iPlayer只在英国可用
          } else {
            await logger.log('BBC iPlayer检测结果: 未知错误');
            detectionResult.available = false;
            detectionResult.message = '检测失败 (未知错误)';
          }
          
          break;
        }
        
        case 'Hulu': {
          // Hulu检测逻辑(美国Hulu)，参考check.sh
          await logger.log('开始检测Hulu(US)...');
          
          // 使用登录API测试地区限制
          const response = await fetch('https://auth.hulu.com/v4/web/password/authenticate', {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Accept-Language': 'en-US,en;q=0.9',
              'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
              'Origin': 'https://www.hulu.com',
              'Referer': 'https://www.hulu.com/welcome',
              'Sec-Fetch-Dest': 'empty',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-site',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
              'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
              'sec-ch-ua-mobile': '?0',
              'sec-ch-ua-platform': '"Windows"'
            },
            body: 'user_email=test%40example.com&password=password123&recaptcha_type=web_invisible&scenario=web_password_login',
            timeout: timeout,
            agent: proxyAgent
          });
          
          if (!response.ok && response.status !== 401 && response.status !== 403) {
            await logger.log(`Hulu响应失败: ${response.status}`);
            detectionResult.available = false;
            detectionResult.message = `检测失败 (HTTP ${response.status})`;
            break;
          }
          
          const responseText = await response.text();
          await logger.logResponse('Hulu API', 'https://auth.hulu.com/v4/web/password/authenticate', response, responseText);
          
          // 检查错误类型
          const errorName = responseText.match(/"name"\s*:\s*"([^"]+)"/);
          
          if (errorName && errorName[1] === 'LOGIN_FORBIDDEN') {
            // LOGIN_FORBIDDEN表示账号错误，但服务可用
            await logger.log('Hulu检测结果: 可用');
            detectionResult.available = true;
            detectionResult.fullSupport = true;
            detectionResult.message = '完全支持';
            detectionResult.region = 'US'; // Hulu主要在美国可用
          } else if (errorName && errorName[1] === 'GEO_BLOCKED') {
            // GEO_BLOCKED表示地区限制
            await logger.log('Hulu检测结果: 地区限制');
            detectionResult.available = false;
            detectionResult.message = '地区限制';
          } else {
            // 其他情况
            await logger.log(`Hulu检测结果: 未知错误 (${errorName ? errorName[1] : '未知'})`);
            detectionResult.available = false;
            detectionResult.message = '检测失败 (未知错误)';
          }
          break;
        }
        
        case 'AbemaTV':
        case 'Abema TV': {
          // AbemaTV检测逻辑 - 使用官方API检测，参考check.sh
          await logger.log('开始检测AbemaTV...');
          
          try {
            // 使用AbemaTV的API检测地区限制
            const response = await fetch('https://api.abema.io/v1/ip/check?device=android', {
              ...baseRequestOptions,
              headers: {
                ...baseRequestOptions.headers,
                'Accept-Language': 'ja-JP,ja',
                'Origin': 'https://abema.tv',
                'Referer': 'https://abema.tv/'
              }
            });
            
            if (!response.ok) {
              await logger.log(`AbemaTV API响应失败: ${response.status}`);
              detectionResult.available = false;
              detectionResult.message = '检测失败';
              break;
            }
            
            const json = await response.json();
            await logger.logResponse('AbemaTV API', 'https://api.abema.io/v1/ip/check?device=android', response, JSON.stringify(json));
            
            // 检查返回的国家代码
            if (json && json.isoCountryCode) {
              detectionResult.region = json.isoCountryCode.toUpperCase();
              await logger.log(`检测到AbemaTV区域: ${detectionResult.region}`);
              
              // 检查是否在日本
              if (detectionResult.region === 'JP') {
                await logger.log('AbemaTV检测结果: 完全支持');
                detectionResult.available = true;
                detectionResult.fullSupport = true;
                detectionResult.message = '完全支持';
              } else {
                await logger.log('AbemaTV检测结果: 仅限日本地区');
                detectionResult.available = false;
                detectionResult.message = '仅限日本地区';
              }
            } else {
              // 在新版API中，如果返回的isoCountryCode为空，通常意味着地区限制
              await logger.log('AbemaTV检测结果: 地区限制');
              detectionResult.available = false;
              detectionResult.message = '地区限制';
            }
          } catch (error) {
            await logger.error(`AbemaTV检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测出错';
          }
          break;
        }
        
        case 'myTVSuper':
        case 'MyTVSuper': {
          // myTVSuper检测逻辑 - 香港本地流媒体服务，参考check.sh
          await logger.log('开始检测myTVSuper...');
          
          try {
            // 使用myTVSuper的检测API
            const response = await fetch('https://www.mytvsuper.com/api/auth/getSession', {
              ...baseRequestOptions,
              headers: {
                ...baseRequestOptions.headers,
                'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': 'https://www.mytvsuper.com/'
              }
            });
            
            if (!response.ok) {
              await logger.log(`myTVSuper API响应失败: ${response.status}`);
              detectionResult.available = false;
              detectionResult.message = '检测失败';
              break;
            }
            
            const json = await response.json();
            await logger.logResponse('myTVSuper API', 'https://www.mytvsuper.com/api/auth/getSession', response, JSON.stringify(json));
            
            // 检查地区限制
            if (json && json.code === 0 && !json.region_denied) {
              // 访问不受限制
              await logger.log('myTVSuper检测结果: 完全支持');
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = '完全支持';
              detectionResult.region = 'HK'; // myTVSuper主要在香港可用
            } else if (json && json.region_denied) {
              // 明确的地区限制
              await logger.log('myTVSuper检测结果: 仅限香港地区');
              detectionResult.available = false;
              detectionResult.message = '仅限香港地区';
            } else {
              // 其他错误
              await logger.log('myTVSuper检测结果: 访问受限');
              detectionResult.available = false;
              detectionResult.message = '访问受限';
            }
          } catch (error) {
            await logger.error(`myTVSuper检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测出错';
          }
          break;
        }
        
        case 'Bilibili港澳台': {
          // Bilibili港澳台解锁检测，参考check.sh
          await logger.log('开始检测Bilibili港澳台...');
          
          try {
            // 使用和check.sh相同的API端点和参数
            const randsession = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            
            // 港澳台限定内容检测：使用与check.sh中相同的参数
            const hkmctwResponse = await fetch(`https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=183799&fourk=1&fnver=0&fnval=16&session=${randsession}&module=bangumi`, {
              ...baseRequestOptions,
              headers: {
                ...baseRequestOptions.headers,
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Referer': 'https://www.bilibili.com/',
                'Origin': 'https://www.bilibili.com'
              }
            });
            
            if (!hkmctwResponse.ok) {
              await logger.log(`Bilibili港澳台API响应失败: ${hkmctwResponse.status}`);
              detectionResult.available = false;
              detectionResult.message = '检测失败 (网络连接错误)';
              break;
            }
            
            const hkmctwJson = await hkmctwResponse.json();
            await logger.logResponse('Bilibili港澳台API', `https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&...`, hkmctwResponse, JSON.stringify(hkmctwJson));
            
            // 根据返回码判断港澳台解锁状态
            const hkmctwCode = hkmctwJson.code;
            await logger.log(`Bilibili港澳台API返回码: ${hkmctwCode}`);
            
            if (hkmctwCode === 0) {
              await logger.log('Bilibili港澳台检测结果: 已解锁');
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = '已解锁港澳台内容';
              detectionResult.region = '港澳台';
            } else if (hkmctwCode === -10403) {
              await logger.log('Bilibili港澳台检测结果: 未解锁');
              detectionResult.available = false;
              detectionResult.message = '未解锁港澳台内容';
            } else {
              await logger.log(`Bilibili港澳台检测结果: 检测失败 (错误码: ${hkmctwCode})`);
              detectionResult.available = false;
              detectionResult.message = `检测失败 (错误码: ${hkmctwCode})`;
            }
          } catch (error) {
            await logger.error(`Bilibili港澳台检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测出错: ' + error.message;
          }
          break;
        }
        
        case 'Bilibili台湾': {
          // 仅台湾限定内容解锁检测，参考check.sh
          await logger.log('开始检测Bilibili台湾...');
          
          try {
            // 使用和check.sh相同的API端点和参数
            const randsession = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            
            // 台湾限定内容检测：使用与check.sh中相同的参数
            const twResponse = await fetch(`https://api.bilibili.com/pgc/player/web/playurl?avid=50762638&cid=100279344&qn=0&type=&otype=json&ep_id=268176&fourk=1&fnver=0&fnval=16&session=${randsession}&module=bangumi`, {
              ...baseRequestOptions,
              headers: {
                ...baseRequestOptions.headers,
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Referer': 'https://www.bilibili.com/',
                'Origin': 'https://www.bilibili.com'
              }
            });
            
            if (!twResponse.ok) {
              await logger.log(`Bilibili台湾API响应失败: ${twResponse.status}`);
              detectionResult.available = false;
              detectionResult.message = '检测失败 (网络连接错误)';
              break;
            }
            
            const twJson = await twResponse.json();
            await logger.logResponse('Bilibili台湾API', `https://api.bilibili.com/pgc/player/web/playurl?avid=50762638&cid=100279344&qn=0&...`, twResponse, JSON.stringify(twJson));
            
            // 根据返回码判断台湾解锁状态
            const twCode = twJson.code;
            await logger.log(`Bilibili台湾API返回码: ${twCode}`);
            
            if (twCode === 0) {
              await logger.log('Bilibili台湾检测结果: 已解锁');
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = '已解锁台湾限定内容';
              detectionResult.region = '台湾';
            } else if (twCode === -10403) {
              await logger.log('Bilibili台湾检测结果: 未解锁');
              detectionResult.available = false;
              detectionResult.message = '未解锁台湾限定内容';
            } else {
              await logger.log(`Bilibili台湾检测结果: 检测失败 (错误码: ${twCode})`);
              detectionResult.available = false;
              detectionResult.message = `检测失败 (错误码: ${twCode})`;
            }
          } catch (error) {
            await logger.error(`Bilibili台湾检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测出错: ' + error.message;
          }
          break;
        }
        
        case 'Claude AI':
        case 'ClaudeAI': {
          // Claude AI可用性检测 - 进一步简化方法
          await logger.log('开始检测Claude AI...');
          
          try {
            // 使用更简单的方法：检查主页访问和重定向
            await logger.log('尝试使用代理检测Claude AI...');
            const homePageResponse = await fetch('https://claude.ai/', {
              ...baseRequestOptions,
              redirect: 'follow', // 允许重定向
              headers: {
                ...baseRequestOptions.headers,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                'Accept-Language': 'en-US,en;q=0.9',
                'Upgrade-Insecure-Requests': '1'
              }
            });
            
            await logger.log(`Claude AI代理检测响应状态码: ${homePageResponse.status}`);
            await logger.log(`Claude AI代理检测最终URL: ${homePageResponse.url}`);
            
            // 检查是否重定向到不可用区域页面
            const isRedirectedToUnavailable = homePageResponse.url.includes('anthropic.com/app-unavailable-in-region');
            const isAccessForbidden = homePageResponse.status === 403;
            
            // 如果通过代理访问被限制，尝试不使用代理直接访问
            if (isRedirectedToUnavailable || isAccessForbidden) {
              await logger.log('代理检测返回限制，尝试不使用代理直接检测...');
              
              try {
                // 动态导入node-fetch，不使用代理
                const { default: fetchDirect } = await import('node-fetch');
                
                // 不使用代理的请求选项
                const directRequestOptions = {
                  method: 'GET',
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                    'Upgrade-Insecure-Requests': '1'
                  },
                  timeout: timeout,
                  redirect: 'follow'
                };
                
                const directResponse = await fetchDirect('https://claude.ai/', directRequestOptions);
                
                await logger.log(`Claude AI直连检测响应状态码: ${directResponse.status}`);
                await logger.log(`Claude AI直连检测最终URL: ${directResponse.url}`);
                
                // 检查直接访问的结果
                const directIsRedirectedToUnavailable = directResponse.url.includes('anthropic.com/app-unavailable-in-region');
                
                if (directIsRedirectedToUnavailable) {
                  await logger.log('Claude AI检测结果: 地区限制（直连也被重定向到不可用区域页面）');
                  detectionResult.available = false;
                  detectionResult.message = '地区限制';
                } else if (directResponse.ok) {
                  const directHtml = await directResponse.text();
                  
                  // 额外检查页面内容是否存在明确的地区限制提示
                  const hasGeoRestriction = directHtml.includes('not available in your country') || 
                                         directHtml.includes('not available in your region') ||
                                         directHtml.includes('geoblocked') ||
                                         directHtml.includes('unavailable in your area');
                  
                  if (hasGeoRestriction) {
                    await logger.log('Claude AI检测结果: 地区限制（直连页面内容显示限制）');
                    detectionResult.available = false;
                    detectionResult.message = '地区限制';
                  } else {
                    await logger.log('Claude AI检测结果: 直连完全支持，但代理访问受限');
                    detectionResult.available = true;
                    detectionResult.fullSupport = true;
                    detectionResult.message = '直连可用，代理受限';
                  }
                } else {
                  await logger.log(`Claude AI检测结果: 直连和代理都不可用 (HTTP ${directResponse.status})`);
                  detectionResult.available = false;
                  detectionResult.message = '访问失败';
                }
              } catch (directError) {
                await logger.error(`Claude AI直连检测出错: ${directError.message}`);
                await logger.log('Claude AI检测结果: 代理和直连都无法访问');
                detectionResult.available = false;
                detectionResult.message = '不可访问';
              }
            } else if (homePageResponse.ok) {
              const homePageHtml = await homePageResponse.text();
              await logger.logResponse('Claude AI Home', 'https://claude.ai/', homePageResponse, homePageHtml);
              
              // 额外检查页面内容是否存在明确的地区限制提示
              const hasGeoRestriction = homePageHtml.includes('not available in your country') || 
                                     homePageHtml.includes('not available in your region') ||
                                     homePageHtml.includes('geoblocked') ||
                                     homePageHtml.includes('unavailable in your area');
              
              if (hasGeoRestriction) {
                await logger.log('Claude AI检测结果: 地区限制（页面提示）');
                detectionResult.available = false;
                detectionResult.message = '地区限制';
              } else {
                await logger.log('Claude AI检测结果: 完全支持');
                detectionResult.available = true;
                detectionResult.fullSupport = true;
                detectionResult.message = '完全支持';
                
                // 尝试获取区域信息，但不影响主要判断
                try {
                  const locationResponse = await fetch('https://claude.ai/api/location', {
                    ...baseRequestOptions,
                    headers: {
                      ...baseRequestOptions.headers,
                      'Accept': 'application/json',
                      'Referer': 'https://claude.ai/'
                    }
                  });
                  
                  if (locationResponse.ok) {
                    const locationData = await locationResponse.json();
                    if (locationData && locationData.country) {
                      detectionResult.region = locationData.country.toUpperCase();
                      await logger.log(`检测到Claude AI区域: ${detectionResult.region}`);
                    }
                  }
                } catch (locationError) {
                  await logger.error(`获取Claude AI区域信息失败: ${locationError.message}`);
                  // 区域API失败不影响主要检测结果
                }
              }
            } else {
              // 其他错误状态码，但不是403，之前已经单独处理了403
              await logger.log(`Claude AI检测结果: 访问失败 (HTTP ${homePageResponse.status})`);
              detectionResult.available = false;
              detectionResult.message = `访问失败 (HTTP ${homePageResponse.status})`;
            }
          } catch (error) {
            await logger.error(`Claude AI检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测出错: ' + error.message;
          }
          break;
        }
        
        case 'Meta AI': {
          // Meta AI可用性检测，参考check.sh
          await logger.log('开始检测Meta AI...');
          
          try {
            const response = await fetch('https://www.meta.ai/', {
              ...baseRequestOptions,
              headers: {
                ...baseRequestOptions.headers,
                'accept': '*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'accept-language': 'en-US,en;q=0.9',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1'
              }
            });
            
            if (!response.ok) {
              await logger.log(`Meta AI响应失败: ${response.status}`);
              detectionResult.available = false;
              detectionResult.message = `访问失败 (HTTP ${response.status})`;
              break;
            }
            
            const html = await response.text();
            await logger.logResponse('Meta AI', 'https://www.meta.ai/', response, html);
            
            // 检查是否被地区限制
            const isBlocked = html.includes('AbraGeoBlockedErrorRoot');
            // 检查是否可用
            const isOK = html.includes('AbraHomeRootConversationQuery');
            
            if (!isBlocked && !isOK) {
              await logger.log('Meta AI检测结果: 页面错误');
              detectionResult.available = false;
              detectionResult.message = '检测失败 (页面错误)';
            } else if (isBlocked) {
              await logger.log('Meta AI检测结果: 地区限制');
              detectionResult.available = false;
              detectionResult.message = '地区限制';
            } else if (isOK) {
              // 尝试提取地区信息
              const regionMatch = html.match(/"code"\s*:\s*"([^"]+)"/);
              if (regionMatch && regionMatch[1]) {
                const regionCode = regionMatch[1];
                const region = regionCode.split('_')[1]; // 通常格式为 XX_US 这样
                
                if (region) {
                  detectionResult.region = region.toUpperCase();
                  await logger.log(`检测到Meta AI区域: ${detectionResult.region}`);
                }
              }
              
              await logger.log('Meta AI检测结果: 可用');
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = '完全支持';
            } else {
              await logger.log('Meta AI检测结果: 未知错误');
              detectionResult.available = false;
              detectionResult.message = '检测失败 (未知错误)';
            }
          } catch (error) {
            await logger.error(`Meta AI检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测出错: ' + error.message;
          }
          break;
        }
        
        case 'Bing区域': {
          // Bing区域检测，参考check.sh
          await logger.log('开始检测Bing区域...');
          
          try {
            const response = await fetch('https://www.bing.com/search?q=curl', {
              ...baseRequestOptions,
              headers: {
                ...baseRequestOptions.headers,
                'accept-language': 'en-US,en;q=0.9',
                'upgrade-insecure-requests': '1'
              }
            });
            
            if (!response.ok) {
              await logger.log(`Bing响应失败: ${response.status}`);
              detectionResult.available = false;
              detectionResult.message = `访问失败 (HTTP ${response.status})`;
              break;
            }
            
            const html = await response.text();
            await logger.logResponse('Bing区域', 'https://www.bing.com/search?q=curl', response, html);
            
            // 检查是否被重定向到中国版
            const isCN = html.includes('cn.bing.com');
            if (isCN) {
              await logger.log('Bing区域检测结果: 中国大陆');
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = '中国大陆';
              detectionResult.region = 'CN';
              break;
            }
            
            // 检查是否为风险IP
            const isRisky = html.includes('sj_cook.set("SRCHHPGUSR","HV"');
            
            // 尝试提取区域信息
            const regionMatch = html.match(/Region\s*:\s*"([^"]+)"/);
            let region = regionMatch ? regionMatch[1] : '未知';
            
            if (isRisky) {
              await logger.log(`Bing区域检测结果: ${region} (风险IP)`);
              detectionResult.available = true;
              detectionResult.fullSupport = false;
              detectionResult.message = `${region} (风险IP)`;
              detectionResult.region = region;
            } else {
              await logger.log(`Bing区域检测结果: ${region}`);
              detectionResult.available = true;
              detectionResult.fullSupport = true;
              detectionResult.message = region;
              detectionResult.region = region;
            }
          } catch (error) {
            await logger.error(`Bing区域检测出错: ${error.message}`);
            detectionResult.available = false;
            detectionResult.message = '检测出错: ' + error.message;
          }
          break;
        }
        
        // 对于其他服务，维持简单检测
        default: {
          await logger.log(`开始检测 ${serviceName}...`);
          const response = await fetch(checkUrl || `https://www.${serviceName.toLowerCase().replace(/\s+/g, '')}.com`, baseRequestOptions);
          
          // 记录响应
          let html = '';
          try {
            html = await response.text();
            await logger.logResponse(serviceName, checkUrl || `https://www.${serviceName.toLowerCase().replace(/\s+/g, '')}.com`, response, html);
          } catch (error) {
            await logger.error(`无法读取响应内容: ${error.message}`);
          }
          
          if (!response.ok) {
            await logger.log(`${serviceName}响应失败: ${response.status}`);
            detectionResult.available = false;
            detectionResult.message = `无法访问 (HTTP ${response.status})`;
          } else if (html.includes('not available in your') || 
                    html.includes('unavailable in your') || 
                    html.includes('not available for your') || 
                    html.includes('geoblocked')) {
            // 通用的地区限制检测
            await logger.log(`${serviceName}检测结果: 地区限制`);
            detectionResult.available = false;
            detectionResult.message = '地区限制';
          } else {
            await logger.log(`${serviceName}检测结果: 可访问`);
            detectionResult.available = true;
            detectionResult.fullSupport = true;
            detectionResult.message = '可访问';
            
            // 尝试从URL中提取区域代码
            try {
              const regionMatch = response.url.match(/\/([a-z]{2})(?:\/|$)/i);
              if (regionMatch && regionMatch[1]) {
                detectionResult.region = regionMatch[1].toUpperCase();
                await logger.log(`检测到${serviceName}区域: ${detectionResult.region}`);
              }
            } catch (error) {
              await logger.error(`提取区域代码出错: ${error.message}`);
            }
          }
          break;
        }
      }
    } catch (error) {
      await logger.error(`检测 ${serviceName} 出错: ${error.message}`);
      detectionResult.available = false;
      detectionResult.message = '检测出错: ' + error.message;
    }
    
    // 计算检测耗时
    detectionResult.checkTime = Date.now() - startTime;
    
    await logger.log(`${serviceName} 检测完成: ${JSON.stringify(detectionResult)}`);
    return detectionResult;
  } catch (error) {
    await logger.error('媒体检测函数错误: ' + error.message);
    return {
      available: false,
      message: '内部错误: ' + error.message,
      checkTime: 0,
      logPath: logger.logFile
    };
  }
}

module.exports = {
  testMediaStreaming
}; 