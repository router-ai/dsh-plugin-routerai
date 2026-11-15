// Адаптер маршрута: штатный PiAiAdapter плюс три вещи, нужные RouterAI, —
// подписи моделей в пикере, учёт токенов каждого вызова и человеческие сообщения о деньгах.
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CallTokens } from './costs.ts'
import { describeProblem } from './failures.ts'
import type { MoneyProblem } from './failures.ts'

export interface RouteObserver {
  /** Подпись модели в пикере или пустая строка. */
  caption(model: string): string
  /** Показывать ли модель в пикере (служебная модель есть в маршруте, но выбирать её не предлагаем). */
  offered(model: string): boolean
  /** Завершился вызов модели: сколько токенов он занял. */
  spent(call: GenerateOptions, tokens: CallTokens): void
  /** RouterAI отказал из-за денег. */
  refused(problem: MoneyProblem): void
}

export class RouterAiAdapter extends PiAiAdapter {
  constructor(options: PiAiAdapterOptions, private readonly observer: RouteObserver) {
    super(options)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const listed: LlmModelInfo[] = []
    for (const model of await super.listModels(provider)) {
      if (!this.observer.offered(model.id)) continue
      const caption = this.observer.caption(model.id)
      listed.push(caption === '' ? model : { ...model, description: caption })
    }
    return listed
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.watch(options, super.stream(options))
  }

  /** Агент «замораживает» вызов на шаг через prepareCall — наблюдать нужно и этот путь. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    return { ...call, stream: options => this.watch(options, call.stream(options)) }
  }

  private async* watch(options: GenerateOptions, source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    try {
      for await (const chunk of source) {
        if (chunk.type === 'usage') {
          this.observer.spent(options, chunk.usage)
        } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          const problem = describeProblem(chunk.reason.failure)
          if (problem !== undefined) {
            this.observer.refused(problem)
            // Код QUOTA harness показывает как нехватку квоты, а не как сбой сети.
            yield { ...chunk, reason: { kind: 'error', failure: { ...chunk.reason.failure, code: 'QUOTA', message: problem.text } } }
            continue
          }
        }
        yield chunk
      }
    } catch (error) {
      const problem = error instanceof LlmError
        ? describeProblem({ message: error.message, status: (error as { status?: number }).status })
        : undefined
      if (problem === undefined) throw error
      this.observer.refused(problem)
      throw new LlmError(problem.text, 'QUOTA', { cause: error })
    }
  }
}
