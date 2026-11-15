// Готовые наборы моделей для пикера. В наборах только модели, умеющие вызывать инструменты:
// без них агент не может работать с файлами и терминалом.
export interface ModelSet {
  key: 'everyday' | 'coding' | 'budget'
  models: readonly string[]
}

export const MODEL_SETS: readonly ModelSet[] = [
  {
    key: 'everyday',
    models: [
      'anthropic/claude-sonnet-5.5',
      'deepseek/deepseek-v4.1-flash',
      'openai/gpt-6.1-sol',
      'google/gemini-4-argon',
      'anthropic/claude-opus-5.5',
      'moonshotai/kimi-k3.1-pro',
      'z-ai/glm-5.3-flash',
    ],
  },
  {
    // Совпадает с подборкой routerai.ru/agent-install/models для кодовых агентов.
    key: 'coding',
    models: [
      'anthropic/claude-opus-5.5',
      'google/gemini-4-argon',
      'z-ai/glm-5.3-flash',
      'openai/gpt-6.1-sol',
      'moonshotai/kimi-k3.1-pro',
    ],
  },
  {
    key: 'budget',
    models: ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'],
  },
]

/** Что видит в пикере новый пользователь. */
export const STARTER_MODELS: readonly string[] = MODEL_SETS[0]!.models
