import { describe, expect, it } from 'vitest';
import { runtimeSkillBundles, toolArguments } from './runtime.js';

const source = "<Slide style={{width:1280,height:720}}><Text style={{height:80}}>PPT</Text></Slide>";
const firstBuild = {
  storyMarkdown: '# STORY.md\n目标、受众和逐页主张已明确。',
  designMarkdown: '# DESIGN.md\n画布、色彩和版式规则已明确。',
  slides: [{ pageNumber: 1, source }],
};

describe('PPT assistant deck-builder contract', () => {
  it('exposes the new workflow tools as one mounted skill', () => {
    const bundle = runtimeSkillBundles.find(item => item.code === 'ppt_assistant');
    expect(bundle?.tools).toEqual([
      'local_ppt_doctor', 'local_ppt_guide', 'local_ppt_theme_list',
      'local_ppt_dsl_validate', 'local_ppt_build', 'local_ppt_inspect', 'local_ppt_render',
    ]);
  });

  it('requires STORY/DESIGN and page DSL for a new deck, but accepts revisions', () => {
    expect(toolArguments.local_ppt_build.safeParse(firstBuild).success).toBe(true);
    const revision = toolArguments.local_ppt_build.safeParse({ documentId: 'runs/one/deck.pptx', slides: [] });
    expect(revision.success).toBe(true);
    if (revision.success) expect(revision.data.fileName).toBeUndefined();
    expect(toolArguments.local_ppt_build.safeParse({ slides: [{ pageNumber: 1, source }] }).success).toBe(false);
    expect(toolArguments.local_ppt_build.safeParse({ specJson: '{}' }).success).toBe(false);
  });

  it('keeps source and filename bounds at the gateway', () => {
    expect(toolArguments.local_ppt_build.safeParse({ ...firstBuild, fileName: '../deck.pptx' }).success).toBe(false);
    expect(toolArguments.local_ppt_dsl_validate.safeParse({ source, fileName: 'page.slide' }).success).toBe(true);
    expect(toolArguments.local_ppt_guide.safeParse({ section: 'portability' }).success).toBe(true);
  });
});
