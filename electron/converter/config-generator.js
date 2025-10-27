/**
 * 完整配置文件生成器
 * 对应安卓端的 ConfigGenerator.kt
 * 基于模板生成包含规则、策略组等完整配置
 */

const yaml = require('js-yaml');
const { ProxyProducers, OutputFormat } = require('./proxy-producer');

class ConfigGenerator {
  /**
   * 生成完整的 Clash 配置(使用模板)
   */
  static generateClashConfig(proxies, template, configName = null) {
    const actualConfigName = configName || template.name;
    const proxyNames = proxies.map(p => p.name);

    const config = {};

    // 基础配置
    const advancedConfig = template.advancedConfig;
    config.port = advancedConfig?.port || 7890;
    config['socks-port'] = advancedConfig?.socksPort || 7891;
    config['allow-lan'] = advancedConfig?.allowLan || false;
    config.mode = advancedConfig?.mode || 'rule';
    config['log-level'] = advancedConfig?.logLevel || 'info';
    config['external-controller'] = '127.0.0.1:9090';

    // DNS 配置
    const dnsConfig = template.dnsConfig;
    if (dnsConfig && dnsConfig.enable) {
      config.dns = {
        enable: true,
        listen: '0.0.0.0:53',
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        nameserver: dnsConfig.nameserver,
        fallback: dnsConfig.fallback
      };
    }

    // 代理节点
    const producer = ProxyProducers.getProducer(OutputFormat.CLASH);
    const proxiesYaml = producer.produce(proxies);
    const parsed = yaml.load(proxiesYaml);
    const proxiesList = parsed.proxies || [];
    config.proxies = proxiesList;

    // 策略组 - 使用模板配置
    config['proxy-groups'] = this.buildProxyGroups(template.proxyGroups, proxyNames);

    // 规则
    config.rules = template.rules;

    return yaml.dump(config, {
      indent: 2,
      lineWidth: -1,
      noRefs: true
    });
  }

  /**
   * 生成完整的 Clash Meta 配置(使用模板)
   */
  static generateClashMetaConfig(proxies, template, configName = null) {
    const actualConfigName = configName || template.name;
    const proxyNames = proxies.map(p => p.name);

    const config = {};

    // 基础配置
    const advancedConfig = template.advancedConfig;
    config.port = advancedConfig?.port || 7890;
    config['socks-port'] = advancedConfig?.socksPort || 7891;
    config['allow-lan'] = advancedConfig?.allowLan || false;
    config.mode = advancedConfig?.mode || 'rule';
    config['log-level'] = advancedConfig?.logLevel || 'info';
    config['external-controller'] = '127.0.0.1:9090';

    // DNS 配置
    const dnsConfig = template.dnsConfig;
    if (dnsConfig && dnsConfig.enable) {
      config.dns = {
        enable: true,
        listen: '0.0.0.0:53',
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        nameserver: dnsConfig.nameserver,
        fallback: dnsConfig.fallback
      };
    }

    // 代理节点
    const producer = ProxyProducers.getProducer(OutputFormat.CLASH_META);
    const proxiesYaml = producer.produce(proxies);
    const parsed = yaml.load(proxiesYaml);
    const proxiesList = parsed.proxies || [];
    config.proxies = proxiesList;

    // 策略组 - 使用模板配置,支持图标
    config['proxy-groups'] = this.buildProxyGroups(template.proxyGroups, proxyNames, true);

    // 规则
    config.rules = template.rules;

    return yaml.dump(config, {
      indent: 2,
      lineWidth: -1,
      noRefs: true
    });
  }

