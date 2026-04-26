/**
 * Safe expression evaluator (PR4 Agent Workflow).
 *
 * Lets workflow `if` / `loop.exitCondition` / `switch.switchOn` use a tiny
 * expression language without giving the LLM any path to RCE.
 *
 * **Whitelist** (anything else throws):
 *   Literals:           number, string ("..."), boolean, null
 *   Identifiers:        ctx, scope, trigger, workflow, user, i (iterator)
 *   Member access:      a.b, a["b"], a.b.c
 *   Logical:            &&, ||, !
 *   Comparison:         ===, !==, ==, !=, >, <, >=, <=
 *   Arithmetic:         + - * /  (allowed but limited use case)
 *   Function calls:     length(x), includes(s, "x"), match(s, "regex")
 *   Template-resolve helper: only the above operators
 *
 * Forbidden node types (any presence → throw):
 *   - FunctionExpression / ArrowFunctionExpression (no closures)
 *   - AssignmentExpression / UpdateExpression (no side effects)
 *   - NewExpression / ThisExpression / Super (no constructor / prototype hack)
 *   - SequenceExpression (no comma operator chains)
 *   - SpreadElement / RestElement / ArrayExpression / ObjectExpression
 *     (don't need them; reduces attack surface)
 *
 * Implementation: hand-rolled tiny tokenizer + recursive-descent parser.
 * Avoiding the acorn dependency keeps the workflow service independent of
 * external grammar surprises and gives us total control over what's legal.
 */

type TokenType =
  | "num"
  | "str"
  | "ident"
  | "punct"
  | "op"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const PUNCT = new Set(["(", ")", "[", "]", ",", "."]);
const SINGLE_OP = new Set(["+", "-", "*", "/"]);
const KEYWORDS = new Set(["true", "false", "null"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ type: "punct", value: c, pos: i });
      i++;
      continue;
    }
    // Multi-char ops first
    if (src[i] === "=" && src[i + 1] === "=" && src[i + 2] === "=") {
      tokens.push({ type: "op", value: "===", pos: i });
      i += 3;
      continue;
    }
    if (src[i] === "!" && src[i + 1] === "=" && src[i + 2] === "=") {
      tokens.push({ type: "op", value: "!==", pos: i });
      i += 3;
      continue;
    }
    if (src[i] === "=" && src[i + 1] === "=") {
      tokens.push({ type: "op", value: "==", pos: i });
      i += 2;
      continue;
    }
    if (src[i] === "!" && src[i + 1] === "=") {
      tokens.push({ type: "op", value: "!=", pos: i });
      i += 2;
      continue;
    }
    if (src[i] === ">" && src[i + 1] === "=") {
      tokens.push({ type: "op", value: ">=", pos: i });
      i += 2;
      continue;
    }
    if (src[i] === "<" && src[i + 1] === "=") {
      tokens.push({ type: "op", value: "<=", pos: i });
      i += 2;
      continue;
    }
    if (src[i] === "&" && src[i + 1] === "&") {
      tokens.push({ type: "op", value: "&&", pos: i });
      i += 2;
      continue;
    }
    if (src[i] === "|" && src[i + 1] === "|") {
      tokens.push({ type: "op", value: "||", pos: i });
      i += 2;
      continue;
    }
    if (c === ">" || c === "<" || c === "!") {
      tokens.push({ type: "op", value: c, pos: i });
      i++;
      continue;
    }
    if (SINGLE_OP.has(c)) {
      tokens.push({ type: "op", value: c, pos: i });
      i++;
      continue;
    }
    // Number
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: "num", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // String (double or single quoted)
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let str = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          str += src[j + 1];
          j += 2;
        } else {
          str += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error("Unterminated string");
      tokens.push({ type: "str", value: str, pos: i });
      i = j + 1;
      continue;
    }
    // Identifier
    if (/[a-zA-Z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_$]/.test(src[j])) j++;
      const value = src.slice(i, j);
      tokens.push({ type: "ident", value, pos: i });
      i = j;
      continue;
    }
    throw new Error(`Unexpected char '${c}' at ${i}`);
  }
  tokens.push({ type: "eof", value: "", pos: src.length });
  return tokens;
}

