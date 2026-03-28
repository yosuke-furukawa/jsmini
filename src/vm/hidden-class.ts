// Hidden Class — オブジェクトのプロパティレイアウトを追跡
// V8 の Map に相当する最小実装

let nextId = 0;

export type HiddenClass = {
  id: number;
  properties: Map<string, number>;  // name → slot offset
  transitions: Map<string, HiddenClass>;  // プロパティ名 → 次の HC
};

// 空の Hidden Class (全オブジェクトの起点)
const ROOT_HC: HiddenClass = {
  id: nextId++,
  properties: new Map(),
  transitions: new Map(),
};

// 空の Hidden Class を取得
export function getRootHC(): HiddenClass {
  return ROOT_HC;
}

// プロパティを追加して新しい HC に遷移
// 既に同じ遷移があればキャッシュを返す (遷移チェーンの共有)
export function transition(hc: HiddenClass, name: string): HiddenClass {
  // 既にこのプロパティを持っている場合は遷移不要
  if (hc.properties.has(name)) return hc;

  // 既存の遷移があるか
  const existing = hc.transitions.get(name);
  if (existing) return existing;

  // 新しい HC を作成
  const newProps = new Map(hc.properties);
  newProps.set(name, newProps.size); // 次の offset = 現在のサイズ
  const newHC: HiddenClass = {
    id: nextId++,
    properties: newProps,
    transitions: new Map(),
  };

  // 遷移テーブルに登録
  hc.transitions.set(name, newHC);

  return newHC;
}

// プロパティのオフセットを返す (-1 = 未定義)
export function lookupOffset(hc: HiddenClass, name: string): number {
  return hc.properties.get(name) ?? -1;
}
