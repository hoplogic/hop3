// @module: prompt-assembler ^anc-struct-prompt-assembler
import { describe, it, expect, vi } from 'vitest';
import {
  extractKnowledgeHints,
  collectKnowledgeHints,
  retrieveKnowledge,
  formatKnowledgeContext,
  injectKnowledgeContext,
} from '../src/prompt.js';
import type { SpecAST, StepNode } from '../src/ast-types.js';
import type { KnowledgeProvider, KnowledgeFragment } from '../src/provider-types.js';
import type { AssembledContext } from '../src/runtime-types.js';

// @v: anc-exec-knowledge-retrieval
describe('L2 Knowledge Retrieval', () => {
  describe('extractKnowledgeHints', () => {
    it('extracts single @knowledge hint', () => {
      const text = '使用 @knowledge 量子纠错 进行推理';
      const hints = extractKnowledgeHints(text);
      expect(hints).toEqual(['量子纠错 进行推理']);
    });

    it('extracts multiple @knowledge hints', () => {
      const text = '@knowledge FHE\n@knowledge 同态加密';
      const hints = extractKnowledgeHints(text);
      expect(hints).toEqual(['FHE', '同态加密']);
    });

    it('deduplicates identical hints', () => {
      const text = '@knowledge FHE\n一些内容\n@knowledge FHE';
      const hints = extractKnowledgeHints(text);
      expect(hints).toEqual(['FHE']);
    });

    it('returns empty array for text without @knowledge', () => {
      const text = '普通约束文本，没有知识标记';
      const hints = extractKnowledgeHints(text);
      expect(hints).toEqual([]);
    });

    it('returns empty array for empty/null text', () => {
      expect(extractKnowledgeHints('')).toEqual([]);
      expect(extractKnowledgeHints(undefined as any)).toEqual([]);
    });

    it('handles @knowledge at end of line', () => {
      const text = '约束条件 @knowledge 密算协议';
      const hints = extractKnowledgeHints(text);
      expect(hints).toEqual(['密算协议']);
    });

    it('trims whitespace from hints', () => {
      const text = '@knowledge   多余空格  ';
      const hints = extractKnowledgeHints(text);
      expect(hints).toEqual(['多余空格']);
    });
  });

  describe('collectKnowledgeHints', () => {
    it('collects hints from spec constraints and step instruction', () => {
      const spec: SpecAST = {
        header: {
          title: 'Test',
          constraints: ['必须使用 @knowledge FHE 加密', '保证安全性'],
        },
        steps: [],
      };
      const step: StepNode = {
        step_id: '1',
        step_type: 'reason',
        summary: 'Analyze',
        instruction: '参考 @knowledge 同态加密 的概念',
      } as StepNode;

      const { specHints, stepHints } = collectKnowledgeHints(spec, step);
      expect(specHints).toEqual(['FHE 加密']);
      expect(stepHints).toEqual(['同态加密 的概念']);
    });

    it('returns empty arrays when no hints present', () => {
      const spec: SpecAST = {
        header: { title: 'Test', constraints: ['普通约束'] },
        steps: [],
      };
      const step: StepNode = {
        step_id: '1',
        step_type: 'reason',
        summary: 'Analyze',
      } as StepNode;

      const { specHints, stepHints } = collectKnowledgeHints(spec, step);
      expect(specHints).toEqual([]);
      expect(stepHints).toEqual([]);
    });

    it('handles spec without constraints', () => {
      const spec: SpecAST = {
        header: { title: 'Test' },
        steps: [],
      };
      const step: StepNode = {
        step_id: '1',
        step_type: 'reason',
        summary: 'Analyze',
        instruction: '@knowledge 测试知识',
      } as StepNode;

      const { specHints, stepHints } = collectKnowledgeHints(spec, step);
      expect(specHints).toEqual([]);
      expect(stepHints).toEqual(['测试知识']);
    });

    // @v: anc-exec-knowledge-retrieval —— 祖先容器 instruction 扫描（todo/0049 补装:设计四来源
    // 承诺"当前步及祖先容器",此前只扫当前步——容器上挂的 @knowledge 对 children 静默失效）
    describe('祖先容器 instruction 扫描（todo/0049）', () => {
      const treeSpec = (steps: StepNode[]): SpecAST => ({ header: { title: 'T' }, steps });
      const node = (id: string, type: string, instruction?: string, children?: StepNode[]): StepNode =>
        ({ step_id: id, step_type: type, summary: id, ...(instruction ? { instruction } : {}), ...(children ? { children } : {}) } as unknown as StepNode);

      it('正例:subtask 容器 instruction 带 @knowledge → child 步收集结果含该 hint（容器声明对整段 children 生效）', () => {
        const child = node('1.1', 'reason', '干活');
        const spec = treeSpec([node('1', 'subtask', '@knowledge 领域词表', [child])]);
        const { stepHints } = collectKnowledgeHints(spec, child);
        expect(stepHints).toEqual(['领域词表']);
      });

      it('正例:三层嵌套两层祖先 hint 都在,排列祖先自外向内在前、当前步最后', () => {
        const leaf = node('1.1.1', 'reason', '@knowledge 叶子知识');
        const inner = node('1.1', 'loop', '@knowledge 内层知识', [leaf]);
        const spec = treeSpec([node('1', 'subtask', '@knowledge 外层知识', [inner])]);
        const { stepHints } = collectKnowledgeHints(spec, leaf);
        expect(stepHints).toEqual(['外层知识', '内层知识', '叶子知识']);
      });

      it('反例:兄弟步骤 instruction 的 @knowledge 不串入（只认直系祖先链,不认旁系）', () => {
        const sibling = node('1.1', 'act', '@knowledge 旁系知识');
        const me = node('1.2', 'reason', '本步无声明');
        const spec = treeSpec([node('1', 'subtask', undefined, [sibling, me])]);
        const { stepHints } = collectKnowledgeHints(spec, me);
        expect(stepHints).toEqual([]);
      });

      it('反例:祖先与当前步声明同一 hint → 只出现一次（去重保序,祖先位次在先）', () => {
        const child = node('1.1', 'reason', '@knowledge 同一份知识');
        const spec = treeSpec([node('1', 'subtask', '@knowledge 同一份知识', [child])]);
        const { stepHints } = collectKnowledgeHints(spec, child);
        expect(stepHints).toEqual(['同一份知识']);
      });
    });
  });

  describe('retrieveKnowledge', () => {
    function createMockProvider(fragments: KnowledgeFragment[]): KnowledgeProvider {
      return {
        retrieve: vi.fn().mockResolvedValue(fragments),
      };
    }

    it('retrieves knowledge for spec hints', async () => {
      const fragments: KnowledgeFragment[] = [
        { source_id: 'doc1', content: 'FHE is...', relevance: 'high' },
      ];
      const provider = createMockProvider(fragments);

      const result = await retrieveKnowledge(provider, ['FHE'], [], undefined);
      expect(result.specKnowledge).toEqual(fragments);
      expect(result.stepKnowledge).toEqual([]);
      expect(result.supplementary).toEqual([]);
      expect(provider.retrieve).toHaveBeenCalledWith('FHE', 3);
    });

    it('retrieves knowledge for step hints', async () => {
      const fragments: KnowledgeFragment[] = [
        { source_id: 'doc2', content: '同态加密定义', relevance: 'medium' },
      ];
      const provider = createMockProvider(fragments);

      const result = await retrieveKnowledge(provider, [], ['同态加密'], undefined);
      expect(result.specKnowledge).toEqual([]);
      expect(result.stepKnowledge).toEqual(fragments);
    });

    it('retrieves supplementary knowledge for lack_of_info', async () => {
      const fragments: KnowledgeFragment[] = [
        { source_id: 'doc3', content: '补充知识', relevance: 'low' },
      ];
      const provider = createMockProvider(fragments);

      const result = await retrieveKnowledge(provider, [], [], '需要了解密码学基础');
      expect(result.supplementary).toEqual(fragments);
      expect(provider.retrieve).toHaveBeenCalledWith('需要了解密码学基础', 3);
    });

    it('degrades gracefully when provider throws', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockRejectedValue(new Error('network error')),
      };

      const result = await retrieveKnowledge(provider, ['FHE'], ['test'], 'query');
      expect(result.specKnowledge).toEqual([]);
      expect(result.stepKnowledge).toEqual([]);
      expect(result.supplementary).toEqual([]);
    });

    it('calls retrieve for each hint separately', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockResolvedValue([]),
      };

      await retrieveKnowledge(provider, ['hint1', 'hint2'], ['hint3'], undefined);
      expect(provider.retrieve).toHaveBeenCalledTimes(3);
      expect(provider.retrieve).toHaveBeenCalledWith('hint1', 3);
      expect(provider.retrieve).toHaveBeenCalledWith('hint2', 3);
      expect(provider.retrieve).toHaveBeenCalledWith('hint3', 3);
    });
  });

  describe('formatKnowledgeContext', () => {
    it('formats spec knowledge section', () => {
      const result = {
        specKnowledge: [
          { source_id: 'doc1', content: 'FHE概念', relevance: 'high' as const },
        ],
        stepKnowledge: [],
        supplementary: [],
      };

      const formatted = formatKnowledgeContext(result);
      expect(formatted).toContain('[知识上下文]');
      expect(formatted).toContain('### Spec @knowledge（全程可用）');
      expect(formatted).toContain('doc1: FHE概念');
    });

    it('formats step knowledge section', () => {
      const result = {
        specKnowledge: [],
        stepKnowledge: [
          { source_id: 'doc2', content: '步骤知识', relevance: 'medium' as const },
        ],
        supplementary: [],
      };

      const formatted = formatKnowledgeContext(result);
      expect(formatted).toContain('### 步骤 @knowledge');
      expect(formatted).toContain('doc2: 步骤知识');
    });

    it('formats supplementary knowledge with trigger step info', () => {
      const result = {
        specKnowledge: [],
        stepKnowledge: [],
        supplementary: [
          { source_id: 'doc3', content: '补充内容', relevance: 'low' as const },
        ],
      };

      const formatted = formatKnowledgeContext(result, '2.1');
      expect(formatted).toContain('### 补充检索');
      expect(formatted).toContain('步骤 2.1');
      expect(formatted).toContain('lack_of_info');
      expect(formatted).toContain('doc3: 补充内容');
    });

    it('deduplicates fragments by source_id', () => {
      const result = {
        specKnowledge: [
          { source_id: 'doc1', content: 'content A', relevance: 'high' as const },
        ],
        stepKnowledge: [
          { source_id: 'doc1', content: 'content A repeated', relevance: 'medium' as const },
        ],
        supplementary: [],
      };

      const formatted = formatKnowledgeContext(result);
      // doc1 should appear only once (in spec section, since it's processed first)
      const matches = formatted.match(/doc1:/g);
      expect(matches).toHaveLength(1);
    });

    it('returns empty string when no fragments', () => {
      const result = {
        specKnowledge: [],
        stepKnowledge: [],
        supplementary: [],
      };

      const formatted = formatKnowledgeContext(result);
      expect(formatted).toBe('');
    });

    it('sorts fragments by relevance within each section', () => {
      const result = {
        specKnowledge: [
          { source_id: 'low', content: 'low content', relevance: 'low' as const },
          { source_id: 'high', content: 'high content', relevance: 'high' as const },
          { source_id: 'med', content: 'med content', relevance: 'medium' as const },
        ],
        stepKnowledge: [],
        supplementary: [],
      };

      const formatted = formatKnowledgeContext(result);
      const highIdx = formatted.indexOf('high:');
      const medIdx = formatted.indexOf('med:');
      const lowIdx = formatted.indexOf('low:');
      expect(highIdx).toBeLessThan(medIdx);
      expect(medIdx).toBeLessThan(lowIdx);
    });

    it('逐源平摊:超预算在片段边界截、留痕省略计数(2026-08-09 取代整串尾切)', () => {
      const result: KnowledgeRetrievalResult = {
        specKnowledge: [
          { source_id: 'kb1', content: 'A'.repeat(400), relevance: 'high' },
          { source_id: 'kb2', content: 'B'.repeat(400), relevance: 'low' },
        ],
        stepKnowledge: [], supplementary: [], dynamic: [], failures: [],
      };
      const formatted = formatKnowledgeContext(result, undefined, 500);
      expect(formatted).toContain('kb1');                          // 高相关保留
      expect(formatted).not.toContain('B'.repeat(400));            // 超份额片段整条弃(边界截)
      expect(formatted).toContain('因预算省略');                    // 源内留痕
      expect(formatted).toContain('[context-compress]');           // 总留痕
      expect(formatted).not.toContain('[TRUNCATED]');              // 不再整串尾切
    });
  });

  describe('injectKnowledgeContext', () => {
    // @v: anc-rule-narrative-sections — 检索侧追加不覆盖（阅卷漂移二实锤:narrative 组装期先入,
    // 检索后跑赋值曾整段覆盖——修前红:口径甲消失只剩检索片段）
    it('正例：narrative 预置的 spec_knowledge_context 与检索型 spec 知识并存不覆盖', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockResolvedValue([
          { source_id: 'kb-spec', content: '检索片段', relevance: 'high' },
        ]),
      };
      const spec: SpecAST = {
        header: { title: 'T', constraints: ['@knowledge 密算'] },
        steps: [],
      };
      const step: StepNode = { step_id: '1', step_type: 'reason', summary: 's', instruction: 'i' } as StepNode;
      const ctx: AssembledContext = {
        task_context: '', progress_summary: '', inputs: {}, instruction: '', output_schema: [],
        spec_knowledge_context: '[Spec 级知识（全程恒定）]\n本文件《背景》:\n口径甲',
      };
      await injectKnowledgeContext(ctx, provider, spec, step);
      expect(ctx.spec_knowledge_context).toContain('口径甲');       // narrative 不被覆盖
      expect(ctx.spec_knowledge_context).toContain('检索片段');     // 检索照常追加
    });

    it('injects knowledge_context into AssembledContext when hints exist', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockResolvedValue([
          { source_id: 'kb1', content: '知识片段', relevance: 'high' },
        ]),
      };

      const spec: SpecAST = {
        header: {
          title: 'Test',
          constraints: ['使用 @knowledge 密算 进行计算'],
        },
        steps: [],
      };

      const step: StepNode = {
        step_id: '1',
        step_type: 'reason',
        summary: 'Analyze',
        instruction: '分析数据',
      } as StepNode;

      const ctx: AssembledContext = {
        task_context: 'Goal: test',
        progress_summary: 'No steps completed.',
        inputs: {},
        instruction: 'Do analysis',
        output_schema: [],
      };

      const { sources } = await injectKnowledgeContext(ctx, provider, spec, step);
      expect(ctx.knowledge_context).toBeDefined();
      expect(ctx.knowledge_context).toContain('kb1: 知识片段');
      expect(provider.retrieve).toHaveBeenCalledWith('密算 进行计算', 3);
      // 返回检索到的 source_id 列表（供 HopLog knowledge 流控字段记录）
      expect(sources).toContain('kb1');
    });

    // @v: anc-exec-knowledge-retrieval
    // 动态检索（来源4）：无显式 @knowledge 时也用 summary+instruction 作 query 检索。
    // provider 返回空 → knowledge_context 仍 undefined，但 provider 被调用过（动态检索触发）。
    it('triggers dynamic retrieval with no explicit hints; empty result leaves context undefined', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockResolvedValue([]),
      };

      const spec: SpecAST = {
        header: { title: 'Test', constraints: ['普通约束'] },
        steps: [],
      };

      const step: StepNode = {
        step_id: '1',
        step_type: 'reason',
        summary: 'Analyze',
        instruction: 'Do analysis',
      } as StepNode;

      const ctx: AssembledContext = {
        task_context: 'Goal: test',
        progress_summary: 'No steps completed.',
        inputs: {},
        instruction: 'Do analysis',
        output_schema: [],
      };

      await injectKnowledgeContext(ctx, provider, spec, step);
      expect(ctx.knowledge_context).toBeUndefined();   // 返回空 → 不设 L2
      expect(provider.retrieve).toHaveBeenCalled();     // 但动态检索触发了 provider 调用
    });

    // @v: anc-exec-knowledge-retrieval
    // 动态检索命中：summary+instruction 检索到知识 → 出现在"### 动态检索"区
    it('dynamic retrieval populates 动态检索 section when provider returns fragments', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockResolvedValue([
          { source_id: 'kb-dyn', content: '动态知识内容', relevance: 'high' },
        ]),
      };
      const spec: SpecAST = { header: { title: 'T', constraints: [] }, steps: [] };
      const step: StepNode = {
        step_id: '1', step_type: 'reason', summary: '分析风险', instruction: '评估等级',
      } as StepNode;
      const ctx: AssembledContext = {
        task_context: 'Goal: t', progress_summary: '', inputs: {}, instruction: '评估等级', output_schema: [],
      };
      const { sources } = await injectKnowledgeContext(ctx, provider, spec, step);
      expect(ctx.knowledge_context).toContain('### 动态检索');
      expect(ctx.knowledge_context).toContain('kb-dyn');
      expect(sources).toContain('kb-dyn');
    });

    it('leaves knowledge_context undefined when provider returns empty', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockResolvedValue([]),
      };

      const spec: SpecAST = {
        header: {
          title: 'Test',
          constraints: ['@knowledge 某概念'],
        },
        steps: [],
      };

      const step: StepNode = {
        step_id: '1',
        step_type: 'reason',
        summary: 'Analyze',
      } as StepNode;

      const ctx: AssembledContext = {
        task_context: 'Goal: test',
        progress_summary: 'No steps completed.',
        inputs: {},
        instruction: 'Do analysis',
        output_schema: [],
      };

      const { sources } = await injectKnowledgeContext(ctx, provider, spec, step);
      expect(ctx.knowledge_context).toBeUndefined();
    });

    it('degrades gracefully when provider throws', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockRejectedValue(new Error('provider crashed')),
      };

      const spec: SpecAST = {
        header: {
          title: 'Test',
          constraints: ['@knowledge 重要概念'],
        },
        steps: [],
      };

      const step: StepNode = {
        step_id: '1',
        step_type: 'reason',
        summary: 'Analyze',
      } as StepNode;

      const ctx: AssembledContext = {
        task_context: 'Goal: test',
        progress_summary: 'No steps completed.',
        inputs: {},
        instruction: 'Do analysis',
        output_schema: [],
      };

      // Should not throw, L2 remains empty
      const { sources } = await injectKnowledgeContext(ctx, provider, spec, step);
      expect(ctx.knowledge_context).toBeUndefined();
    });

    it('includes supplementary query results when provided', async () => {
      const provider: KnowledgeProvider = {
        retrieve: vi.fn().mockResolvedValue([
          { source_id: 'supp1', content: '补充知识', relevance: 'medium' },
        ]),
      };

      const spec: SpecAST = {
        header: { title: 'Test' },
        steps: [],
      };

      const step: StepNode = {
        step_id: '2',
        step_type: 'reason',
        summary: 'Continue',
      } as StepNode;

      const ctx: AssembledContext = {
        task_context: 'Goal: test',
        progress_summary: 'Step 1 done.',
        inputs: {},
        instruction: 'Continue work',
        output_schema: [],
      };

      const { sources } = await injectKnowledgeContext(
        ctx, provider, spec, step,
        '缺少密码学基础知识', // supplementaryQuery
        '1',               // triggerStepId
      );

      expect(ctx.knowledge_context).toBeDefined();
      expect(ctx.knowledge_context).toContain('补充检索');
      expect(ctx.knowledge_context).toContain('步骤 1');
      expect(ctx.knowledge_context).toContain('supp1: 补充知识');
      expect(sources).toContain('supp1');
    });
  });

  describe('PromptAssembler backward compatibility', () => {
    it('existing tests still pass without KnowledgeProvider', async () => {
      // Verify that the PromptAssembler constructor signature is backward compatible
      const { PromptAssembler } = await import('../src/prompt.js');
      const { ExecutionEngine } = await import('../src/engine.js');

      const spec = `# Compat Test
Id: compat

## Goal
Backward compatibility

## Outputs
- result: text  # result

## Steps
1. [reason] Do work
  + → result: text  # output
  > Work on it
`;
      const engine = new ExecutionEngine();
      engine.initExecution(spec, {
        workspace_dir: '/tmp/test',
        sandbox: { filesystem: { workspace_dir: '.', read_access: { allowed: ['.'], denied: [], confirm_required: [] } }, network: { trusted_hosts: [] }, runtime: { available: [] } },
        api_key: 'test',
      });

      // Without knowledge provider flag
      const assembler1 = new PromptAssembler(engine);
      const step = engine.getSpec()!.steps![0];
      const ctx1 = assembler1.assembleReasonContext(step);
      expect(ctx1.knowledge_context).toBeUndefined();

      // With knowledge provider flag = false
      const assembler2 = new PromptAssembler(engine, false);
      const ctx2 = assembler2.assembleReasonContext(step);
      expect(ctx2.knowledge_context).toBeUndefined();

      // With knowledge provider flag = true (budget changes but no injection)
      const assembler3 = new PromptAssembler(engine, true);
      const ctx3 = assembler3.assembleReasonContext(step);
      // Synchronous assembly does not inject knowledge — that's the dispatcher's job
      expect(ctx3.knowledge_context).toBeUndefined();
    });
  });
});

// Spec @knowledge 缓存：同 hint 不重复调 Provider（2026-08-08 作者定按设计实装缓存,
// 避免每步重查反复读文件浪费 IO）。// @v: anc-exec-knowledge-retrieval
describe('Spec @knowledge 缓存', () => {
  it('同一 provider 同一 hint 第二次检索走缓存不再调 retrieve', async () => {
    let calls = 0;
    const provider = {
      retrieve: async (_q: string, _n?: number) => {
        calls++;
        return [{ source_id: 'cached-doc', content: 'K', relevance: 1 }];
      },
    };
    const r1 = await retrieveKnowledge(provider as never, ['hintA'], [], undefined, undefined);
    expect(r1.specKnowledge).toHaveLength(1);
    const callsAfterFirst = calls;
    const r2 = await retrieveKnowledge(provider as never, ['hintA'], [], undefined, undefined);
    expect(r2.specKnowledge).toHaveLength(1);
    expect(calls).toBe(callsAfterFirst);   // 第二轮零新调用=缓存命中
  });
});
