/**
 * QuantumultX 格式解析器
 * 使用 peggy 解析器实现完整的 QuantumultX 语法支持
 */

const getQXParser = require('./peggy-qx');

class QXParser {
  /**
   * 解析 QuantumultX 格式的代理行
   * 格式: protocol = server:port, [options...]
   */
  static parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      return null;
    }

    try {
      const parser = getQXParser();
      const proxy = parser.parse(trimmed);
      return proxy;
    } catch (e) {
      console.error('[QXParser] Parse failed:', e.message);
      return null;
    }
  }

}

module.exports = QXParser;

