import React, { useMemo } from 'react';
import { parseEmoji } from '@/lib/emoji';
import { cn } from '@/lib/utils';

interface EmojiTextProps {
  text: string;
  className?: string;
  as?: keyof JSX.IntrinsicElements;
}

/**
 * EmojiText 组件 - 自动将文本中的emoji转换为Twemoji图片
 * 支持所有emoji，包括国旗emoji
 */
export const EmojiText: React.FC<EmojiTextProps> = ({
  text,
  className,
  as: Component = 'span'
}) => {
  const emojiHTML = useMemo(() => {
    if (!text) return '';
    return parseEmoji(text);
  }, [text]);

  return (
    <Component
      className={cn('emoji-text', className)}
      dangerouslySetInnerHTML={{ __html: emojiHTML }}
    />
  );
};

export default EmojiText;
