/**
 * Surge 格式解析器
 * 使用 peggy 解析器实现完整的 Surge 语法支持
 */

const getSurgeParser = require('./peggy-surge');

class SurgeParser {
  /**
   * 解析 Surge 格式的代理行
   * 格式: name = protocol, server, port, [options...]
   */
  static parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      return null;
    }

    try {
      const parser = getSurgeParser();
      const proxy = parser.parse(trimmed);
      return proxy;
    } catch (e) {
      console.error('[SurgeParser] Parse failed:', e.message);
      return null;
    }
  }

}

module.exports = SurgeParser;

