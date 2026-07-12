import { describe, expect, test } from "bun:test";
import {
  MAX_INDEX_BODY_BYTES,
  MAX_TOKENS_PER_DOCUMENT,
  TOKEN_WEIGHT_BODY,
  TOKEN_WEIGHT_DESCRIPTION,
  TOKEN_WEIGHT_TAG,
  TOKEN_WEIGHT_TITLE,
} from "./constants.ts";
import {
  buildDocumentTokens,
  tokenize,
  tokenizeQuery,
  truncateUtf8Bytes,
} from "./tokenizer.ts";

describe("tokenize: ASCII", () => {
  test("lowercases and splits on non-word chars", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });

  test("digits and alnum runs", () => {
    expect(tokenize("GPT-4 turbo v2")).toEqual(["gpt", "4", "turbo", "v2"]);
  });

  test("dedupes while keeping first-appearance order", () => {
    expect(tokenize("aws lambda aws s3 lambda")).toEqual(["aws", "lambda", "s3"]);
  });

  test("underscore and slash are separators", () => {
    expect(tokenize("snake_case path/to/file")).toEqual(["snake", "case", "path", "to", "file"]);
  });
});

describe("tokenize: CJK bigrams", () => {
  test("kanji run becomes overlapping bigrams", () => {
    expect(tokenize("東京都")).toEqual(["東京", "京都"]);
  });

  test("two-char run is a single bigram", () => {
    expect(tokenize("東京")).toEqual(["東京"]);
  });

  test("single CJK char run is emitted as-is", () => {
    expect(tokenize("犬")).toEqual(["犬"]);
    expect(tokenize("犬 と 猫")).toEqual(["犬", "と", "猫"]);
  });

  test("hiragana/katakana/kanji contiguous run bigrams across script boundaries", () => {
    expect(tokenize("月次レポート")).toEqual(["月次", "次レ", "レポ", "ポー", "ート"]);
  });

  test("prolonged sound mark (ー) is part of katakana runs", () => {
    expect(tokenize("サーバー")).toEqual(["サー", "ーバ", "バー"]);
  });

  test("iteration mark 々 is CJK", () => {
    expect(tokenize("人々")).toEqual(["人々"]);
  });

  test("punctuation (、。・「」) splits CJK runs", () => {
    expect(tokenize("売上、利益。")).toEqual(["売上", "利益"]);
  });
});

describe("tokenize: mixed & normalization", () => {
  test("ASCII and CJK segments in one string", () => {
    expect(tokenize("Claude3で検索")).toEqual(["claude3", "で検", "検索"]);
  });

  test("NFKC folds fullwidth ASCII", () => {
    expect(tokenize("ＡＢＣ１２３")).toEqual(["abc123"]);
  });

  test("NFKC folds halfwidth katakana", () => {
    expect(tokenize("ｶﾀｶﾅ")).toEqual(["カタ", "タカ", "カナ"]);
  });

  test("NFKC decomposes compatibility chars like ㈱", () => {
    // ㈱ -> (株)
    expect(tokenize("㈱テスト")).toEqual(["株", "テス", "スト"]);
  });

  test("empty and symbol-only inputs yield no tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! --- ??? 。、")).toEqual([]);
    expect(tokenize("   \n\t ")).toEqual([]);
  });

  test("emoji are separators", () => {
    expect(tokenize("done🎉report")).toEqual(["done", "report"]);
  });

  test("query tokenization is the exact same function", () => {
    expect(tokenizeQuery).toBe(tokenize);
    const s = "月次レポート 2025 Sales";
    expect(tokenizeQuery(s)).toEqual(tokenize(s));
  });
});

describe("truncateUtf8Bytes", () => {
  test("returns input unchanged when under limit", () => {
    expect(truncateUtf8Bytes("abc", 10)).toBe("abc");
  });

  test("never splits a multi-byte code point", () => {
    const s = "あ".repeat(10); // 3 bytes each
    const out = truncateUtf8Bytes(s, 10); // 10 / 3 -> 3 chars
    expect(out).toBe("あああ");
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(10);
  });

  test("zero / negative budget yields empty string", () => {
    expect(truncateUtf8Bytes("abc", 0)).toBe("");
  });
});

