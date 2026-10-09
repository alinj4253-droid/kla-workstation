import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Pencil, Trash2, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';

export function LibraryMenu({ name, detailUrl, onEdit, onDelete }: { name: string; detailUrl?: string; onEdit?: (() => void) | undefined; onDelete?: (() => void) | undefined }) {
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="kl-icon-button" aria-label={`${name}操作菜单`}><MoreHorizontal size={19}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><div className="kl-menu-scope"><DropdownMenu.Content className="kl-library-menu" align="start" side="bottom" sideOffset={6} collisionPadding={10}>
    {detailUrl && <DropdownMenu.Item asChild><Link to={detailUrl}><ArrowUpRight size={15}/>查看详情</Link></DropdownMenu.Item>}
    <DropdownMenu.Item disabled={!onEdit} onSelect={() => onEdit?.()}><Pencil size={15}/>编辑知识库</DropdownMenu.Item>
    <DropdownMenu.Separator/>
    <DropdownMenu.Item className="kl-menu-danger" disabled={!onDelete} onSelect={() => onDelete?.()}><Trash2 size={15}/>删除知识库</DropdownMenu.Item>
  </DropdownMenu.Content></div></DropdownMenu.Portal></DropdownMenu.Root>;
}
