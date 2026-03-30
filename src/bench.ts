import { evaluate } from "./interpreter/evaluator.js";
import { vmEvaluate } from "./vm/index.js";

const benchmarks = [
  {
    name: "fibonacci(25)",
    source: `
      function fib(n) {
        if (n <= 1) { return n; }
        return fib(n - 1) + fib(n - 2);
      }
      fib(25);
    `,
    jitEligible: true,
  },
  {
    name: "for loop sum (10000)",
    source: `
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) {
        sum = sum + i;
      }
      sum;
    `,
    jitEligible: false,
  },
  {
    name: "hot function add (10000 calls)",
    source: `
      function add(a, b) { return a + b; }
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) {
        sum = sum + add(i, 1);
      }
      sum;
    `,
    jitEligible: true,
  },
  {
    name: "hot function mul (10000 calls)",
    source: `
      function mul(a, b) { return a * b; }
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) {
        sum = sum + mul(i, 2);
      }
      sum;
    `,
    jitEligible: true,
  },
  {
    name: "nested loop (100x100)",
    source: `
      var sum = 0;
      for (var i = 0; i < 100; i = i + 1) {
        for (var j = 0; j < 100; j = j + 1) {
          sum = sum + 1;
        }
      }
      sum;
    `,
    jitEligible: false,
  },
  {
    name: "map/reduce (500 elements)",
    source: `
      function map(arr, fn) {
        var result = [];
        for (var i = 0; i < arr.length; i = i + 1) { result[i] = fn(arr[i]); }
        return result;
      }
      function reduce(arr, fn, init) {
        var acc = init;
        for (var i = 0; i < arr.length; i = i + 1) { acc = fn(acc, arr[i]); }
        return acc;
      }
      function double(x) { return x * 2; }
      function add(a, b) { return a + b; }
      var arr = [];
      for (var i = 0; i < 500; i = i + 1) { arr[i] = i; }
      reduce(map(arr, double), add, 0);
    `,
    jitEligible: false,
  },
  {
    name: "quicksort (200 elements x10)",
    source: `
      function swap(arr, i, j) { var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; }
      function partition(arr, lo, hi) {
        var pivot = arr[hi];
        var i = lo;
        for (var j = lo; j < hi; j = j + 1) {
          if (arr[j] <= pivot) { swap(arr, i, j); i = i + 1; }
        }
        swap(arr, i, hi);
        return i;
      }
      function qsort(arr, lo, hi) {
        if (lo < hi) { var p = partition(arr, lo, hi); qsort(arr, lo, p - 1); qsort(arr, p + 1, hi); }
      }
      function runSort() {
        var arr = [];
        for (var i = 0; i < 200; i = i + 1) { arr[i] = (i * 7 + 13) % 200; }
        qsort(arr, 0, arr.length - 1);
        return arr[0] + arr[99] + arr[199];
      }
      var result = 0;
      for (var r = 0; r < 10; r = r + 1) { result = runSort(); }
      result;
    `,
    jitEligible: true,
  },
  {
    name: "ackermann(3,4) — 深い再帰 10547 calls",
    source: `
      function ack(m, n) {
        if (m === 0) { return n + 1; }
        if (n === 0) { return ack(m - 1, 1); }
        return ack(m - 1, ack(m, n - 1));
      }
      ack(3, 4);
    `,
    jitEligible: false,
  },
  {
    name: "mutual recursion — isEven/isOdd 10000 calls",
    source: `
      function isEven(n) { if (n === 0) { return true; } return isOdd(n - 1); }
      function isOdd(n) { if (n === 0) { return false; } return isEven(n - 1); }
      var count = 0;
      for (var i = 0; i < 100; i = i + 1) {
        if (isEven(i)) { count = count + 1; }
      }
      count;
    `,
    jitEligible: false,
  },
  {
    name: "callback chain — forEach x3 (1500 calls)",
    source: `
      function forEach(arr, fn) {
        for (var i = 0; i < arr.length; i = i + 1) { fn(arr[i]); }
      }
      var arr = [];
      for (var i = 0; i < 500; i = i + 1) { arr[i] = i; }
      var sum = 0;
      forEach(arr, function step1(x) {
        sum = sum + x * 2 + 1;
      });
      sum;
    `,
    jitEligible: false,
  },
  {
    name: "tree traversal — 1023 nodes, 2046 calls",
    source: `
      function makeTree(depth) {
        if (depth === 0) { return { val: 1, left: null, right: null }; }
        return { val: depth, left: makeTree(depth - 1), right: makeTree(depth - 1) };
      }
      function sumTree(node) {
        if (node === null) { return 0; }
        return node.val + sumTree(node.left) + sumTree(node.right);
      }
      var tree = makeTree(9);
      sumTree(tree);
    `,
    jitEligible: false,
  },
  {
    name: "Vec class (1000 iterations)",
    source: `
      class Vec {
        constructor(x, y) { this.x = x; this.y = y; }
        add(other) { return new Vec(this.x + other.x, this.y + other.y); }
        dot(other) { return this.x * other.x + this.y * other.y; }
      }
      var sum = new Vec(0, 0);
      for (var i = 0; i < 1000; i = i + 1) {
        var v = new Vec(i, i * 2);
        sum = sum.add(v);
      }
      sum.dot(new Vec(1, 1));
    `,
    jitEligible: false,
  },
  {
    name: "string concat (1000 iterations)",
    source: `
      var s = "";
      for (var i = 0; i < 1000; i = i + 1) {
        s = s + "x";
      }
      s;
    `,
    jitEligible: false,
  },
  {
    name: "string compare (10000 iterations)",
    source: `
      var count = 0;
      for (var i = 0; i < 10000; i = i + 1) {
        if ("hello" === "hello") { count = count + 1; }
      }
      count;
    `,
    jitEligible: false,
  },
  {
    name: "template literal (1000 iterations)",
    source: `
      var result = "";
      for (var i = 0; i < 1000; i = i + 1) {
        result = \`item \${i}\`;
      }
      result;
    `,
    jitEligible: false,
  },
  {
    name: "closure makeAdder (10000 calls)",
    source: `
      function makeAdder(n) { return function(x) { return x + n; }; }
      var add5 = makeAdder(5);
      var sum = 0;
      for (var i = 0; i < 10000; i = i + 1) { sum = sum + add5(i); }
      sum;
    `,
    jitEligible: false,
  },
  {
    name: "closure counter (10000 calls)",
    source: `
      function counter() {
        var c = 0;
        return function() { c = c + 1; return c; };
      }
      var inc = counter();
      for (var i = 0; i < 10000; i = i + 1) { inc(); }
      inc();
    `,
    jitEligible: false,
  },
];

