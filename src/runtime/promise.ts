// Promise 実装 — jsmini のランタイム組み込み
//
// ECMAScript 仕様 (27.2) に基づく Promise オブジェクト。
// state (pending/fulfilled/rejected) + result + reactions で管理。

export type PromiseState = "pending" | "fulfilled" | "rejected";

export type PromiseReaction = {
  onFulfilled: ((value: unknown) => unknown) | undefined;
  onRejected: ((reason: unknown) => unknown) | undefined;
  childPromise: JSPromise;
};

export class JSPromise {
  __promise__: true = true;
  state: PromiseState = "pending";
  result: unknown = undefined;
  fulfillReactions: PromiseReaction[] = [];
  rejectReactions: PromiseReaction[] = [];

  constructor(executor?: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void) {
    if (executor) {
      const resolve = (value: unknown) => this._resolve(value);
      const reject = (reason: unknown) => this._reject(reason);
      try {
        executor(resolve, reject);
      } catch (e) {
        reject(e);
      }
    }
  }

  private _resolve(value: unknown): void {
    if (this.state !== "pending") return;

    // thenable チェック: value が Promise なら adopt
    if (value instanceof JSPromise) {
      // value の状態を引き継ぐ
      if (value.state === "fulfilled") {
        this._fulfill(value.result);
      } else if (value.state === "rejected") {
        this._reject(value.result);
      } else {
        // pending: value が settle したら自分も settle
        value.then(
          (v: unknown) => this._resolve(v),
          (r: unknown) => this._reject(r),
        );
      }
      return;
    }

    this._fulfill(value);
  }

  private _fulfill(value: unknown): void {
    if (this.state !== "pending") return;
    this.state = "fulfilled";
    this.result = value;
    // fulfillReactions を microtask キューに enqueue
    for (const reaction of this.fulfillReactions) {
      enqueueMicrotask(() => runReaction(reaction, "fulfilled", value));
    }
    this.fulfillReactions = [];
    this.rejectReactions = [];
  }

  private _reject(reason: unknown): void {
    if (this.state !== "pending") return;
    this.state = "rejected";
    this.result = reason;
    for (const reaction of this.rejectReactions) {
      enqueueMicrotask(() => runReaction(reaction, "rejected", reason));
    }
    this.fulfillReactions = [];
    this.rejectReactions = [];
  }

  then(
    onFulfilled?: ((value: unknown) => unknown) | undefined | null,
    onRejected?: ((reason: unknown) => unknown) | undefined | null,
  ): JSPromise {
    const child = new JSPromise();
    const reaction: PromiseReaction = {
      onFulfilled: typeof onFulfilled === "function" ? onFulfilled : undefined,
      onRejected: typeof onRejected === "function" ? onRejected : undefined,
      childPromise: child,
    };

    if (this.state === "pending") {
      this.fulfillReactions.push(reaction);
      this.rejectReactions.push(reaction);
    } else if (this.state === "fulfilled") {
      enqueueMicrotask(() => runReaction(reaction, "fulfilled", this.result));
    } else {
      enqueueMicrotask(() => runReaction(reaction, "rejected", this.result));
    }

    return child;
  }

  catch(onRejected?: ((reason: unknown) => unknown) | undefined | null): JSPromise {
    return this.then(undefined, onRejected);
  }

  // Promise.resolve
  static resolve(value: unknown): JSPromise {
    if (value instanceof JSPromise) return value;
    const p = new JSPromise();
    p._fulfill(value);
    return p;
  }

  // Promise.reject
  static reject(reason: unknown): JSPromise {
    const p = new JSPromise();
    p._reject(reason);
    return p;
  }
}

// ========== PromiseReactionJob ==========

function runReaction(reaction: PromiseReaction, type: "fulfilled" | "rejected", value: unknown): void {
  const handler = type === "fulfilled" ? reaction.onFulfilled : reaction.onRejected;
  const child = reaction.childPromise;

  if (handler) {
    try {
      const result = handler(value);
      // handler の戻り値で子 Promise を resolve
      child._resolve(result);
    } catch (e) {
      child._reject(e);
    }
  } else {
    // handler なし: 値をそのまま伝播
    if (type === "fulfilled") {
      child._fulfill(value);
    } else {
      child._reject(value);
    }
  }
}

// ========== Microtask キュー ==========

const microtaskQueue: (() => void)[] = [];

export function enqueueMicrotask(task: () => void): void {
  microtaskQueue.push(task);
}

// microtask キューを drain (全タスクを実行)
// drain 中に追加されたタスクも処理する (then チェーン)
export function drainMicrotasks(): void {
  while (microtaskQueue.length > 0) {
    const task = microtaskQueue.shift()!;
    task();
  }
}

// ========== ヘルパー ==========

export function isJSPromise(value: unknown): value is JSPromise {
  return value instanceof JSPromise;
}

// JSPromise の _resolve / _reject を外部から呼べるようにするアクセサ
// (async/await の resume で使う)
export function resolvePromise(promise: JSPromise, value: unknown): void {
  (promise as any)._resolve(value);
}

export function rejectPromise(promise: JSPromise, reason: unknown): void {
  (promise as any)._reject(reason);
}
