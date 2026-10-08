import { z } from 'zod';
export const libraryEntrySchema = z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(80), description: z.string().max(500), scope: z.enum(['company', 'project', 'personal']), collection: z.string().trim().max(200), updatedAt: z.string() });
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export const knowledgeCatalogSchema = z.array(libraryEntrySchema).max(100).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate library ID');
export const initialKnowledgeCatalog: LibraryEntry[] = [
 { id: 'company', name: '公司知识库', description: '汇聚公司制度、业务规范与培训资料，让组织知识持续沉淀。', scope: 'company', collection: '年会知识库', updatedAt: '' },
 { id: 'project', name: '项目知识库', description: '集中管理项目方案、研发文档与交付资料，建立可追溯的项目知识。', scope: 'project', collection: '项目知识库', updatedAt: '' },
 { id: 'personal', name: '个人知识库', description: '整理学习笔记、工作经验与参考资料，打造自己的知识空间。', scope: 'personal', collection: '个人知识库', updatedAt: '' }
];
