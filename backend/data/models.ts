// A few models in the slim form of the models.dev catalog (XLR8-93), for the local test data and the
// end-to-end tests: local work and CI need no request to models.dev. Values as listed there in
// October 2026; the real catalog replaces them on the first sync.

export const SAMPLE_MODELS = [
  {
    provider: 'anthropic',
    name: 'Anthropic',
    hash: 'sample',
    models: [
      { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', family: 'claude-opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modes: ['fast'], context: 1_000_000, output: 128_000, releaseDate: '2026-09-22' },
      { modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', family: 'claude-sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: 1_000_000, output: 64_000, releaseDate: '2026-09-28' },
      { modelId: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', family: 'claude-haiku', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: 1_000_000, output: 64_000, releaseDate: '2026-10-07' },
    ],
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    hash: 'sample',
    models: [
      { modelId: 'gpt-6-sol', name: 'GPT-6 Sol', family: 'gpt', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], modes: ['fast', 'pro'], context: 1_050_000, output: 128_000, releaseDate: '2026-09-22' },
      { modelId: 'gpt-5.6', name: 'GPT-5.6', family: 'gpt', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], modes: ['fast', 'pro'], context: 1_050_000, output: 128_000, releaseDate: '2026-07-09' },
    ],
  },
  {
    provider: 'google',
    name: 'Google',
    hash: 'sample',
    models: [{ modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', family: 'gemini-flash', efforts: ['low', 'medium', 'high'], context: 1_048_576, output: 65_536, releaseDate: '2026-09-02' }],
  },
];

/** Enabled in the test data: offered in the chip. */
export const SAMPLE_ENABLED = [
  { provider: 'anthropic', modelId: 'claude-opus-5-5' },
  { provider: 'anthropic', modelId: 'claude-sonnet-5-5' },
  { provider: 'openai', modelId: 'gpt-6-sol' },
];
