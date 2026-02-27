import type { ToolDefinition } from './ai-api-client';

export interface ToolResult {
  success: boolean;
  content: string;
  data?: any;
}

// Tool definitions for the AI assistant
export const aiToolDefinitions: ToolDefinition[] = [
  {
    name: 'control_service',
    description: '控制代理服务：启动、停止、重启或查询运行状态',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'status'], description: '要执行的操作' },
      },
      required: ['action'],
    },
  },
  {
    name: 'switch_mode',
    description: '切换代理模式：规则模式、全局模式、直连模式',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['rule', 'global', 'direct'], description: '代理模式' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'switch_proxy',
    description: '在指定代理组中切换到指定的代理节点',
    parameters: {
      type: 'object',
      properties: {
        group_name: { type: 'string', description: '代理组名称' },
        proxy_name: { type: 'string', description: '要切换到的代理节点名称' },
      },
      required: ['group_name', 'proxy_name'],
    },
  },
  {
    name: 'health_check',
    description: '测试代理节点或整个代理组的延迟',
    parameters: {
      type: 'object',
      properties: {
        group_name: { type: 'string', description: '代理组名称，不填则测试所有组' },
        proxy_name: { type: 'string', description: '指定节点名称，填写后只测试该节点' },
      },
    },
  },
  {
    name: 'query_proxies',
    description: '查询代理组和节点信息',
    parameters: {
      type: 'object',
      properties: {
        group_name: { type: 'string', description: '指定组名，不填则返回所有组概览' },
        include_nodes: { type: 'boolean', description: '是否包含节点详情（延迟等），默认 false' },
      },
    },
  },
  {
    name: 'query_connections',
    description: '查询当前活跃连接',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回的连接数，默认 20' },
      },
    },
  },
  {
    name: 'query_traffic',
    description: '查询流量统计，包括实时速度和累计流量',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['now', 'total', 'all'], description: '查询类型：now（实时速度）、total（累计流量）、all（全部），默认 all' },
      },
    },
  },
  {
    name: 'query_settings',
    description: '查询当前应用设置',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['service', 'ui', 'all'], description: '设置分类：service（服务相关）、ui（界面相关）、all（全部），默认 all' },
      },
    },
  },
  {
    name: 'manage_profiles',
    description: '管理配置订阅：列表、激活、更新、删除',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'activate', 'update', 'delete'],
          description: '要执行的操作',
        },
        profile_name: { type: 'string', description: '配置名称（用于 activate/update/delete）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'modify_settings',
    description: '修改应用设置（键值对方式）',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '设置项名称' },
        value: { type: 'string', description: '设置值。布尔值用 true/false，数字直接填写' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'read_config',
    description: '读取当前配置文件的 YAML 内容，支持按段落读取和分页',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'proxies', 'proxy-groups', 'rules', 'dns'],
          description: '要读取的段落：all（全部，默认）、proxies、proxy-groups、rules、dns',
        },
        offset: { type: 'number', description: '起始行偏移（从 0 开始），用于大文件分页读取' },
        limit: { type: 'number', description: '读取行数，不填则读取全部' },
      },
    },
  },
  {
    name: 'edit_config',
    description: `编辑配置文件，使用精确字符串替换（类似 Claude Code Edit 模式）。

使用方法：
1. 先用 read_config 读取配置内容
2. 找到要修改的部分，将原文复制为 old_string
3. 将修改后的文本写为 new_string
4. old_string 必须在配置中唯一存在

兼容模式：
- 可用 anchor 代替 old_string（当 old_string 难以精确匹配时）
- 用 mode=insert_before/insert_after + anchor + insert 在锚点前后插入内容

注意事项：
- old_string 必须与配置文件内容完全匹配（包括缩进和换行）
- 如果 old_string 匹配到多处，编辑会失败
- 编辑后会验证 YAML 格式，格式无效会自动回滚`,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['replace', 'insert_before', 'insert_after'],
          description: '编辑模式：replace（替换，默认）、insert_before（在锚点前插入）、insert_after（在锚点后插入）',
        },
        old_string: { type: 'string', description: '要替换的原始文本，必须与配置内容完全匹配' },
        new_string: { type: 'string', description: '替换后的新文本，可以为空字符串（删除）' },
        anchor: { type: 'string', description: '锚点文本（可替代 old_string，或配合 insert_before/insert_after + insert 使用）' },
        insert: { type: 'string', description: '要插入的文本（配合 insert_before/insert_after 模式使用）' },
      },
      required: ['old_string', 'new_string'],
    },
  },
  {
    name: 'validate_config',
    description: '验证配置文件的 YAML 格式是否正确',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要验证的 YAML 内容' },
      },
      required: ['content'],
    },
  },
  {
    name: 'manage_overrides',
    description: '管理覆写脚本：列出、创建、删除、启用/禁用、更新远程覆写、关联订阅。覆写分为全局覆写（对所有订阅生效）和订阅特定覆写（需关联到订阅才生效）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'delete', 'enable', 'disable', 'update_remote', 'associate'],
          description: '操作类型。associate: 将覆写关联到当前订阅',
        },
        id: { type: 'string', description: '覆写 ID（delete/enable/disable/update_remote/associate 时使用）' },
        name: { type: 'string', description: '覆写名称（create 时必填）' },
        content: { type: 'string', description: '覆写内容（create 时使用，JavaScript 或 YAML）' },
        type: { type: 'string', enum: ['javascript', 'yaml'], description: '覆写文件类型（create 时使用），默认 yaml' },
        url: { type: 'string', description: '远程覆写 URL（create 时使用，填写后为远程覆写）' },
        global: { type: 'boolean', description: '是否为全局覆写（create 时使用），默认 true。全局覆写对所有订阅生效，非全局需通过 associate 关联到订阅' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_override',
    description: '读取覆写脚本的代码内容（JavaScript/YAML），支持按行分页',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '覆写 ID（与 name 二选一）' },
        name: { type: 'string', description: '覆写名称（与 id 二选一）' },
        offset: { type: 'number', description: '起始行偏移（从 0 开始）' },
        limit: { type: 'number', description: '读取行数，不填则读取全部' },
      },
    },
  },
  {
    name: 'edit_override',
    description: `编辑覆写脚本内容，支持精确替换和全量替换两种模式。

- replace（默认）：old_string/new_string 精确字符串替换
- full：full_content 全量替换整个脚本内容`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '覆写 ID（与 name 二选一）' },
        name: { type: 'string', description: '覆写名称（与 id 二选一）' },
        mode: { type: 'string', enum: ['replace', 'full'], description: '编辑模式：replace（精确替换，默认）、full（全量替换）' },
        old_string: { type: 'string', description: '要替换的原文本（replace 模式必填）' },
        new_string: { type: 'string', description: '替换后的新文本（replace 模式必填）' },
        full_content: { type: 'string', description: '完整的新脚本内容（full 模式必填）' },
      },
    },
  },
  {
    name: 'manage_proxy_icon_rules',
    description: '管理代理组图标规则：列出、添加、更新、删除、启用/禁用',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'delete', 'toggle'],
          description: '操作类型',
        },
        id: { type: 'string', description: '规则 ID（update/delete/toggle 时使用）' },
        name: { type: 'string', description: '规则名称（add 时必填）' },
        regex: { type: 'string', description: '匹配代理组名的正则表达式（add/update 时使用）' },
        icon_url: { type: 'string', description: '图标 URL（add/update 时使用）' },
        enabled: { type: 'boolean', description: '是否启用（toggle 时使用）' },
      },
      required: ['action'],
    },
  },
];
interface MihomoAPI {
  configs: () => Promise<any>;
  patchConfigs: (config: any) => Promise<any>;
  proxies: () => Promise<any>;
  putProxies: (opts: { group: string; proxy: string }) => Promise<any>;
  connections: () => Promise<any>;
  proxiesDelay: (name: string, opts?: any) => Promise<any>;
  groupDelay: (group: string, opts?: any) => Promise<any>;
  proxyProviders: () => Promise<any>;
  version: () => Promise<any>;
}