  /**
   * 构建代理组
   */
  static buildProxyGroups(templateGroups, allProxyNames, supportIcon = false) {
    const groups = [];

    for (const group of templateGroups) {
      const proxyGroup = {
        name: group.name,
        type: group.type
      };

      // 处理代理列表
      let proxies = [];
      if (group.proxies && group.proxies.length > 0) {
        for (const proxy of group.proxies) {
          if (proxy === 'ALL_PROXIES') {
            // 替换为所有代理节点
            proxies = proxies.concat(allProxyNames);
          } else {
            proxies.push(proxy);
          }
        }
      }

      // 如果有过滤器,应用过滤
      if (group.filter) {
        // 移除 (?i) 内联修饰符(JavaScript不支持)
        const filterPattern = group.filter.replace(/\(\?i\)/g, '');
        const regex = new RegExp(filterPattern, 'i');
        const filtered = allProxyNames.filter(name => regex.test(name));
        if (filtered.length > 0) {
          proxies = filtered;
        }
      }

      // 如果代理列表为空,使用所有代理
      if (proxies.length === 0) {
        proxies = allProxyNames;
      }

      proxyGroup.proxies = proxies;

      // url-test 和 fallback 需要 url 和 interval
      if (group.type === 'url-test' || group.type === 'fallback') {
        proxyGroup.url = group.url || 'http://www.gstatic.com/generate_204';
        proxyGroup.interval = group.interval || 300;
        if (group.tolerance) {
          proxyGroup.tolerance = group.tolerance;
        }
      }

      // load-balance 需要 url 和 interval
      if (group.type === 'load-balance') {
        proxyGroup.url = group.url || 'http://www.gstatic.com/generate_204';
        proxyGroup.interval = group.interval || 300;
        if (group.strategy) {
          proxyGroup.strategy = group.strategy;
        }
      }

      // Clash Meta 支持图标
      if (supportIcon && group.icon) {
        proxyGroup.icon = group.icon;
      }

      groups.push(proxyGroup);
    }

    return groups;
  }

  /**
   * 生成 Sing-box 配置(使用模板)
   */
  static generateSingboxConfig(proxies, template, configName = null) {
    const actualConfigName = configName || template.name;

    const config = {
      log: {
        level: 'info'
      },
      dns: {
        servers: [
          {
            tag: 'dns_proxy',
            address: '8.8.8.8',
            detour: 'proxy'
          },
          {
            tag: 'dns_direct',
            address: '223.5.5.5',
            detour: 'direct'
          }
        ],
        rules: [
          {
            geosite: 'cn',
            server: 'dns_direct'
          }
        ]
      },
      inbounds: [
        {
          type: 'mixed',
          tag: 'mixed-in',
          listen: '127.0.0.1',
          listen_port: 7890
        }
      ],
      outbounds: [],
      route: {
        rules: [],
        auto_detect_interface: true
      }
    };

    // 添加代理节点
    const producer = ProxyProducers.getProducer(OutputFormat.SING_BOX);
    const singboxJson = producer.produce(proxies);
    const parsed = JSON.parse(singboxJson);
    config.outbounds = parsed.outbounds || [];

    // 添加 direct 和 block outbound
    config.outbounds.push({
      type: 'direct',
      tag: 'direct'
    });
    config.outbounds.push({
      type: 'block',
      tag: 'block'
    });

    // 添加代理组作为 selector outbound
    const proxyTags = proxies.map(p => p.name);
    config.outbounds.unshift({
      type: 'selector',
      tag: 'proxy',
      outbounds: proxyTags.concat(['direct'])
    });

    // 添加路由规则
    config.route.rules = [
      {
        geosite: 'cn',
        outbound: 'direct'
      },
      {
        geoip: 'cn',
        outbound: 'direct'
      }
    ];

    config.route.final = 'proxy';

    return JSON.stringify(config, null, 2);
  }

  /**
   * 生成 Surge 配置(使用模板)
   */
  static generateSurgeConfig(proxies, template, configName = null) {
    const actualConfigName = configName || template.name;
    const lines = [];

    // [General] 部分
    lines.push('[General]');
    lines.push('loglevel = notify');
    lines.push('dns-server = 223.5.5.5, 119.29.29.29, 8.8.8.8');
    lines.push('skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local');
    lines.push('');

    // [Proxy] 部分
    lines.push('[Proxy]');
    const producer = ProxyProducers.getProducer(OutputFormat.SURGE);
    const surgeProxies = producer.produce(proxies);
    lines.push(surgeProxies);
    lines.push('');

    // [Proxy Group] 部分
    lines.push('[Proxy Group]');
    for (const group of template.proxyGroups) {
      const line = this.buildSurgeProxyGroup(group, proxies.map(p => p.name));
      if (line) {
        lines.push(line);
      }
    }
    lines.push('');

    // [Rule] 部分
    lines.push('[Rule]');
    for (const rule of template.rules) {
      lines.push(this.convertClashRuleToSurge(rule));
    }

    return lines.join('\n');
  }

