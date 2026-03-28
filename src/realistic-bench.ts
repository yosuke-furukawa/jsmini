// より現実的なプログラムでのベンチマーク
// 関数呼び出し、オブジェクト操作、条件分岐、再帰が混在

import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate, flatVmEvaluate } from "./vm/index.js";

function bench(fn: () => unknown, warmup = 3, runs = 10): { avg: number; result: unknown } {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  let result: unknown;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return { avg, result };
}

const benchmarks = [
  {
    name: "単純 for ループ (従来)",
    source: `
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) { sum = sum + i; }
      sum;
    `,
  },
  {
    name: "関数呼び出し多数 (map/reduce 的パターン)",
    source: `
      function map(arr, fn) {
        var result = [];
        for (var i = 0; i < arr.length; i = i + 1) {
          result[i] = fn(arr[i], i);
        }
        return result;
      }
      function reduce(arr, fn, init) {
        var acc = init;
        for (var i = 0; i < arr.length; i = i + 1) {
          acc = fn(acc, arr[i]);
        }
        return acc;
      }
      function double(x) { return x * 2; }
      function add(a, b) { return a + b; }

      var arr = [];
      for (var i = 0; i < 500; i = i + 1) { arr[i] = i; }
      var doubled = map(arr, double);
      reduce(doubled, add, 0);
    `,
  },
  {
    name: "オブジェクト操作 (プロパティ読み書き多数)",
    source: `
      function makePoint(x, y) {
        return { x: x, y: y };
      }
      function distance(a, b) {
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        return dx * dx + dy * dy;
      }
      function closest(points, target) {
        var minDist = 999999;
        var minIdx = 0;
        for (var i = 0; i < points.length; i = i + 1) {
          var d = distance(points[i], target);
          if (d < minDist) {
            minDist = d;
            minIdx = i;
          }
        }
        return minIdx;
      }

      var points = [];
      for (var i = 0; i < 500; i = i + 1) {
        points[i] = makePoint(i % 100, i % 50);
      }
      var target = makePoint(42, 23);
      var result = 0;
      for (var j = 0; j < 20; j = j + 1) {
        target = makePoint(j * 5, j * 3);
        result = result + closest(points, target);
      }
      result;
    `,
  },
  {
    name: "再帰 + 条件分岐 (ソートアルゴリズム的)",
    source: `
      function partition(arr, lo, hi) {
        var pivot = arr[hi];
        var i = lo;
        for (var j = lo; j < hi; j = j + 1) {
          if (arr[j] <= pivot) {
            var tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
            i = i + 1;
          }
        }
        var tmp2 = arr[i];
        arr[i] = arr[hi];
        arr[hi] = tmp2;
        return i;
      }
      function quicksort(arr, lo, hi) {
        if (lo < hi) {
          var p = partition(arr, lo, hi);
          quicksort(arr, lo, p - 1);
          quicksort(arr, p + 1, hi);
        }
      }

      var arr = [];
      for (var i = 0; i < 200; i = i + 1) {
        arr[i] = (i * 7 + 13) % 200;
      }
      quicksort(arr, 0, arr.length - 1);
      arr[0] + arr[99] + arr[199];
    `,
  },
  {
    name: "クラス + メソッドチェーン的パターン",
    source: `
      class Vec {
        constructor(x, y) {
          this.x = x;
          this.y = y;
        }
        add(other) {
          return new Vec(this.x + other.x, this.y + other.y);
        }
        scale(n) {
          return new Vec(this.x * n, this.y * n);
        }
        dot(other) {
          return this.x * other.x + this.y * other.y;
        }
      }

      var sum = new Vec(0, 0);
      for (var i = 0; i < 1000; i = i + 1) {
        var v = new Vec(i, i * 2);
        sum = sum.add(v.scale(2));
      }
      sum.dot(new Vec(1, 1));
    `,
  },
  {
    name: "コールバック多段 (イベントハンドラ的)",
    source: `
      function forEach(arr, fn) {
        for (var i = 0; i < arr.length; i = i + 1) {
          fn(arr[i], i);
        }
      }
      function filter(arr, fn) {
        var result = [];
        forEach(arr, function check(item, idx) {
          if (fn(item)) {
            result[result.length] = item;
          }
        });
        return result;
      }
      function transform(arr, fn) {
        var result = [];
        forEach(arr, function apply(item, idx) {
          result[result.length] = fn(item);
        });
        return result;
      }

      var data = [];
      for (var i = 0; i < 500; i = i + 1) { data[i] = i; }
      var evens = filter(data, function isEven(n) { return n % 2 === 0; });
      var doubled = transform(evens, function dbl(n) { return n * 2; });
      var total = 0;
      forEach(doubled, function sum(n) { total = total + n; });
      total;
    `,
  },
];

console.log("=== 現実的なプログラムでの TW vs VM 比較 (V8-JITless) ===\n");

for (const { name, source } of benchmarks) {
  const tw = bench(() => evaluate(source));

  let vm: { avg: number; result: unknown } | null = null;
  let flat: { avg: number; result: unknown } | null = null;
  try { vm = bench(() => vmEvaluate(source)); } catch {}
  try { flat = bench(() => flatVmEvaluate(source)); } catch {}

  console.log(`${name}`);
  console.log(`  TW:     ${tw.avg.toFixed(2).padStart(8)}ms  result=${tw.result}`);

  if (vm && vm.result === tw.result) {
    const ratio = tw.avg / vm.avg;
    console.log(`  ObjVM:  ${vm.avg.toFixed(2).padStart(8)}ms  result=${vm.result}  ${ratio > 1 ? "VM wins" : "TW wins"} (${ratio.toFixed(2)}x)`);
  } else {
    console.log(`  ObjVM:  (結果不一致または未対応 — 比較スキップ)`);
  }

  if (flat && flat.result === tw.result) {
    const ratio = tw.avg / flat.avg;
    console.log(`  FlatVM: ${flat.avg.toFixed(2).padStart(8)}ms  result=${flat.result}  ${ratio > 1 ? "VM wins" : "TW wins"} (${ratio.toFixed(2)}x)`);
  } else {
    console.log(`  FlatVM: (結果不一致または未対応 — 比較スキップ)`);
  }
  console.log();
}
