/**
 * Safe recursive descent parser for arithmetic expressions.
 * Supports +, -, *, / operators, parentheses, decimal numbers, and unary minus.
 * NO eval() for security.
 */

class MathParser {
  private input: string;
  private pos: number;
  private current: string;

  constructor(input: string) {
    this.input = input.replace(/\s+/g, ''); // Remove all whitespace
    this.pos = 0;
    this.current = this.input[0] || '';
  }

  private advance(): void {
    this.pos++;
    this.current = this.input[this.pos] || '';
  }

  private peek(): string {
    return this.input[this.pos + 1] || '';
  }

  /**
   * Parse number at current position.
   * Returns null if invalid.
   */
  private parseNumber(): number | null {
    let numStr = '';
    let hasDot = false;

    while (this.current && (this.current >= '0' && this.current <= '9' || this.current === '.')) {
      if (this.current === '.') {
        if (hasDot) return null; // Multiple dots invalid
        hasDot = true;
      }
      numStr += this.current;
      this.advance();
    }

    if (!numStr || numStr === '.') return null;
    const num = parseFloat(numStr);
    return isNaN(num) ? null : num;
  }

  /**
   * Factor: handles unary minus, parentheses, and numbers.
   * factor -> '-' factor | '(' expression ')' | number
   */
  private factor(): number | null {
    // Unary minus
    if (this.current === '-') {
      this.advance();
      const f = this.factor();
      return f !== null ? -f : null;
    }

    // Parentheses
    if (this.current === '(') {
      this.advance();
      const expr = this.expression();
      if (expr === null) return null;
      const closeParen: string = this.current;
      if (closeParen !== ')') return null;
      this.advance();
      return expr;
    }

    // Number
    return this.parseNumber();
  }

  /**
   * Term: handles * and / operators.
   * term -> factor ( ('*' | '/') factor )*
   */
  private term(): number | null {
    let left = this.factor();
    if (left === null) return null;

    while (this.current === '*' || this.current === '/') {
      const op = this.current;
      this.advance();
      const right = this.factor();
      if (right === null) return null;

      if (op === '*') {
        left = left * right;
      } else {
        // Division by zero
        if (right === 0) return null;
        left = left / right;
      }
    }

    return left;
  }

  /**
   * Expression: handles + and - operators.
   * expression -> term ( ('+' | '-') term )*
   */
  private expression(): number | null {
    let left = this.term();
    if (left === null) return null;

    while (this.current === '+' || this.current === '-') {
      const op = this.current;
      this.advance();
      const right = this.term();
      if (right === null) return null;

      if (op === '+') {
        left = left + right;
      } else {
        left = left - right;
      }
    }

    return left;
  }

  /**
   * Parse the entire expression.
   * Returns null if invalid or if input is not fully consumed.
   */
  parse(): number | null {
    const result = this.expression();
    // Must consume entire input
    if (this.current !== '') return null;
    return result;
  }
}

/**
 * Check if a string contains math operators (for visual indicator).
 * Returns true if string contains +, -, *, / or parentheses.
 * Does NOT count unary minus at start as an operator.
 */
export function containsMathExpression(input: string): boolean {
  if (!input) return false;
  const trimmed = input.trim();

  // Check for operators (excluding leading minus)
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '+' || char === '*' || char === '/' || char === '(' || char === ')') {
      return true;
    }
    // Only count minus if it's not at the start
    if (char === '-' && i > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluate a math expression safely.
 * Returns the result rounded to 2 decimal places.
 * Returns null if:
 * - Input is just a plain number (no operators)
 * - Input is invalid
 * - Division by zero occurs
 */
export function evaluateMathExpression(input: string): number | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // If no operators, return null (plain number, no evaluation needed)
  if (!containsMathExpression(trimmed)) {
    return null;
  }

  try {
    const parser = new MathParser(trimmed);
    const result = parser.parse();

    if (result === null) return null;
    if (!isFinite(result)) return null;

    // Round to 2 decimal places
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}
