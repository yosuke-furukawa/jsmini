// Range Analysis — 各 Op の値の範囲 [min, max] を追跡
//
// コンパイル時に i32 で安全か判定し、危険なら f64 に昇格する。
// 実行時の overflow チェックは不要。

import type { IRFunction, Op, PhiOp } from "./types.js";
import { isPhi } from "./types.js";

// ========== Range 型 ==========

export type Range = {
  min: number;
  max: number;
};

const I32_MIN = -(2 ** 31);       // -2147483648
const I32_MAX = 2 ** 31 - 1;      // 2147483647

export const RANGE_I32: Range = { min: I32_MIN, max: I32_MAX };
export const RANGE_UNKNOWN: Range = { min: -Infinity, max: Infinity };

export function canFitI32(range: Range): boolean {
  return range.min >= I32_MIN && range.max <= I32_MAX;
}

// ========== Range 伝播 ==========

export function analyzeRanges(irFunc: IRFunction): Map<number, Range> {
  const ranges = new Map<number, Range>();

  // Op を id で引けるテーブル
  const opById = new Map<number, Op>();
  for (const block of irFunc.blocks) {
    for (const phi of block.phis) opById.set(phi.id, phi);
    for (const op of block.ops) opById.set(op.id, op);
  }

  function getRange(opId: number): Range {
    return ranges.get(opId) ?? RANGE_I32;
  }

  // fixpoint: range が安定するまで繰り返す
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;

    for (const block of irFunc.blocks) {
      // Phi
      for (const phi of block.phis) {
        const newRange = computePhiRange(phi, ranges);
        if (updateRange(ranges, phi.id, newRange)) changed = true;
      }

      // 通常の Op
      for (const op of block.ops) {
        const newRange = computeOpRange(op, getRange, opById);
        if (newRange && updateRange(ranges, op.id, newRange)) changed = true;
      }
    }

    if (!changed) break;
  }

  return ranges;
}

function updateRange(ranges: Map<number, Range>, id: number, newRange: Range): boolean {
  const old = ranges.get(id);
  if (old && old.min === newRange.min && old.max === newRange.max) return false;
  ranges.set(id, newRange);
  return true;
}

// ========== Op ごとの Range 計算 ==========

function computeOpRange(
  op: Op,
  getRange: (id: number) => Range,
  opById: Map<number, Op>,
): Range | null {
  switch (op.opcode) {
    case "Const": {
      if (typeof op.value === "number") {
        return { min: op.value, max: op.value };
      }
      if (typeof op.value === "boolean") {
        return { min: op.value ? 1 : 0, max: op.value ? 1 : 0 };
      }
      return null;
    }

    case "Param":
      return RANGE_I32;

    case "Undefined":
      return { min: 0, max: 0 };

    case "Add": {
      const l = getRange(op.args[0]), r = getRange(op.args[1]);
      return { min: l.min + r.min, max: l.max + r.max };
    }

    case "Sub": {
      const l = getRange(op.args[0]), r = getRange(op.args[1]);
      return { min: l.min - r.max, max: l.max - r.min };
    }

    case "Mul": {
      const l = getRange(op.args[0]), r = getRange(op.args[1]);
      // 4 通りの組み合わせの min/max
      const products = [l.min * r.min, l.min * r.max, l.max * r.min, l.max * r.max];
      return { min: Math.min(...products), max: Math.max(...products) };
    }

    case "Div": {
      const r = getRange(op.args[1]);
      if (r.min > 0 || r.max < 0) {
        // 除数がゼロを含まない
        const l = getRange(op.args[0]);
        const quotients = [l.min / r.min, l.min / r.max, l.max / r.min, l.max / r.max];
        return {
          min: Math.min(...quotients.map(Math.floor)),
          max: Math.max(...quotients.map(Math.ceil)),
        };
      }
      return RANGE_I32; // ゼロ除算の可能性 → 全範囲
    }

    case "Mod": {
      const r = getRange(op.args[1]);
      if (r.min > 0) {
        // 正の定数で mod → [0, r.max - 1]
        return { min: 0, max: r.max - 1 };
      }
      return RANGE_I32;
    }

    case "Negate": {
      const a = getRange(op.args[0]);
      return { min: -a.max, max: -a.min };
    }

    // 比較 → 結果は 0 or 1
    case "LessThan": case "LessEqual":
    case "GreaterThan": case "GreaterEqual":
    case "Equal": case "StrictEqual":
    case "NotEqual": case "StrictNotEqual":
    case "Not":
      return { min: 0, max: 1 };

    // ビット演算は i32 に収まる
    case "BitAnd": case "BitOr": case "BitXor": case "BitNot":
    case "ShiftLeft": case "ShiftRight":
      return RANGE_I32;

    // TypeGuard: 元の値と同じ range
    case "TypeGuard":
      return getRange(op.args[0]);

    // 配列: 値がわからない → 全範囲
    case "ArrayGet": case "ArrayLength":
      return RANGE_I32;
    case "ArraySet":
      return null;

    // LoadGlobal: 全範囲 (値がわからない)
    case "LoadGlobal":
      return RANGE_I32;

    // Increment/Decrement は builder で Add/Sub に展開されるので来ないはず
    default:
      return null;
  }
}

// ========== Phi の Range ==========

function computePhiRange(phi: PhiOp, ranges: Map<number, Range>): Range {
  if (phi.inputs.length === 0) return RANGE_I32;

  let min = Infinity;
  let max = -Infinity;
  for (const [, valueId] of phi.inputs) {
    const r = ranges.get(valueId) ?? RANGE_I32;
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
  }
  return { min, max };
}

// ========== 関数全体の overflow 判定 ==========

// 関数内の全演算が i32 に収まるか判定
export function functionNeedsF64(irFunc: IRFunction): boolean {
  // Math.X 呼び出しは f64 in/out → 関数全体を f64 に格上げ
  for (const block of irFunc.blocks) {
    for (const op of block.ops) {
      if (op.opcode === "Call" && op.calleeName?.startsWith("Math.")) return true;
    }
  }
  const ranges = analyzeRanges(irFunc);
  for (const [, range] of ranges) {
    if (!canFitI32(range)) return true;
  }
  return false;
}
