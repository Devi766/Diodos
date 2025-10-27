/**
 * 模板管理器
 * 对应安卓端的 TemplateManager.kt
 */

const { ConfigTemplate, ProxyGroup, DnsConfig, AdvancedConfig, TemplateCategory } = require('./config-template');

class TemplateManager {
  constructor() {
    this.templates = [];
    this.initBuiltinTemplates();
  }

  /**
   * 获取所有模板
   */
  getAllTemplates() {
    return [...this.templates];
  }

  /**
   * 根据ID获取模板
   */
  getTemplateById(id) {
    return this.templates.find(t => t.id === id);
  }

  /**
   * 根据分类获取模板
   */
  getTemplatesByCategory(category) {
    return this.templates.filter(t => t.category === category);
  }

  /**
   * 添加自定义模板
   */
  addCustomTemplate(template) {
    this.templates = this.templates.filter(t => t.id !== template.id);
    this.templates.push(template);
  }

  /**
   * 删除模板
   */
  removeTemplate(id) {
    this.templates = this.templates.filter(t => t.id !== id);
  }

  /**
   * 初始化内置模板
   */
  initBuiltinTemplates() {
    this.templates = [];
    
    // 1. 基础模板
    this.templates.push(this.createBasicTemplate());
    
    // 2. 流媒体优化模板
    this.templates.push(this.createStreamingTemplate());
    
    // 3. 均衡配置模板
    this.templates.push(this.createBalancedTemplate());
    
    // 4. 全局代理模板
    this.templates.push(this.createGlobalProxyTemplate());
    
    // 5. 自动选择模板
    this.templates.push(this.createAutoSelectTemplate());
    
    // 6. 中国优化模板
    this.templates.push(this.createChinaOptimizedTemplate());
    
    // 7. 全球加速模板
    this.templates.push(this.createGlobalAccelerateTemplate());
    
    // 8. 完整策略模板
    this.templates.push(this.createComprehensiveTemplate());
    
    // 9. OpenAI 专用模板
    this.templates.push(this.createOpenAITemplate());
    
    // 10. 分流精细模板
    this.templates.push(this.createDetailedRoutingTemplate());
    
    // 11. 极简模板
    this.templates.push(this.createMinimalTemplate());
    
    // 12. Clash Meta 完整模板
    this.templates.push(this.createClashMetaFullTemplate());
    
    // 13. Clash Meta 精简模板
    this.templates.push(this.createClashMetaLiteTemplate());
    
    // 14. Clash Meta 图标模板
    this.templates.push(this.createClashMetaIconTemplate());
  }

