export type TokenType =
  // Literals
  | "Number"
  | "String"
  | "NoSubstitutionTemplate"  // `hello`        (式埋め込みなし)
  | "TemplateHead"            // `hello ${      (先頭〜最初の${)
  | "TemplateMiddle"          // } ... ${       (} 〜 次の${)
  | "TemplateTail"            // } ... `        (} 〜 閉じ`)


  // Identifiers & Keywords
  | "Identifier"
  | "Var"              // var
  | "Let"              // let
  | "Const"            // const
  | "If"               // if
  | "Else"             // else
  | "True"             // true
  | "False"            // false
  | "Null"             // null
  | "While"            // while
  | "For"              // for
  | "Function"         // function
  | "Return"           // return
  | "Typeof"           // typeof
  | "Throw"            // throw
  | "Try"              // try
  | "Catch"            // catch
  | "Finally"          // finally
  | "New"              // new
  | "This"             // this
  | "Class"            // class
  | "Extends"          // extends
  | "Super"            // super
  | "Of"               // of
  // undefined は予約語ではないのでキーワードに含めない
  // Operators
  | "Plus"             // +
  | "Minus"            // -
  | "Star"             // *
  | "Slash"            // /
  | "Percent"          // %
  | "Equals"           // =
  | "Arrow"            // =>
  | "EqualEqual"       // ==
  | "EqualEqualEqual"  // ===
  | "Bang"             // !
  | "BangEqual"        // !=
  | "BangEqualEqual"   // !==
  | "Less"             // <
  | "Greater"          // >
  | "LessEqual"        // <=
  | "GreaterEqual"     // >=
  | "AmpersandAmpersand" // &&
  | "PipePipe"         // ||
  // Delimiters
  | "LeftParen"        // (
  | "RightParen"       // )
  | "LeftBrace"        // {
  | "RightBrace"       // }
  | "LeftBracket"      // [
  | "RightBracket"     // ]
  | "DotDotDot"        // ...
  | "Colon"            // :
  | "Dot"              // .
  | "Comma"            // ,
  | "Semicolon"        // ;
  // Special
  | "EOF";

export type Token = {
  type: TokenType;
  value: string;
  line: number;
  column: number;
};