function extractSection(content: string, sectionName: string): string {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((l) => {
    const trimmed = l.trim();
    return trimmed === `${sectionName}:` || trimmed.startsWith(`${sectionName}:`);
  });
  if (startIndex === -1) return `# 未找到 ${sectionName} 段落`;
  const result: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && line.includes(':') && !line.startsWith('-')) {
      break;
    }
    result.push(line);
  }
  return result.join('\n').trimEnd();
}

function countOccurrences(text: string, substring: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(substring, index);
    if (index < 0) break;
    count++;
    index += substring.length;
  }
  return count;
}

function findSimilarContent(content: string, target: string): string {
  const firstLine = target.split('\n')[0]?.trim();
  if (!firstLine) return '';
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(firstLine)) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 5);
      const ctx = lines.slice(start, end).join('\n');
      return `在第 ${i + 1} 行附近找到 "${firstLine.slice(0, 30)}..."：\n\n\`\`\`\n${ctx}\n\`\`\``;
    }
  }
  return '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  mihomoAPI: MihomoAPI
): Promise<ToolResult> {
  // Helper: reload mihomo after config/override changes
  // Strategy: try hot-reload first (PUT /configs?force=true), fallback to full restart
  const reloadConfig = async () => {
    try {
      const configPath = await window.electronAPI?.getActiveConfig?.();
      if (!configPath) {
        console.warn('[AI-reloadConfig] No active config path, skipping reload');
        return;
      }

      // Step 1: Try hot-reload via PUT /configs?force=true
      let hotReloadOk = false;
      if (window.electronAPI?.reloadMihomoConfig) {
        try {
          hotReloadOk = await window.electronAPI.reloadMihomoConfig(configPath);
          console.log('[AI-reloadConfig] Hot-reload result:', hotReloadOk);
        } catch (e) {
          console.warn('[AI-reloadConfig] Hot-reload threw:', e);
        }
      }

      // Step 2: If hot-reload failed, fallback to full service restart
      if (!hotReloadOk && window.electronAPI?.restartService) {
        console.log('[AI-reloadConfig] Hot-reload failed, falling back to restartService');
        try {
          await window.electronAPI.restartService();
          console.log('[AI-reloadConfig] Service restart completed');
        } catch (e) {
          console.error('[AI-reloadConfig] Service restart also failed:', e);
        }
      }
    } catch (e) {
      console.error('[AI-reloadConfig] Unexpected error:', e);
    }
  };

  try {
    switch (toolName) {
      case 'control_service': {
        const action = args.action;
        if (typeof window === 'undefined' || !window.electronAPI) {
          return { success: false, content: '错误：electronAPI 不可用' };
        }
        if (action === 'status') {
          try {
            const running = window.electronAPI.isMihomoRunning ? await (window.electronAPI as any).isMihomoRunning() : null;
            if (running !== null) {
              return { success: true, content: running ? '服务正在运行' : '服务未运行', data: { running } };
            }
            // Fallback: try version API
            const ver = await mihomoAPI.version();
            return { success: true, content: `服务正在运行，版本: ${ver.version || 'unknown'}`, data: { running: true, version: ver.version } };
          } catch {
            return { success: true, content: '服务未运行', data: { running: false } };
          }
        }
        if (action === 'start') {
          const configPath = await window.electronAPI.getActiveConfig();
          if (!configPath) return { success: false, content: '没有可用的配置文件' };
          await window.electronAPI.startMihomo(configPath);
          return { success: true, content: '服务已启动' };
        }
        if (action === 'stop') {
          await window.electronAPI.stopMihomo();
          return { success: true, content: '服务已停止' };
        }
        if (action === 'restart') {
          if (window.electronAPI.restartService) {
            await window.electronAPI.restartService();
          } else {
            await window.electronAPI.stopMihomo();
            await new Promise((r) => setTimeout(r, 1000));
            const configPath = await window.electronAPI.getActiveConfig();
            if (configPath) await window.electronAPI.startMihomo(configPath);
          }
          return { success: true, content: '服务已重启' };
        }
        return { success: false, content: `未知操作: ${action}` };
      }

      case 'switch_mode': {
        const modeMap: Record<string, string> = { rule: 'rule', global: 'global', direct: 'direct' };
        const mode = modeMap[args.mode] || args.mode;
        await mihomoAPI.patchConfigs({ mode } as any);
        return { success: true, content: `已切换到${mode === 'rule' ? '规则' : mode === 'global' ? '全局' : '直连'}模式` };
      }

      case 'switch_proxy': {
        const groupName = args.group_name || args.group;
        const proxyName = args.proxy_name || args.proxy;
        if (!groupName || !proxyName) return { success: false, content: '缺少 group_name 或 proxy_name 参数' };
        await mihomoAPI.putProxies({ group: groupName, proxy: proxyName });
        return { success: true, content: `已将 ${groupName} 切换到 ${proxyName}` };
      }

      case 'health_check': {
        const groupName = args.group_name || args.group;
        const proxyName = args.proxy_name || args.node;
        if (groupName && proxyName) {
          const result = await mihomoAPI.proxiesDelay(proxyName);
          return { success: true, content: `节点 ${proxyName} 延迟: ${result.delay}ms`, data: { node: proxyName, delay: result.delay } };
        }
        if (groupName) {
          const result = await mihomoAPI.groupDelay(groupName);
          return { success: true, content: `代理组 ${groupName} 延迟测试完成`, data: { group: groupName, delays: result } };
        }
        // Test all groups
        const allData = await mihomoAPI.proxies();
        const groups = Object.entries(allData.proxies || {}).filter(([, v]: [string, any]) => v.all && v.all.length > 0);
        let tested = 0;
        for (const [name] of groups) {
          try { await mihomoAPI.groupDelay(name); tested++; } catch { /* skip */ }
        }
        return { success: true, content: `已完成 ${tested} 个代理组的延迟测试` };
      }
      case 'query_proxies': {
        const groupName = args.group_name || args.group;
        const includeNodes = args.include_nodes ?? false;
        const allData = await mihomoAPI.proxies();
        if (groupName) {
          const group = allData.proxies?.[groupName];
          if (!group) return { success: false, content: `未找到代理组 "${groupName}"` };
          const nodeCount = group.all?.length || 0;
          const data: any = { name: groupName, type: group.type, current: group.now, nodeCount };
          if (includeNodes) {
            data.nodes = (group.all || []).map((nodeName: string) => {
              const node = allData.proxies?.[nodeName];
              return node ? { name: nodeName, type: node.type, delay: node.history?.[node.history.length - 1]?.delay } : { name: nodeName };
            });
          } else {
            data.nodeNames = group.all || [];
          }
          return { success: true, content: `代理组 "${groupName}": ${group.type}，当前: ${group.now || '无'}，共 ${nodeCount} 个节点`, data };
        }
        const groupsList = Object.entries(allData.proxies || {})
          .filter(([, v]: [string, any]) => v.all && v.all.length > 0)
          .map(([name, v]: [string, any]) => ({
            name, type: v.type, current: v.now, nodeCount: v.all?.length || 0,
          }));
        return { success: true, content: `共找到 ${groupsList.length} 个代理组`, data: { groupCount: groupsList.length, groups: groupsList } };
      }

      case 'query_connections': {
        const limit = args.limit ?? 20;
        const data = await mihomoAPI.connections();
        const conns = data.connections || [];
        const limited = conns.slice(0, limit);
        const result = {
          totalCount: conns.length,
          returnedCount: limited.length,
          uploadTotal: formatBytes(data.uploadTotal || 0),
          downloadTotal: formatBytes(data.downloadTotal || 0),
          connections: limited.map((c: any) => ({
            host: c.metadata?.host || c.metadata?.destinationIP,
            type: c.metadata?.type,
            chains: c.chains,
            upload: formatBytes(c.upload || 0),
            download: formatBytes(c.download || 0),
          })),
        };
        return { success: true, content: `共 ${conns.length} 个活跃连接，上传: ${result.uploadTotal}，下载: ${result.downloadTotal}`, data: result };
      }

      case 'query_traffic': {
        const type = args.type || 'all';
        const connData = await mihomoAPI.connections();
        const activeConns = connData.connections?.length || 0;
        const upload = connData.uploadTotal || 0;
        const download = connData.downloadTotal || 0;
        if (type === 'now') {
          return { success: true, content: `当前活跃连接: ${activeConns}` };
        } else if (type === 'total') {
          return { success: true, content: `累计上传: ${formatBytes(upload)}，累计下载: ${formatBytes(download)}` };
        }
        return { success: true, content: `活跃连接: ${activeConns}，累计上传: ${formatBytes(upload)}，累计下载: ${formatBytes(download)}` };
      }

      case 'query_settings': {
        const config = await mihomoAPI.configs();
        return { success: true, content: '当前设置已获取', data: config };
      }
      case 'manage_profiles': {
        if (typeof window === 'undefined' || !window.electronAPI) {
          return { success: false, content: '错误：electronAPI 不可用' };
        }
        const profileName = args.profile_name || args.name;

        if (args.action === 'list') {
          const subs: any[] = await window.electronAPI.getSubscriptions() || [];
          const activeConfig = await window.electronAPI.getActiveConfig();
          const profiles = subs.map((s: any) => ({
            name: s.name,
            path: s.path,
            active: s.path === activeConfig,
            lastUpdated: s.lastUpdated,
          }));
          return { success: true, content: `共 ${profiles.length} 个配置`, data: { count: profiles.length, profiles } };
        }
        if (args.action === 'activate' && profileName) {
          const subs: any[] = await window.electronAPI.getSubscriptions() || [];
          const target = subs.find((s: any) => s.name === profileName || s.path === profileName);
          if (!target) return { success: false, content: `未找到配置 "${profileName}"` };
          await window.electronAPI.startMihomo(target.path);
          return { success: true, content: `已激活配置 "${target.name}"` };
        }
        if (args.action === 'update' && profileName) {
          const subs: any[] = await window.electronAPI.getSubscriptions() || [];
          const target = subs.find((s: any) => s.name === profileName || s.path === profileName);
          if (!target) return { success: false, content: `未找到配置 "${profileName}"` };
          const result = await window.electronAPI.refreshSubscription(target.path);
          if (result.success) {
            return { success: true, content: `配置 "${target.name}" 已更新` };
          }
          return { success: false, content: `更新失败: ${result.error || '未知错误'}` };
        }
        if (args.action === 'delete' && profileName) {
          const subs: any[] = await window.electronAPI.getSubscriptions() || [];
          const target = subs.find((s: any) => s.name === profileName || s.path === profileName);
          if (!target) return { success: false, content: `未找到配置 "${profileName}"` };
          await window.electronAPI.deleteSubscription(target.path);
          return { success: true, content: `已删除配置 "${target.name}"` };
        }
        return { success: false, content: `不支持的操作或缺少参数` };
      }

      case 'modify_settings': {
        const key = args.key;
        const value = args.value;
        if (!key || value === undefined) {
          return { success: false, content: '缺少 key/value 参数' };
        }
        let parsedValue: any = value;
        if (value === 'true') parsedValue = true;
        else if (value === 'false') parsedValue = false;
        else if (!isNaN(Number(value)) && value !== '') parsedValue = Number(value);

        // Try electronAPI.setSetting first for app-level settings
        if (typeof window !== 'undefined' && window.electronAPI?.setSetting) {
          try {
            const result = await window.electronAPI.setSetting(key, parsedValue);
            if (result.success) {
              return { success: true, content: `设置 "${key}" 已更新为 ${value}` };
            }
          } catch { /* fall through to mihomo API */ }
        }
        // Fallback: mihomo patchConfigs for service-level settings
        await mihomoAPI.patchConfigs({ [key]: parsedValue } as any);
        return { success: true, content: `设置 "${key}" 已更新为 ${value}` };
      }
      case 'read_config': {
        if (typeof window !== 'undefined' && window.electronAPI?.readConfigFile) {
          const readResult = await window.electronAPI.readConfigFile();
          if (!readResult.success || !readResult.content) {
            return { success: false, content: `读取配置失败: ${readResult.error || '未知错误'}` };
          }
          const fullContent = readResult.content;
          const section = args.section || 'all';
          const offset = args.offset || 0;
          const limit = args.limit;

          const sectionContent = section === 'all' ? fullContent : extractSection(fullContent, section);
          const allLines = sectionContent.split('\n');
          const totalLines = allLines.length;
          const totalChars = sectionContent.length;

          const selectedLines = limit ? allLines.slice(offset, offset + limit) : allLines.slice(offset);
          const content = selectedLines.join('\n');
          const endLine = offset + selectedLines.length;

          // Truncate large content to avoid bloating message history
          const MAX_CONTENT_CHARS = 8000;
          let displayContent = content;
          let truncated = false;
          if (displayContent.length > MAX_CONTENT_CHARS) {
            displayContent = displayContent.slice(0, MAX_CONTENT_CHARS);
            truncated = true;
          }

          const resultText = [
            `配置文件: ${section === 'all' ? '全部' : section}`,
            `共 ${totalLines} 行, ${totalChars} 字符`,
            ...(offset > 0 || limit ? [`范围: 第 ${offset} - ${endLine} 行 (${selectedLines.length} 行)`] : []),
            ...(truncated ? [`⚠️ 内容过长已截断（显示前 ${MAX_CONTENT_CHARS} 字符），请使用 section/offset/limit 参数分段读取`] : []),
            '',
            '```yaml',
            displayContent,
            '```',
          ].join('\n');

          return { success: true, content: resultText, data: { section, totalLines, totalChars, offset, returnedLines: selectedLines.length, content } };
        }
        const config = await mihomoAPI.configs();
        return { success: true, content: '已获取运行中的配置', data: { config } };
      }

      case 'edit_config': {
        if (typeof window === 'undefined' || !window.electronAPI?.editConfigAtomic) {
          return { success: false, content: '错误：electronAPI 不可用' };
        }
        const _log = (...a: any[]) => window.electronAPI?.debugLog?.(...a);
        const ecStart = performance.now();
        _log('edit_config: start');
        const mode = args.mode || 'replace';
        const oldStringArg = args.old_string;
        const newStringArg = args.new_string;
        const anchor = args.anchor;
        const insert = args.insert;

        let oldString: string;
        let newString: string;
        if (oldStringArg != null) {
          oldString = oldStringArg;
          newString = newStringArg ?? '';
        } else if (anchor != null && newStringArg != null) {
          oldString = anchor;
          newString = newStringArg;
        } else if (anchor != null && insert != null) {
          if (mode === 'insert_before') {
            oldString = anchor;
            newString = insert + anchor;
          } else if (mode === 'insert_after') {
            oldString = anchor;
            newString = anchor + insert;
          } else {
            return { success: false, content: '缺少 old_string；使用 anchor+insert 时需设置 mode 为 insert_before 或 insert_after' };
          }
        } else {
          return { success: false, content: '缺少 old_string（可用 anchor 代替，或用 anchor+insert 进行插入）' };
        }

        _log(`edit_config: oldString.len=${oldString.length}, newString.len=${newString.length}`);
        if (!oldString) {
          _log('edit_config: oldString is empty, abort');
          return { success: false, content: 'old_string 不能为空' };
        }
        const ipcStart = performance.now();
        _log('edit_config: calling IPC editConfigAtomic...');
        const result = await window.electronAPI.editConfigAtomic(oldString, newString);
        _log(`edit_config: IPC returned in ${(performance.now() - ipcStart).toFixed(1)}ms, success=${result.success}, error=${result.error || 'none'}`);
        _log(`edit_config: total ${(performance.now() - ecStart).toFixed(1)}ms`);

        if (!result.success) {
          if (result.error === 'old_string_not_found') {
            const hint = result.content ? findSimilarContent(result.content, oldString) : '';
            return { success: false, content: `old_string 在配置中未找到。\n\n请确保 old_string 与配置内容完全匹配（包括缩进和换行）。\n\n${hint}\n\n提示：使用 read_config 查看配置的确切内容。` };
          }
          if (result.error === 'multiple_matches') {
            return { success: false, content: `old_string 在配置中匹配到 ${result.matchCount} 处，请提供更多上下文使其唯一。` };
          }
          if (result.error === 'yaml_invalid') {
            return { success: false, content: `编辑后 YAML 格式无效，已回滚。\n\n错误: ${result.yamlError}\n\n请检查 new_string 的格式（特别是缩进）。` };
          }
          return { success: false, content: `编辑失败: ${result.error}` };
        }
        // Hot-reload mihomo so changes take effect immediately
        await reloadConfig();
        return { success: true, content: '配置已更新并重载', data: { oldLength: oldString.length, newLength: newString.length, mode } };
      }

      case 'validate_config': {
        try {
          if (typeof window !== 'undefined' && window.electronAPI?.validateConfig) {
            const result = await window.electronAPI.validateConfig(args.content);
            return { success: result.valid, content: result.valid ? '配置格式正确' : `配置格式无效: ${result.error}`, data: result };
          }
          return { success: true, content: '基本验证通过（完整验证需要 electronAPI）' };
        } catch (e: any) {
          return { success: false, content: `验证出错: ${e.message}`, data: { valid: false, error: e.message } };
        }
      }

      case 'manage_overrides': {
        if (typeof window === 'undefined' || !window.electronAPI) {
          return { success: false, content: '错误：electronAPI 不可用' };
        }
        const action = args.action;
        if (action === 'list') {
          const overrides: any[] = await window.electronAPI.getOverrides() || [];
          const items = overrides.map((o: any) => ({
            id: o.id, name: o.name, type: o.type, ext: o.ext, enabled: o.enabled, global: o.global,
            url: o.url || undefined,
          }));
          return { success: true, content: `共 ${items.length} 个覆写`, data: { count: items.length, overrides: items } };
        }
        if (action === 'create') {
          if (!args.name) return { success: false, content: '缺少 name 参数' };
          const extMap: Record<string, string> = { javascript: 'js', yaml: 'yaml' };
          const fileType = args.type || 'yaml';
          const ext = extMap[fileType] || 'yaml';
          const defaultContent = ext === 'js'
            ? '// JavaScript 覆写脚本\nfunction main(config) {\n  return config;\n}\n'
            : '# YAML 覆写配置\n';
          const newItem: any = {
            name: args.name,
            type: args.url ? 'remote' : 'local',
            ext,
            file: args.content || defaultContent,
            enabled: true,
            global: args.global !== undefined ? args.global : true,
          };
          if (args.url) newItem.url = args.url;
          const result = await window.electronAPI.addOverride(newItem);
          await reloadConfig();
          return { success: true, content: `覆写 "${args.name}" 已创建（${newItem.global ? '全局' : '需关联订阅'}）`, data: { id: result?.id } };
        }
        if (action === 'delete') {
          if (!args.id) return { success: false, content: '缺少 id 参数' };
          await window.electronAPI.deleteOverride(args.id);
          return { success: true, content: `覆写已删除` };
        }
        if (action === 'enable' || action === 'disable') {
          if (!args.id) return { success: false, content: '缺少 id 参数' };
          await window.electronAPI.updateOverride(args.id, { enabled: action === 'enable' });
          await reloadConfig();
          return { success: true, content: `覆写已${action === 'enable' ? '启用' : '禁用'}` };
        }
        if (action === 'update_remote') {
          if (!args.id) return { success: false, content: '缺少 id 参数' };
          await window.electronAPI.updateRemoteOverride(args.id);
          return { success: true, content: '远程覆写已更新' };
        }
        if (action === 'associate') {
          if (!args.id) return { success: false, content: '缺少 id 参数' };
          const configPath = await window.electronAPI?.getActiveConfig?.();
          if (!configPath) return { success: false, content: '没有活动的订阅配置' };
          const currentOverrides: string[] = await window.electronAPI.getSubscriptionOverrides?.(configPath) || [];
          if (!currentOverrides.includes(args.id)) {
            currentOverrides.push(args.id);
            await window.electronAPI.setSubscriptionOverrides?.(configPath, currentOverrides);
          }
          await reloadConfig();
          return { success: true, content: `覆写已关联到当前订阅` };
        }
        return { success: false, content: `不支持的操作: ${action}` };
      }

      case 'read_override': {
        if (typeof window === 'undefined' || !window.electronAPI) {
          return { success: false, content: '错误：electronAPI 不可用' };
        }
        let targetId = args.id;
        if (!targetId && args.name) {
          const overrides: any[] = await window.electronAPI.getOverrides() || [];
          const found = overrides.find((o: any) => o.name === args.name);
          if (!found) return { success: false, content: `未找到覆写 "${args.name}"` };
          targetId = found.id;
        }
        if (!targetId) return { success: false, content: '缺少 id 或 name 参数' };
        const content = await window.electronAPI.getOverrideFileContent(targetId);
        if (content == null) return { success: false, content: '读取覆写内容失败' };
        const allLines = String(content).split('\n');
        const offset = args.offset || 0;
        const limit = args.limit;
        const selectedLines = limit ? allLines.slice(offset, offset + limit) : allLines.slice(offset);
        return {
          success: true,
          content: `覆写内容（共 ${allLines.length} 行）:\n\n\`\`\`\n${selectedLines.join('\n')}\n\`\`\``,
          data: { totalLines: allLines.length, offset, returnedLines: selectedLines.length, content: selectedLines.join('\n') },
        };
      }

      case 'edit_override': {
        if (typeof window === 'undefined' || !window.electronAPI) {
          return { success: false, content: '错误：electronAPI 不可用' };
        }
        let targetId = args.id;
        if (!targetId && args.name) {
          const overrides: any[] = await window.electronAPI.getOverrides() || [];
          const found = overrides.find((o: any) => o.name === args.name);
          if (!found) return { success: false, content: `未找到覆写 "${args.name}"` };
          targetId = found.id;
        }
        if (!targetId) return { success: false, content: '缺少 id 或 name 参数' };
        const editMode = args.mode || 'replace';
        if (editMode === 'full') {
          if (!args.full_content) return { success: false, content: '缺少 full_content 参数' };
          await window.electronAPI.updateOverrideFileContent(targetId, args.full_content);
          await reloadConfig();
          return { success: true, content: '覆写内容已全量替换并重载' };
        }
        // replace mode
        if (!args.old_string) return { success: false, content: '缺少 old_string 参数' };
        const currentContent = await window.electronAPI.getOverrideFileContent(targetId);
        if (currentContent == null) return { success: false, content: '读取覆写内容失败' };
        const cur = String(currentContent);
        if (!cur.includes(args.old_string)) {
          return { success: false, content: 'old_string 在覆写内容中未找到，请确保完全匹配' };
        }
        const occurrences = countOccurrences(cur, args.old_string);
        if (occurrences > 1) {
          return { success: false, content: `old_string 匹配到 ${occurrences} 处，请提供更多上下文使其唯一` };
        }
        const newContent = cur.replace(args.old_string, args.new_string ?? '');
        await window.electronAPI.updateOverrideFileContent(targetId, newContent);
        await reloadConfig();
        return { success: true, content: '覆写内容已更新并重载' };
      }

      case 'manage_proxy_icon_rules': {
        if (typeof window === 'undefined' || !window.electronAPI?.proxyIcon) {
          return { success: false, content: '错误：electronAPI 或 proxyIcon 不可用' };
        }
        const action = args.action;
        if (action === 'list') {
          const config = await window.electronAPI.proxyIcon.getConfig();
          const rules = config?.rules || [];
          return { success: true, content: `共 ${rules.length} 条图标规则`, data: { count: rules.length, rules } };
        }
        const notifyIconChanged = () => {
          window.dispatchEvent(new CustomEvent('proxy-icon-changed'));
        };
        if (action === 'add') {
          if (!args.name || !args.regex || !args.icon_url) {
            return { success: false, content: '缺少 name、regex 或 icon_url 参数' };
          }
          await window.electronAPI.proxyIcon.addRule({
            name: args.name,
            regex: args.regex,
            iconType: 'URL',
            iconData: args.icon_url,
            enabled: true,
            priority: 0,
          });
          notifyIconChanged();
          return { success: true, content: `图标规则 "${args.name}" 已添加` };
        }
        if (action === 'update') {
          if (!args.id) return { success: false, content: '缺少 id 参数' };
          const updates: any = {};
          if (args.name) updates.name = args.name;
          if (args.regex) updates.regex = args.regex;
          if (args.icon_url) {
            updates.iconType = 'URL';
            updates.iconData = args.icon_url;
          }
          await window.electronAPI.proxyIcon.updateRule(args.id, updates);
          notifyIconChanged();
          return { success: true, content: '图标规则已更新' };
        }
        if (action === 'delete') {
          if (!args.id) return { success: false, content: '缺少 id 参数' };
          await window.electronAPI.proxyIcon.deleteRule(args.id);
          notifyIconChanged();
          return { success: true, content: '图标规则已删除' };
        }
        if (action === 'toggle') {
          if (!args.id) return { success: false, content: '缺少 id 参数' };
          const enabled = args.enabled !== undefined ? args.enabled : true;
          await window.electronAPI.proxyIcon.toggleRule(args.id, enabled);
          notifyIconChanged();
          return { success: true, content: `图标规则已${enabled ? '启用' : '禁用'}` };
        }
        return { success: false, content: `不支持的操作: ${action}` };
      }

      default:
        return { success: false, content: `未知工具: ${toolName}` };
    }
  } catch (e: any) {
    return { success: false, content: `执行出错: ${e.message || String(e)}` };
  }
}
