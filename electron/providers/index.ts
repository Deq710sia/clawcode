/**
 * ClawCode — Provider registry.
 * Lists all built-in provider presets the user can pick in Settings.
 * Includes API providers (OpenAI, Anthropic, Z.ai/GLM, Groq, Together, OpenRouter),
 * local servers (Ollama, LM Studio), and the WebChat Bridge (local Playwright server).
 */
export interface ProviderPreset {
  id: string;
  label: string;
  category: 'api' | 'local' | 'webchat' | 'opencode';
  endpoint: string;
  defaultModel?: string;
  models?: string[];
  docsUrl?: string;
  note?: string;
  isWebChat?: boolean;
  isOpenCode?: boolean;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'api',
    endpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini', 'o1-mini'],
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'api',
    endpoint: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-flash-1.5',
      'meta-llama/llama-3.1-70b-instruct',
      'qwen/qwen-2.5-coder-32b-instruct',
    ],
    docsUrl: 'https://openrouter.ai/keys',
    note: 'Single API key, access 200+ models including free tiers.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Direct)',
    category: 'api',
    endpoint: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-20241022',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    docsUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Direct Anthropic API. NOTE: Anthropic uses /v1/messages, not /v1/chat/completions. ClawCode calls /chat/completions, so this preset only works if Anthropic adds OpenAI-compat mode. Use OpenRouter for Claude models instead.',
  },
  {
    id: 'zai-glm',
    label: 'Z.ai (GLM-5.2)',
    category: 'api',
    endpoint: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5v', 'glm-4-plus', 'glm-5.2'],
    docsUrl: 'https://z.ai/manage/apikey',
    note: 'Z.ai GLM series. GLM-5.2 is the latest flagship; 4.6 is the current stable.',
  },
  {
    id: 'groq',
    label: 'Groq',
    category: 'api',
    endpoint: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    docsUrl: 'https://console.groq.com/keys',
    note: 'Free tier available. Very fast inference.',
  },
  {
    id: 'together',
    label: 'Together AI',
    category: 'api',
    endpoint: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-Coder-32B-Instruct'],
    docsUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    category: 'api',
    endpoint: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    docsUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'deepseek-api',
    label: 'DeepSeek API',
    category: 'api',
    endpoint: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'xai',
    label: 'xAI (Grok API)',
    category: 'api',
    endpoint: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    models: ['grok-2-latest', 'grok-2-mini', 'grok-beta'],
    docsUrl: 'https://console.x.ai',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    category: 'local',
    endpoint: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1:8b',
    models: ['llama3.1:8b', 'llama3.1:70b', 'qwen2.5-coder:7b', 'qwen2.5-coder:32b', 'deepseek-coder-v2', 'mistral-nemo'],
    note: 'Run `ollama serve` first. No API key needed.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    category: 'local',
    endpoint: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    note: 'Start LM Studio\'s local server. No API key needed.',
  },
  {
    id: 'vllm',
    label: 'vLLM (local)',
    category: 'local',
    endpoint: 'http://localhost:8000/v1',
    defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    note: 'vLLM OpenAI-compatible server. Set any string in the API key field.',
  },
  {
    id: 'webchat-claude',
    label: 'WebChat · Claude.ai',
    category: 'webchat',
    endpoint: 'http://127.0.0.1:7777/v1',
    defaultModel: 'claude.ai',
    isWebChat: true,
    note: 'Uses your claude.ai login via headless Chrome. Free with web account.',
  },
  {
    id: 'webchat-chatgpt',
    label: 'WebChat · ChatGPT.com',
    category: 'webchat',
    endpoint: 'http://127.0.0.1:7777/v1',
    defaultModel: 'chatgpt.com',
    isWebChat: true,
    note: 'Uses your chatgpt.com login via headless Chrome.',
  },
  {
    id: 'webchat-gemini',
    label: 'WebChat · Gemini',
    category: 'webchat',
    endpoint: 'http://127.0.0.1:7777/v1',
    defaultModel: 'gemini.google.com',
    isWebChat: true,
    note: 'Uses your gemini.google.com login via headless Chrome.',
  },
  {
    id: 'webchat-grok',
    label: 'WebChat · Grok.com',
    category: 'webchat',
    endpoint: 'http://127.0.0.1:7777/v1',
    defaultModel: 'grok.com',
    isWebChat: true,
    note: 'Uses your grok.com (xAI) login via headless Chrome.',
  },
  {
    id: 'webchat-deepseek',
    label: 'WebChat · DeepSeek',
    category: 'webchat',
    endpoint: 'http://127.0.0.1:7777/v1',
    defaultModel: 'deepseek.com',
    isWebChat: true,
    note: 'Uses your deepseek.com login via headless Chrome.',
  },
  {
    id: 'opencode',
    label: 'OpenCode Backend',
    category: 'opencode',
    endpoint: 'http://127.0.0.1:43182/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    isOpenCode: true,
    note: 'Spawns `opencode serve` as the agent runtime. Brings OpenCode\'s full provider set + tools.',
  },
];

export function getProviderById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getProvidersByCategory(cat: ProviderPreset['category']): ProviderPreset[] {
  return PROVIDERS.filter((p) => p.category === cat);
}