// ─── AST + parser ───
type Node =
  | { type: "Lit"; value: any }
  | { type: "Ident"; name: string }
  | { type: "Member"; obj: Node; prop: string; computed: boolean }
  | { type: "Call"; callee: string; args: Node[] }
  | { type: "Unary"; op: "!" | "-"; arg: Node }
  | { type: "Bin"; op: string; left: Node; right: Node };

class Parser {
  i = 0;
  constructor(public toks: Token[]) {}

  peek(k = 0) {
    return this.toks[this.i + k];
  }
  eat() {
    return this.toks[this.i++];
  }
  expect(type: TokenType, value?: string) {
    const t = this.eat();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${value ?? type} got ${t.value} at ${t.pos}`);
    }
    return t;
  }

  parse(): Node {
    const node = this.parseOr();
    this.expect("eof");
    return node;
  }
  parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().type === "op" && this.peek().value === "||") {
      this.eat();
      const right = this.parseAnd();
      left = { type: "Bin", op: "||", left, right };
    }
    return left;
  }
  parseAnd(): Node {
    let left = this.parseEq();
    while (this.peek().type === "op" && this.peek().value === "&&") {
      this.eat();
      const right = this.parseEq();
      left = { type: "Bin", op: "&&", left, right };
    }
    return left;
  }
  parseEq(): Node {
    let left = this.parseCmp();
    while (this.peek().type === "op" && ["===", "!==", "==", "!="].includes(this.peek().value)) {
      const op = this.eat().value;
      const right = this.parseCmp();
      left = { type: "Bin", op, left, right };
    }
    return left;
  }
  parseCmp(): Node {
    let left = this.parseAdd();
    while (this.peek().type === "op" && [">", "<", ">=", "<="].includes(this.peek().value)) {
      const op = this.eat().value;
      const right = this.parseAdd();
      left = { type: "Bin", op, left, right };
    }
    return left;
  }
  parseAdd(): Node {
    let left = this.parseMul();
    while (this.peek().type === "op" && ["+", "-"].includes(this.peek().value)) {
      const op = this.eat().value;
      const right = this.parseMul();
      left = { type: "Bin", op, left, right };
    }
    return left;
  }
  parseMul(): Node {
    let left = this.parseUnary();
    while (this.peek().type === "op" && ["*", "/"].includes(this.peek().value)) {
      const op = this.eat().value;
      const right = this.parseUnary();
      left = { type: "Bin", op, left, right };
    }
    return left;
  }
  parseUnary(): Node {
    if (this.peek().type === "op" && (this.peek().value === "!" || this.peek().value === "-")) {
      const op = this.eat().value as "!" | "-";
      return { type: "Unary", op, arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  parsePrimary(): Node {
    const t = this.peek();
    if (t.type === "num") {
      this.eat();
      return { type: "Lit", value: parseFloat(t.value) };
    }
    if (t.type === "str") {
      this.eat();
      return { type: "Lit", value: t.value };
    }
    if (t.type === "ident") {
      this.eat();
      if (KEYWORDS.has(t.value)) {
        if (t.value === "true") return { type: "Lit", value: true };
        if (t.value === "false") return { type: "Lit", value: false };
        if (t.value === "null") return { type: "Lit", value: null };
      }
      // Function call?
      if (this.peek().type === "punct" && this.peek().value === "(") {
        this.eat();
        const args: Node[] = [];
        if (!(this.peek().type === "punct" && this.peek().value === ")")) {
          args.push(this.parseOr());
          while (this.peek().type === "punct" && this.peek().value === ",") {
            this.eat();
            args.push(this.parseOr());
          }
        }
        this.expect("punct", ")");
        return { type: "Call", callee: t.value, args };
      }
      // identifier with member access
      let node: Node = { type: "Ident", name: t.value };
      while (true) {
        const nxt = this.peek();
        if (nxt.type === "punct" && nxt.value === ".") {
          this.eat();
          const prop = this.expect("ident");
          node = { type: "Member", obj: node, prop: prop.value, computed: false };
          continue;
        }
        if (nxt.type === "punct" && nxt.value === "[") {
          this.eat();
          const propNode = this.parseOr();
          this.expect("punct", "]");
          if (propNode.type !== "Lit" || (typeof propNode.value !== "string" && typeof propNode.value !== "number")) {
            throw new Error("Computed member access only allows literal string/number");
          }
          node = { type: "Member", obj: node, prop: String(propNode.value), computed: true };
          continue;
        }
        break;
      }
      return node;
    }
    if (t.type === "punct" && t.value === "(") {
      this.eat();
      const inner = this.parseOr();
      this.expect("punct", ")");
      return inner;
    }
    throw new Error(`Unexpected token ${t.value} at ${t.pos}`);
  }
}

// ─── Evaluator ───
const ALLOWED_ROOT_IDENTS = new Set([
  "ctx",
  "scope",
  "trigger",
  "workflow",
  "user",
  "i",
  "iter",
  "true",
  "false",
  "null",
]);

const ALLOWED_FUNCTIONS = new Set(["length", "includes", "match", "starts_with", "ends_with"]);

function evalNode(node: Node, env: Record<string, any>): any {
  switch (node.type) {
    case "Lit":
      return node.value;
    case "Ident":
      if (!ALLOWED_ROOT_IDENTS.has(node.name)) {
        // Allow if it exists in env (passed scope keys)
        if (!(node.name in env)) {
          throw new Error(`Identifier '${node.name}' not in env`);
        }
      }
      return env[node.name];
    case "Member": {
      const obj = evalNode(node.obj, env);
      if (obj == null) return undefined;
      return obj[node.prop];
    }
    case "Call": {
      if (!ALLOWED_FUNCTIONS.has(node.callee)) {
        throw new Error(`Function '${node.callee}' not allowed`);
      }
      const args = node.args.map((a) => evalNode(a, env));
      switch (node.callee) {
        case "length":
          return typeof args[0] === "string" || Array.isArray(args[0]) ? args[0].length : 0;
        case "includes":
          return typeof args[0] === "string" && typeof args[1] === "string"
            ? args[0].includes(args[1])
            : Array.isArray(args[0])
            ? args[0].includes(args[1])
            : false;
        case "match":
          if (typeof args[0] !== "string" || typeof args[1] !== "string") return false;
          try {
            return new RegExp(args[1]).test(args[0]);
          } catch {
            return false;
          }
        case "starts_with":
          return typeof args[0] === "string" && typeof args[1] === "string" && args[0].startsWith(args[1]);
        case "ends_with":
          return typeof args[0] === "string" && typeof args[1] === "string" && args[0].endsWith(args[1]);
        default:
          throw new Error(`unreachable: ${node.callee}`);
      }
    }
    case "Unary":
      if (node.op === "!") return !evalNode(node.arg, env);
      if (node.op === "-") return -evalNode(node.arg, env);
      throw new Error(`Unknown unary ${node.op}`);
    case "Bin": {
      const l = evalNode(node.left, env);
      // && / || short-circuit
      if (node.op === "&&") return l && evalNode(node.right, env);
      if (node.op === "||") return l || evalNode(node.right, env);
      const r = evalNode(node.right, env);
      switch (node.op) {
        case "===": return l === r;
        case "!==": return l !== r;
        case "==": return l == r;
        case "!=": return l != r;
        case ">": return l > r;
        case "<": return l < r;
        case ">=": return l >= r;
        case "<=": return l <= r;
        case "+": return (l ?? 0) + (r ?? 0);
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        default:
          throw new Error(`Unknown bin op ${node.op}`);
      }
    }
  }
}

/**
 * Evaluate an expression against an env. Throws on syntax error or
 * disallowed identifier / function.
 */
export function evalExpression(expr: string, env: Record<string, any>): any {
  const toks = tokenize(expr);
  const ast = new Parser(toks).parse();
  return evalNode(ast, env);
}

/**
 * Resolve `${path.to.value}` placeholders inside a template string against
 * an env (e.g. ctx.scope). Each placeholder is evaluated with `evalExpression`.
 * Used by ActionNode.inputBinding to pass prior nodes' outputs into the
 * next prompt.
 */
export function resolveTemplate(template: string, env: Record<string, any>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    try {
      const v = evalExpression(expr.trim(), env);
      if (v === undefined || v === null) return "";
      return typeof v === "string" ? v : JSON.stringify(v);
    } catch {
      return ""; // 评估失败给空字符串,模板继续渲染
    }
  });
}
