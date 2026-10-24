import { sanitizeJsonValue } from '@shared/validation/json';
import { ValidationError } from '@shared/errors';

const MAX_JSON_DEPTH = 64;
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function invalid(message: string, position: number): ValidationError {
  return new ValidationError(`Invalid plan JSON at character ${position}: ${message}`, [
    { path: [], message },
  ]);
}

/**
 * A deliberately small JSON parser whose only extra rule is that object keys
 * must be unique. JSON.parse silently keeps the last duplicate, which would let
 * a plan carry two different values for the same security-relevant field.
 */
class StrictJsonParser {
  private position = 0;
  private depth = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.position !== this.text.length) {
      throw invalid('Unexpected trailing content.', this.position);
    }
    return sanitizeJsonValue(value);
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const character = this.text[this.position];
    if (character === undefined) throw invalid('Expected a value.', this.position);

    if (character === '{') return this.parseObject();
    if (character === '[') return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === 't') return this.parseLiteral('true', true);
    if (character === 'f') return this.parseLiteral('false', false);
    if (character === 'n') return this.parseLiteral('null', null);
    return this.parseNumber();
  }

  private parseObject(): Record<string, unknown> {
    this.enterContainer();
    this.expect('{');
    const result: Record<string, unknown> = Object.create(null);
    const keys = new Set<string>();

    this.skipWhitespace();
    if (this.text[this.position] === '}') {
      this.position += 1;
      this.depth -= 1;
      return result;
    }

    while (true) {
      this.skipWhitespace();
      if (this.text[this.position] !== '"') {
        throw invalid('Expected a quoted object key.', this.position);
      }
      const key = this.parseString();
      if (keys.has(key)) {
        throw invalid(`Duplicate object key "${key}".`, this.position);
      }
      keys.add(key);

      this.skipWhitespace();
      this.expect(':');
      result[key] = this.parseValue();

      this.skipWhitespace();
      const separator = this.text[this.position];
      if (separator === ',') {
        this.position += 1;
        continue;
      }
      if (separator === '}') {
        this.position += 1;
        this.depth -= 1;
        return result;
      }
      throw invalid('Expected "," or "}" after an object member.', this.position);
    }
  }

  private parseArray(): unknown[] {
    this.enterContainer();
    this.expect('[');
    const result: unknown[] = [];

    this.skipWhitespace();
    if (this.text[this.position] === ']') {
      this.position += 1;
      this.depth -= 1;
      return result;
    }

    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.text[this.position];
      if (separator === ',') {
        this.position += 1;
        continue;
      }
      if (separator === ']') {
        this.position += 1;
        this.depth -= 1;
        return result;
      }
      throw invalid('Expected "," or "]" after an array element.', this.position);
    }
  }

  private parseString(): string {
    if (this.text[this.position] !== '"') {
      throw invalid('Expected a quoted string.', this.position);
    }

    const start = this.position;
    this.position += 1;
    let closed = false;

    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character === '"') {
        this.position += 1;
        closed = true;
        break;
      }
      if (character === '\\') {
        this.position += 1;
        const escape = this.text[this.position];
        if (escape === 'u') {
          const digits = this.text.slice(this.position + 1, this.position + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
            throw invalid('Invalid Unicode escape.', this.position);
          }
          this.position += 5;
          continue;
        }
        if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
          this.position += 1;
          continue;
        }
        throw invalid('Invalid string escape.', this.position);
      }
      const code = character?.charCodeAt(0) ?? 0;
      if (code < 0x20) throw invalid('Control characters must be escaped.', this.position);
      this.position += 1;
    }

    if (!closed) throw invalid('Unterminated string.', start);

    const literal = this.text.slice(start, this.position);
    try {
      return JSON.parse(literal) as string;
    } catch {
      throw invalid('Malformed string literal.', start);
    }
  }

  private parseNumber(): number {
    const match = NUMBER_PATTERN.exec(this.text.slice(this.position));
    if (match === null) throw invalid('Expected a JSON value.', this.position);
    const token = match[0];
    this.position += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) throw invalid('Numbers must be finite.', this.position);
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.text.startsWith(literal, this.position)) {
      throw invalid(`Expected "${literal}".`, this.position);
    }
    this.position += literal.length;
    return value;
  }

  private enterContainer(): void {
    this.depth += 1;
    if (this.depth > MAX_JSON_DEPTH) {
      throw invalid(`JSON nesting exceeds ${MAX_JSON_DEPTH} levels.`, this.position);
    }
  }

  private expect(character: string): void {
    if (this.text[this.position] !== character) {
      throw invalid(`Expected "${character}".`, this.position);
    }
    this.position += 1;
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character === undefined || !isWhitespace(character)) return;
      this.position += 1;
    }
  }
}

export function parseStrictJson(text: string): unknown {
  return new StrictJsonParser(text).parse();
}
