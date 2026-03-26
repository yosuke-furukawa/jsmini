import type { Token, TokenType } from "./token.js";

const KEYWORDS: Record<string, TokenType> = {
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
  typeof: "Typeof",
  throw: "Throw",
  try: "Try",
  catch: "Catch",
  finally: "Finally",
  new: "New",
  this: "This",
  // undefined は予約語ではないのでキーワードに含めない
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 1;

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

    // 数値リテラル
    if (isDigit(ch)) {
      const start = pos;
      const startCol = column;
      while (pos < source.length && isDigit(peek())) advance();
      if (peek() === "." && isDigit(peek(1))) {
        advance(); // '.'
        while (pos < source.length && isDigit(peek())) advance();
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

    // 識別子・キーワード
    if (isAlpha(ch)) {
      const start = pos;
      const startCol = column;
      while (pos < source.length && isAlphaNumeric(peek())) advance();
      const word = source.slice(start, pos);
      pushToken(KEYWORDS[word] ?? "Identifier", word, startCol);
      continue;
    }

    // 複数文字演算子
    const startCol = column;

    if (ch === "=" && peek(1) === "=" && peek(2) === "=") {
      pushToken("EqualEqualEqual", "===", startCol);
      pos += 3; column += 3; continue;
    }
    if (ch === "=" && peek(1) === "=") {
      pushToken("EqualEqual", "==", startCol);
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

    // 単一文字トークン
    const singleCharMap: Record<string, TokenType> = {
      "+": "Plus", "-": "Minus", "*": "Star", "/": "Slash", "%": "Percent",
      "=": "Equals", "!": "Bang", "<": "Less", ">": "Greater",
      "(": "LeftParen", ")": "RightParen",
      "{": "LeftBrace", "}": "RightBrace",
      "[": "LeftBracket", "]": "RightBracket",
      ":": "Colon", ".": "Dot", ",": "Comma",
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
