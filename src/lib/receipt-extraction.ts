// src/lib/receipt-extraction.ts

export interface ExtractedData {
  amount: number | null;
  currency: string;
  date: string | null;
  vendor: string | null;
  vendor_normalized: string | null;
  extraction_method: 'regex' | 'ai' | 'ai_fallback_regex';
  confidence: number;
}

export interface AiConfig {
  provider: string;
  base_url: string | null;
  api_key: string | null;
  model: string | null;
  enabled: boolean;
}

/** Extract structured data from OCR text. Uses AI if configured, falls back to regex. */
export async function extractReceiptData(
  ocrText: string,
  aiConfig: AiConfig | null
): Promise<ExtractedData> {
  if (aiConfig?.enabled && aiConfig.base_url && aiConfig.model) {
    try {
      return await extractWithAi(ocrText, aiConfig);
    } catch (err) {
      console.warn('AI extraction failed, falling back to regex:', err);
      const regexResult = extractWithRegex(ocrText);
      return { ...regexResult, extraction_method: 'ai_fallback_regex' };
    }
  }
  return extractWithRegex(ocrText);
}

/** Regex-based extraction (always available, no external dependencies). */
export function extractWithRegex(ocrText: string): ExtractedData {
  return {
    amount: extractAmount(ocrText),
    currency: 'USD',
    date: extractDate(ocrText),
    vendor: extractVendor(ocrText),
    vendor_normalized: normalizeVendor(extractVendor(ocrText)),
    extraction_method: 'regex',
    confidence: 0.6,
  };
}

/** Extract the total amount from receipt text. Returns the largest dollar amount. */
export function extractAmount(text: string): number | null {
  // Match patterns: $42.17, TOTAL: 42.17, TOTAL $1,234.56, etc.
  const patterns = [
    /(?:TOTAL|GRAND\s*TOTAL|AMOUNT\s*DUE|BALANCE\s*DUE|AMOUNT)\s*:?\s*\$?([\d,]+\.\d{2})/gi,
    /\$\s*([\d,]+\.\d{2})/g,
  ];

  let largest: number | null = null;

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(value) && (largest === null || value > largest)) {
        largest = value;
      }
    }
  }

  return largest;
}

/** Extract the first date from receipt text. */
export function extractDate(text: string): string | null {
  const patterns: { regex: RegExp; parse: (m: RegExpMatchArray) => string | null }[] = [
    // YYYY-MM-DD
    { regex: /(\d{4})-(\d{2})-(\d{2})/, parse: (m) => `${m[1]}-${m[2]}-${m[3]}` },
    // MM/DD/YYYY
    { regex: /(\d{1,2})\/(\d{1,2})\/(\d{4})/, parse: (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
    // MM/DD/YY
    { regex: /(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/, parse: (m) => `20${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
    // Mon DD, YYYY (e.g., Mar 15, 2026)
    {
      regex: /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i,
      parse: (m) => {
        const months: Record<string, string> = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
        const mon = months[m[1].toLowerCase().slice(0, 3)];
        return mon ? `${m[3]}-${mon}-${m[2].padStart(2, '0')}` : null;
      },
    },
  ];

  for (const { regex, parse } of patterns) {
    const match = text.match(regex);
    if (match) {
      const result = parse(match);
      if (result) return result;
    }
  }
  return null;
}

/** Extract vendor name: first non-numeric, non-date line of OCR text. */
export function extractVendor(text: string): string | null {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  for (const line of lines) {
    // Skip lines that are mostly numbers, dates, or very short
    if (/^\d+[\s./-]*\d*$/.test(line)) continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) continue;
    if (/^[\d\s$.,]+$/.test(line)) continue;
    return line;
  }
  return null;
}

/** Normalize vendor name for fuzzy matching. */
export function normalizeVendor(vendor: string | null): string | null {
  if (!vendor) return null;
  return vendor
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/** AI-based extraction via OpenAI-compatible API. */
async function extractWithAi(ocrText: string, config: AiConfig): Promise<ExtractedData> {
  const url = `${config.base_url!.replace(/\/+$/, '')}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: 'Extract structured data from this receipt text. Return ONLY valid JSON with these fields: amount (number), currency (string, e.g. "USD"), date (string, YYYY-MM-DD format), vendor (string). No explanation, just JSON.',
          },
          { role: 'user', content: ocrText },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
    });

    if (!response.ok) throw new Error(`AI API error: ${response.status}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty AI response');

    // Parse JSON from response (may be wrapped in markdown code block)
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      amount: typeof parsed.amount === 'number' ? parsed.amount : null,
      currency: parsed.currency || 'USD',
      date: parsed.date || null,
      vendor: parsed.vendor || null,
      vendor_normalized: normalizeVendor(parsed.vendor),
      extraction_method: 'ai',
      confidence: 0.9,
    };
  } finally {
    clearTimeout(timeout);
  }
}
