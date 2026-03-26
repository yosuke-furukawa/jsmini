// TDZ を表す特別な値
const TDZ_SENTINEL = Symbol("TDZ");

export class Environment {
  private values: Map<string, unknown> = new Map();
  private readonly readOnly: Set<string> = new Set();
  private readonly constants: Set<string> = new Set();
  private parent: Environment | null;
  private _isFunctionScope: boolean;
  private _thisValue: unknown = undefined;

  constructor(parent: Environment | null = null, isFunctionScope = false) {
    this.parent = parent;
    this._isFunctionScope = isFunctionScope;
  }

  setThis(value: unknown): void {
    this._thisValue = value;
  }

  getThis(): unknown {
    if (this._isFunctionScope) return this._thisValue;
    if (this.parent) return this.parent.getThis();
    return undefined;
  }

  // var はブロックスコープを貫通し、関数/グローバルスコープに定義される
  findVarScope(): Environment {
    if (this._isFunctionScope || !this.parent) return this;
    return this.parent.findVarScope();
  }

  define(name: string, value: unknown): void {
    this.values.set(name, value);
  }

  defineReadOnly(name: string, value: unknown): void {
    this.values.set(name, value);
    this.readOnly.add(name);
  }

  // let/const 用: TDZ 状態で登録し、初期化時に値をセット
  declareTDZ(name: string): void {
    this.values.set(name, TDZ_SENTINEL);
  }

  defineConst(name: string, value: unknown): void {
    this.values.set(name, value);
    this.constants.add(name);
  }

  has(name: string): boolean {
    if (this.values.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }

  // このスコープだけで持っているか（親は見ない）
  hasOwn(name: string): boolean {
    return this.values.has(name);
  }

  get(name: string): unknown {
    if (this.values.has(name)) {
      const val = this.values.get(name);
      if (val === TDZ_SENTINEL) {
        throw new ReferenceError(`Cannot access '${name}' before initialization`);
      }
      return val;
    }
    if (this.parent) {
      return this.parent.get(name);
    }
    throw new ReferenceError(`${name} is not defined`);
  }

  // 全スコープチェーンの変数をダンプ（デバッグ用）
  dump(): { scope: string; variables: Record<string, unknown> }[] {
    const result: { scope: string; variables: Record<string, unknown> }[] = [];
    let env: Environment | null = this;
    let depth = 0;
    while (env) {
      const variables: Record<string, unknown> = {};
      for (const [key, val] of env.values) {
        if (env.readOnly.has(key)) continue; // undefined, console 等の組み込みはスキップ
        if (typeof val === "object" && val !== null && "params" in val && "body" in val) {
          variables[key] = "[Function]";
        } else {
          variables[key] = val;
        }
      }
      if (Object.keys(variables).length > 0) {
        const scope = depth === 0 ? "local" : env.parent ? `scope[${depth}]` : "global";
        result.push({ scope, variables });
      }
      env = env.parent;
      depth++;
    }
    return result;
  }

  set(name: string, value: unknown): void {
    if (this.values.has(name)) {
      if (this.readOnly.has(name)) return; // undefined 等の書き換え不可は無視
      if (this.constants.has(name)) {
        throw new TypeError(`Assignment to constant variable '${name}'`);
      }
      const current = this.values.get(name);
      if (current === TDZ_SENTINEL) {
        throw new ReferenceError(`Cannot access '${name}' before initialization`);
      }
      this.values.set(name, value);
      return;
    }
    if (this.parent) {
      this.parent.set(name, value);
      return;
    }
    throw new ReferenceError(`${name} is not defined`);
  }
}
