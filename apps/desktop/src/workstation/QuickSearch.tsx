import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, Search, X } from 'lucide-react';
import { searchQuickEntries, type QuickSearchEntry, type WorkstationSection } from './quick-search';
import './quick-search.css';

type Props = { entries: QuickSearchEntry[]; currentSection: WorkstationSection; onSelect: (entry: QuickSearchEntry) => void };
export function QuickSearch({ entries, currentSection, onSelect }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const options = useRef(new Map<string, HTMLButtonElement>());
  const listId = useId();
  const results = searchQuickEntries(entries, query, currentSection);
  const activeIndex = Math.max(0, results.findIndex(entry => entry.id === activeId));
  const selected = results[activeIndex];
  const changeOpen = (next: boolean) => { if (next) { setQuery(''); setActiveId(''); } setOpen(next); };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.repeat && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.altKey && !event.isComposing) { event.preventDefault(); setQuery(''); setActiveId(''); setOpen(value => !value); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const choose = (entry: QuickSearchEntry) => { setOpen(false); onSelect(entry); };
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><button type="button" className="ws-top-search" aria-label="快捷搜索功能、智能体和任务" title="快捷搜索（Ctrl + K）"><Search size={14} /><span>快速搜索功能、任务…</span></button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="ws-quick-search-overlay" /><Dialog.Content className="ws-quick-search-dialog" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}>
      <div className="ws-quick-search-heading"><div><Dialog.Title asChild><h2>快捷搜索</h2></Dialog.Title><Dialog.Description>输入功能名称，或查找当前身份的智能体、项目、群组和任务。</Dialog.Description></div><Dialog.Close asChild><button type="button" aria-label="关闭快捷搜索"><X size={18} /></button></Dialog.Close></div>
      <div className="ws-quick-search-input"><Search size={18} /><input ref={input} type="search" role="combobox" aria-label="搜索功能、智能体或任务" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined} placeholder="搜索：智能体、任务、记忆、API 密钥…" value={query} onChange={event => { setQuery(event.target.value); setActiveId(''); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
          event.preventDefault(); const next = results[(activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length]; setActiveId(next.id); options.current.get(next.id)?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') { event.preventDefault(); if (selected) choose(selected); }
      }} />{query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); setActiveId(''); input.current?.focus(); }}><X size={14} /></button>}</div>
      <div className="ws-quick-search-results" id={listId} role="listbox" aria-label="快捷搜索结果">{results.length ? results.map(entry => <button type="button" role="option" tabIndex={-1} aria-selected={entry.id === selected?.id} id={`${listId}-${entry.id}`} key={entry.id} ref={element => { if (element) options.current.set(entry.id, element); else options.current.delete(entry.id); }} onMouseEnter={() => setActiveId(entry.id)} onClick={() => choose(entry)}><span><strong>{entry.title}</strong><small>{entry.description}</small></span><b>{entry.category}</b><ArrowRight size={14} /></button>) : <p className="ws-quick-search-empty" role="status">未找到匹配的功能或记录，请换个关键词。</p>}</div>
      <footer><span>↑ ↓ 选择 · Enter 跳转 · Esc 关闭</span><small>业务记录来自当前身份已加载的数据</small></footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
