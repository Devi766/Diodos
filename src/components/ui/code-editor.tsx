'use client';

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaseSensitive, ChevronDown, ChevronUp, Replace, ReplaceAll, Search, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type CodeEditorLanguage = 'yaml' | 'javascript' | 'plain';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeEditorLanguage;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  autoFocus?: boolean;
}

const FONT_STYLE: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: '20px',
  tabSize: 2,
};

// 超过此体积跳过高亮，保证大文件的输入流畅度
const HIGHLIGHT_SIZE_LIMIT = 400_000;

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TOKEN_CLASS: Record<string, string> = {
  comment: 'text-gray-400 dark:text-gray-500 italic',
  key: 'text-sky-600 dark:text-sky-400',
  string: 'text-emerald-600 dark:text-emerald-400',
  number: 'text-amber-600 dark:text-amber-400',
  keyword: 'text-violet-600 dark:text-violet-400 font-medium',
  boolean: 'text-orange-600 dark:text-orange-400',
  punctuation: 'text-gray-400 dark:text-gray-500',
  anchor: 'text-pink-600 dark:text-pink-400',
  function: 'text-blue-600 dark:text-blue-400',
};

const span = (type: string, text: string) =>
  `<span class="${TOKEN_CLASS[type] ?? ''}">${escapeHtml(text)}</span>`;

const YAML_VALUE_PATTERN =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\btrue\b|\bfalse\b|\bnull\b|~(?=\s|$))|(-?\b\d+(?:\.\d+)?\b)|([&*][\w-]+)/g;

function tokenizeSegment(
  segment: string,
  pattern: RegExp,
  renderer: (groups: (string | undefined)[], match: string) => string,
): string {
  let lastIndex = 0;
  let html = '';
  for (const match of segment.matchAll(pattern)) {
    const offset = match.index ?? 0;
    html += escapeHtml(segment.slice(lastIndex, offset));
    html += renderer(match.slice(1), match[0]);
    lastIndex = offset + match[0].length;
  }
  html += escapeHtml(segment.slice(lastIndex));
  return html;
}