  /**
   * 构建 Surge 策略组
   */
  static buildSurgeProxyGroup(group, allProxyNames) {
    const parts = [group.name];

    // 类型映射
    const surgeType = {
      'select': 'select',
      'url-test': 'url-test',
      'fallback': 'fallback',
      'load-balance': 'load-balance'
    }[group.type] || 'select';

    parts.push(surgeType);

    // 处理代理列表
    let proxies = [];
    if (group.proxies && group.proxies.length > 0) {
      for (const proxy of group.proxies) {
        if (proxy === 'ALL_PROXIES') {
          proxies = proxies.concat(allProxyNames);
        } else {
          proxies.push(proxy);
        }
      }
    }

    // 应用过滤器
    if (group.filter) {
      // 移除 (?i) 内联修饰符(JavaScript不支持)
      const filterPattern = group.filter.replace(/\(\?i\)/g, '');
      const regex = new RegExp(filterPattern, 'i');
      const filtered = allProxyNames.filter(name => regex.test(name));
      if (filtered.length > 0) {
        proxies = filtered;
      }
    }

    if (proxies.length === 0) {
      proxies = allProxyNames;
    }

    parts.push(...proxies);

    // 添加测试参数
    if (surgeType === 'url-test' || surgeType === 'fallback') {
      parts.push(`url=${group.url || 'http://www.gstatic.com/generate_204'}`);
      parts.push(`interval=${group.interval || 300}`);
    }

    return parts.join(', ');
  }

  /**
   * 将 Clash 规则转换为 Surge 规则
   */
  static convertClashRuleToSurge(clashRule) {
    return clashRule.replace('MATCH', 'FINAL');
  }

  /**
   * 生成 QuantumultX 配置(使用模板)
   */
  static generateQuantumultXConfig(proxies, template, configName = null) {
    const actualConfigName = configName || template.name;
    const lines = [];

    // [general] 部分
    lines.push('[general]');
    lines.push('server_check_url=http://www.gstatic.com/generate_204');
    lines.push('dns_exclusion_list=*.cmpassport.com, *.jegotrip.com.cn, *.icitymobile.mobi, id6.me');
    lines.push('geo_location_checker=http://ip-api.com/json/?lang=zh-CN, https://raw.githubusercontent.com/Orz-3/Orz-3/master/QuantumultX/IP.js');
    lines.push('resource_parser_url=https://raw.githubusercontent.com/KOP-XIAO/QuantumultX/master/Scripts/resource-parser.js');
    lines.push('');

    // [dns] 部分
    lines.push('[dns]');
    lines.push('server=223.5.5.5');
    lines.push('server=119.29.29.29');
    lines.push('server=8.8.8.8');
    lines.push('');

    // [policy] 部分
    lines.push('[policy]');
    for (const group of template.proxyGroups) {
      const line = this.buildQuantumultXPolicyGroup(group, proxies.map(p => p.name));
      if (line) {
        lines.push(line);
      }
    }
    lines.push('');

    // [server_local] 部分
    lines.push('[server_local]');
    const producer = ProxyProducers.getProducer(OutputFormat.QUANTUMULT_X);
    const qxProxies = producer.produce(proxies);
    lines.push(qxProxies);
    lines.push('');

    // [filter_local] 部分
    lines.push('[filter_local]');
    for (const rule of template.rules) {
      lines.push(this.convertClashRuleToQuantumultX(rule));
    }

    return lines.join('\n');
  }

  /**
   * 构建 QuantumultX 策略组
   */
  static buildQuantumultXPolicyGroup(group, allProxyNames) {
    const parts = [];

    // 类型映射
    const qxType = {
      'select': 'static',
      'url-test': 'url-latency-benchmark',
      'fallback': 'available',
      'load-balance': 'round-robin'
    }[group.type] || 'static';

    parts.push(qxType);
    parts.push(group.name);

    // 处理代理列表
    let proxies = [];
    if (group.proxies && group.proxies.length > 0) {
      for (const proxy of group.proxies) {
        if (proxy === 'ALL_PROXIES') {
          proxies = proxies.concat(allProxyNames);
        } else {
          proxies.push(proxy);
        }
      }
    }

    // 应用过滤器
    if (group.filter) {
      // 移除 (?i) 内联修饰符(JavaScript不支持)
      const filterPattern = group.filter.replace(/\(\?i\)/g, '');
      const regex = new RegExp(filterPattern, 'i');
      const filtered = allProxyNames.filter(name => regex.test(name));
      if (filtered.length > 0) {
        proxies = filtered;
      }
    }

    if (proxies.length === 0) {
      proxies = allProxyNames;
    }

    parts.push(...proxies);

    // 添加测试参数
    if (qxType === 'url-latency-benchmark' || qxType === 'available') {
      parts.push(`check-interval=${group.interval || 300}`);
      parts.push(`url=${group.url || 'http://www.gstatic.com/generate_204'}`);
    }

    return parts.join(', ');
  }