describe("buildDocumentTokens", () => {
  test("field weights: title=8, description=4, body=1", () => {
    const tokens = buildDocumentTokens({
      title: "alpha",
      description: "beta",
      body: "gamma",
    });
    const byToken = new Map(tokens.map((t) => [t.token, t.weight]));
    expect(byToken.get("alpha")).toBe(TOKEN_WEIGHT_TITLE);
    expect(byToken.get("beta")).toBe(TOKEN_WEIGHT_DESCRIPTION);
    expect(byToken.get("gamma")).toBe(TOKEN_WEIGHT_BODY);
  });

  test("weights are additive across fields", () => {
    const tokens = buildDocumentTokens({
      title: "東京",
      description: "東京",
      body: "東京 report",
    });
    const byToken = new Map(tokens.map((t) => [t.token, t.weight]));
    expect(byToken.get("東京")).toBe(
      TOKEN_WEIGHT_TITLE + TOKEN_WEIGHT_DESCRIPTION + TOKEN_WEIGHT_BODY,
    );
    expect(byToken.get("report")).toBe(TOKEN_WEIGHT_BODY);
  });

  test("missing description/body are treated as empty", () => {
    const tokens = buildDocumentTokens({ title: "solo" });
    expect(tokens).toEqual([{ token: "solo", weight: TOKEN_WEIGHT_TITLE }]);
  });

  test("tags carry weight 6, additive with other fields", () => {
    const tokens = buildDocumentTokens({
      title: "alpha",
      tags: ["alpha", "delta"],
      body: "delta",
    });
    const byToken = new Map(tokens.map((t) => [t.token, t.weight]));
    expect(byToken.get("alpha")).toBe(TOKEN_WEIGHT_TITLE + TOKEN_WEIGHT_TAG);
    expect(byToken.get("delta")).toBe(TOKEN_WEIGHT_TAG + TOKEN_WEIGHT_BODY);
  });

  test("CJK tags are bigram-tokenized without crossing tag boundaries", () => {
    const tokens = buildDocumentTokens({ title: "t", tags: ["売上", "月次"] });
    const set = new Set(tokens.map((t) => t.token));
    expect(set.has("売上")).toBe(true);
    expect(set.has("月次")).toBe(true);
    // タグ跨ぎのバイグラム（"上月"）は生まれない
    expect(set.has("上月")).toBe(false);
  });

  test("caps at MAX_TOKENS_PER_DOCUMENT keeping high-weight tokens", () => {
    const bodyTokens: string[] = [];
    for (let i = 0; i < MAX_TOKENS_PER_DOCUMENT + 500; i++) bodyTokens.push(`tok${i}`);
    const tokens = buildDocumentTokens({
      title: "keepme",
      body: bodyTokens.join(" "),
    });
    expect(tokens.length).toBe(MAX_TOKENS_PER_DOCUMENT);
    const byToken = new Map(tokens.map((t) => [t.token, t.weight]));
    expect(byToken.get("keepme")).toBe(TOKEN_WEIGHT_TITLE);
  });

  test("cap is deterministic (same input -> same token set)", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `t${i}`).join(" ");
    const a = buildDocumentTokens({ title: "x", body });
    const b = buildDocumentTokens({ title: "x", body });
    expect(a).toEqual(b);
  });

  test("body is truncated at 50KB before tokenizing", () => {
    const filler = "pad ".repeat(Math.ceil(MAX_INDEX_BODY_BYTES / 4) + 100);
    const body = `earlymarker ${filler} latemarker`;
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(MAX_INDEX_BODY_BYTES);
    const tokens = buildDocumentTokens({ title: "t", body });
    const set = new Set(tokens.map((t) => t.token));
    expect(set.has("earlymarker")).toBe(true);
    expect(set.has("latemarker")).toBe(false);
  });

  test("document tokens match query tokens for the same phrase", () => {
    const phrase = "月次売上レポート";
    const docTokens = new Set(
      buildDocumentTokens({ title: phrase }).map((t) => t.token),
    );
    for (const q of tokenizeQuery(phrase)) {
      expect(docTokens.has(q)).toBe(true);
    }
  });
});
