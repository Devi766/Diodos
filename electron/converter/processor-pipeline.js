/**
 * 订阅节点处理流水线（Processor Pipeline）
 * 提供基础的过滤/排序/重命名/属性设置能力，便于后续前端扩展配置。
 *
 * 设计目标：
 * - 接收一组 proxies 以及一组 processor 配置，按顺序执行。
 * - 当前实现的 Processor 类型：
 *   - includeRegex: 保留名称匹配正则的节点
 *   - excludeRegex: 丢弃名称匹配正则的节点
 *   - typeFilter: 只保留指定类型（如 ss/vmess/trojan 等）
 *   - sortByName: 按名称排序（可指定升序/降序）
 *   - sortByRegex: 按正则命中优先排序
 *   - renameRegex: 使用正则替换名称
 *   - setProps: 批量设置常见属性（udp/tfo/skipCertVerify 等）
 */

function applyProcessor(proxies, processor) {
  if (!processor || !processor.type) {
    return proxies;
  }

  switch (processor.type) {
    case 'includeRegex':
      return includeRegex(proxies, processor.pattern);
    case 'excludeRegex':
      return excludeRegex(proxies, processor.pattern);
    case 'typeFilter':
      return typeFilter(proxies, processor.types);
    case 'sortByName':
      return sortByName(proxies, processor.order || 'asc');
    case 'sortByRegex':
      return sortByRegex(proxies, processor.patterns || []);
    case 'renameRegex':
      return renameRegex(proxies, processor.pattern, processor.replace || '');
    case 'setProps':
      return setProps(proxies, processor.props || {});
    default:
      console.warn('[ProcessorPipeline] Unknown processor type:', processor.type);
      return proxies;
  }
}

function includeRegex(proxies, pattern) {
  if (!pattern) return proxies;
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    console.warn('[ProcessorPipeline] includeRegex invalid pattern:', pattern, e.message);
    return proxies;
  }
  return proxies.filter(p => regex.test(p.name || ''));
}

function excludeRegex(proxies, pattern) {
  if (!pattern) return proxies;
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    console.warn('[ProcessorPipeline] excludeRegex invalid pattern:', pattern, e.message);
    return proxies;
  }
  return proxies.filter(p => !regex.test(p.name || ''));
}

function typeFilter(proxies, types) {
  if (!Array.isArray(types) || types.length === 0) return proxies;
  const normalized = types.map(t => String(t).toLowerCase());
  return proxies.filter(p => normalized.includes(String(p.type).toLowerCase()));
}

function sortByName(proxies, order) {
  const asc = (order || 'asc') !== 'desc';
  return [...proxies].sort((a, b) => {
    const na = (a.name || '').toString();
    const nb = (b.name || '').toString();
    if (na === nb) return 0;
    return asc ? na.localeCompare(nb) : nb.localeCompare(na);
  });
}

function sortByRegex(proxies, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return sortByName(proxies, 'asc');
  }
  const regexes = patterns.map(p => {
    try {
      return new RegExp(p);
    } catch {
      return null;
    }
  });

  return [...proxies].sort((a, b) => {
    const sa = scoreByRegex(a.name || '', regexes);
    const sb = scoreByRegex(b.name || '', regexes);
    if (sa === sb) {
      const na = (a.name || '').toString();
      const nb = (b.name || '').toString();
      return na.localeCompare(nb);
    }
    // 分数越小优先级越高（匹配到前面的正则优先）
    return sa - sb;
  });
}

function scoreByRegex(name, regexes) {
  for (let i = 0; i < regexes.length; i++) {
    const r = regexes[i];
    if (r && r.test(name)) return i;
  }
  return regexes.length;
}

function renameRegex(proxies, pattern, replace) {
  if (!pattern) return proxies;
  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (e) {
    console.warn('[ProcessorPipeline] renameRegex invalid pattern:', pattern, e.message);
    return proxies;
  }
  return proxies.map(p => {
    const name = p.name || '';
    return {
      ...p,
      name: name.replace(regex, replace)
    };
  });
}

function setProps(proxies, props) {
  if (!props || typeof props !== 'object') return proxies;
  const {
    udp,
    tfo,
    skipCertVerify,
    udpOverTcp
  } = props;

  return proxies.map(p => {
    const clone = { ...p };
    if (typeof udp === 'boolean') clone.udp = udp;
    if (typeof tfo === 'boolean') clone.tfo = tfo;
    if (typeof udpOverTcp === 'boolean') clone.udpOverTcp = udpOverTcp;
    if (typeof skipCertVerify === 'boolean') {
      clone.skipCertVerify = skipCertVerify;
      clone['skip-cert-verify'] = skipCertVerify;
    }
    return clone;
  });
}

/**
 * 按顺序应用 processors
 * @param {Array} proxies 规范化后的代理数组
 * @param {Array} processors 处理器配置列表
 */
function applyProcessors(proxies, processors) {
  if (!Array.isArray(processors) || processors.length === 0) {
    return proxies;
  }

  return processors.reduce((current, processor) => applyProcessor(current, processor), proxies);
}

module.exports = {
  applyProcessors
};

