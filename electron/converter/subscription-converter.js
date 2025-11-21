/**
 * 订阅转换器核心逻辑
 * 对应安卓端的 SubscriptionConverter.kt
 */

const { ProxyParsers } = require('./proxy-parser');
const { ProxyProducers } = require('./proxy-producer');
const { OutputFormat } = require('./proxy-models');
const SubscriptionPreprocessor = require('./subscription-preprocessor');
const { applyProcessors } = require('./processor-pipeline');
const yaml = require('js-yaml');

/**
 * 转换选项
 */
class ConversionOptions {
  constructor(options = {}) {
    this.enableUdp = options.enableUdp || false;
    this.enableTcpFastOpen = options.enableTcpFastOpen || false;
    this.skipCertificateVerify = options.skipCertificateVerify || false;
    this.autoAddEmoji = options.autoAddEmoji || false;
  }

  get isDefault() {
    return !this.enableUdp && 
           !this.enableTcpFastOpen && 
           !this.skipCertificateVerify && 
           !this.autoAddEmoji;
  }
}

/**
 * 转换结果
 */
class ConversionResult {
  constructor(success, output, inputProxyCount, outputProxyCount, errorMessage = null) {
    this.success = success;
    this.output = output;
    this.inputProxyCount = inputProxyCount;
    this.outputProxyCount = outputProxyCount;
    this.errorMessage = errorMessage;
  }
}

/**
 * 订阅转换器
 */
class SubscriptionConverter {
  constructor() {
    this.parser = new ProxyParsers();
  }

  /**
   * 转换订阅
   * @param {string} input - 输入内容（订阅链接内容、配置文件内容或分享链接）
   * @param {string} targetFormat - 目标格式
   * @param {string|null} filterRegex - 节点过滤正则表达式（可选）
   * @param {ConversionOptions} options - 转换选项
   * @param {string|null} templateId - 配置模板ID（可选）
   * @param {Array|null} processors - 可选的处理器流水线配置
   * @returns {ConversionResult}
   */
  convert(input, targetFormat, filterRegex = null, options = new ConversionOptions(), templateId = null, processors = null) {
    try {
      console.log(`[SubscriptionConverter] Starting conversion, input length: ${input.length}`);

      // 1. 解析输入内容
      const proxies = this.parseInput(input);

      if (proxies.length === 0) {
        return new ConversionResult(
          false,
          '',
          0,
          0,
          '未检测到有效的代理节点'
        );
      }

      console.log(`[SubscriptionConverter] Parsed ${proxies.length} proxies`);

      // 2. 过滤节点
      let filteredProxies = proxies;
      if (filterRegex) {
        try {
          const regex = new RegExp(filterRegex);
          filteredProxies = proxies.filter(proxy => regex.test(proxy.name));
          console.log(`[SubscriptionConverter] After filtering: ${filteredProxies.length} proxies`);
        } catch (e) {
          console.error('[SubscriptionConverter] Invalid regex:', e.message);
          return new ConversionResult(
            false,
            '',
            proxies.length,
            0,
            `无效的正则表达式: ${e.message}`
          );
        }
      }

      if (filteredProxies.length === 0) {
        return new ConversionResult(
          false,
          '',
          proxies.length,
          0,
          '过滤后没有剩余节点'
        );
      }

      // 3. 应用处理流水线（processors）
      let processedProxies = filteredProxies;
      if (Array.isArray(processors) && processors.length > 0) {
        processedProxies = applyProcessors(filteredProxies, processors);
        console.log(`[SubscriptionConverter] After processors: ${processedProxies.length} proxies`);
        if (processedProxies.length === 0) {
          return new ConversionResult(
            false,
            '',
            proxies.length,
            0,
            '处理流水线执行后没有剩余节点'
          );
        }
      }

      // 4. 应用转换选项
      processedProxies = this.applyOptions(processedProxies, options);
      console.log(`[SubscriptionConverter] After applying options: ${processedProxies.length} proxies`);

      // 5. 生成目标格式
      let output;
      if (templateId && (targetFormat === OutputFormat.CLASH || targetFormat === OutputFormat.CLASH_META)) {
        // 使用模板生成配置
        const templateManager = require('./template-manager');
        const template = templateManager.getTemplateById(templateId);
        if (template) {
          const ConfigGenerator = require('./config-generator');
          output = ConfigGenerator.generateClashConfig(processedProxies, template);
          console.log(`[SubscriptionConverter] Generated config with template: ${template.name}`);
        } else {
          console.warn(`[SubscriptionConverter] Template not found: ${templateId}, using default producer`);
          const producer = ProxyProducers.getProducer(targetFormat);
          output = producer.produce(processedProxies);
        }
      } else {
        // 不使用模板,直接生成
        const producer = ProxyProducers.getProducer(targetFormat);
        output = producer.produce(processedProxies);
      }

      console.log(`[SubscriptionConverter] Conversion successful, output length: ${output.length}`);

      return new ConversionResult(
        true,
        output,
        proxies.length,
        processedProxies.length
      );
    } catch (error) {
      console.error('[SubscriptionConverter] Conversion failed:', error);
      return new ConversionResult(
        false,
        '',
        0,
        0,
        error.message
      );
    }
  }

