import type { Token, TokenType } from "./token.js";

const KEYWORDS: Record<string, TokenType> = Object.create(null);
Object.assign(KEYWORDS, {
  var: "Var",
  let: "Let",
  const: "Const",
  if: "If",
  else: "Else",
  true: "True",
  false: "False",
  null: "Null",
  while: "While",
  for: "For",
  function: "Function",
  return: "Return",
  break: "Break",
  continue: "Continue",
  typeof: "Typeof",
  throw: "Throw",
  try: "Try",
  catch: "Catch",
  finally: "Finally",
  new: "New",
  this: "This",
  class: "Class",
  extends: "Extends",
  super: "Super",
  of: "Of",
  in: "In",
  instanceof: "Instanceof",
  do: "Do",
  switch: "Switch",
  case: "Case",
  default: "Default",
  delete: "Delete",
  void: "Void",
  yield: "Yield",
  async: "Async",
  await: "Await",
  // undefined は予約語ではないのでキーワードに含めない
});

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 1;

  // テンプレートリテラルのネスト管理
  // スタックに template の深さを積む。} が来たときにスタックが空でなければ
  // テンプレート文字列モードに戻る
  const templateDepthStack: number[] = [];
  let braceDepth = 0;

  function peek(offset = 0): string {
    return source[pos + offset] ?? "";
  }

  function advance(): string {
    const ch = source[pos];
    pos++;
    column++;
    return ch;
  }

  function pushToken(type: TokenType, value: string, startColumn: number): void {
    tokens.push({ type, value, line, column: startColumn });
  }

  while (pos < source.length) {
    const ch = peek();

    // コメントのスキップ
    if (ch === "/" && peek(1) === "/") {
      while (pos < source.length && peek() !== "\n") advance();
      continue;
    }
    if (ch === "/" && peek(1) === "*") {
      advance(); advance(); // skip /*
      while (pos < source.length && !(peek() === "*" && peek(1) === "/")) {
        if (peek() === "\n") { pos++; line++; column = 1; }
        else advance();
      }
      if (pos < source.length) { advance(); advance(); } // skip */
      continue;
    }

    // 空白・改行のスキップ
    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }
    if (ch === "\n") {
      pos++;
      line++;
      column = 1;
      continue;
    }

    // 数値リテラル (0x, 0b, 0o 対応)
    if (isDigit(ch)) {
      const start = pos;
      const startCol = column;
      if (ch === "0" && (peek(1) === "x" || peek(1) === "X")) {
        advance(); advance(); // skip '0x'
        while (pos < source.length && /[0-9a-fA-F]/.test(peek())) advance();
      } else if (ch === "0" && (peek(1) === "b" || peek(1) === "B")) {
        advance(); advance(); // skip '0b'
        while (pos < source.length && (peek() === "0" || peek() === "1")) advance();
      } else if (ch === "0" && (peek(1) === "o" || peek(1) === "O")) {
        advance(); advance(); // skip '0o'
        while (pos < source.length && /[0-7]/.test(peek())) advance();
      } else {
        while (pos < source.length && isDigit(peek())) advance();
        if (peek() === "." && isDigit(peek(1))) {
          advance(); // '.'
          while (pos < source.length && isDigit(peek())) advance();
        }
      }
      pushToken("Number", source.slice(start, pos), startCol);
      continue;
    }

    // 文字列リテラル
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startCol = column;
      advance(); // opening quote
      let str = "";
      while (pos < source.length && peek() !== quote) {
        if (peek() === "\\") {
          advance(); // backslash
          const esc = advance();
          switch (esc) {
            case "n": str += "\n"; break;
            case "t": str += "\t"; break;
            case "\\": str += "\\"; break;
            case "'": str += "'"; break;
            case '"': str += '"'; break;
            default: str += esc;
          }
        } else {
          str += advance();
        }
      }
      if (pos >= source.length) {
        throw new SyntaxError(`Unterminated string at line ${line}, column ${startCol}`);
      }
      advance(); // closing quote
      pushToken("String", str, startCol);
      continue;
    }

    // テンプレートリテラル
    if (ch === "`") {
      scanTemplate(false);
      continue;
    }

    // 識別子・キーワード (unicode escape 対応)
    if (isAlpha(ch) || (ch === "\\" && peek(1) === "u")) {
      const startCol = column;
      let word = "";
      while (pos < source.length) {
        if (peek() === "\\" && peek(1) === "u") {
          advance(); advance(); // skip \u
          if (peek() === "{") {
            // \u{XXXX} 形式
            advance(); // skip {
            let hex = "";
            while (pos < source.length && peek() !== "}") hex += advance();
            if (pos < source.length) advance(); // skip }
            word += String.fromCodePoint(parseInt(hex, 16));
          } else {
            // \uXXXX 形式
            let hex = "";
            for (let j = 0; j < 4 && pos < source.length; j++) hex += advance();
            word += String.fromCharCode(parseInt(hex, 16));
          }
        } else if (isAlphaNumeric(peek())) {
          word += advance();
        } else {
          break;
        }
      }
      pushToken(KEYWORDS[word] ?? "Identifier", word, startCol);
      continue;
    }

    // Private identifier: #name
    if (ch === "#" && isAlpha(peek(1))) {
      const startCol = column;
      advance(); // skip #
      const start = pos;
      while (pos < source.length && isAlphaNumeric(peek())) advance();
      pushToken("PrivateIdentifier", "#" + source.slice(start, pos), startCol);
      continue;
    }

    // 複数文字演算子
    const startCol = column;

    if (ch === "+" && peek(1) === "+") {
      pushToken("PlusPlus", "++", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "-" && peek(1) === "-") {
      pushToken("MinusMinus", "--", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "+" && peek(1) === "=") {
      pushToken("PlusEquals", "+=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "-" && peek(1) === "=") {
      pushToken("MinusEquals", "-=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "*" && peek(1) === "=") {
      pushToken("StarEquals", "*=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "/" && peek(1) === "=") {
      pushToken("SlashEquals", "/=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "%" && peek(1) === "=") {
      pushToken("PercentEquals", "%=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "=" && peek(1) === "=" && peek(2) === "=") {
      pushToken("EqualEqualEqual", "===", startCol);
      pos += 3; column += 3; continue;
    }
    if (ch === "=" && peek(1) === "=") {
      pushToken("EqualEqual", "==", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "=" && peek(1) === ">") {
      pushToken("Arrow", "=>", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "!" && peek(1) === "=" && peek(2) === "=") {
      pushToken("BangEqualEqual", "!==", startCol);
      pos += 3; column += 3; continue;
    }
    if (ch === "!" && peek(1) === "=") {
      pushToken("BangEqual", "!=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "<" && peek(1) === "=") {
      pushToken("LessEqual", "<=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === ">" && peek(1) === "=") {
      pushToken("GreaterEqual", ">=", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "&" && peek(1) === "&") {
      pushToken("AmpersandAmpersand", "&&", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "|" && peek(1) === "|") {
      pushToken("PipePipe", "||", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === ">" && peek(1) === ">" && peek(2) === ">") {
      pushToken("UnsignedShiftRight", ">>>", startCol);
      pos += 3; column += 3; continue;
    }
    if (ch === "<" && peek(1) === "<") {
      pushToken("ShiftLeft", "<<", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === ">" && peek(1) === ">") {
      pushToken("ShiftRight", ">>", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "*" && peek(1) === "*") {
      pushToken("StarStar", "**", startCol);
      pos += 2; column += 2; continue;
    }
    if (ch === "." && peek(1) === "." && peek(2) === ".") {
      pushToken("DotDotDot", "...", startCol);
      pos += 3; column += 3; continue;
    }
    if (ch === "?" && peek(1) === "." && !(peek(2) >= "0" && peek(2) <= "9")) {
      pushToken("QuestionDot", "?.", startCol);
      pos += 2; column += 2; continue;
    }
    // 先頭ドットの小数リテラル: .123
    if (ch === "." && peek(1) >= "0" && peek(1) <= "9") {
      let num = ".";
      advance();
      while (pos < source.length && source[pos] >= "0" && source[pos] <= "9") {
        num += source[pos]; advance();
      }
      // 指数部 e/E
      if (pos < source.length && (source[pos] === "e" || source[pos] === "E")) {
        num += source[pos]; advance();
        if (pos < source.length && (source[pos] === "+" || source[pos] === "-")) {
          num += source[pos]; advance();
        }
        while (pos < source.length && source[pos] >= "0" && source[pos] <= "9") {
          num += source[pos]; advance();
        }
      }
      pushToken("Number", num, startCol);
      continue;
    }
    if (ch === "?" && peek(1) === "?") {
      pushToken("QuestionQuestion", "??", startCol);
      pos += 2; column += 2; continue;
    }

    // 波括弧: テンプレートリテラルのネスト管理のため特別扱い
    if (ch === "{") {
      braceDepth++;
      pushToken("LeftBrace", ch, startCol);
      advance();
      continue;
    }
    if (ch === "}") {
      if (templateDepthStack.length > 0 && braceDepth === templateDepthStack[templateDepthStack.length - 1]) {
        // テンプレートリテラルの ${...} の閉じ → テンプレート文字列モードに復帰
        templateDepthStack.pop();
        scanTemplate(true);
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      pushToken("RightBrace", ch, startCol);
      advance();
      continue;
    }

    // 単一文字トークン
    const singleCharMap: Record<string, TokenType> = {
      "+": "Plus", "-": "Minus", "*": "Star", "/": "Slash", "%": "Percent",
      "=": "Equals", "!": "Bang", "<": "Less", ">": "Greater",
      "&": "Ampersand", "|": "Pipe", "^": "Caret", "~": "Tilde",
      "(": "LeftParen", ")": "RightParen",
      "[": "LeftBracket", "]": "RightBracket",
      ":": "Colon", "?": "Question", ".": "Dot", ",": "Comma",
      ";": "Semicolon",
    };

    if (ch in singleCharMap) {
      pushToken(singleCharMap[ch], ch, startCol);
      advance();
      continue;
    }

    throw new SyntaxError(`Unexpected character '${ch}' at line ${line}, column ${column}`);
  }

  tokens.push({ type: "EOF", value: "", line, column });
  return tokens;

  // テンプレートリテラルをスキャン
  // isContinuation: true = `}` からの復帰 (TemplateMiddle or TemplateTail)
  //                 false = `` ` `` からの開始 (NoSubstitutionTemplate or TemplateHead)
  function scanTemplate(isContinuation: boolean): void {
    const startCol = column;
    if (!isContinuation) {
      advance(); // skip opening `
    }
    // } からの復帰の場合、} は既に消費されていないので消費
    if (isContinuation) {
      advance(); // skip }
    }

    let str = "";
    while (pos < source.length) {
      const c = peek();
      if (c === "`") {
        advance(); // skip closing `
        if (isContinuation) {
          pushToken("TemplateTail", str, startCol);
        } else {
          pushToken("NoSubstitutionTemplate", str, startCol);
        }
        return;
      }
      if (c === "$" && peek(1) === "{") {
        advance(); // $
        advance(); // {
        templateDepthStack.push(braceDepth);
        if (isContinuation) {
          pushToken("TemplateMiddle", str, startCol);
        } else {
          pushToken("TemplateHead", str, startCol);
        }
        return;
      }
      if (c === "\\") {
        advance();
        const esc = advance();
        switch (esc) {
          case "n": str += "\n"; break;
          case "t": str += "\t"; break;
          case "r": str += "\r"; break;
          case "\\": str += "\\"; break;
          case "`": str += "`"; break;
          case "$": str += "$"; break;
          case "\n": break; // 行継続: バックスラッシュ+改行 → 何も追加しない
          default: str += "\\" + esc; // 未知のエスケープはそのまま保持
        }
      } else if (c === "\n") {
        str += "\n";
        pos++; line++; column = 1;
      } else {
        str += advance();
      }
    }
    throw new SyntaxError(`Unterminated template literal at line ${line}, column ${startCol}`);
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isAlphaNumeric(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch);
}
