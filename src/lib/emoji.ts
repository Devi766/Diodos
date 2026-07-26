import twemoji from 'twemoji';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 转义 HTML 元字符。
 *
 * twemoji.parse() 接收字符串时只会替换其中的 emoji 码位，非 emoji 部分原样返回，
 * 它内部的 escapeHTML() 仅用于自己生成的 <img> 标签属性。因此传入的文本必须在
 * 调用前自行转义——本模块的输出会经由 dangerouslySetInnerHTML 注入 DOM，而输入
 * 通常是订阅下发的节点名，属于外部不可信数据。
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * 将文本中的emoji转换为Twemoji图片
 * @param text 包含emoji的文本（会先做 HTML 转义）
 * @param options Twemoji配置选项
 * @returns 转换后的HTML字符串，可安全用于 dangerouslySetInnerHTML
 */
export function parseEmoji(text: string, options?: any): string {
  if (!text) return '';

  return twemoji.parse(escapeHtml(text), {
    folder: 'svg',
    ext: '.svg',
    base: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/',
    ...options
  });
}

/**
 * React组件中安全地渲染包含emoji的文本
 * @param text 包含emoji的文本
 * @returns 可以用于dangerouslySetInnerHTML的对象
 */
export function renderEmojiHTML(text: string) {
  return {
    __html: parseEmoji(text)
  };
}

/**
 * 检测文本中是否包含emoji
 * @param text 要检测的文本
 * @returns 是否包含emoji
 */
export function hasEmoji(text: string): boolean {
  if (!text) return false;

  // 匹配emoji的正则表达式
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}-\u{2454}\u{20D0}-\u{20FF}]/u;

  return emojiRegex.test(text);
}