  /**
   * 解析输入内容
   * 支持多种格式：
   * 1. Base64 编码的分享链接列表
   * 2. 原始分享链接列表（每行一个）
   * 3. Clash YAML 配置
   * 4. Sing-box JSON 配置
   * 5. JSON 行格式（预处理器输出）
   */
  parseInput(input) {
    console.log(
      '[SubscriptionConverter] parseInput() 收到原始输入长度:',
      input?.length ?? 0
    );
    console.log(
      '[SubscriptionConverter] parseInput() 原始输入预览:',
      typeof input === 'string' ? input.substring(0, 200) : ''
    );

    // 预处理输入(包括Base64解码、格式转换)
    const preprocessed = SubscriptionPreprocessor.preprocess(input);

    console.log(
      '[SubscriptionConverter] parseInput() 预处理结果长度:',
      preprocessed?.length ?? 0
    );
    console.log(
      '[SubscriptionConverter] parseInput() 预处理结果预览:',
      typeof preprocessed === 'string' ? preprocessed.substring(0, 200) : ''
    );

    if (!preprocessed) {
      console.warn('[SubscriptionConverter] parseInput() 预处理结果为空，返回空代理列表');
      return [];
    }

    // 分享链接列表或JSON行（每行一个）
    // 预处理器已经将Clash/Sing-box配置转换为JSON行格式
    // 直接按行解析
    const proxies = preprocessed
      .split('\n')
      .map(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return null;
        return this.parser.parseLine(trimmedLine);
      })
      .filter(proxy => proxy !== null);

    console.log('[SubscriptionConverter] parseInput() 最终解析到代理数量:', proxies.length);
    return proxies;
  }

  /**
   * 解析 Clash 配置
   */
  parseClashConfig(content) {
    try {
      const config = yaml.load(content);
      
      if (!config || !config.proxies || !Array.isArray(config.proxies)) {
        return [];
      }

      const proxies = [];
      for (const proxyConfig of config.proxies) {
        const yamlStr = yaml.dump(proxyConfig);
        const proxy = this.parser.parseLine(yamlStr);
        if (proxy) {
          proxies.push(proxy);
        }
      }

      return proxies;
    } catch (e) {
      console.error('[SubscriptionConverter] Failed to parse Clash config:', e.message);
      return [];
    }
  }

  /**
   * 应用转换选项
   */
  applyOptions(proxies, options) {
    if (proxies.length === 0 || options.isDefault) {
      return proxies;
    }

    return proxies.map(proxy => {
      let current = proxy;
      
      if (options.enableUdp) {
        current = this.enableUdp(current);
      }
      
      if (options.enableTcpFastOpen) {
        current = this.enableTcpFastOpen(current);
      }
      
      if (options.skipCertificateVerify) {
        current = this.enableSkipCert(current);
      }
      
      if (options.autoAddEmoji) {
        current = this.enrichWithEmoji(current);
      }
      
      return current;
    });
  }

  /**
   * 启用 UDP
   */
  enableUdp(proxy) {
    if (proxy.udp !== undefined) {
      proxy.udp = true;
    }
    return proxy;
  }

  /**
   * 启用 TCP Fast Open
   */
  enableTcpFastOpen(proxy) {
    // TCP Fast Open 通常在配置文件的全局设置中
    // 这里暂时不做处理
    return proxy;
  }

  /**
   * 跳过证书验证
   */
  enableSkipCert(proxy) {
    if (proxy.skipCertVerify !== undefined) {
      proxy.skipCertVerify = true;
    }
    return proxy;
  }

  /**
   * 自动添加 Emoji
   */
  enrichWithEmoji(proxy) {
    const name = proxy.name;
    
    // 国家/地区 Emoji 映射
    const emojiMap = {
      '香港': '🇭🇰', 'HK': '🇭🇰', 'Hong Kong': '🇭🇰',
      '台湾': '🇹🇼', 'TW': '🇹🇼', 'Taiwan': '🇹🇼',
      '日本': '🇯🇵', 'JP': '🇯🇵', 'Japan': '🇯🇵',
      '韩国': '🇰🇷', 'KR': '🇰🇷', 'Korea': '🇰🇷',
      '新加坡': '🇸🇬', 'SG': '🇸🇬', 'Singapore': '🇸🇬',
      '美国': '🇺🇸', 'US': '🇺🇸', 'United States': '🇺🇸',
      '英国': '🇬🇧', 'UK': '🇬🇧', 'United Kingdom': '🇬🇧',
      '德国': '🇩🇪', 'DE': '🇩🇪', 'Germany': '🇩🇪',
      '法国': '🇫🇷', 'FR': '🇫🇷', 'France': '🇫🇷',
      '加拿大': '🇨🇦', 'CA': '🇨🇦', 'Canada': '🇨🇦',
      '澳大利亚': '🇦🇺', 'AU': '🇦🇺', 'Australia': '🇦🇺',
      '俄罗斯': '🇷🇺', 'RU': '🇷🇺', 'Russia': '🇷🇺',
      '印度': '🇮🇳', 'IN': '🇮🇳', 'India': '🇮🇳',
      '荷兰': '🇳🇱', 'NL': '🇳🇱', 'Netherlands': '🇳🇱',
      '土耳其': '🇹🇷', 'TR': '🇹🇷', 'Turkey': '🇹🇷',
      '阿根廷': '🇦🇷', 'AR': '🇦🇷', 'Argentina': '🇦🇷',
      '巴西': '🇧🇷', 'BR': '🇧🇷', 'Brazil': '🇧🇷'
    };

    // 检查名称中是否已经包含 Emoji
    const hasEmoji = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u.test(name);
    
    if (!hasEmoji) {
      // 尝试匹配国家/地区
      for (const [keyword, emoji] of Object.entries(emojiMap)) {
        if (name.includes(keyword)) {
          proxy.name = `${emoji} ${name}`;
          break;
        }
      }
    }

    return proxy;
  }
}

module.exports = {
  SubscriptionConverter,
  ConversionOptions,
  ConversionResult
};