function highlightYamlLine(line: string): string {
  const commentIndex = findYamlCommentIndex(line);
  const body = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : '';

  let html = '';
  const keyMatch = body.match(/^(\s*(?:-\s+)?)((?:"[^"]*"|'[^']*'|[^:#\s][^:]*?))(:)(?=\s|$)/);
  let rest = body;
  if (keyMatch) {
    html += escapeHtml(keyMatch[1]) + span('key', keyMatch[2]) + span('punctuation', ':');
    rest = body.slice(keyMatch[1].length + keyMatch[2].length + 1);
  } else {
    const dashMatch = body.match(/^(\s*)-(?=\s|$)/);
    if (dashMatch) {
      html += escapeHtml(dashMatch[1]) + span('punctuation', '-');
      rest = body.slice(dashMatch[1].length + 1);
    }
  }

  html += tokenizeSegment(rest, YAML_VALUE_PATTERN, ([str, bool, num, anchor], match) => {
    if (str) return span('string', str);
    if (bool) return span('boolean', bool);
    if (num) return span('number', num);
    if (anchor) return span('anchor', anchor);
    return escapeHtml(match);
  });

  if (comment) html += span('comment', comment);
  return html;
}

function findYamlCommentIndex(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

const JS_PATTERN =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:function|return|if|else|for|while|do|switch|case|break|continue|const|let|var|new|typeof|instanceof|in|of|try|catch|finally|throw|class|extends|super|this|async|await|yield|delete|void|default|import|export|from)\b)|(\btrue\b|\bfalse\b|\bnull\b|\bundefined\b|\bNaN\b)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|0x[0-9a-fA-F]+)|([A-Za-z_$][\w$]*)(?=\s*\()/gm;

function highlightJsSegment(segment: string): string {
  let lastIndex = 0;
  let html = '';
  segment.replace(JS_PATTERN, (match, comment, str, keyword, bool, num, fn, offset: number) => {
    html += escapeHtml(segment.slice(lastIndex, offset));
    if (comment) html += span('comment', comment);
    else if (str) html += span('string', str);
    else if (keyword) html += span('keyword', keyword);
    else if (bool) html += span('boolean', bool);
    else if (num) html += span('number', num);
    else if (fn) html += span('function', fn);
    else html += escapeHtml(match);
    lastIndex = offset + match.length;
    return match;
  });
  html += escapeHtml(segment.slice(lastIndex));
  return html;
}

/** JS 高亮：先按跨行块注释切分（逐行状态机），其余交给行内正则。 */
function highlightJs(code: string): string[] {
  const lines = code.split('\n');
  const output: string[] = [];
  let inBlockComment = false;
  for (const line of lines) {
    let html = '';
    let rest = line;
    while (rest.length > 0) {
      if (inBlockComment) {
        const end = rest.indexOf('*/');
        if (end === -1) {
          html += span('comment', rest);
          rest = '';
        } else {
          html += span('comment', rest.slice(0, end + 2));
          rest = rest.slice(end + 2);
          inBlockComment = false;
        }
      } else {
        const start = findBlockCommentStart(rest);
        if (start === -1) {
          html += highlightJsSegment(rest);
          rest = '';
        } else {
          html += highlightJsSegment(rest.slice(0, start));
          rest = rest.slice(start);
          inBlockComment = true;
        }
      }
    }
    output.push(html);
  }
  return output;
}

function findBlockCommentStart(segment: string): number {
  let inString: string | null = null;
  for (let i = 0; i < segment.length - 1; i += 1) {
    const ch = segment[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inString = ch;
    else if (ch === '/' && segment[i + 1] === '/') return -1;
    else if (ch === '/' && segment[i + 1] === '*') return i;
  }
  return -1;
}

function highlight(code: string, language: CodeEditorLanguage): string[] {
  if (language === 'plain' || code.length > HIGHLIGHT_SIZE_LIMIT) {
    return code.split('\n').map(escapeHtml);
  }
  if (language === 'javascript') return highlightJs(code);
  return code.split('\n').map(highlightYamlLine);
}

interface SearchMatch {
  start: number;
  end: number;
}

function findMatches(text: string, query: string, caseSensitive: boolean): SearchMatch[] {
  if (!query) return [];
  const matches: SearchMatch[] = [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index !== -1 && matches.length < 10_000) {
    matches.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
  }
  return matches;
}

/** 构建搜索命中覆盖层：整体透明，仅命中区域着色，与高亮层逐字符对齐。 */
function buildSearchOverlay(text: string, matches: SearchMatch[], currentIndex: number): string {
  if (matches.length === 0) return '';
  let html = '';
  let cursor = 0;
  matches.forEach((match, index) => {
    html += escapeHtml(text.slice(cursor, match.start));
    const cls = index === currentIndex
      ? 'rounded-[2px] bg-orange-400/60 outline outline-1 outline-orange-500/80'
      : 'rounded-[2px] bg-amber-300/45 dark:bg-amber-400/30';
    html += `<mark class="${cls}" style="color:transparent">${escapeHtml(text.slice(match.start, match.end))}</mark>`;
    cursor = match.end;
  });
  html += escapeHtml(text.slice(cursor));
  return html;
}

export function CodeEditor({
  value,
  onChange,
  language = 'plain',
  placeholder,
  readOnly,
  className,
  autoFocus,
}: CodeEditorProps) {
  const { t } = useTranslation();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const highlightRef = React.useRef<HTMLDivElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const [searchOpen, setSearchOpen] = React.useState(false);
  const [replaceOpen, setReplaceOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [replacement, setReplacement] = React.useState('');
  const [caseSensitive, setCaseSensitive] = React.useState(false);
  const [currentMatch, setCurrentMatch] = React.useState(0);

  const lines = React.useMemo(() => highlight(value, language), [value, language]);
  const matches = React.useMemo(
    () => (searchOpen ? findMatches(value, query, caseSensitive) : []),
    [value, query, caseSensitive, searchOpen],
  );
  const boundedMatch = matches.length > 0 ? Math.min(currentMatch, matches.length - 1) : 0;
  const overlayHtml = React.useMemo(
    () => buildSearchOverlay(value, matches, boundedMatch),
    [value, matches, boundedMatch],
  );

  const lineCount = React.useMemo(() => value.split('\n').length, [value]);
  const gutterWidth = Math.max(String(lineCount).length, 2) * 8 + 20;

  const syncScroll = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    if (highlightRef.current) highlightRef.current.style.transform = transform;
    if (overlayRef.current) overlayRef.current.style.transform = transform;
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }, []);

  const scrollToMatch = React.useCallback(
    (match: SearchMatch | undefined) => {
      const textarea = textareaRef.current;
      if (!textarea || !match) return;
      const before = value.slice(0, match.start);
      const line = before.split('\n').length - 1;
      const lineHeight = 20;
      const targetTop = line * lineHeight;
      if (targetTop < textarea.scrollTop + lineHeight || targetTop > textarea.scrollTop + textarea.clientHeight - lineHeight * 2) {
        textarea.scrollTop = Math.max(0, targetTop - textarea.clientHeight / 2);
      }
      const column = match.start - (before.lastIndexOf('\n') + 1);
      const targetLeft = column * 7.8;
      if (targetLeft < textarea.scrollLeft || targetLeft > textarea.scrollLeft + textarea.clientWidth - 80) {
        textarea.scrollLeft = Math.max(0, targetLeft - 80);
      }
      syncScroll();
    },
    [value, syncScroll],
  );

  const gotoMatch = React.useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const next = ((index % matches.length) + matches.length) % matches.length;
      setCurrentMatch(next);
      scrollToMatch(matches[next]);
    },
    [matches, scrollToMatch],
  );

  const openSearch = React.useCallback(
    (withReplace: boolean) => {
      const textarea = textareaRef.current;
      const selection = textarea
        ? value.slice(textarea.selectionStart, textarea.selectionEnd)
        : '';
      if (selection && !selection.includes('\n')) setQuery(selection);
      setSearchOpen(true);
      if (withReplace) setReplaceOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    [value],
  );

  const closeSearch = React.useCallback(() => {
    setSearchOpen(false);
    setReplaceOpen(false);
    textareaRef.current?.focus();
  }, []);

  const replaceCurrent = React.useCallback(() => {
    if (readOnly || matches.length === 0) return;
    const match = matches[boundedMatch];
    const next = value.slice(0, match.start) + replacement + value.slice(match.end);
    onChange(next);
    // 保持指向下一处命中（内容变化后由 memo 重算）
    setCurrentMatch(boundedMatch);
  }, [readOnly, matches, boundedMatch, value, replacement, onChange]);

  const replaceAll = React.useCallback(() => {
    if (readOnly || !query || matches.length === 0) return;
    const pattern = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
    onChange(value.replace(pattern, () => replacement));
    setCurrentMatch(0);
  }, [readOnly, query, matches.length, caseSensitive, value, replacement, onChange]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openSearch(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        openSearch(true);
        return;
      }
      if (event.key === 'Tab' && !readOnly) {
        event.preventDefault();
        const textarea = event.currentTarget;
        const { selectionStart, selectionEnd } = textarea;
        const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
        onChange(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = selectionStart + 2;
          textarea.selectionEnd = selectionStart + 2;
        });
      }
    },
    [openSearch, readOnly, value, onChange],
  );

  const handleSearchKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        gotoMatch(boundedMatch + (event.shiftKey ? -1 : 1));
      }
    },
    [closeSearch, gotoMatch, boundedMatch],
  );

  React.useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  React.useEffect(() => {
    setCurrentMatch(0);
  }, [query, caseSensitive]);

  const searchBarButton =
    'flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 disabled:pointer-events-none dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200';

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-600 dark:bg-[#1e1e1e]',
        className,
      )}
    >
      {/* 搜索 / 替换工具条 */}
      {searchOpen && (
        <div className="absolute right-3 top-2 z-10 w-[min(420px,calc(100%-24px))] rounded-xl border border-gray-200/90 bg-white/95 p-1.5 shadow-lg backdrop-blur-md dark:border-gray-600/90 dark:bg-[#2a2a2a]/95">
          <div className="flex items-center gap-1">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('codeEditor.searchPlaceholder', '搜索')}
                className="h-7 w-full rounded-lg border border-transparent bg-gray-100 pl-7 pr-16 text-xs text-gray-700 outline-none transition-colors focus:border-blue-500/40 focus:bg-white dark:bg-white/10 dark:text-gray-200 dark:focus:bg-white/5"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-gray-400">
                {query ? `${matches.length === 0 ? 0 : boundedMatch + 1}/${matches.length}` : ''}
              </span>
            </div>
            <button
              type="button"
              title={t('codeEditor.caseSensitive', '区分大小写')}
              onClick={() => setCaseSensitive((v) => !v)}
              className={cn(searchBarButton, caseSensitive && 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300')}
            >
              <CaseSensitive className="h-4 w-4" />
            </button>
            <button type="button" title={t('codeEditor.prevMatch', '上一个')} onClick={() => gotoMatch(boundedMatch - 1)} disabled={matches.length === 0} className={searchBarButton}>
              <ChevronUp className="h-4 w-4" />
            </button>
            <button type="button" title={t('codeEditor.nextMatch', '下一个')} onClick={() => gotoMatch(boundedMatch + 1)} disabled={matches.length === 0} className={searchBarButton}>
              <ChevronDown className="h-4 w-4" />
            </button>
            <button type="button" title={t('codeEditor.close', '关闭')} onClick={closeSearch} className={searchBarButton}>
              <X className="h-4 w-4" />
            </button>
          </div>
          {replaceOpen && !readOnly && (
            <div className="mt-1 flex items-center gap-1">
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('codeEditor.replacePlaceholder', '替换为')}
                className="h-7 flex-1 rounded-lg border border-transparent bg-gray-100 px-2.5 text-xs text-gray-700 outline-none transition-colors focus:border-blue-500/40 focus:bg-white dark:bg-white/10 dark:text-gray-200 dark:focus:bg-white/5"
              />
              <button type="button" title={t('codeEditor.replace', '替换')} onClick={replaceCurrent} disabled={matches.length === 0} className={searchBarButton}>
                <Replace className="h-4 w-4" />
              </button>
              <button type="button" title={t('codeEditor.replaceAll', '全部替换')} onClick={replaceAll} disabled={matches.length === 0} className={searchBarButton}>
                <ReplaceAll className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* 行号 */}
        <div
          className="relative shrink-0 select-none overflow-hidden border-r border-gray-100 bg-gray-50/80 text-right dark:border-white/5 dark:bg-white/[0.03]"
          style={{ width: gutterWidth }}
        >
          <div ref={gutterRef} className="py-3 pr-2 text-gray-300 dark:text-gray-600" style={FONT_STYLE}>
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        </div>

        {/* 代码区：高亮层 + 搜索命中层 + 透明输入层 */}
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              ref={highlightRef}
              aria-hidden
              className="whitespace-pre px-3 py-3 text-gray-800 dark:text-gray-200"
              style={FONT_STYLE}
              dangerouslySetInnerHTML={{
                __html: lines.map((line) => line || '&nbsp;').join('\n'),
              }}
            />
          </div>
          {overlayHtml && (
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div
                ref={overlayRef}
                aria-hidden
                className="whitespace-pre px-3 py-3 text-transparent"
                style={FONT_STYLE}
                dangerouslySetInnerHTML={{ __html: overlayHtml }}
              />
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            readOnly={readOnly}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={handleKeyDown}
            className="relative h-full w-full resize-none overflow-auto whitespace-pre bg-transparent px-3 py-3 text-transparent caret-blue-500 outline-none placeholder:text-gray-300 dark:caret-blue-400 dark:placeholder:text-gray-600"
            style={FONT_STYLE}
          />
        </div>
      </div>
    </div>
  );
}