  /**
   * 基础模板 - 简单实用
   */
  createBasicTemplate() {
    return new ConfigTemplate({
      id: 'basic',
      name: '基础模板',
      description: '简单实用的基础配置',
      category: TemplateCategory.BASIC,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', 'DIRECT', 'ALL_PROXIES']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'IP-CIDR,17.0.0.0/8,DIRECT',
        'IP-CIDR,100.64.0.0/10,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({
        enable: true,
        ipv6: false,
        nameserver: ['223.5.5.5', '119.29.29.29'],
        fallback: ['8.8.8.8', '1.1.1.1']
      }),
      advancedConfig: new AdvancedConfig({
        port: 7890,
        socksPort: 7891,
        allowLan: false,
        mode: 'rule',
        logLevel: 'info'
      })
    });
  }

  /**
   * 流媒体优化模板
   */
  createStreamingTemplate() {
    return new ConfigTemplate({
      id: 'streaming',
      name: '流媒体优化',
      description: '针对流媒体服务优化的配置',
      category: TemplateCategory.STREAMING,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', '香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点', 'DIRECT']
        }),
        new ProxyGroup({
          name: '🎬 流媒体',
          type: 'select',
          proxies: ['香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点']
        }),
        new ProxyGroup({
          name: '📺 Netflix',
          type: 'select',
          proxies: ['香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点']
        }),
        new ProxyGroup({
          name: '🎵 Spotify',
          type: 'select',
          proxies: ['香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点', 'DIRECT']
        }),
        new ProxyGroup({
          name: '📹 YouTube',
          type: 'select',
          proxies: ['香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '香港节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)港|hk|hongkong|hong kong',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '台湾节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)台|tw|taiwan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '日本节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '新加坡节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新|sg|singapore',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '美国节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        // Netflix
        'DOMAIN-SUFFIX,netflix.com,📺 Netflix',
        'DOMAIN-SUFFIX,netflix.net,📺 Netflix',
        'DOMAIN-SUFFIX,nflxext.com,📺 Netflix',
        'DOMAIN-SUFFIX,nflximg.com,📺 Netflix',
        'DOMAIN-SUFFIX,nflxso.net,📺 Netflix',
        'DOMAIN-SUFFIX,nflxvideo.net,📺 Netflix',
        // Spotify
        'DOMAIN-SUFFIX,spotify.com,🎵 Spotify',
        'DOMAIN-SUFFIX,scdn.co,🎵 Spotify',
        'DOMAIN-SUFFIX,spoti.fi,🎵 Spotify',
        // YouTube
        'DOMAIN-SUFFIX,youtube.com,📹 YouTube',
        'DOMAIN-SUFFIX,googlevideo.com,📹 YouTube',
        'DOMAIN-SUFFIX,ytimg.com,📹 YouTube',
        // 其他流媒体
        'DOMAIN-SUFFIX,hulu.com,🎬 流媒体',
        'DOMAIN-SUFFIX,disneyplus.com,🎬 流媒体',
        'DOMAIN-SUFFIX,hbo.com,🎬 流媒体',
        'DOMAIN-SUFFIX,primevideo.com,🎬 流媒体',
        // 本地网络
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({
        enable: true,
        ipv6: false,
        nameserver: ['223.5.5.5', '119.29.29.29'],
        fallback: ['8.8.8.8', '1.1.1.1']
      }),
      advancedConfig: new AdvancedConfig({
        port: 7890,
        socksPort: 7891,
        allowLan: false,
        mode: 'rule',
        logLevel: 'info'
      })
    });
  }

  /**
   * 均衡配置模板
   */
  createBalancedTemplate() {
    return new ConfigTemplate({
      id: 'balanced',
      name: '均衡配置',
      description: '平衡速度与稳定性',
      category: TemplateCategory.BALANCED,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', '负载均衡', 'DIRECT', 'ALL_PROXIES']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50
        }),
        new ProxyGroup({
          name: '负载均衡',
          type: 'load-balance',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * 全局代理模板
   */
  createGlobalProxyTemplate() {
    return new ConfigTemplate({
      id: 'global_proxy',
      name: '全局代理',
      description: '所有流量通过代理',
      category: TemplateCategory.BASIC,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', 'ALL_PROXIES']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * 自动选择模板
   */
  createAutoSelectTemplate() {
    return new ConfigTemplate({
      id: 'auto_select',
      name: '自动选择',
      description: '自动选择最快节点',
      category: TemplateCategory.SPEED,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 自动选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * 中国优化模板
   */
  createChinaOptimizedTemplate() {
    return new ConfigTemplate({
      id: 'china_optimized',
      name: '中国优化',
      description: '针对中国大陆优化',
      category: TemplateCategory.BALANCED,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', '香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点', 'DIRECT']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '香港节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)港|hk|hongkong|hong kong',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '台湾节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)台|tw|taiwan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '日本节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '新加坡节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新|sg|singapore',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '美国节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,cn,DIRECT',
        'DOMAIN-KEYWORD,-cn,DIRECT',
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * 全球加速模板
   */
  createGlobalAccelerateTemplate() {
    return new ConfigTemplate({
      id: 'global_accelerate',
      name: '全球加速',
      description: '全球流量加速，多地区节点智能选择',
      category: TemplateCategory.SPEED,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 全球加速',
          type: 'select',
          proxies: ['⚡ 负载均衡', '自动选择', '🇭🇰 香港', '🇨🇳 台湾', '🇯🇵 日本', '🇸🇬 新加坡', '🇺🇲 美国', 'DIRECT']
        }),
        new ProxyGroup({
          name: '⚡ 负载均衡',
          type: 'load-balance',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50
        }),
        new ProxyGroup({
          name: '🇭🇰 香港',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)港|hk|hongkong|hong kong|🇭🇰',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🇨🇳 台湾',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)台|tw|taiwan|🇹🇼',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🇯🇵 日本',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan|🇯🇵',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🇸🇬 新加坡',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新加坡|sg|singapore|🇸🇬',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🇺🇲 美国',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states|🇺🇸',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'MATCH,🚀 全球加速'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * 完整策略模板
   */
  createComprehensiveTemplate() {
    return new ConfigTemplate({
      id: 'comprehensive',
      name: '完整策略',
      description: '包含所有常用服务的完整分流策略',
      category: TemplateCategory.BALANCED,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', '香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点', 'DIRECT']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50
        }),
        new ProxyGroup({
          name: '🤖 AI 服务',
          type: 'select',
          proxies: ['美国节点', '日本节点', '新加坡节点', '🚀 节点选择']
        }),
        new ProxyGroup({
          name: '📲 Telegram',
          type: 'select',
          proxies: ['🚀 节点选择', '香港节点', '新加坡节点']
        }),
        new ProxyGroup({
          name: '🎬 流媒体',
          type: 'select',
          proxies: ['🚀 节点选择', '香港节点', '台湾节点', '日本节点', '美国节点']
        }),
        new ProxyGroup({
          name: '🎮 游戏平台',
          type: 'select',
          proxies: ['DIRECT', '🚀 节点选择', '香港节点', '日本节点']
        }),
        new ProxyGroup({
          name: '🍎 Apple',
          type: 'select',
          proxies: ['DIRECT', '🚀 节点选择', '美国节点']
        }),
        new ProxyGroup({
          name: 'Ⓜ️ Microsoft',
          type: 'select',
          proxies: ['DIRECT', '🚀 节点选择']
        }),
        new ProxyGroup({
          name: '香港节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)港|hk|hongkong|hong kong',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '台湾节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)台|tw|taiwan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '日本节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '新加坡节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新|sg|singapore',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '美国节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        // AI服务
        'DOMAIN-SUFFIX,openai.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,chatgpt.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,anthropic.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,claude.ai,🤖 AI 服务',
        // Telegram
        'DOMAIN-SUFFIX,t.me,📲 Telegram',
        'DOMAIN-SUFFIX,telegram.org,📲 Telegram',
        // 流媒体
        'DOMAIN-SUFFIX,netflix.com,🎬 流媒体',
        'DOMAIN-SUFFIX,youtube.com,🎬 流媒体',
        'DOMAIN-SUFFIX,disney.com,🎬 流媒体',
        // Apple
        'DOMAIN-SUFFIX,apple.com,🍎 Apple',
        'DOMAIN-SUFFIX,icloud.com,🍎 Apple',
        // Microsoft
        'DOMAIN-SUFFIX,microsoft.com,Ⓜ️ Microsoft',
        'DOMAIN-SUFFIX,windows.com,Ⓜ️ Microsoft',
        // 本地网络
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * OpenAI 专用模板
   */
  createOpenAITemplate() {
    return new ConfigTemplate({
      id: 'openai',
      name: 'OpenAI 专用',
      description: '专为访问 ChatGPT、Claude 等 AI 服务优化',
      category: TemplateCategory.CUSTOM,
      proxyGroups: [
        new ProxyGroup({
          name: '🤖 AI 服务',
          type: 'select',
          proxies: ['美国节点', '日本节点', '新加坡节点', '自动选择']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50
        }),
        new ProxyGroup({
          name: '美国节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states|🇺🇸',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '日本节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan|🇯🇵',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '新加坡节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新|sg|singapore|🇸🇬',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🚀 其他代理',
          type: 'select',
          proxies: ['自动选择', 'DIRECT']
        })
      ],
      rules: [
        // OpenAI
        'DOMAIN-SUFFIX,openai.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,chatgpt.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,oaistatic.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,oaiusercontent.com,🤖 AI 服务',
        'DOMAIN-KEYWORD,openai,🤖 AI 服务',
        // Claude
        'DOMAIN-SUFFIX,anthropic.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,claude.ai,🤖 AI 服务',
        // Google AI
        'DOMAIN-SUFFIX,gemini.google.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,bard.google.com,🤖 AI 服务',
        // Perplexity
        'DOMAIN-SUFFIX,perplexity.ai,🤖 AI 服务',
        // Midjourney
        'DOMAIN-SUFFIX,midjourney.com,🤖 AI 服务',
        // 本地网络
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 其他代理'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * 分流精细模板
   */
  createDetailedRoutingTemplate() {
    return new ConfigTemplate({
      id: 'detailed_routing',
      name: '分流精细',
      description: '精细化流量分类，针对不同服务使用最优节点',
      category: TemplateCategory.BALANCED,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 默认策略',
          type: 'select',
          proxies: ['自动选择', 'DIRECT']
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🎥 Netflix',
          type: 'select',
          proxies: ['🇭🇰 香港', '🇸🇬 新加坡', '🇯🇵 日本', '🇺🇲 美国']
        }),
        new ProxyGroup({
          name: '📺 Disney+',
          type: 'select',
          proxies: ['🇭🇰 香港', '🇸🇬 新加坡', '🇯🇵 日本', '🇺🇲 美国']
        }),
        new ProxyGroup({
          name: '📹 YouTube',
          type: 'select',
          proxies: ['🇭🇰 香港', '🇸🇬 新加坡', '🇯🇵 日本', '🇺🇲 美国']
        }),
        new ProxyGroup({
          name: '🎵 Spotify',
          type: 'select',
          proxies: ['🇭🇰 香港', '🇸🇬 新加坡', '🇯🇵 日本', '🇺🇲 美国', 'DIRECT']
        }),
        new ProxyGroup({
          name: '🇭🇰 香港',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)港|hk|hongkong|hong kong',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🇸🇬 新加坡',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新|sg|singapore',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🇯🇵 日本',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        }),
        new ProxyGroup({
          name: '🇺🇲 美国',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,netflix.com,🎥 Netflix',
        'DOMAIN-SUFFIX,disneyplus.com,📺 Disney+',
        'DOMAIN-SUFFIX,youtube.com,📹 YouTube',
        'DOMAIN-SUFFIX,spotify.com,🎵 Spotify',
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 默认策略'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * 极简模板
   */
  createMinimalTemplate() {
    return new ConfigTemplate({
      id: 'minimal',
      name: '极简模板',
      description: '最简单的配置，只有基本功能',
      category: TemplateCategory.BASIC,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 代理',
          type: 'select',
          proxies: ['ALL_PROXIES', 'DIRECT']
        })
      ],
      rules: [
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 代理'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * Clash Meta 完整模板
   */
  createClashMetaFullTemplate() {
    return new ConfigTemplate({
      id: 'clash_meta_full',
      name: 'Clash Meta 完整',
      description: 'Clash Meta 完整功能模板，包含所有高级特性',
      category: TemplateCategory.BALANCED,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', '香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点', 'DIRECT'],
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Rocket.png'
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Auto.png'
        }),
        new ProxyGroup({
          name: '🎬 流媒体',
          type: 'select',
          proxies: ['香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点'],
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Netflix.png'
        }),
        new ProxyGroup({
          name: '🤖 AI 服务',
          type: 'select',
          proxies: ['美国节点', '日本节点', '新加坡节点'],
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Bot.png'
        }),
        new ProxyGroup({
          name: '香港节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)港|hk|hongkong|hong kong',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Hong_Kong.png'
        }),
        new ProxyGroup({
          name: '台湾节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)台|tw|taiwan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Taiwan.png'
        }),
        new ProxyGroup({
          name: '日本节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Japan.png'
        }),
        new ProxyGroup({
          name: '新加坡节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新|sg|singapore',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Singapore.png'
        }),
        new ProxyGroup({
          name: '美国节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/United_States.png'
        })
      ],
      rules: [
        // AI服务
        'DOMAIN-SUFFIX,openai.com,🤖 AI 服务',
        'DOMAIN-SUFFIX,anthropic.com,🤖 AI 服务',
        // 流媒体
        'DOMAIN-SUFFIX,netflix.com,🎬 流媒体',
        'DOMAIN-SUFFIX,youtube.com,🎬 流媒体',
        // 本地网络
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * Clash Meta 精简模板
   */
  createClashMetaLiteTemplate() {
    return new ConfigTemplate({
      id: 'clash_meta_lite',
      name: 'Clash Meta 精简',
      description: '轻量级 Clash Meta 模板，提供常用分流与图标',
      category: TemplateCategory.STREAMING,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', '香港节点', '台湾节点', '日本节点', '新加坡节点', '美国节点', 'DIRECT'],
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Rocket.png'
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          tolerance: 50,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Auto.png'
        }),
        new ProxyGroup({
          name: '香港节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)港|hk|hongkong|hong kong',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Hong_Kong.png'
        }),
        new ProxyGroup({
          name: '台湾节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)台|tw|taiwan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Taiwan.png'
        }),
        new ProxyGroup({
          name: '日本节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)日本|jp|japan',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Japan.png'
        }),
        new ProxyGroup({
          name: '新加坡节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)新|sg|singapore',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Singapore.png'
        }),
        new ProxyGroup({
          name: '美国节点',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          filter: '(?i)美|us|unitedstates|united states',
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/United_States.png'
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }

  /**
   * Clash Meta 图标模板
   */
  createClashMetaIconTemplate() {
    return new ConfigTemplate({
      id: 'clash_meta_icon',
      name: 'Clash Meta 图标',
      description: 'Clash Meta 图标模板，所有策略组都带图标',
      category: TemplateCategory.BASIC,
      proxyGroups: [
        new ProxyGroup({
          name: '🚀 节点选择',
          type: 'select',
          proxies: ['自动选择', 'DIRECT', 'ALL_PROXIES'],
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Rocket.png'
        }),
        new ProxyGroup({
          name: '自动选择',
          type: 'url-test',
          proxies: ['ALL_PROXIES'],
          url: 'http://www.gstatic.com/generate_204',
          interval: 300,
          icon: 'https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Auto.png'
        })
      ],
      rules: [
        'DOMAIN-SUFFIX,local,DIRECT',
        'IP-CIDR,127.0.0.0/8,DIRECT',
        'IP-CIDR,172.16.0.0/12,DIRECT',
        'IP-CIDR,192.168.0.0/16,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT',
        'GEOIP,CN,DIRECT',
        'MATCH,🚀 节点选择'
      ],
      dnsConfig: new DnsConfig({}),
      advancedConfig: new AdvancedConfig({})
    });
  }
}

// 导出单例
module.exports = new TemplateManager();

