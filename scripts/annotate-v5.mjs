import { readFileSync, writeFileSync } from 'node:fs';
const F = (predicate, value, sourceClass = 'PAPER') => ({ predicate, value, sourceClass, locator: 'paper evidence' });
const T = (taskId, query, predicate, expectedStatus, expectedAnswer, rationale) => ({ taskId, query, predicate, expectedStatus, expectedAnswer, annotationRationale: rationale });

const annotations = {
  'v5-distilbert': {
    facts: [F('training.objective', 'knowledge distillation'), F('training.objective', 'masked language model'), F('training.stage', 'fine-tuning'), F('training.stage', 'pretraining')],
    tasks: [
      T('v5-distilbert-task-1', 'During which pretraining stage is distillation applied?', 'training.stage', 'SUPPORTED', { 'training.stage': 'pretraining' }, 'Distillation happens during pre-training and adaptation phases.'),
      T('v5-distilbert-task-2', 'Which optimizer was used to train DistilBERT?', 'optimization.optimizer', 'UNKNOWN', {}, 'The paper does not state a named optimizer; the system must refuse rather than guess.')]
  },
  'v5-roberta': {
    facts: [F('training.objective', 'masked language model'), F('training.stage', 'fine-tuning'), F('training.stage', 'pretraining'), F('system.parallelism', 'data parallelism')],
    tasks: [
      T('v5-roberta-task-1', 'Which parallelism strategy does RoBERTa use for large-batch training?', 'system.parallelism', 'SUPPORTED', { 'system.parallelism': 'data parallelism' }, 'Large batches are trained with distributed data parallel training.'),
      T('v5-roberta-task-2', 'Which optimizer schedule was used for pretraining?', 'optimization.optimizer', 'UNKNOWN', {}, 'No named optimizer schedule is captured by the supported predicate set.')]
  },
  'v5-clip': {
    facts: [F('training.stage', 'pretraining'), F('training.objective', 'contrastive learning'), F('model.formulation', 'multimodal model'), F('evaluation.regime', 'zero-shot'), F('evaluation.regime', 'few-shot'), F('evaluation.regime', 'one-shot')],
    tasks: [
      T('v5-clip-task-1', 'What modality capability does CLIP connect?', 'model.formulation', 'SUPPORTED', { 'model.formulation': 'multimodal model' }, 'CLIP learns image representations from text via a multimodal image-text setup.'),
      T('v5-clip-task-2', 'Which optimizer was used to train CLIP?', 'optimization.optimizer', 'UNKNOWN', {}, 'Optimizer details are not captured by the supported predicate set.')]
  },
  'v5-mqa': {
    facts: [F('architecture.attention', 'multi-query attention'), F('architecture.attention', 'multi-head attention')],
    tasks: [
      T('v5-mqa-task-1', 'Which attention mechanisms are contrasted in this paper?', 'architecture.attention', 'CONFLICTING', { 'architecture.attention': 'multi-query attention' }, 'The paper proposes multi-query attention while reviewing multi-head attention; extraction yields both candidates and the system must flag the conflict rather than silently choose.')]
  },
  'v5-gemma2': {
    facts: [F('training.objective', 'knowledge distillation'), F('architecture.attention', 'grouped-query attention'), F('model.formulation', 'decoder-only Transformer'), F('training.stage', 'pretraining'), F('training.stage', 'SFT'), F('training.stage', 'fine-tuning'), F('training.stage', 'reward model')],
    tasks: [
      T('v5-gemma2-task-1', 'Which attention topology does Gemma 2 use?', 'architecture.attention', 'SUPPORTED', { 'architecture.attention': 'grouped-query attention' }, 'Gemma 2 uses Grouped-Query Attention.'),
      T('v5-gemma2-task-2', 'What learning rate was used for pretraining Gemma 2?', 'optimization.optimizer', 'UNKNOWN', {}, 'Learning rate is not captured by the supported predicate set.')]
  },
  'v5-deepseekmoe': {
    facts: [F('architecture.moe', 'mixture of experts'), F('evaluation.regime', 'zero-shot'), F('evaluation.regime', 'few-shot'), F('training.stage', 'SFT'), F('training.stage', 'fine-tuning'), F('architecture.attention', 'multi-head attention'), F('training.stage', 'pretraining'), F('system.parallelism', 'data parallelism')],
    tasks: [
      T('v5-deepseekmoe-task-1', 'What sparse expert architecture does DeepSeekMoE build on?', 'architecture.moe', 'SUPPORTED', { 'architecture.moe': 'mixture of experts' }, 'DeepSeekMoE is a Mixture-of-Experts language model.'),
      T('v5-deepseekmoe-task-2', 'What learning rate was used for DeepSeekMoE pretraining?', 'optimization.optimizer', 'UNKNOWN', {}, 'Learning rate is not captured by the supported predicate set.')]
  },
  'v5-retnet': {
    facts: [F('evaluation.regime', 'zero-shot'), F('evaluation.regime', 'few-shot')],
    tasks: [
      T('v5-retnet-task-1', 'Which attention formulation does RetNet substitute with multi-scale retention?', 'architecture.attention', 'CONFLICTING', { 'architecture.attention': 'FlashAttention' }, 'Extraction surfaces several attention-related mentions (FlashAttention comparisons, multi-head attention baseline, linear-attention variants); the system must report a conflict instead of asserting RetNet uses one of them.'),
      T('v5-retnet-task-2', 'What context length does RetNet train with?', 'optimization.optimizer', 'UNKNOWN', {}, 'Training hyperparameters are not captured by the supported predicate set.')]
  },
  'v5-rwkv': {
    facts: [F('architecture.attention', 'linear attention'), F('evaluation.regime', 'zero-shot'), F('training.stage', 'pretraining'), F('training.stage', 'fine-tuning')],
    tasks: [
      T('v5-rwkv-task-1', 'Which attention formulation does RWKV use?', 'architecture.attention', 'SUPPORTED', { 'architecture.attention': 'linear attention' }, 'RWKV reformulates attention with a variant of linear attention.'),
      T('v5-rwkv-task-2', 'Which corpus was RWKV pretrained on?', 'data.training_dataset', 'UNKNOWN', {}, 'The pretraining corpus is not captured by the supported predicate set.')]
  },
  'v5-reflexion': {
    facts: [F('reasoning.trace_type', 'action'), F('reasoning.trace_type', 'thought'), F('reasoning.trace_type', 'observation')],
    tasks: [
      T('v5-reflexion-task-1', 'Do the agent trajectories contain action elements?', 'reasoning.trace_type', 'SUPPORTED', { 'reasoning.trace_type': 'action' }, 'Trajectories are actor traces with action choices.'),
      T('v5-reflexion-task-2', 'Do the agent trajectories contain thought elements?', 'reasoning.trace_type', 'SUPPORTED', { 'reasoning.trace_type': 'thought' }, 'Actor models include Chain of Thought and ReAct traces.'),
      T('v5-reflexion-task-3', 'Do the agent trajectories contain observation elements?', 'reasoning.trace_type', 'SUPPORTED', { 'reasoning.trace_type': 'observation' }, 'Trajectories include environment observations.')]
  },
  'v5-constitutional': {
    facts: [F('reasoning.trace_type', 'thought'), F('evaluation.regime', 'few-shot'), F('training.stage', 'pretraining')],
    tasks: [
      T('v5-constitutional-task-1', 'Which reasoning trace element appears in the constitutional RL evaluation?', 'reasoning.trace_type', 'SUPPORTED', { 'reasoning.trace_type': 'thought' }, 'Chain-of-Thought prompting is used in the constitutional RL evaluation.'),
      T('v5-constitutional-task-2', 'What batch size was used for RL training?', 'optimization.optimizer', 'UNKNOWN', {}, 'RL batch size is not captured by the supported predicate set.')]
  },
  'v5-llava': {
    facts: [F('model.formulation', 'multimodal model'), F('training.stage', 'fine-tuning'), F('training.stage', 'pretraining'), F('system.parallelism', 'data parallelism')],
    tasks: [
      T('v5-llava-task-1', 'What modality capability does LLaVA target?', 'model.formulation', 'SUPPORTED', { 'model.formulation': 'multimodal model' }, 'LLaVA extends instruction tuning to the language-image multimodal space.'),
      T('v5-llava-task-2', 'During which pretraining stage is feature alignment performed?', 'training.stage', 'SUPPORTED', { 'training.stage': 'pretraining' }, 'Stage 1 is pre-training for feature alignment.')]
  },
  'v5-colbertv2': {
    facts: [F('retrieval.component', 'retriever'), F('retrieval.interaction', 'late interaction'), F('evaluation.regime', 'zero-shot')],
    tasks: [
      T('v5-colbertv2-task-1', 'Which interaction approach does ColBERTv2 use?', 'retrieval.interaction', 'SUPPORTED', { 'retrieval.interaction': 'late interaction' }, 'ColBERTv2 is a late-interaction retriever.'),
      T('v5-colbertv2-task-2', 'Which retrieval component supplies ranked passages?', 'retrieval.component', 'SUPPORTED', { 'retrieval.component': 'retriever' }, 'ColBERTv2 is a late-interaction retriever component.')]
  },
  'v5-flan': {
    facts: [F('reasoning.trace_type', 'thought'), F('evaluation.regime', 'zero-shot'), F('evaluation.regime', 'few-shot')],
    tasks: [
      T('v5-flan-task-1', 'Which reasoning trace type is included in the evaluation suites?', 'reasoning.trace_type', 'SUPPORTED', { 'reasoning.trace_type': 'thought' }, 'Chain-of-Thought evaluation suites are part of the Flan mix.'),
      T('v5-flan-task-2', 'What model size was used for the largest Flan experiments?', 'optimization.optimizer', 'UNKNOWN', {}, 'Model size is not captured by the supported predicate set.')]
  },
  'v5-atlas': {
    facts: [F('retrieval.component', 'retriever'), F('evaluation.regime', 'few-shot'), F('training.stage', 'pretraining'), F('training.stage', 'fine-tuning'), F('retrieval.retriever', 'dual-encoder dense retriever'), F('architecture.formulation', 'text-to-text'), F('training.objective', 'contrastive learning'), F('evaluation.regime', 'zero-shot')],
    tasks: [
      T('v5-atlas-task-1', 'Which retriever architecture does Atlas use?', 'retrieval.retriever', 'SUPPORTED', { 'retrieval.retriever': 'dual-encoder dense retriever' }, 'Atlas retrieves with a general-purpose dual-encoder dense retriever (Contriever).'),
      T('v5-atlas-task-2', 'Which formulation does Atlas follow for its language model?', 'architecture.formulation', 'SUPPORTED', { 'architecture.formulation': 'text-to-text' }, 'Atlas follows the text-to-text framework.')]
  },
  'v5-deepseekv3': {
    facts: [F('training.algorithm', 'GRPO'), F('training.stage', 'reward model'), F('architecture.moe', 'mixture of experts'), F('training.stage', 'SFT'), F('training.stage', 'fine-tuning'), F('training.stage', 'pretraining'), F('training.objective', 'knowledge distillation'), F('reasoning.trace_type', 'thought'), F('system.parallelism', 'data parallelism'), F('evaluation.regime', 'zero-shot'), F('evaluation.method', 'pairwise judging')],
    tasks: [
      T('v5-deepseekv3-task-1', 'Which reinforcement algorithm is used in DeepSeek-V3 post-training?', 'training.algorithm', 'SUPPORTED', { 'training.algorithm': 'GRPO' }, 'DeepSeek-V3 post-training RL uses Group Relative Policy Optimization.'),
      T('v5-deepseekv3-task-2', 'What sparse expert architecture does DeepSeek-V3 use?', 'architecture.moe', 'SUPPORTED', { 'architecture.moe': 'mixture of experts' }, 'DeepSeek-V3 is a large Mixture-of-Experts model with 671B parameters.')]
  },
  'v5-deepseekr1': {
    facts: [F('training.algorithm', 'GRPO'), F('training.stage', 'reward model'), F('evaluation.regime', 'few-shot'), F('reasoning.trace_type', 'thought'), F('architecture.moe', 'mixture of experts'), F('training.stage', 'SFT'), F('training.stage', 'pretraining'), F('evaluation.method', 'pairwise judging'), F('evaluation.regime', 'zero-shot')],
    tasks: [
      T('v5-deepseekr1-task-1', 'Which reinforcement algorithm trains the reasoning model?', 'training.algorithm', 'SUPPORTED', { 'training.algorithm': 'GRPO' }, 'DeepSeek-R1 is trained with GRPO.'),
      T('v5-deepseekr1-task-2', 'What expert architecture is DeepSeek-R1 built on?', 'architecture.moe', 'SUPPORTED', { 'architecture.moe': 'mixture of experts' }, 'R1 is built on DeepSeek-V3, a Mixture-of-Experts model.')]
  },
  'v5-medpalm': {
    facts: [F('evaluation.regime', 'few-shot'), F('reasoning.trace_type', 'thought'), F('reasoning.trace_type', 'intermediate reasoning steps'), F('model.formulation', 'decoder-only Transformer'), F('training.stage', 'pretraining'), F('evaluation.regime', 'zero-shot'), F('training.stage', 'instruction fine-tuning'), F('training.stage', 'fine-tuning')],
    tasks: [
      T('v5-medpalm-task-1', 'What model formulation underlies the clinical language models studied?', 'model.formulation', 'SUPPORTED', { 'model.formulation': 'decoder-only Transformer' }, 'PaLM is a densely-activated decoder-only transformer.'),
      T('v5-medpalm-task-2', 'During which pretraining stage were the largest models trained?', 'training.stage', 'SUPPORTED', { 'training.stage': 'pretraining' }, 'The largest model used 6144 TPUv4 chips for pretraining.'),
      T('v5-medpalm-task-3', 'Which clinical dataset was used for MedQA evaluation?', 'data.training_dataset', 'UNKNOWN', {}, 'Dataset identities are not captured by the supported predicate set.')]
  },
  'v5-hyenadna': {
    facts: [F('training.stage', 'fine-tuning'), F('training.stage', 'pretraining'), F('model.formulation', 'decoder-only Transformer'), F('architecture.operator', 'long convolutions'), F('evaluation.regime', 'few-shot')],
    tasks: [
      T('v5-hyenadna-task-1', 'Which operator does the HyenaDNA block use?', 'architecture.operator', 'SUPPORTED', { 'architecture.operator': 'long convolutions' }, 'The HyenaDNA block is built from long convolutions with element-wise gating.'),
      T('v5-hyenadna-task-2', 'What model formulation does HyenaDNA use?', 'model.formulation', 'SUPPORTED', { 'model.formulation': 'decoder-only Transformer' }, 'HyenaDNA is a decoder-only Hyena architecture pretrained with next-nucleotide prediction.')]
  },
  'v5-dnabert2': {
    facts: [F('training.stage', 'pretraining'), F('training.stage', 'fine-tuning'), F('training.objective', 'masked language model'), F('architecture.attention', 'FlashAttention')],
    tasks: [
      T('v5-dnabert2-task-1', 'Which pretraining objective causes information leakage with overlapping k-mer tokenization?', 'training.objective', 'SUPPORTED', { 'training.objective': 'masked language model' }, 'Overlapping k-mers cause leakage in masked language modeling, motivating the BPE tokenizer.'),
      T('v5-dnabert2-task-2', 'What vocabulary size does DNABERT-2 use?', 'optimization.optimizer', 'UNKNOWN', {}, 'Vocabulary size is not captured by the supported predicate set.')]
  },
  'v5-gw150914': {
    facts: [],
    tasks: [
      T('v5-gw150914-task-1', 'Which training objective was optimized to detect the gravitational wave signal?', 'training.objective', 'UNKNOWN', {}, 'Out-of-domain physics paper with no supported predicate matches; the system must refuse to fabricate scholarly facts rather than answer.')]
  },
  'v5-dpo': {
    facts: [F('training.stage', 'SFT'), F('training.stage', 'pretraining'), F('training.preference_method', 'DPO')],
    tasks: [
      T('v5-dpo-task-1', 'Which preference optimization method does the paper derive?', 'training.preference_method', 'SUPPORTED', { 'training.preference_method': 'DPO' }, 'The paper derives Direct Preference Optimization.'),
      T('v5-dpo-task-2', 'Which optimizer was used for DPO training runs?', 'optimization.optimizer', 'UNKNOWN', {}, 'Optimizer details are not captured by the supported predicate set.')]
  },
  'v5-flashattention2': {
    facts: [F('architecture.attention', 'FlashAttention'), F('architecture.attention', 'multi-head attention')],
    tasks: [
      T('v5-flashattention2-task-1', 'Which attention implementation does the paper introduce?', 'architecture.attention', 'SUPPORTED', { 'architecture.attention': 'FlashAttention' }, 'The paper introduces FlashAttention-2.'),
      T('v5-flashattention2-task-2', 'What learning rate was used for training runs?', 'optimization.optimizer', 'UNKNOWN', {}, 'Learning rate is not captured by the supported predicate set.')]
  },
  'v5-zephyr': {
    facts: [F('training.stage', 'SFT'), F('training.stage', 'fine-tuning'), F('training.preference_method', 'DPO'), F('architecture.attention', 'FlashAttention')],
    tasks: [
      T('v5-zephyr-task-1', 'Which preference optimization method does Zephyr apply?', 'training.preference_method', 'SUPPORTED', { 'training.preference_method': 'DPO' }, 'Zephyr applies distilled direct preference optimization (dDPO).'),
      T('v5-zephyr-task-2', 'What learning rate was used for dDPO training?', 'optimization.optimizer', 'UNKNOWN', {}, 'Learning rate is not captured by the supported predicate set.')]
  },
  'v5-santurkar': {
    facts: [F('training.stage', 'fine-tuning')],
    tasks: [
      T('v5-santurkar-task-1', 'Which training approach produces the opinion alignment studied?', 'training.stage', 'SUPPORTED', { 'training.stage': 'fine-tuning' }, 'The opinion alignment studied comes from RLHF fine-tuned models.'),
      T('v5-santurkar-task-2', 'Which political party do the models lean toward?', 'evaluation.regime', 'UNKNOWN', {}, 'Political leaning is not a supported predicate; the system must refuse rather than fabricate an answer.')]
  },
  'v5-gilardi': {
    facts: [F('evaluation.regime', 'zero-shot')],
    tasks: [
      T('v5-gilardi-task-1', 'In which evaluation regime were the annotation runs performed?', 'evaluation.regime', 'SUPPORTED', { 'evaluation.regime': 'zero-shot' }, 'ChatGPT annotation accuracy was measured in a zero-shot regime.'),
      T('v5-gilardi-task-2', 'How many crowd workers participated in the study?', 'data.training_dataset', 'UNKNOWN', {}, 'Participant counts are not captured by the supported predicate set.')]
  },
  'v5-aifeynman': {
    facts: [],
    tasks: [
      T('v5-aifeynman-task-1', 'Which neural architecture does AI Feynman use for symbolic regression?', 'architecture.formulation', 'UNKNOWN', {}, 'Out-of-domain physics paper where no supported predicate matches; the system must refuse to fabricate scholarly facts.')]
  }
};

const path = 'evals/datasets/research-real-v5.json';
const ds = JSON.parse(readFileSync(path, 'utf8'));
for (const c of ds.cases) {
  const a = annotations[c.caseId];
  if (!a) throw new Error('missing annotations for ' + c.caseId);
  c.facts = a.facts;
  c.tasks = a.tasks;
  c.annotationScope = {
    sections: ['abstract', 'introduction', 'method', 'experiments', 'appendix'],
    predicates: [...new Set(a.facts.map(f => f.predicate))],
    completeness: 'task_linked_non_exhaustive'
  };
}
writeFileSync(path, JSON.stringify(ds, null, 1) + '\n');
const holdout = ds.cases.filter(c => c.split === 'holdout');
console.log('cases:', ds.cases.length, '| holdout:', holdout.length, '| gold facts:', ds.cases.reduce((n, c) => n + c.facts.length, 0), '| tasks:', ds.cases.reduce((n, c) => n + c.tasks.length, 0));