  /**
   * 将 Clash 规则转换为 QuantumultX 规则
   */
  static convertClashRuleToQuantumultX(clashRule) {
    // Clash: DOMAIN-SUFFIX,google.com,Proxy
    // QX: HOST-SUFFIX,google.com,Proxy

    return clashRule
      .replace('DOMAIN-SUFFIX', 'HOST-SUFFIX')
      .replace('DOMAIN-KEYWORD', 'HOST-KEYWORD')
      .replace('DOMAIN', 'HOST')
      .replace('MATCH', 'FINAL')
      .replace('GEOIP', 'GEOIP');
  }

  /**
   * 生成 Shadowrocket 配置(使用模板)
   */
  static generateShadowrocketConfig(proxies, template, configName = null) {
    const actualConfigName = configName || template.name;
    const lines = [];

    // [General] 部分
    lines.push('[General]');
    lines.push('bypass-system = true');
    lines.push('skip-proxy = 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local, captive.apple.com');
    lines.push('bypass-tun = 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 255.255.255.255/32');
    lines.push('dns-server = 223.5.5.5, 119.29.29.29, 8.8.8.8');
    lines.push('');

    // [Proxy] 部分
    lines.push('[Proxy]');
    const producer = ProxyProducers.getProducer(OutputFormat.SHADOWROCKET);
    const srProxies = producer.produce(proxies);
    lines.push(srProxies);
    lines.push('');

    // [Proxy Group] 部分
    lines.push('[Proxy Group]');
    for (const group of template.proxyGroups) {
      const line = this.buildShadowrocketProxyGroup(group, proxies.map(p => p.name));
      if (line) {
        lines.push(line);
      }
    }
    lines.push('');

    // [Rule] 部分
    lines.push('[Rule]');
    for (const rule of template.rules) {
      lines.push(this.convertClashRuleToShadowrocket(rule));
    }

    return lines.join('\n');
  }

  /**
   * 构建 Shadowrocket 策略组
   */
  static buildShadowrocketProxyGroup(group, allProxyNames) {
    const parts = [group.name];

    // 类型映射
    const srType = {
      'select': 'select',
      'url-test': 'url-test',
      'fallback': 'fallback',
      'load-balance': 'load-balance'
    }[group.type] || 'select';

    parts.push(srType);

    // 处理代理列表
    let proxies = [];
    if (group.proxies && group.proxies.length > 0) {
      for (const proxy of group.proxies) {
        if (proxy === 'ALL_PROXIES') {
          proxies = proxies.concat(allProxyNames);
        } else {
          proxies.push(proxy);
        }
      }
    }

    // 应用过滤器
    if (group.filter) {
      // 移除 (?i) 内联修饰符(JavaScript不支持)
      const filterPattern = group.filter.replace(/\(\?i\)/g, '');
      const regex = new RegExp(filterPattern, 'i');
      const filtered = allProxyNames.filter(name => regex.test(name));
      if (filtered.length > 0) {
        proxies = filtered;
      }
    }

    if (proxies.length === 0) {
      proxies = allProxyNames;
    }

    parts.push(...proxies);

    // 添加测试参数
    if (srType === 'url-test' || srType === 'fallback') {
      parts.push(`url=${group.url || 'http://www.gstatic.com/generate_204'}`);
      parts.push(`interval=${group.interval || 300}`);
    }

    return parts.join(', ');
  }

  /**
   * 将 Clash 规则转换为 Shadowrocket 规则
   */
  static convertClashRuleToShadowrocket(clashRule) {
    return clashRule.replace('MATCH', 'FINAL');
  }
}

module.exports = ConfigGenerator;

