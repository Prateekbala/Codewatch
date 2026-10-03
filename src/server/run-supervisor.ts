export interface ActiveRun {
  readonly headSha: string;
  readonly signal: AbortSignal;
}

export class RunSupervisor {
  readonly #active = new Map<string, { controller: AbortController; headSha: string }>();

  start(key: string, headSha: string): AbortSignal {
    const existing = this.#active.get(key);
    if (existing !== undefined) {
      existing.controller.abort(new Error("superseded"));
    }
    const controller = new AbortController();
    this.#active.set(key, { controller, headSha });
    return controller.signal;
  }

  finish(key: string, headSha: string): void {
    const existing = this.#active.get(key);
    if (existing?.headSha === headSha) {
      this.#active.delete(key);
    }
  }

  get(key: string): ActiveRun | null {
    const existing = this.#active.get(key);
    return existing === undefined
      ? null
      : { headSha: existing.headSha, signal: existing.controller.signal };
  }
}
