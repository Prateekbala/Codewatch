import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export interface TokenCounter {
  count(text: string): number;
}

export interface TokenCounterOptions {
  readonly safetyFactor?: number;
  readonly fastPathChars?: number;
}

const DEFAULT_SAFETY_FACTOR = 1.1;
const DEFAULT_FAST_PATH_CHARS = 200_000;
const CHARS_PER_TOKEN_FLOOR = 3;

let sharedEncoder: Tiktoken | null = null;

const encoder = (): Tiktoken => {
  sharedEncoder ??= new Tiktoken(o200kBase);
  return sharedEncoder;
};

export const createTokenCounter = (options: TokenCounterOptions = {}): TokenCounter => {
  const safetyFactor = options.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
  const fastPathChars = options.fastPathChars ?? DEFAULT_FAST_PATH_CHARS;
  return {
    count(text: string): number {
      if (text === "") {
        return 0;
      }
      if (text.length > fastPathChars) {
        return Math.ceil((text.length / CHARS_PER_TOKEN_FLOOR) * safetyFactor);
      }
      return Math.ceil(encoder().encode(text, "all").length * safetyFactor);
    },
  };
};

export const charEstimateCounter = (charsPerToken = 4): TokenCounter => ({
  count: (text) => Math.ceil(text.length / charsPerToken),
});