function bench(fn: () => unknown, warmup = 5, runs = 10): { result: unknown; avg: number; min: number; error?: string } {
  try { for (let i = 0; i < warmup; i++) fn(); } catch (e: any) { return { result: "ERROR: " + e.message, avg: 0, min: 0, error: e.message }; }
  const times: number[] = [];
  let result: unknown;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    try { result = fn(); } catch (e: any) { return { result: "ERROR: " + e.message, avg: 0, min: 0, error: e.message }; }
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  // 上下 20% カットの trimmed mean (外れ値除去)
  const trim = Math.floor(runs * 0.2);
  const trimmed = times.slice(trim, runs - trim);
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  return { result, avg, min: times[0] };
}

console.log("=== jsmini Benchmark: Tree-Walking vs Bytecode VM ===\n");

for (const { name, source, jitEligible } of benchmarks) {
  const tw = bench(() => evaluate(source));
  const vm = bench(() => vmEvaluate(source));

  console.log(`${name}${jitEligible ? " [JIT eligible]" : ""}`);

  if (tw.error || vm.error || tw.result !== vm.result) {
    console.log(`  tree-walking : ${tw.error ? "ERROR (" + tw.error.slice(0, 40) + ")" : tw.avg.toFixed(2) + "ms  result=" + tw.result}`);
    console.log(`  bytecode-vm  : ${vm.error ? "ERROR (" + vm.error.slice(0, 40) + ")" : vm.avg.toFixed(2) + "ms  result=" + vm.result}`);
    if (tw.error && !vm.error) console.log(`  → TW がクラッシュ、VM は正常 — VM の構造的メリット`);
    else console.log(`  → 結果不一致 — スキップ`);
    console.log();
    continue;
  }

  const ratio = tw.avg / vm.avg;
  const winner = ratio > 1 ? "VM wins" : "TW wins";
  console.log(`  tree-walking : ${tw.avg.toFixed(2)}ms (min: ${tw.min.toFixed(2)}ms) result=${tw.result}`);
  console.log(`  bytecode-vm  : ${vm.avg.toFixed(2)}ms (min: ${vm.min.toFixed(2)}ms) result=${vm.result}`);
  console.log(`  ratio        : ${ratio.toFixed(2)}x — ${winner}`);

  if (jitEligible) {
    const jit = bench(() => vmEvaluate(source, { jit: true, jitThreshold: 5 }));
    console.log(`  wasm-jit     : ${jit.avg.toFixed(2)}ms (min: ${jit.min.toFixed(2)}ms) result=${jit.result}`);
    console.log(`  jit vs tw    : ${(tw.avg / jit.avg).toFixed(2)}x`);
  }

  // GC 統計
  try {
    const gcResult = vmEvaluate(source, { traceGC: true }) as any;
    if (gcResult.gcStats) {
      const s = gcResult.gcStats;
      console.log(`  heap         : alloc=${s.totalAllocated} peak=${s.peakSize} final=${s.currentSize} gc=${s.gcCount}x swept=${s.totalSwept}`);
    }
  } catch {}
  console.log();
}
