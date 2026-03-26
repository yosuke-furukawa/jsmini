export type TokenType =
  // Literals
  | "Number"
  | "String"
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
  // undefined は予約語ではないのでキーワードに含めない
  // Operators
  | "Plus"             // +
  | "Minus"            // -
  | "Star"             // *
  | "Slash"            // /
  | "Percent"          // %
  | "Equals"           // =
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
